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
      // Two different things, and only one of them was here before: the
      // INTENT decides what Discord sends the bot, the PERMISSIONS decide what
      // it may do in a server. Under-granting either produces a bot that
      // connects, reports healthy, and silently does nothing — so both are
      // named, with the integer to paste and the two nobody should grant.
      help:
        "From the Discord Developer Portal → your application → Bot → Reset Token. " +
        "On that page also enable the MESSAGE CONTENT intent, or the bot connects, " +
        "looks healthy, and sees every message as empty. Invite it with OAuth2 → URL " +
        "Generator (scope: bot) granting View Channels, Send Messages, Send Messages " +
        "in Threads, Read Message History, Add Reactions and Attach Files — " +
        "permissions integer 274878008384. It never needs Manage Messages or " +
        "Administrator: it only ever deletes its own messages and clears its own " +
        "reactions. Stored by the core; never shown again.",
    },
  ],
  // Nothing is configured per transport: owner rights, personas and tasks all
  // live in the core, and the bot token is per connection above.
  transportConfigSchema: [],
};
