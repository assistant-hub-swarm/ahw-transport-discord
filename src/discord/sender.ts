import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
  type Client,
  type Message,
  type TextBasedChannel,
} from "discord.js";

import { stripRawMentions } from "./ids";

/**
 * The outbound operations over a lazily-resolved gateway client. Everything
 * that touches Discord's API for a SEND lives here; the delivery consumer and
 * the internal API both go through this one surface, so a change to how the
 * platform is addressed has one home.
 *
 * `requireClient` throws when no matching connection runs — the caller (the
 * delivery consumer, the internal API) surfaces that as its own failure
 * rather than swallowing it, because a send nobody performed must never be
 * reported as delivered.
 */

/** A plain button grid the adapter converts to Discord action rows. */
export type MenuGrid = { text: string; callbackData: string }[][];

/** What Discord actually delivered. */
export interface SentMessage {
  messageId: string;
  /** The message this one actually replies to, or null when none was attached. */
  replyToMessageId: string | null;
}

export interface DiscordOutbound {
  /**
   * Send a text message, optionally attached as a reply. `silent` suppresses
   * the push notification, which is what a transient acknowledgement wants.
   */
  sendMessage(
    channelId: string,
    text: string,
    opts?: { replyToMessageId?: string | null; silent?: boolean },
  ): Promise<SentMessage>;
  /** Deliver audio. Discord has no distinct voice bubble, so this is an attachment. */
  sendVoice(
    channelId: string,
    voice: { base64: string; filename: string },
    opts?: { replyToMessageId?: string | null },
  ): Promise<{ messageId: string }>;
  /** Deliver an image as an attachment. */
  sendPhoto(
    channelId: string,
    image: { base64: string; filename: string },
    opts?: { replyToMessageId?: string | null },
  ): Promise<{ messageId: string }>;
  /** Deliver a file, with the caption as the message text. */
  sendFile(
    channelId: string,
    file: { base64: string; filename: string; mime?: string | null },
    opts?: { caption?: string | null },
  ): Promise<{ messageId: string }>;
  /** Delete one of the bot's own messages. */
  deleteMessage(channelId: string, messageId: string): Promise<void>;
  /** Post a button menu (the feedback flow's options). */
  sendMenu(
    channelId: string,
    menu: { text: string; keyboard: MenuGrid; replyToMessageId: string },
  ): Promise<{ messageId: string }>;
  /** Rewrite a previously sent menu (`null` keyboard removes the buttons). */
  editMenu(
    channelId: string,
    messageId: string,
    menu: { text: string; keyboard: MenuGrid | null },
  ): Promise<void>;
  /**
   * Set the bot's reaction on a message. Discord allows a bot several
   * reactions at once, but the core's model is one badge, so an emoji
   * replaces whatever this bot reacted with before; `null` clears it.
   * Throws on refusal so the caller can relay it — a swallowed failure would
   * leave the model telling the channel it reacted.
   */
  setReaction(channelId: string, messageId: string, emoji: string | null): Promise<void>;
  /** Show the typing indicator once (the caller owns the refresh loop). */
  sendTyping(channelId: string): void;
}

/** Discord's typing indicator lasts about ten seconds unless refreshed. */
export const TYPING_REFRESH_MS = 8_000;

function bytes(base64: string): Buffer {
  return Buffer.from(base64, "base64");
}

/** Action rows, five buttons each — Discord's own limit on a row. */
function toComponents(keyboard: MenuGrid) {
  return keyboard.map((row) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      row.slice(0, 5).map((button) =>
        new ButtonBuilder()
          .setCustomId(button.callbackData)
          .setLabel(button.text)
          .setStyle(ButtonStyle.Secondary),
      ),
    ),
  );
}

/**
 * Never ping anyone the model did not deliberately address. Discord expands
 * `@everyone`, role mentions and raw `<@id>` tokens in bot output exactly as
 * it would from a person, so an answer that quotes a name could notify a
 * channel; `parse: []` disables all of it, and the reply ping is opt-out too.
 */
const NO_PINGS = { parse: [] as never[], repliedUser: false };

