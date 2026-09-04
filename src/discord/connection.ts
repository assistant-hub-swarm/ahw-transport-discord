import type {
  BotIdentity,
  MenuGrid,
  PlatformConnection,
  SendOptions,
  SentMessage,
} from "@assistant-hub-swarm/transport-sdk";
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
 * Everything this transport can ASK Discord to do, behind the runtime's
 * platform interface. The delivery consumer, the internal API and the MCP
 * tools all reach the platform through here, so how Discord is addressed has
 * exactly one home.
 *
 * The methods Discord cannot serve are simply absent — `setChatTitle` is not
 * here, because a channel names itself and the core is told so by the shape
 * of this object rather than by a refusal at runtime.
 */

function bytes(base64: string): Buffer {
  return Buffer.from(base64, "base64");
}

/** Action rows, five buttons each — Discord's own limit on a row. */
function toComponents(keyboard: MenuGrid) {
  return keyboard.map((row) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      row
        .slice(0, 5)
        .map((button) =>
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

export function createDiscordConnection(input: {
  /** The live client, or a throw explaining why there is none. */
  requireClient: () => Client<true>;
  /** Whether the gateway handshake has completed. */
  isReady: () => boolean;
  /** Called on shutdown; the adapter owns the client's lifetime. */
  destroy: () => Promise<void>;
}): PlatformConnection {
  const { requireClient, isReady } = input;

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
    return (await channelOf(channelId)).messages.fetch(messageId);
  }

  function replyOptions(opts?: SendOptions) {
    return opts?.replyToSourceMessageId
      ? // Losing the answer to save the pointer is the wrong trade: a stale
        // reply target must not cost the user their message.
        { reply: { messageReference: opts.replyToSourceMessageId, failIfNotExists: false } }
      : {};
  }

  function delivered(message: Message): SentMessage {
    return {
      sourceMessageId: message.id,
      // Read back off the sent message rather than echoed from the request:
      // `failIfNotExists: false` drops an unresolvable target silently, and
      // the mirror must record what is in the channel, not what was asked for.
      replyToSourceMessageId: message.reference?.messageId ?? null,
    };
  }

  return {
    identity(): BotIdentity | null {
      // Null, not a throw: `login()` resolves when the token is accepted and
      // `ClientReady` fires later, so "no identity yet" is an ordinary state
      // this method's own type already describes.
      if (!isReady()) return null;
      const client = requireClient();
      return client.user
        ? {
            id: client.user.id,
            identity: {
              botUsername: client.user.username,
              botDisplayName: client.user.displayName ?? client.user.username,
            },
          }
        : null;
    },

    async sendMessage(channelId, text, opts) {
      const channel = await sendableOf(channelId);
      return delivered(
        await channel.send({
          content: stripRawMentions(text),
          allowedMentions: NO_PINGS,
          flags: opts?.silent ? ["SuppressNotifications"] : undefined,
          ...replyOptions(opts),
        }),
      );
    },

    // Discord has no distinct voice bubble, so audio is an attachment — and
    // the answer says so: `asVoice` is false, and the core keeps the text.
    async sendVoice(channelId, voice, opts) {
      const channel = await sendableOf(channelId);
      const sent = await channel.send({
        files: [new AttachmentBuilder(bytes(voice.base64), { name: voice.filename })],
        allowedMentions: NO_PINGS,
        ...replyOptions(opts),
      });
      return { sourceMessageId: sent.id, asVoice: false };
    },

    async sendPhoto(channelId, image, opts) {
      const channel = await sendableOf(channelId);
      const sent = await channel.send({
        files: [new AttachmentBuilder(bytes(image.base64), { name: image.filename })],
        allowedMentions: NO_PINGS,
        ...replyOptions(opts),
      });
      // Discord serves attachments from a CDN URL rather than a re-usable
      // file id, so there is nothing to hand the core to fetch it again.
      return { sourceMessageId: sent.id, mediaId: null };
    },

    async sendFile(channelId, file, opts) {
      const channel = await sendableOf(channelId);
      const sent = await channel.send({
        ...(opts?.caption ? { content: stripRawMentions(opts.caption) } : {}),
        files: [new AttachmentBuilder(bytes(file.base64), { name: file.filename })],
        allowedMentions: NO_PINGS,
      });
      return { sourceMessageId: sent.id };
    },

    async deleteMessage(channelId, messageId) {
      await (await ownMessage(channelId, messageId)).delete();
    },

    async sendMenu(channelId, menu) {
      const channel = await sendableOf(channelId);
      const sent = await channel.send({
        content: menu.text,
        components: toComponents(menu.keyboard),
        allowedMentions: NO_PINGS,
        reply: { messageReference: menu.replyToSourceMessageId, failIfNotExists: false },
      });
      return { sourceMessageId: sent.id };
    },

    async editMenu(channelId, messageId, menu) {
      await (
        await ownMessage(channelId, messageId)
      ).edit({
        content: menu.text,
        // An empty component list is how Discord removes buttons; omitting
        // the field would leave them in place.
        components: menu.keyboard ? toComponents(menu.keyboard) : [],
      });
    },

    /**
     * Discord allows a bot several reactions at once, but the core's model is
     * one badge, so an emoji replaces whatever this bot reacted with before;
     * `null` clears it. Refusals throw, so the caller can relay them — a
     * swallowed failure would leave the model telling the channel it reacted.
     */
    async setReaction(channelId, messageId, emoji) {
      const client = requireClient();
      const message = await ownMessage(channelId, messageId);
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

    /**
     * A channel is a channel whichever bot looks at it, and discord.js caches
     * the lookup after the first fetch. A channel this bot cannot see is
     * reported as NOT direct: that only affects which dedupe stream a message
     * lands in, whereas the opposite mistake would merge two people's DMs
     * into one shared stream.
     */
    async isDirectChat(channelId) {
      try {
        const channel = await requireClient().channels.fetch(channelId);
        return channel?.isDMBased() ?? false;
      } catch {
        return false;
      }
    },

    close: input.destroy,
  };
}

/** The platform's own words for a refusal, for the core and for the model. */
export function discordErrorText(err: unknown): string {
  if (err instanceof DiscordAPIError) return `${err.message} (Discord code ${err.code})`;
  return err instanceof Error ? err.message : String(err);
}
