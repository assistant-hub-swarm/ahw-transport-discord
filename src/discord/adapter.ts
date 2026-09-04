import type { PlatformAdapter, PlatformConnection } from "@assistant-hub-swarm/transport-sdk";
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

import { createDiscordConnection, discordErrorText } from "./connection";

/**
 * The whole of this transport's Discord knowledge on the INBOUND side: which
 * intents a bot needs, what each gateway event means, and how a connection
 * fails. Everything it reports goes out through the runtime's hooks in the
 * contract's vocabulary — deduping, event assembly and forwarding happen
 * there, once, for every platform.
 *
 * Supervision splits the same way: discord.js reconnects its own websocket
 * with backoff, and what it cannot recover from — a token the platform
 * refuses — is reported as an error status, which is the runtime's cue to
 * retry the connection while the core still wants it.
 */

/**
 * The intents this transport needs, and why each one:
 *
 * - `Guilds` — channel metadata; without it a channel has no name or type.
 * - `GuildMessages` + `DirectMessages` — the messages themselves.
 * - `MessageContent` — a PRIVILEGED intent. Without it every message arrives
 *   with empty `content` and the bot looks broken rather than unconfigured,
 *   which is why the descriptor's help text names it.
 * - the two reaction intents — the feedback flow's thumbs.
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
 * partials unless told to hydrate them. Without these, a reaction on a
 * message the bot did not just send is silently dropped.
 */
const PARTIALS = [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User];

/**
 * The feedback verdict a reaction carries, or null for everything else.
 *
 * Platform semantics, so the mapping lives here: Discord allows any emoji and
 * any number of them, and only a thumb is feedback. The core never sees an
 * emoji — it receives `up` or `down`, or nothing at all. The thumbs are
 * written as escapes to keep this source ASCII.
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

export const discordAdapter: PlatformAdapter<Message> = {
  errorText: discordErrorText,

  async connect(input, hooks): Promise<PlatformConnection> {
    const token = tokenOf(input.config);
    if (!token) throw new Error("this connection has no bot token");

    const client = new Client({ intents: INTENTS, partials: PARTIALS });
    const connection = createDiscordConnection({
      isReady: () => client.isReady(),
      requireClient: () => {
        if (!client.isReady()) throw new Error("the Discord connection is not ready");
        return client;
      },
      destroy: () => client.destroy().catch(() => undefined),
    });

    client.once(Events.ClientReady, (ready) => {
      console.log(`connection ${input.connectionId} running as @${ready.user.username}`);
      hooks.status({ state: "running" });
    });

    client.on(Events.Error, (err) => {
      hooks.status({ state: "error", error: discordErrorText(err) });
    });

    client.on(Events.MessageCreate, (message) => {
      // Bot-authored messages are never forwarded: an assistant's own reply
      // is reported by the send that made it and reaches the channel's other
      // assistants through the core's cross-feed. System messages (joins,
      // pins) are not conversation.
      if (message.author.bot || message.system) return;
      hooks.message(message);
    });

    client.on(Events.MessageUpdate, (_old, updated) => {
      const message = updated as Message;
      if (message.author?.bot || !message.content) return;
      hooks.edited({
        chatId: message.channelId,
        direct: message.channel.isDMBased(),
        sourceMessageId: message.id,
        content: message.content,
        editedAt: new Date(message.editedTimestamp ?? Date.now()).toISOString(),
      });
    });

    client.on(Events.MessageReactionAdd, (reaction, user) => {
      void onReaction(client, hooks, reaction, user);
    });

    client.on(Events.InteractionCreate, (interaction) => {
      void onInteraction(hooks, interaction);
    });

    // A refused token rejects here; the runtime records it and retries.
    await client.login(token);
    return connection;
  },
};

async function onReaction(
  client: Client,
  hooks: Parameters<PlatformAdapter<Message>["connect"]>[1],
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<void> {
  try {
    // A partial arrives when the message predates this process; hydrate it,
    // because the whole point is knowing WHOSE message was reacted to.
    const full = reaction.partial ? await reaction.fetch() : reaction;
    const message = full.message.partial ? await full.message.fetch() : full.message;
    if (user.id === client.user?.id) return;

    const verdict = thumbVerdict(full.emoji.name);
    // Only a reaction on one of THIS assistant's own messages is feedback.
    if (!verdict || message.author?.id !== client.user?.id) return;

    const fetched = user.partial ? await user.fetch() : user;
    hooks.reaction({
      chatId: message.channelId,
      direct: message.channel.isDMBased(),
      sourceMessageId: message.id,
      reaction: verdict,
      user: {
        userId: fetched.id,
        username: fetched.username?.toLowerCase() ?? null,
        firstName: fetched.displayName ?? null,
        lastName: null,
      },
    });
  } catch (err) {
    console.error("failed to read a reaction:", discordErrorText(err));
  }
}

/** A feedback-menu button press: forward it, answer with the toast. */
async function onInteraction(
  hooks: Parameters<PlatformAdapter<Message>["connect"]>[1],
  interaction: Interaction,
): Promise<void> {
  if (!interaction.isButton()) return;
  try {
    const { toast } = await hooks.menuPress({
      chatId: interaction.channelId ?? "",
      direct: interaction.channel?.isDMBased() ?? false,
      menuSourceMessageId: interaction.message.id,
      data: interaction.customId,
      user: {
        userId: interaction.user.id,
        username: interaction.user.username.toLowerCase(),
        firstName: interaction.user.displayName ?? null,
        lastName: null,
      },
    });
    // Ephemeral: the toast is for the presser, and Discord has no toast of
    // its own. An interaction MUST be answered within three seconds or the
    // client shows a failure, so this replies even with nothing to say.
    await interaction.reply({ content: toast ?? "​", ephemeral: true });
  } catch (err) {
    console.error("failed to answer a menu press:", discordErrorText(err));
    await interaction
      .reply({ content: "That did not go through — try again.", ephemeral: true })
      .catch(() => undefined);
  }
}
