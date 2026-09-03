import { randomUUID } from "node:crypto";

import {
  TRANSPORT_UPDATES_QUEUE,
  openQueue,
  type TransportUpdateEvent,
} from "@assistant-hub-swarm/transport-sdk";
import type { Queue } from "bullmq";

/**
 * The transport-update producer: everything this service sees leaves as one
 * event on the transport-updates queue, and the core's ingest persists it.
 * Stateless by design — the only local state is the dedupe cache below.
 */

export interface UpdatePublisher {
  publish(event: TransportUpdateEvent): Promise<void>;
  close(): Promise<void>;
}

export function openUpdatePublisher(redisUrl: string): UpdatePublisher {
  const queue: Queue<TransportUpdateEvent> = openQueue(TRANSPORT_UPDATES_QUEUE, redisUrl);
  return {
    async publish(event) {
      await queue.add(event.type, event);
    },
    close: () => queue.close(),
  };
}

/** Envelope fields every update event shares. */
export function updateEnvelope(correlationId: string) {
  return {
    v: 1 as const,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    correlationId,
  };
}

const DEDUPE_TTL_MS = 10 * 60 * 1000;
const DEDUPE_CAP = 5_000;

/**
 * In-process seen-cache for guild updates.
 *
 * Every bot in a Discord guild receives the same `messageCreate`, and all of
 * this deployment's gateway clients run in one process — so the first receipt
 * forwards the update and the rest only prove presence. Worth nothing after a
 * restart (a re-forwarded update is deduped by the core's store on its dedupe
 * key anyway); it just saves the queue the duplicates.
 */
export class SeenCache {
  private seen = new Map<string, number>();

  /** True the FIRST time a key is offered inside the TTL window. */
  first(key: string): boolean {
    const now = Date.now();
    const at = this.seen.get(key);
    if (at != null && now - at < DEDUPE_TTL_MS) return false;
    this.seen.set(key, now);
    if (this.seen.size > DEDUPE_CAP) {
      // Drop the oldest half — a rough LRU is all a dedupe cache needs.
      const entries = [...this.seen.entries()].sort((a, b) => a[1] - b[1]);
      for (const [staleKey] of entries.slice(0, Math.floor(DEDUPE_CAP / 2))) {
        this.seen.delete(staleKey);
      }
    }
    return true;
  }
}
