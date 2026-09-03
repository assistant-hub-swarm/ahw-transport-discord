import {
  internalEditMenuRequestSchema,
  internalSendFileRequestSchema,
  internalSendMenuRequestSchema,
  internalSendMessageRequestSchema,
  internalSendPhotosRequestSchema,
  internalSendVoiceRequestSchema,
  internalTokenGuard,
  serveMcp,
  type InternalSentPhotosResponse,
} from "@assistant-hub-swarm/transport-sdk";
import { Hono } from "hono";

import type { UpdatePublisher } from "../core/updates";
import type { AssistantConnection } from "../discord/connections";
import type { DiscordManager } from "../discord/manager";
import { discordErrorText, type DiscordOutbound } from "../discord/sender";
import { publishDelivered, sendChatMessage } from "../outbound/send";
import { createDiscordMcpServer } from "./mcp";

/**
 * This service's HTTP surface:
 *
 * - `/health` — liveness plus the connection statuses the dashboard reads
 *   (unauthenticated; it carries no secrets, and the core probes it before
 *   this transport has registered).
 * - `/internal/*` — the sends the core drives: the calls that need a
 *   delivered id back or carry bytes, and the feedback-menu operations.
 * - `/mcp` — this service's own MCP server (delivery + reaction tools).
 *
 * Every performed send is reported to the core as a `message.delivered`
 * event; nothing here reads or writes any storage at all.
 */

