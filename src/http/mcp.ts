import {
  readTurnMeta,
  toolDeliveryResult,
  type TurnToolMeta,
} from "@assistant-hub-swarm/transport-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { lookupMirroredMessage } from "../core/client";
import { SOURCE } from "../core/desired-state";
import type { UpdatePublisher } from "../core/updates";
import type { AssistantConnection } from "../discord/connections";
import { MAX_MESSAGE_LENGTH } from "../discord/ids";
import type { DiscordManager } from "../discord/manager";
import { discordErrorText } from "../discord/sender";
import { sendChatMessage } from "../outbound/send";

/**
 * This transport's own MCP server: the actions Discord has, offered to the
 * model only on Discord's turns. The core discovers it as a managed tool
 * connection and namespaces every tool by this source id, so the model sees
 * `discord__reply_to_message`.
 *
 * Stateless: one server per request, and every call carries its whole turn in
 * `_meta` — read with `readTurnMeta`, and refused when it is absent or names
 * another source. The model is never handed a channel id as an argument,
 * because then it could aim an action at a conversation nobody invited it to.
 */

const NO_TURN =
  "This tool can only be used inside a Discord turn, and this call carries no turn binding. " +
  "Nothing was sent.";
const NOT_A_REPLY_TURN =
  "This turn does not answer a message, so there is nothing to reply to. Nothing was sent.";
const NOT_A_SEND_TURN =
  "This turn answers a message; reply to it instead of sending a standalone message. " +
  "Nothing was sent.";

const REPLY_TO_MESSAGE_DESCRIPTION =
  "Send your answer to the Discord message that opened this turn, attached to it as a reply. " +
  "Use it once, with the complete answer as the chat should read it — the text is delivered " +
  "verbatim. Long answers are split across messages automatically; do not shorten to fit.";

const SEND_MESSAGE_DESCRIPTION =
  "Send a message into the Discord channel this turn belongs to, not attached to anything. " +
  "Use it once, with the complete text as the chat should read it.";

const SET_REACTION_DESCRIPTION =
  "Put a single emoji reaction on a message in this channel, or clear the one you left. " +
  "Reacting is an acknowledgement, not an answer: it does not deliver text and nobody is " +
  "notified. The message must be one you can see in this channel and not one of your own.";

/** The binding a hosted tool refuses to work without. */
function requireTurn(meta: unknown): TurnToolMeta | null {
  const turn = readTurnMeta(meta);
  return turn && turn.source === SOURCE ? turn : null;
}

function refusal(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true as const,
  };
}

function deliveryFailure(text: string, err: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Discord did not accept the message: ${discordErrorText(err)}. ` +
          "Nothing was delivered — do not claim it was.",
      },
    ],
    structuredContent: toolDeliveryResult({ ok: false, sourceMessageId: null, text }),
    isError: true as const,
  };
}

export interface DiscordMcpDeps {
  manager: Pick<DiscordManager, "senderFor">;
  updates: UpdatePublisher;
  running: () => AssistantConnection[];
  isDirect: (channelId: string) => Promise<boolean>;
}

export function createDiscordMcpServer(deps: DiscordMcpDeps): McpServer {
  const server = new McpServer({ name: "ahw-transport-discord", version: "1.0.0" });

  /**
   * The two delivery tools. Which one a turn may use is a fact about the turn,
   * not a choice for the model: a rule triggered by a message answers that
   * message, a timed fire speaks unprompted, and an ordinary reply turn
   * delivers its own text and is offered neither. The core withholds the tool
   * that does not match; this checks the turn as well, so a call that arrives
   * anyway cannot smuggle a send into the wrong turn.
   */
  const deliver = async (turn: TurnToolMeta, text: string, replyToMessageId: string | null) =>
    sendChatMessage(
      {
        sender: deps.manager.senderFor(turn.assistantId ?? null),
        publisher: deps.updates,
        running: deps.running,
      },
      {
        channelId: turn.chatId,
        assistantId: turn.assistantId ?? null,
        text,
        direct: await deps.isDirect(turn.chatId).catch(() => false),
        replyToMessageId,
      },
    );

  server.registerTool(
    "reply_to_message",
    {
      title: "Reply to an earlier message",
      description: REPLY_TO_MESSAGE_DESCRIPTION,
      inputSchema: {
        text: z
          .string()
          .min(1)
          .max(MAX_MESSAGE_LENGTH)
          .describe("The reply text, exactly as the chat should read it"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ text }, extra) => {
      const turn = requireTurn(extra?._meta);
      if (!turn) return refusal(NO_TURN);
      if (turn.deliveryKind !== "reply") return refusal(NOT_A_REPLY_TURN);
      try {
        // Which message it lands under is the turn's, never the model's.
        const sent = await deliver(turn, text, turn.replyToSourceMessageId ?? null);
        return {
          content: [{ type: "text" as const, text: `Reply sent (id ${sent.messageId}).` }],
          structuredContent: toolDeliveryResult({
            ok: true,
            sourceMessageId: sent.messageId,
            text,
          }),
        };
      } catch (err) {
        return deliveryFailure(text, err);
      }
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Send a message to the channel",
      description: SEND_MESSAGE_DESCRIPTION,
      inputSchema: {
        text: z
          .string()
          .min(1)
          .max(MAX_MESSAGE_LENGTH)
          .describe("The message text, exactly as the chat should read it"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ text }, extra) => {
      const turn = requireTurn(extra?._meta);
      if (!turn) return refusal(NO_TURN);
      if (turn.deliveryKind !== "send") return refusal(NOT_A_SEND_TURN);
      try {
        const sent = await deliver(turn, text, null);
        return {
          content: [{ type: "text" as const, text: `Message sent (id ${sent.messageId}).` }],
          structuredContent: toolDeliveryResult({
            ok: true,
            sourceMessageId: sent.messageId,
            text,
          }),
        };
      } catch (err) {
        return deliveryFailure(text, err);
      }
    },
  );

  server.registerTool(
    "set_message_reaction",
    {
      title: "React to a message",
      description: SET_REACTION_DESCRIPTION,
      inputSchema: {
        message_id: z
          .string()
          .min(1)
          .describe("The id of the message in this channel to react to"),
        emoji: z
          .string()
          .nullable()
          .describe("A single emoji, or null to remove the reaction you left"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ message_id, emoji }, extra) => {
      const turn = requireTurn(extra?._meta);
      if (!turn) return refusal(NO_TURN);
      try {
        // Ask the core's mirror first: a guessed id, or the assistant's own
        // message, is refused without touching Discord at all.
        const found = await lookupMirroredMessage({
          chatId: turn.chatId,
          sourceMessageId: message_id,
          assistantId: turn.assistantId ?? null,
          direct: await deps.isDirect(turn.chatId).catch(() => false),
        });
        if (!found.found) {
          return refusal(
            `No message ${message_id} in this channel. Look the message up again and use an ` +
              "id from the result. Nothing was changed.",
          );
        }
        if (found.role === "assistant") {
          return refusal(
            "That is one of your own messages, and reacting to yourself says nothing to " +
              "anyone. Nothing was changed.",
          );
        }
        await deps.manager
          .senderFor(turn.assistantId ?? null)
          .setReaction(turn.chatId, message_id, emoji);
        return {
          content: [
            {
              type: "text" as const,
              text: emoji
                ? `Reacted ${emoji} to message ${message_id}.`
                : `Removed your reaction from message ${message_id}.`,
            },
          ],
        };
      } catch (err) {
        return refusal(
          `Discord refused the reaction: ${discordErrorText(err)}. Nothing was changed.`,
        );
      }
    },
  );

  return server;
}
