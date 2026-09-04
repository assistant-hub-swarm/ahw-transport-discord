import {
  reactToMessage,
  toolRefusal,
  tracedTool,
  turnOf,
  type TransportRuntime,
} from "@assistant-hub-swarm/transport-sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Message } from "discord.js";
import { z } from "zod";

import { discordErrorText } from "./connection";

/**
 * Reacting, as Discord does it.
 *
 * The tool is this transport's because the emoji are: Discord takes any
 * unicode emoji and any custom one the bot can see, which is a very different
 * sentence to write for a model than a fixed set would be. What the tool does
 * NOT own is the mirror gate or the badge record — `reactToMessage` is the
 * contract's, and every transport reaches the same verdicts through it.
 */

const DESCRIPTION =
  "Put a single emoji reaction on a message in this channel, or clear the one you left. " +
  "Reacting is an acknowledgement, not an answer: it does not deliver text and nobody is " +
  "notified, so use it alongside a reply rather than instead of one when something was " +
  "actually asked. The message must be one you can see here and not one of your own.";

export function registerReactionTool(server: McpServer, runtime: TransportRuntime<Message>): void {
  server.registerTool(
    "set_message_reaction",
    {
      title: "React to a message",
      description: DESCRIPTION,
      inputSchema: {
        message_id: z
          .string()
          .min(1)
          .describe("The id of the message in this channel to react to"),
        emoji: z
          .string()
          .default("")
          .describe("A single emoji to react with — leave empty to remove your reaction"),
      },
      outputSchema: {
        ok: z.boolean(),
        message_id: z.string().nullable(),
        emoji: z.string().nullable(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ message_id, emoji }, extra) => {
      const turn = turnOf(extra?._meta, runtime.descriptor.id);
      return tracedTool(
        {
          traces: runtime.traces,
          descriptor: runtime.descriptor,
          turn,
          action: "set_message_reaction",
          inputSummary: `${message_id} ${emoji || "(cleared)"}`,
        },
        async (event) => {
          if (!turn) {
            return toolRefusal(
              "This tool can only be used inside a turn on Discord, and this call carries no turn " +
                "binding. Nothing was changed.",
            );
          }
          const reaction = emoji.trim() || null;

          let outcome;
          try {
            outcome = await reactToMessage(
              { ...runtime.send, core: runtime.core },
              {
                chatId: turn.chatId,
                sourceMessageId: message_id,
                emoji: reaction,
                assistantId: turn.assistantId ?? null,
              },
            );
          } catch (err) {
            // Discord refused for a reason only it knows (an emoji this server
            // does not have, a message too old, no running connection) — relayed
            // verbatim so the model does not claim it reacted.
            return toolRefusal(
              `Discord did not accept the reaction: ${discordErrorText(err)}. ` +
                "Do not claim you reacted.",
            );
          }

          if (outcome.status === "not_found") {
            return toolRefusal(
              `No message ${message_id} in this channel. Do not guess ids — look the message up ` +
                "again and use an id from the result, or answer without reacting.",
            );
          }
          if (outcome.status === "own_message") {
            return toolRefusal(
              `Message ${message_id} is your own — do not react to what you said yourself. ` +
                "React to someone else's message, or say what you mean in your answer.",
            );
          }

          // Whether the bot will *remember* reacting: the mirror renders it on
          // the target line; without that record the very next turn denies having
          // set it. The reaction IS on the message either way.
          const note = outcome.recorded
            ? ""
            : " (Warning: the reaction could not be recorded in your history — later turns may not remember it.)";
          event({
            message: reaction
              ? `reacted ${reaction}`
              : "reaction cleared",
            type: "external_call",
            level: outcome.recorded ? "success" : "warn",
            data: {
              sourceMessageId: message_id,
              emoji: reaction,
              // False means the badge is on the message but the core's mirror
              // does not know, so the next turn will not remember reacting.
              recorded: outcome.recorded,
        },
      });
      return {
        content: [
          {
            type: "text" as const,
            text:
              (reaction
                ? `Reacted ${reaction} to message ${message_id}. The channel sees it under that ` +
                  "message, so there is no need to also say that you reacted."
                : `Removed your reaction from message ${message_id}.`) + note,
          },
        ],
        structuredContent: { ok: true, message_id, emoji: reaction },
      };
        },
      );
    },
  );
}
