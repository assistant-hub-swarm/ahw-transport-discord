import {
  dashboardRefresh,
  scopedRef,
  turnCorrelationId,
  type TransportDesiredState,
  type TransportUpdateEvent,
} from "@assistant-hub-swarm/transport-sdk";
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Interaction,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";

import { forwardCallbackPress } from "../core/client";
import { SOURCE } from "../core/desired-state";
import { SeenCache, updateEnvelope, type UpdatePublisher } from "../core/updates";
import { presenceEvent, processIncomingMessage } from "../inbound/normalize";
import type { AssistantConnection } from "./connections";
import { createDiscordOutbound, discordErrorText, type DiscordOutbound } from "./sender";

/**
 * One gateway client per enabled assistant connection, and the reconcile that
 * makes the running set match the core's desired state.
 *
 * Everything here is Discord's: the intents a bot needs, what its events mean,
 * and how a connection fails. What leaves this module is the contract's
 * vocabulary — transport events out, desired state in.
 *
 * Supervision is this service's problem, not the core's. discord.js reconnects
 * its own websocket with backoff; what it cannot recover from is a token the
 * platform refuses, which settles as `error` and stays there until an operator
 * changes it.
 */

/** What a connection is doing, as the dashboard shows it. */
export interface ConnectionStatus {
  connectionId: string;
  assistantId: string;
  state: "starting" | "running" | "stopped" | "error";
  username: string | null;
  since: string | null;
  error: string | null;
}

interface RunningClient {
  connectionId: string;
  assistantId: string;
  /** The token it was started with — a changed one means restart. */
  token: string;
  client: Client;
  outbound: DiscordOutbound;
  status: ConnectionStatus;
}

/**
 * The intents this transport needs, and why each one:
 *
 * - `Guilds` — channel metadata; without it a channel has no name or type.
 * - `GuildMessages` + `DirectMessages` — the messages themselves.
 * - `MessageContent` — a PRIVILEGED intent. Without it every message arrives
 *   with empty `content` and the bot looks broken rather than unconfigured,
 *   which is why the registration's help text names it.
 * - the two reaction intents — the feedback flow's 👍/👎.
 */
const INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.DirectMessageReactions,
];

/**
 * DMs and older messages arrive uncached, and discord.js delivers those as
 * partials unless told to hydrate them. Without these, a reaction on a message
 * the bot did not just send is silently dropped.
 */
const PARTIALS = [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User];

export interface ManagerDeps {
  redisUrl: string;
  updates: UpdatePublisher;
  /** Publish a dashboard refresh so the editor's badge flips without a reload. */
  publishStatus?: (event: TransportUpdateEvent) => Promise<void>;
}

export class DiscordManager {
  private running = new Map<string, RunningClient>();
  private seen = new SeenCache();

  constructor(private readonly deps: ManagerDeps) {}

  /** The roster an inbound event and a delivered event both carry. */
  runningConnections(): AssistantConnection[] {
    return [...this.running.values()]
      .filter((c) => c.status.state === "running")
      .map((c) => ({
        assistantId: c.assistantId,
        botId: c.client.user?.id ?? "",
        identity: {
          botUsername: c.client.user?.username ?? "",
          botDisplayName: c.client.user?.displayName ?? c.client.user?.username ?? "",
        },
      }));
  }

  /** Every connection's state, for `/health`. */
  statuses(): ConnectionStatus[] {
    return [...this.running.values()].map((c) => c.status);
  }

  /**
   * Whether a channel is a DM.
   *
   * The core addresses chats by scoped ref and does not carry the kind, so
   * the transport answers it — from any running client, since a channel is a
   * channel whichever bot looks at it. discord.js caches the lookup after the
   * first fetch. A channel none of them can see is reported as NOT direct:
   * that only affects which dedupe stream a message lands in, whereas the
   * opposite mistake would merge two people's DMs into one shared stream.
   */
  async isDirectChannel(channelId: string): Promise<boolean> {
    for (const running of this.running.values()) {
      if (!running.client.isReady()) continue;
      try {
        const channel = await running.client.channels.fetch(channelId);
        if (channel) return channel.isDMBased();
      } catch {
        // This bot cannot see it; another one may.
      }
    }
    return false;
  }

  /** The outbound surface of the bot serving one assistant, or the only one running. */
  senderFor(assistantId: string | null): DiscordOutbound {
    const match = assistantId
      ? [...this.running.values()].find((c) => c.assistantId === assistantId)
      : [...this.running.values()][0];
    const found = match ?? [...this.running.values()][0];
    if (!found) throw new Error("no Discord connection is running");
    return found.outbound;
  }