export function createApi(input: {
  manager: Pick<DiscordManager, "statuses" | "senderFor">;
  internalToken: string;
  updates: UpdatePublisher;
  running: () => AssistantConnection[];
  /** Whether a channel is a DM — the delivered event's chat kind. */
  isDirect: (channelId: string) => Promise<boolean>;
}): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, connections: input.manager.statuses() }));

  const internal = new Hono();
  internal.use("*", internalTokenGuard(input.internalToken));

  const assistantIdOf = (c: { req: { query: (k: string) => string | undefined } }): string | null =>
    c.req.query("assistantId") ?? null;

  const senderOf = (c: {
    req: { query: (k: string) => string | undefined };
  }): DiscordOutbound => input.manager.senderFor(assistantIdOf(c));

  const sendDeps = (c: { req: { query: (k: string) => string | undefined } }) => ({
    sender: senderOf(c),
    publisher: input.updates,
    running: input.running,
  });

  // ---- Outbound sends -------------------------------------------------------

  internal.post("/chats/:chatId/messages", async (c) => {
    const parsed = internalSendMessageRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { message: "text is required" } }, 400);
    const channelId = c.req.param("chatId");
    const body = parsed.data;
    try {
      const sent = await sendChatMessage(sendDeps(c), {
        channelId,
        assistantId: assistantIdOf(c),
        text: body.text,
        direct: await input.isDirect(channelId).catch(() => false),
        replyToMessageId: body.replyToSourceMessageId ?? null,
        silent: body.silent,
      });
      return c.json({ sourceMessageId: sent.messageId });
    } catch (err) {
      return c.json({ error: { message: discordErrorText(err) } }, 502);
    }
  });

  internal.post("/chats/:chatId/voice", async (c) => {
    const parsed = internalSendVoiceRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: "audioBase64 and text are required" } }, 400);
    }
    const channelId = c.req.param("chatId");
    const body = parsed.data;
    const direct = await input.isDirect(channelId).catch(() => false);
    try {
      // Discord has no voice bubble a bot can post, so the audio goes as an
      // attachment and the spoken text as the message — which is what the
      // core mirrors either way. `asVoice: false` says so honestly rather
      // than claiming a form this platform does not have.
      const sent = await senderOf(c).sendVoice(
        channelId,
        { base64: body.audioBase64, filename: "voice.ogg" },
        { replyToMessageId: body.replyToSourceMessageId ?? null },
      );
      await publishDelivered(
        { publisher: input.updates, running: input.running },
        {
          channelId,
          assistantId: assistantIdOf(c),
          messageId: sent.messageId,
          content: body.text,
          direct,
          replyToMessageId: body.replyToSourceMessageId ?? null,
        },
      ).catch(() => undefined);
      return c.json({ sourceMessageId: sent.messageId, asVoice: false });
    } catch {
      // The audio could not be delivered; fall back to the words themselves,
      // which is the whole point of carrying `text` alongside the bytes.
      try {
        const sent = await sendChatMessage(sendDeps(c), {
          channelId,
          assistantId: assistantIdOf(c),
          text: body.text,
          direct,
          replyToMessageId: body.replyToSourceMessageId ?? null,
        });
        return c.json({ sourceMessageId: sent.messageId, asVoice: false });
      } catch (err) {
        return c.json({ error: { message: discordErrorText(err) } }, 502);
      }
    }
  });

  internal.post("/chats/:chatId/photos", async (c) => {
    const parsed = internalSendPhotosRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { message: "images are required" } }, 400);
    const channelId = c.req.param("chatId");
    const direct = await input.isDirect(channelId).catch(() => false);
    const delivered: InternalSentPhotosResponse["delivered"] = [];
    for (const [index, image] of parsed.data.images.entries()) {
      try {
        const sent = await senderOf(c).sendPhoto(channelId, {
          base64: image,
          filename: `image-${index + 1}.png`,
        });
        let stored = true;
        await publishDelivered(
          { publisher: input.updates, running: input.running },
          {
            channelId,
            assistantId: assistantIdOf(c),
            messageId: sent.messageId,
            content: "",
            direct,
            replyToMessageId: null,
            // The generated picture is reported as media so the core's
            // describer recognizes what the assistant itself drew.
            image: { fileId: sent.messageId, fileUniqueId: null, base64: image },
          },
        ).catch(() => {
          stored = false;
        });
        delivered.push({ sourceMessageId: sent.messageId, stored });
      } catch (err) {
        return c.json({ error: { message: discordErrorText(err) } }, 502);
      }
    }
    return c.json({ delivered } satisfies InternalSentPhotosResponse);
  });

  internal.post("/chats/:chatId/files", async (c) => {
    const parsed = internalSendFileRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: "dataBase64 and filename are required" } }, 400);
    }
    const channelId = c.req.param("chatId");
    const body = parsed.data;
    try {
      const sent = await senderOf(c).sendFile(
        channelId,
        { base64: body.dataBase64, filename: body.filename, mime: body.mime },
        { caption: body.caption },
      );
      await publishDelivered(
        { publisher: input.updates, running: input.running },
        {
          channelId,
          assistantId: assistantIdOf(c),
          messageId: sent.messageId,
          content: body.caption ?? body.filename,
          direct: await input.isDirect(channelId).catch(() => false),
          replyToMessageId: null,
        },
      ).catch(() => undefined);
      return c.json({ sourceMessageId: sent.messageId });
    } catch (err) {
      return c.json({ error: { message: discordErrorText(err) } }, 502);
    }
  });

  internal.delete("/chats/:chatId/messages/:messageId", async (c) => {
    try {
      await senderOf(c).deleteMessage(c.req.param("chatId"), c.req.param("messageId"));
    } catch {
      // A refusal is cosmetic for every caller — the message simply stays.
      return c.json({ deleted: false });
    }
    return c.json({ deleted: true });
  });

  // ---- Feedback menus -------------------------------------------------------

  internal.post("/chats/:chatId/menu", async (c) => {
    const parsed = internalSendMenuRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: { message: "text, keyboard and replyToSourceMessageId are required" } },
        400,
      );
    }
    try {
      const sent = await senderOf(c).sendMenu(c.req.param("chatId"), {
        text: parsed.data.text,
        keyboard: parsed.data.keyboard,
        replyToMessageId: parsed.data.replyToSourceMessageId,
      });
      return c.json({ sourceMessageId: sent.messageId });
    } catch (err) {
      return c.json({ error: { message: discordErrorText(err) } }, 502);
    }
  });

  internal.patch("/chats/:chatId/menu/:messageId", async (c) => {
    const parsed = internalEditMenuRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { message: "text is required" } }, 400);
    try {
      await senderOf(c).editMenu(c.req.param("chatId"), c.req.param("messageId"), {
        text: parsed.data.text,
        keyboard: parsed.data.keyboard,
      });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: { message: discordErrorText(err) } }, 502);
    }
  });

  internal.delete("/chats/:chatId/menu/:messageId", async (c) => {
    try {
      await senderOf(c).deleteMessage(c.req.param("chatId"), c.req.param("messageId"));
      return c.json({ deleted: true });
    } catch {
      return c.json({ deleted: false });
    }
  });

  // A Discord channel always has a name of its own, so `PUT /title` — the
  // route for platforms whose conversations arrive unnamed — is deliberately
  // not served. The contract carries no capability flags: an action a
  // platform does not have is a route that does not exist.

  app.route("/internal", internal);

  // This service's own MCP server: the core reaches it as a managed tool
  // connection, with the same shared secret the internal API takes.
  const mcp = new Hono();
  mcp.use("*", internalTokenGuard(input.internalToken));
  mcp.all("/", (c) =>
    serveMcp(c, () =>
      createDiscordMcpServer({
        manager: input.manager,
        updates: input.updates,
        running: input.running,
        isDirect: input.isDirect,
      }),
    ),
  );
  app.route("/mcp", mcp);

  return app;
}
