import type { TransportDescriptor } from "@assistant-hub-swarm/transport-sdk";

import { MAX_MESSAGE_LENGTH } from "./discord/ids";

/**
 * Who this transport is, as the core learns it at registration: the id every
 * scoped ref is prefixed with, the name the dashboard shows, the config
 * fields the assistant editor renders, and the two platform limits the
 * runtime needs to send correctly.
 *
 * Nothing else about Discord reaches the core. Adding a field here is how
 * this transport asks the dashboard for a new setting — no core change.
 */

/** Discord's typing indicator lasts about ten seconds unless refreshed. */
const TYPING_REFRESH_MS = 8_000;

export const descriptor: TransportDescriptor = {
  id: "discord",
  name: "Discord",
  mcpPath: "/mcp",
  maxMessageLength: MAX_MESSAGE_LENGTH,
  typingRefreshMs: TYPING_REFRESH_MS,
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
  // Nothing is configured per transport: owner rights, personas and tasks all
  // live in the core, and the bot token is per connection above.
  transportConfigSchema: [],
};
