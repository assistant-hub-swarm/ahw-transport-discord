import {
  BUS_EVENTS_CHANNEL,
  busTraceClient,
  openPublisher,
  openSubscriber,
  parseScopedRef,
  replyDeliveryEventSchema,
  turnLifecycleEventSchema,
  type BusPublisher,
  type BusSubscription,
} from "@assistant-hub-swarm/transport-sdk";

import { SOURCE } from "../core/desired-state";
import type { UpdatePublisher } from "../core/updates";
import type { AssistantConnection } from "../discord/connections";
import { TYPING_REFRESH_MS, type DiscordOutbound } from "../discord/sender";
import { sendChatMessage } from "./send";

/**
 * The outbound half of the transport contract: consume the core's
 * reply-delivery events (perform the send, report it back as
 * `message.delivered` — the core mirrors and cross-feeds) and its
 * turn-lifecycle events (render as Discord's typing indicator). The model
 * never has to remember to deliver its own answer, and typing is never a tool.
 */

/** What delivery needs from a running connection; the manager provides it. */
export type DiscordSender = Pick<DiscordOutbound, "sendMessage" | "sendTyping">;

export interface DeliveryConsumer {
  close(): Promise<void>;
}

/**
 * Typing runs from `accepted` until `settled` — the transport renders the
 * core's turn lifecycle natively. Keyed per turn so concurrent channels never
 * share a loop.
 */
class TypingLoops {
  private loops = new Map<string, ReturnType<typeof setInterval>>();

  constructor(private readonly senderFor: (assistantId: string | null) => DiscordSender) {}

  start(key: string, channelId: string, assistantId: string | null): void {
    if (this.loops.has(key)) return;
    const tick = () => {
      try {
        this.senderFor(assistantId).sendTyping(channelId);
      } catch {
        // No running connection for this assistant right now.
      }
    };
    tick();
    const interval = setInterval(tick, TYPING_REFRESH_MS);
    interval.unref?.();
    this.loops.set(key, interval);
  }

  stop(key: string): void {
    const interval = this.loops.get(key);
    if (!interval) return;
    clearInterval(interval);
    this.loops.delete(key);
  }

  stopAll(): void {
    for (const key of [...this.loops.keys()]) this.stop(key);
  }
}

/**
 * Subscribe to the bus and act on the events addressed to this transport.
 * Failures are logged, never thrown into the subscriber — one bad delivery
 * must not kill the consumer for every channel.
 */
export async function startDeliveryConsumer(input: {
  redisUrl: string;
  /** Resolve the sender for one assistant's connection, per event. */
  senderFor: (assistantId: string | null) => DiscordSender;
  /** The connections running right now (the delivered event's roster). */
  running: () => AssistantConnection[];
  /** The transport-update producer (delivered events). */
  updates: UpdatePublisher;
  /** Whether a channel is a DM — the core's chat refs do not carry it. */
  isDirect: (channelId: string) => Promise<boolean>;
  onError?: (context: string, error: unknown) => void;
}): Promise<DeliveryConsumer> {
  const onError =
    input.onError ??
    ((context: string, error: unknown) => console.error(`[discord delivery] ${context}:`, error));
  const typing = new TypingLoops(input.senderFor);
  const publisher: BusPublisher = openPublisher(input.redisUrl);
  const traces = busTraceClient(SOURCE, publisher);

  const handle = async (payload: unknown): Promise<void> => {
    const type =
      payload && typeof payload === "object" ? (payload as { type?: unknown }).type : undefined;

    if (type === "reply.delivery") {
      const parsed = replyDeliveryEventSchema.safeParse(payload);
      if (!parsed.success || parsed.data.source !== SOURCE) return;
      const event = parsed.data;
      const channelId = parseScopedRef(event.chatRef).id;
      // The delivery half of the turn, on the turn's own correlation — in
      // Debug it lines up right after the core's reply trace.
      const trace = traces.startTrace({
        feature: "bot-messaging",
        action: "deliver",
        assistantId: event.assistantId,
        trigger: { kind: "transport", actor: event.chatRef, correlationId: event.correlationId },
        inputSummary: event.text,
      });
      try {
        const direct = await input.isDirect(channelId).catch(() => false);
        // The whole answer arrives; the split under Discord's cap, each send
        // and the delivered report per part all happen in the one send
        // function, so the three callers cannot drift apart.
        const sent = await sendChatMessage(
          {
            sender: input.senderFor(event.assistantId),
            publisher: input.updates,
            running: input.running,
            onReportFailure: (messageId, error) => {
              onError(`delivered report ${channelId}:${messageId}`, error);
              trace.event({
                message: "delivered report failed (message already delivered)",
                type: "db",
                level: "warn",
                data: {
                  messageId,
                  error: error instanceof Error ? error.message : String(error),
                },
              });
            },
          },
          {
            channelId,
            assistantId: event.assistantId,
            text: event.text,
            direct,
            replyToMessageId: event.replyToSourceMessageId ?? null,
            silent: event.silent,
          },
        );
        // Discord drops a reply target it cannot resolve and delivers the
        // message anyway (`failIfNotExists: false`). Said out loud here.
        const replyTargetDropped =
          event.replyToSourceMessageId != null && sent.replyToMessageId == null;
        const parts = sent.messageIds.length > 1 ? ` as ${sent.messageIds.length} messages` : "";
        trace.event({
          message: replyTargetDropped
            ? `reply sent${parts} — Discord did not attach the reply target`
            : `reply sent${parts}`,
          type: "external_call",
          level: replyTargetDropped ? "warn" : "success",
          data: {
            messageId: sent.messageId,
            messageIds: sent.messageIds,
            silent: event.silent,
            requestedReplyToMessageId: event.replyToSourceMessageId ?? null,
            replyToMessageId: sent.replyToMessageId,
          },
        });
        await trace.succeed({
          outputSummary: `delivered ${channelId}:${sent.messageIds.join(",")}`,
        });
      } catch (error) {
        await trace.fail(error);
        throw error;
      }
      return;
    }

    if (type === "turn.lifecycle") {
      const parsed = turnLifecycleEventSchema.safeParse(payload);
      if (!parsed.success || parsed.data.source !== SOURCE) return;
      const event = parsed.data;
      const channelId = parseScopedRef(event.chatRef).id;
      const key = `${channelId}:${event.sourceMessageId}`;
      if (event.phase === "settled") {
        typing.stop(key);
      } else {
        typing.start(key, channelId, event.assistantId ?? null);
      }
    }
  };

  const subscription: BusSubscription = await openSubscriber(
    input.redisUrl,
    BUS_EVENTS_CHANNEL,
    (payload) => {
      void handle(payload).catch((error) => onError("event handling", error));
    },
    (error) => onError("bus payload parse", error),
  );

  return {
    async close(): Promise<void> {
      typing.stopAll();
      await subscription.close();
      await publisher.close();
    },
  };
}
