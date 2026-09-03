import {
  messageDedupeKey,
  scopedRef,
  turnCorrelationId,
  type MessageDeliveredEvent,
} from "@assistant-hub-swarm/transport-sdk";

import { SOURCE } from "../core/desired-state";
import { updateEnvelope, type UpdatePublisher } from "../core/updates";
import { runningRoster, type AssistantConnection } from "../discord/connections";
import type { DiscordOutbound } from "../discord/sender";
import { splitMessage } from "./split";

/**
 * Sending text into a Discord channel, as one assistant: the split under
 * Discord's cap, each send, and the `message.delivered` event per part that
 * the core's ingest mirrors and cross-feeds. One function because there are
 * three callers who must not drift apart: the reply-delivery consumer, the
 * internal REST API and this service's MCP delivery tools.
 *
 * The core hands over the whole answer and knows no platform's cap: a long
 * text becomes several messages here, every part attached to the same reply
 * target and reported on its own, so the mirror holds all of it.
 */

export interface SendDeps {
  sender: Pick<DiscordOutbound, "sendMessage">;
  publisher: UpdatePublisher;
  running: () => AssistantConnection[];
  /**
   * Called when a delivered report could not be published — the message is in
   * the channel regardless, so this is for the caller's log or trace.
   * Default: `console.error`.
   */
  onReportFailure?: (messageId: string, error: unknown) => void;
}

export interface SendChatMessageInput {
  channelId: string;
  assistantId: string | null;
  text: string;
  /** Whether this channel is a DM — the core's `direct` half of a chat's identity. */
  direct: boolean;
  /** What to attach the message to; Discord may drop an unresolvable target. */
  replyToMessageId?: string | null;
  silent?: boolean;
}

export interface SentChatMessage {
  /** The first message sent — what a later deletion or a reply target names. */
  messageId: string;
  /** What Discord actually attached to the first part, which is not always what was asked. */
  replyToMessageId: string | null;
  /** Every message the text became, in order — one unless it exceeded the cap. */
  messageIds: string[];
}

/** Report one performed delivery to the core (mirror + cross-feed seam). */
export async function publishDelivered(
  deps: Pick<SendDeps, "publisher" | "running">,
  input: {
    channelId: string;
    assistantId: string | null;
    messageId: string;
    content: string;
    direct: boolean;
    replyToMessageId: string | null;
    silent?: boolean;
    image?: { fileId: string; fileUniqueId: string | null; base64: string } | null;
  },
): Promise<void> {
  const event: MessageDeliveredEvent = {
    ...updateEnvelope(
      turnCorrelationId(scopedRef(SOURCE, "chat", input.channelId), input.messageId),
    ),
    type: "message.delivered",
    source: SOURCE,
    chat: { id: input.channelId, kind: input.direct ? "direct" : "group" },
    assistantId: input.assistantId,
    sourceMessageId: input.messageId,
    dedupeKey: messageDedupeKey({
      chatId: input.channelId,
      sourceMessageId: input.messageId,
      // A guild channel is one shared stream every bot in it mirrors
      // idempotently; a DM belongs to the one assistant that owns it.
      assistantId: input.direct ? input.assistantId : null,
    }),
    content: input.content,
    replyToSourceMessageId: input.replyToMessageId,
    sentAt: new Date().toISOString(),
    threadId: null,
    silent: input.silent ?? false,
    image: input.image ?? null,
    running: runningRoster(deps.running()),
  };
  await deps.publisher.publish(event);
}

export async function sendChatMessage(
  deps: SendDeps,
  input: SendChatMessageInput,
): Promise<SentChatMessage> {
  const reportFailure =
    deps.onReportFailure ??
    ((messageId: string, err: unknown) =>
      console.error(
        `Failed to report delivery ${input.channelId}:${messageId}:`,
        err instanceof Error ? err.message : String(err),
      ));
  // Empty text is sent as-is: Discord's refusal is the honest answer, and it
  // reaches the caller as the send error it is.
  const parts = splitMessage(input.text);
  if (parts.length === 0) parts.push(input.text);

  let first: SentChatMessage | null = null;
  const messageIds: string[] = [];
  for (const part of parts) {
    const sent = await deps.sender.sendMessage(input.channelId, part, {
      replyToMessageId: input.replyToMessageId ?? null,
      silent: input.silent ?? false,
    });
    messageIds.push(sent.messageId);
    first ??= { messageId: sent.messageId, replyToMessageId: sent.replyToMessageId, messageIds };

    await publishDelivered(deps, {
      channelId: input.channelId,
      assistantId: input.assistantId,
      messageId: sent.messageId,
      content: part,
      direct: input.direct,
      // What is actually in the channel, not what was asked for.
      replyToMessageId: sent.replyToMessageId,
      silent: input.silent,
    }).catch((err) => reportFailure(sent.messageId, err));
  }
  return first!;
}