  /**
   * Make the running set match the desired state. Idempotent, which is what
   * lets a burst of config changes collapse into one call:
   *
   * - a connection that is gone, or disabled, is stopped and forgotten;
   * - an unchanged running connection is left alone (comparing the token it
   *   was started with — a live client will not hand its secret back);
   * - everything else is started, replacing any instance already there.
   */
  async applyDesiredState(desired: TransportDesiredState): Promise<ConnectionStatus[]> {
    const wanted = desired.transport.enabled
      ? desired.connections.filter((c) => c.enabled)
      : [];
    const wantedIds = new Set(wanted.map((c) => c.id));

    for (const [id, running] of this.running) {
      if (!wantedIds.has(id)) {
        await this.stop(id);
        continue;
      }
      const next = wanted.find((c) => c.id === id)!;
      if (tokenOf(next.config) === running.token) wantedIds.delete(id);
    }

    for (const connection of wanted) {
      if (!wantedIds.has(connection.id)) continue;
      await this.start(connection.id, connection.assistantId, tokenOf(connection.config));
    }
    await this.announceStatus();
    return this.statuses();
  }

  private async announceStatus(): Promise<void> {
    const event = dashboardRefresh(SOURCE, ["status"]) as unknown as TransportUpdateEvent;
    await (this.deps.publishStatus?.(event) ?? Promise.resolve()).catch(() => undefined);
  }

  private async stop(connectionId: string): Promise<void> {
    const running = this.running.get(connectionId);
    if (!running) return;
    this.running.delete(connectionId);
    await running.client.destroy().catch(() => undefined);
  }

  private async start(connectionId: string, assistantId: string, token: string): Promise<void> {
    await this.stop(connectionId);
    if (!token) {
      this.running.set(connectionId, {
        connectionId,
        assistantId,
        token,
        client: new Client({ intents: [] }),
        outbound: createDiscordOutbound(() => {
          throw new Error("this connection has no bot token");
        }),
        status: {
          connectionId,
          assistantId,
          state: "error",
          username: null,
          since: null,
          error: "no bot token configured",
        },
      });
      return;
    }

    const client = new Client({ intents: INTENTS, partials: PARTIALS });
    const entry: RunningClient = {
      connectionId,
      assistantId,
      token,
      client,
      outbound: createDiscordOutbound(() => {
        if (!client.isReady()) throw new Error("the Discord connection is not ready");
        return client;
      }),
      status: {
        connectionId,
        assistantId,
        state: "starting",
        username: null,
        since: null,
        error: null,
      },
    };
    this.running.set(connectionId, entry);
    this.wire(entry);

    try {
      await client.login(token);
    } catch (err) {
      entry.status = {
        ...entry.status,
        state: "error",
        error: discordErrorText(err),
      };
    }
  }

  /** Every gateway event this transport cares about, for one connection. */
  private wire(entry: RunningClient): void {
    const { client } = entry;

    client.once(Events.ClientReady, (ready) => {
      entry.status = {
        ...entry.status,
        state: "running",
        username: ready.user.username,
        since: new Date().toISOString(),
        error: null,
      };
      console.log(`connection ${entry.connectionId} running as @${ready.user.username}`);
      void this.announceStatus();
    });

    client.on(Events.Error, (err) => {
      entry.status = { ...entry.status, state: "error", error: discordErrorText(err) };
      console.error(`connection ${entry.connectionId} errored:`, discordErrorText(err));
      void this.announceStatus();
    });

    client.on(Events.MessageCreate, (message) => {
      void this.onMessage(entry, message);
    });

    client.on(Events.MessageUpdate, (_old, updated) => {
      void this.onEdit(entry, updated as Message);
    });

    client.on(Events.MessageReactionAdd, (reaction, user) => {
      void this.onReaction(entry, reaction, user);
    });

    client.on(Events.InteractionCreate, (interaction) => {
      void this.onInteraction(entry, interaction);
    });
  }

  private async onMessage(entry: RunningClient, message: Message): Promise<void> {
    try {
      const result = await processIncomingMessage(message, {
        assistantId: entry.assistantId,
        running: () => this.runningConnections(),
        seen: this.seen,
      });
      if (result.status === "forwarded") {
        await this.deps.updates.publish(result.event);
      } else if (result.status === "duplicate") {
        // Not this connection's to forward, but its presence in the channel is
        // exactly what the core resolves an audience from.
        await this.deps.updates.publish(
          presenceEvent({ channelId: message.channelId, assistantId: entry.assistantId }),
        );
      }
    } catch (err) {
      console.error("failed to forward a message:", discordErrorText(err));
    }
  }