export function createDiscordOutbound(requireClient: () => Client<true>): DiscordOutbound {
  async function channelOf(channelId: string): Promise<TextBasedChannel> {
    const channel = await requireClient().channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`channel ${channelId} is not a text channel this bot can see`);
    }
    return channel;
  }

  /** A sendable channel; Discord's types separate "can read" from "can send". */
  async function sendableOf(channelId: string) {
    const channel = await channelOf(channelId);
    if (!("send" in channel)) {
      throw new Error(`channel ${channelId} cannot be sent to by this bot`);
    }
    return channel;
  }

  async function ownMessage(channelId: string, messageId: string): Promise<Message> {
    const channel = await channelOf(channelId);
    return channel.messages.fetch(messageId);
  }

  function replyOptions(replyToMessageId?: string | null) {
    return replyToMessageId
      ? // Losing the answer to save the pointer is the wrong trade: a stale
        // reply target must not cost the user their message.
        { reply: { messageReference: replyToMessageId, failIfNotExists: false } }
      : {};
  }

  function delivered(message: Message): SentMessage {
    return {
      messageId: message.id,
      // Read back off the sent message rather than echoed from the request:
      // `failIfNotExists: false` drops an unresolvable target silently, and
      // the mirror must record what is in the channel, not what was asked for.
      replyToMessageId: message.reference?.messageId ?? null,
    };
  }

  return {
    async sendMessage(channelId, text, opts) {
      const channel = await sendableOf(channelId);
      const sent = await channel.send({
        content: stripRawMentions(text),
        allowedMentions: NO_PINGS,
        flags: opts?.silent ? ["SuppressNotifications"] : undefined,
        ...replyOptions(opts?.replyToMessageId),
      });
      return delivered(sent);
    },

    async sendVoice(channelId, voice, opts) {
      const channel = await sendableOf(channelId);
      const sent = await channel.send({
        files: [new AttachmentBuilder(bytes(voice.base64), { name: voice.filename })],
        allowedMentions: NO_PINGS,
        ...replyOptions(opts?.replyToMessageId),
      });
      return { messageId: sent.id };
    },

    async sendPhoto(channelId, image, opts) {
      const channel = await sendableOf(channelId);
      const sent = await channel.send({
        files: [new AttachmentBuilder(bytes(image.base64), { name: image.filename })],
        allowedMentions: NO_PINGS,
        ...replyOptions(opts?.replyToMessageId),
      });
      return { messageId: sent.id };
    },

    async sendFile(channelId, file, opts) {
      const channel = await sendableOf(channelId);
      const sent = await channel.send({
        ...(opts?.caption ? { content: stripRawMentions(opts.caption) } : {}),
        files: [new AttachmentBuilder(bytes(file.base64), { name: file.filename })],
        allowedMentions: NO_PINGS,
      });
      return { messageId: sent.id };
    },

    async deleteMessage(channelId, messageId) {
      const message = await ownMessage(channelId, messageId);
      await message.delete();
    },

    async sendMenu(channelId, menu) {
      const channel = await sendableOf(channelId);
      const sent = await channel.send({
        content: menu.text,
        components: toComponents(menu.keyboard),
        allowedMentions: NO_PINGS,
        reply: { messageReference: menu.replyToMessageId, failIfNotExists: false },
      });
      return { messageId: sent.id };
    },

    async editMenu(channelId, messageId, menu) {
      const message = await ownMessage(channelId, messageId);
      await message.edit({
        content: menu.text,
        // An empty component list is how Discord removes buttons; omitting the
        // field would leave them in place.
        components: menu.keyboard ? toComponents(menu.keyboard) : [],
      });
    },

    async setReaction(channelId, messageId, emoji) {
      const client = requireClient();
      const message = await ownMessage(channelId, messageId);
      // One badge per bot: clear whatever this bot reacted with first, so the
      // core's single-reaction model holds on a platform that allows many.
      for (const reaction of message.reactions.cache.values()) {
        if (reaction.users.cache.has(client.user.id) || reaction.me) {
          await reaction.users.remove(client.user.id).catch(() => undefined);
        }
      }
      if (emoji) await message.react(emoji);
    },

    sendTyping(channelId) {
      void sendableOf(channelId)
        .then((channel) => channel.sendTyping())
        .catch(() => undefined);
    },
  };
}

/** The platform's own words for a refusal, for relaying to the core and the model. */
export function discordErrorText(err: unknown): string {
  if (err instanceof DiscordAPIError) return `${err.message} (Discord code ${err.code})`;
  return err instanceof Error ? err.message : String(err);
}
