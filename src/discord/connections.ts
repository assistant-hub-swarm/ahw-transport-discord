import { type ConnectionIdentity } from "@assistant-hub-swarm/transport-sdk";

/**
 * One running connection: the assistant it serves and the bot account serving
 * it. Both halves of shared-channel behaviour ride on this list — the
 * receivers of an inbound event (each with its own structural verdict) and the
 * `running` roster a delivered event carries for the core's cross-feed.
 */
export interface AssistantConnection {
  assistantId: string;
  /** The bot user's snowflake, verbatim. */
  botId: string;
  identity: ConnectionIdentity;
}

/** The delivered-event roster shape. */
export function runningRoster(connections: readonly AssistantConnection[]) {
  return connections.map((connection) => ({
    assistantId: connection.assistantId,
    botId: connection.botId,
    identity: connection.identity,
  }));
}
