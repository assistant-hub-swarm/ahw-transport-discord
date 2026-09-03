import {
  INTERNAL_TOKEN_HEADER,
  optionalEnv,
  requireEnv,
  transportCallbackResponseSchema,
  transportMessageLookupResponseSchema,
  type TransportCallbackRequest,
  type TransportMessageLookupResponse,
} from "@assistant-hub-swarm/transport-sdk";

import { SOURCE } from "./desired-state";

/**
 * The synchronous half of the contract: a feedback-menu press wants its toast
 * back before Discord's interaction times out, and the reaction tool asks the
 * mirror (which lives in the core) before touching the platform. Everything
 * asynchronous travels the transport-updates queue instead.
 */

const REQUEST_TIMEOUT_MS = 15_000;

function coreApi(): { baseUrl: string; token: string } {
  const baseUrl = (optionalEnv("CORE_API_URL") ?? "http://localhost:3200").replace(/\/$/, "");
  return { baseUrl, token: requireEnv("INTERNAL_API_TOKEN") };
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const { baseUrl, token } = coreApi();
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      [INTERNAL_TOKEN_HEADER]: token,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(body?.error?.message ?? `core internal API ${path} answered ${res.status}`);
  }
  return res.json();
}

/** Ask the core's mirror about one message (the reaction tool's pre-check). */
export async function lookupMirroredMessage(params: {
  chatId: string;
  sourceMessageId: string;
  assistantId: string | null;
  direct: boolean;
}): Promise<TransportMessageLookupResponse> {
  const query = new URLSearchParams({
    source: SOURCE,
    chatId: params.chatId,
    sourceMessageId: params.sourceMessageId,
    ...(params.assistantId ? { assistantId: params.assistantId } : {}),
    ...(params.direct ? { direct: "true" } : {}),
  });
  return transportMessageLookupResponseSchema.parse(
    await request(`/api/internal/transports/messages?${query.toString()}`),
  );
}

/** Forward a menu press and get the toast to answer the interaction with. */
export async function forwardCallbackPress(
  body: TransportCallbackRequest,
): Promise<{ toast: string | null }> {
  return transportCallbackResponseSchema.parse(
    await request("/api/internal/transports/callback", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}