  private async onEdit(entry: RunningClient, message: Message): Promise<void> {
    if (message.author?.bot || !message.content) return;
    // Edits are shared like the message they change: forwarded once.
    if (
      !message.channel.isDMBased() &&
      !this.seen.first(`e:${message.id}:${message.editedTimestamp ?? 0}`)
    ) {
      return;
    }
    await this.deps.updates
      .publish({
        ...updateEnvelope(
          turnCorrelationId(scopedRef(SOURCE, "chat", message.channelId), message.id),
        ),
        type: "transport.edited",
        source: SOURCE,
        chat: {
          id: message.channelId,
          kind: message.channel.isDMBased() ? "direct" : "group",
        },
        assistantId: entry.assistantId,
        sourceMessageId: message.id,
        content: message.content,
        editedAt: new Date(message.editedTimestamp ?? Date.now()).toISOString(),
      })
      .catch((err) => console.error("failed to forward an edit:", discordErrorText(err)));
  }

  private async onReaction(
    entry: RunningClient,
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    try {
      // A partial arrives when the message predates this process; hydrate it,
      // because the whole point is knowing WHOSE message was reacted to.
      const full = reaction.partial ? await reaction.fetch() : reaction;
      const message = full.message.partial ? await full.message.fetch() : full.message;
      if (user.id === entry.client.user?.id) return;

      const verdict = thumbVerdict(full.emoji.name);
      if (!verdict) return;

      const authoredByThisBot = message.author?.id === entry.client.user?.id;
      const direct = message.channel.isDMBased();
      if (!direct && !this.seen.first(`r:${message.id}:${user.id}:${verdict}`)) return;

      if (authoredByThisBot) {
        // A reaction on one of this assistant's own messages is feedback.
        const fetched = user.partial ? await user.fetch() : user;
        await this.deps.updates.publish({
          ...updateEnvelope(
            turnCorrelationId(scopedRef(SOURCE, "chat", message.channelId), message.id),
          ),
          type: "transport.reaction",
          source: SOURCE,
          assistantId: entry.assistantId,
          chat: { id: message.channelId, kind: direct ? "direct" : "group" },
          sourceMessageId: message.id,
          user: {
            userId: fetched.id,
            username: fetched.username?.toLowerCase() ?? null,
            firstName: fetched.displayName ?? null,
            lastName: null,
          },
          reaction: verdict,
        });
      }
    } catch (err) {
      console.error("failed to forward a reaction:", discordErrorText(err));
    }
  }

  /** A feedback-menu button press: forward it, answer with the toast. */
  private async onInteraction(entry: RunningClient, interaction: Interaction): Promise<void> {
    if (!interaction.isButton()) return;
    try {
      const { toast } = await forwardCallbackPress({
        source: SOURCE,
        assistantId: entry.assistantId,
        chat: {
          id: interaction.channelId ?? "",
          kind: interaction.channel?.isDMBased() ? "direct" : "group",
        },
        user: {
          userId: interaction.user.id,
          username: interaction.user.username.toLowerCase(),
          firstName: interaction.user.displayName ?? null,
          lastName: null,
        },
        menuSourceMessageId: interaction.message.id,
        data: interaction.customId,
      });
      // Ephemeral: the toast is for the presser, and Discord has no toast of
      // its own. An interaction MUST be answered within three seconds or the
      // client shows a failure, so this replies even when there is nothing to
      // say.
      await interaction.reply({ content: toast ?? "​", ephemeral: true });
    } catch (err) {
      console.error("failed to forward a menu press:", discordErrorText(err));
      await interaction
        .reply({ content: "That did not go through — try again.", ephemeral: true })
        .catch(() => undefined);
    }
  }

  /** Stop every connection (shutdown). */
  async close(): Promise<void> {
    for (const id of [...this.running.keys()]) await this.stop(id);
  }
}

/**
 * The feedback verdict a reaction carries, or null for everything else.
 *
 * Platform semantics, so the mapping lives with the transport: Discord allows
 * any emoji and any number of them, and only a thumb is feedback. The core
 * never sees an emoji - it receives `up` or `down`, or nothing at all. The
 * thumbs are written as escapes to keep this source ASCII.
 */
export function thumbVerdict(emoji: string | null): "up" | "down" | null {
  if (emoji === "\u{1F44D}") return "up";
  if (emoji === "\u{1F44E}") return "down";
  return null;
}

/** The bot token out of a connection's opaque config blob. */
function tokenOf(config: Record<string, unknown>): string {
  const token = config["botToken"];
  return typeof token === "string" ? token.trim() : "";
}
