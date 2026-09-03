import {
  CONTRACT_MAJOR,
  INTERNAL_TOKEN_HEADER,
  optionalEnv,
  requireEnv,
  transportDesiredStateSchema,
  type TransportDesiredState,
  type TransportRegistrationRequest,
} from "@assistant-hub-swarm/transport-sdk";

/**
 * Self-registration and desired state (the manual's "Step 2 — Register,
 * receive desired state, reconcile"): this transport announces itself to the
 * core at boot — its id, name, its own base URL, its MCP path, and the config
 * fields the dashboard renders — and receives its desired state in the same
 * round trip. Config changes arrive as `transport.config.changed` bus events;
 * the service refetches and reconciles. Zero local storage.
 */

/** This transport's source id. Every scoped ref and MCP tool is namespaced by it. */
export const SOURCE = "discord";

const REGISTER_RETRY_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;

/** What this transport announces about itself. */
export function registrationRequest(port: number): TransportRegistrationRequest {
  return {
    id: SOURCE,
    name: "Discord",
    contractMajor: CONTRACT_MAJOR,
    baseUrl: (optionalEnv("SELF_URL") ?? `http://localhost:${port}`).replace(/\/$/, ""),
    mcpPath: "/mcp",
    connectionConfigSchema: [
      {
        key: "botToken",
        label: "Bot token",
        kind: "secret",
        required: true,
        help:
          "From the Discord Developer Portal → your application → Bot → Reset Token. " +
          "The bot needs the MESSAGE CONTENT intent enabled on that page, or it will " +
          "connect and see every message as empty. Stored by the core; never shown again.",
      },
    ],
    // Nothing is configured per transport: owner rights, personas and tasks
    // all live in the core, and the bot token is per connection above.
    transportConfigSchema: [],
  };
}

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
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    // A 409 is the contract-major handshake refusing this build by name; it
    // reads the same as any other failure here and is retried the same way,
    // because the operator's fix is to update one side or the other.
    throw new Error(`core ${path} answered ${res.status}`);
  }
  return res.json();
}

/** Register once; the response is the desired state to reconcile from. */
export async function registerWithCore(port: number): Promise<TransportDesiredState> {
  return transportDesiredStateSchema.parse(
    await request("/api/internal/transports/register", {
      method: "POST",
      body: JSON.stringify(registrationRequest(port)),
    }),
  );
}

/** Refetch the desired state (on a config-changed event). */
export async function fetchDesiredState(): Promise<TransportDesiredState> {
  return transportDesiredStateSchema.parse(
    await request(`/api/internal/transports/${SOURCE}/desired`),
  );
}

/**
 * Register, retrying until the core answers — the core may boot after this
 * service, and a transport with no desired state has nothing to run.
 */
export async function registerUntilAccepted(port: number): Promise<TransportDesiredState> {
  for (;;) {
    try {
      return await registerWithCore(port);
    } catch (err) {
      console.warn(
        `registration with the core failed (${err instanceof Error ? err.message : String(err)}) — ` +
          `retrying in ${REGISTER_RETRY_MS / 1000}s`,
      );
      await new Promise((resolve) => setTimeout(resolve, REGISTER_RETRY_MS));
    }
  }
}
