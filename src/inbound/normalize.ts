import {
  messageDedupeKey,
  scopedRef,
  transportMessageEventSchema,
  turnCorrelationId,
  type TransportMessageEvent,
  type TransportReceiver,
  type TransportUpdateEvent,
} from "@assistant-hub-swarm/transport-sdk";
import type { Message } from "discord.js";

import { SOURCE } from "../core/desired-state";
import { updateEnvelope, type SeenCache } from "../core/updates";
import type { AssistantConnection } from "../discord/connections";
import { attachmentNote, loadMessageMedia } from "../discord/media/ingest";
import { checkAddressed, type AddressableMessage } from "./addressing";

/**
 * Inbound processing: normalize one Discord `messageCreate` — media fetched
 * here, the per-connection structural addressing verdicts computed here —
 * into ONE transport-update event. The core's ingest persists it, resolves
 * the audience from its presence rows, composes the context and opens the
 * turns; this service never decides anything about replying.
 *
 * A guild message reaches EVERY bot in the channel but is forwarded once: the
 * in-process seen-cache suppresses the duplicates, which still count as
 * presence evidence (the caller publishes a presence stamp for them).
 */

export type InboundResult =
  | { status: "forwarded"; event: TransportMessageEvent }
  | { status: "duplicate" }
  | { status: "skipped"; reason: "bot_or_system_sender" | "no_content" };

export interface InboundDeps {
  /** The connection (bot) that received the update. */
  assistantId: string;
  /**
   * Every connection running right now, with bot identities — the receivers
   * list carries a structural verdict per each, so the core can fan a guild
   * message out without ever reading Discord's wire format.
   */
  running: () => AssistantConnection[];
  /** The guild-update dedupe cache (one per process). */
  seen: SeenCache;
}

/** What the structural check sees of a discord.js message. */
export function addressableOf(message: Message): AddressableMessage {
  return {
    content: message.content,
    direct: message.channel.isDMBased(),
    // `mentions.users` holds direct mentions only: a role ping or @everyone
    // targets a group of people, and answering those would make the bot a
    // nuisance in every busy channel.
    mentionedUserIds: [...message.mentions.users.keys()],
    replyToAuthorId: message.reference?.messageId
      ? (message.mentions.repliedUser?.id ?? null)
      : null,
  };
}

/** Normalize one incoming Discord message into its event. */
export async function processIncomingMessage(
  message: Message,
  deps: InboundDeps,
): Promise<InboundResult> {
  // Bot-authored messages are never forwarded: an assistant's own reply is
  // reported by the send that made it (`message.delivered`) and reaches the
  // channel's other assistants through the core's cross-feed. System messages
  // (joins, pins) are not conversation.
  if (message.author.bot || message.system) {
    return { status: "skipped", reason: "bot_or_system_sender" };
  }

  const direct = message.channel.isDMBased();
  const channelId = message.channelId;
  const note = attachmentNote(message);
  const text = [message.content, note].filter(Boolean).join(" ").trim();
  const hasMedia = message.attachments.size > 0 || message.stickers.size > 0;
  if (!text && !hasMedia) {
    return { status: "skipped", reason: "no_content" };
  }

  const dedupeKey = messageDedupeKey({
    chatId: channelId,
    sourceMessageId: message.id,
    // A guild channel is one shared stream; a DM belongs to one assistant.
    assistantId: direct ? deps.assistantId : null,
  });
  if (!direct && !deps.seen.first(`m:${dedupeKey}`)) {
    return { status: "duplicate" };
  }

  const media = hasMedia ? await loadMessageMedia(message).catch(() => null) : null;

  // The structural verdict per running connection — judged against each
  // receiver's own bot account. DMs list the receiving connection alone.
  const connections = direct
    ? deps.running().filter((c) => c.assistantId === deps.assistantId)
    : deps.running();
  const addressable = addressableOf(message);
  const receivers: TransportReceiver[] = connections.map((connection) => ({
    assistantId: connection.assistantId,
    identity: connection.identity,
    addressing: checkAddressed(addressable, {
      id: connection.botId,
      username: connection.identity.botUsername,
    }),
  }));

  const replied = message.reference?.messageId
    ? await message.fetchReference().catch(() => null)
    : null;
  const replyAuthor = replied?.author ?? null;
  const replyAuthorAssistant = replyAuthor?.bot
    ? (deps.running().find((c) => c.botId === replyAuthor.id)?.assistantId ?? null)
    : null;

  const event = transportMessageEventSchema.parse({
    ...updateEnvelope(turnCorrelationId(scopedRef(SOURCE, "chat", channelId), message.id)),
    type: "transport.message",
    source: SOURCE,
    receivedBy: deps.assistantId,
    chat: {
      id: channelId,
      kind: direct ? "direct" : "group",
      title: direct ? null : channelName(message),
      type: direct ? null : "guild",
    },
    // Owner rights are the core's judgement; this service only reports who spoke.
    sender: {
      userId: message.author.id,
      username: message.author.username.toLowerCase(),
      // Discord has one display name, not a first/last pair. It goes in the
      // first slot and the second stays null rather than being invented.
      firstName: message.member?.displayName ?? message.author.displayName ?? null,
      lastName: null,
    },
    message: {
      sourceMessageId: message.id,
      content: text,
      sentAt: message.createdAt.toISOString(),
      threadId: null,
      replyTo: replied
        ? {
            sourceMessageId: replied.id,
            hasMedia: replied.attachments.size > 0 || replied.stickers.size > 0,
            text: replied.content || null,
            quote: null,
            author:
              replyAuthor && !replyAuthor.bot
                ? {
                    userId: replyAuthor.id,
                    username: replyAuthor.username.toLowerCase(),
                    firstName: replyAuthor.displayName ?? null,
                    lastName: null,
                  }
                : null,
            authorAssistantId: replyAuthorAssistant,
          }
        : null,
    },
    media,
    receivers,
    dedupeKey,
  } satisfies TransportMessageEvent);

  return { status: "forwarded", event };
}

/** A guild channel's name, for the core's chat title. */
function channelName(message: Message): string | null {
  const channel = message.channel;
  return "name" in channel && typeof channel.name === "string" ? channel.name : null;
}

/** The presence stamp for a suppressed duplicate guild receipt. */
export function presenceEvent(input: {
  channelId: string;
  assistantId: string;
}): TransportUpdateEvent {
  return {
    ...updateEnvelope(`presence:${input.channelId}:${input.assistantId}`),
    type: "transport.presence",
    source: SOURCE,
    chatId: input.channelId,
    assistantId: input.assistantId,
  };
}
