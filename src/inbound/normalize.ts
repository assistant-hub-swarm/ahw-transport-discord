import type { InboundMessage, Normalizer } from "@assistant-hub-swarm/transport-sdk";
import type { Message } from "discord.js";

import { attachmentNote, loadMessageMedia } from "../discord/media";

/**
 * One Discord message, read into the contract's vocabulary. That is the whole
 * job: what a `messageCreate` MEANS is Discord's business, and everything
 * that happens to the result afterwards — deduping, the receivers list, the
 * envelope, the queue — belongs to the runtime and is the same everywhere.
 */
export const normalizeMessage: Normalizer<Message> = async (
  message,
): Promise<InboundMessage | null> => {
  const direct = message.channel.isDMBased();
  const note = attachmentNote(message);
  // `cleanContent`, not `content`: Discord puts mentions on the wire as
  // `<@1545468913393860950>`, and that snowflake is what the core mirrors,
  // indexes and shows the model — which reads it as noise, because it is.
  // discord.js resolves the same tokens to the readable `@name` a person sees
  // in the client. Outgoing text already strips raw mention tokens for the
  // same reason; this is that rule on the way in.
  const text = [message.cleanContent, note].filter(Boolean).join(" ").trim();
  const hasMedia = message.attachments.size > 0 || message.stickers.size > 0;
  if (!text && !hasMedia) return null;

  const replied = message.reference?.messageId
    ? await message.fetchReference().catch(() => null)
    : null;
  const replyAuthor = replied?.author ?? null;

  return {
    chatId: message.channelId,
    direct,
    chatTitle: direct ? null : channelName(message),
    chatType: direct ? null : "guild",
    sourceMessageId: message.id,
    content: text,
    sentAt: message.createdAt.toISOString(),
    // Discord threads are channels of their own, so a message never carries
    // one — the channel id already says which conversation it belongs to.
    threadId: null,
    // Owner rights are the core's judgement; this only reports who spoke.
    sender: {
      userId: message.author.id,
      username: message.author.username.toLowerCase(),
      // Discord has one display name, not a first/last pair. It goes in the
      // first slot and the second stays null rather than being invented.
      firstName: message.member?.displayName ?? message.author.displayName ?? null,
      lastName: null,
    },
    replyTo: replied
      ? {
          sourceMessageId: replied.id,
          hasMedia: replied.attachments.size > 0 || replied.stickers.size > 0,
          text: replied.cleanContent || null,
          quote: null,
          author:
            replyAuthor && !replyAuthor.bot
              ? {
                  userId: replyAuthor.id,
                  username: replyAuthor.username.toLowerCase(),
                  firstName: replyAuthor.displayName ?? null,
                  lastName: null,
                }
              : null,
          // The runtime resolves this to an assistant when it is one of ours.
          authorPlatformId: replyAuthor?.bot ? replyAuthor.id : null,
        }
      : null,
    media: hasMedia ? await loadMessageMedia(message).catch(() => null) : null,
  };
};

/** A guild channel's name, for the core's chat title. */
function channelName(message: Message): string | null {
  const channel = message.channel;
  return "name" in channel && typeof channel.name === "string" ? channel.name : null;
}
