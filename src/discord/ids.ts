/**
 * Pure facts about Discord identifiers this transport needs at its boundary.
 *
 * Discord ids are **snowflakes**: 64-bit integers that arrive as strings and
 * must stay strings. `Number("1183478562359283712")` loses the low digits, so
 * a transport that parses one has silently invented a different message. The
 * wire keeps every id verbatim for exactly this reason — nothing here converts.
 */

/** The longest a Discord message may be. Longer text is split, never truncated. */
export const MAX_MESSAGE_LENGTH = 2000;

/**
 * How a reply cites a message it is talking about: `#1183…`, or the numero
 * sign (`№`, written as an escape to keep this source ASCII) that a model
 * reaches for in some languages. Anchored to a boundary so a URL fragment and
 * a word-shaped hashtag are both left alone — only a delimiter followed by
 * digits counts. Snowflakes are 17-20 digits.
 */
export const MESSAGE_REF_PATTERN = /(^|[\s(\[«"'—-])([#№])(\d{15,21})\b/gu;

/** Every message id a text cites, de-duplicated, in first-appearance order. */
export function findMessageRefs(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(MESSAGE_REF_PATTERN)) {
    const id = match[3];
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * A message's permanent URL, which is how Discord links one message from
 * another. A guild message is `channels/<guild>/<channel>/<message>`; a DM
 * uses the literal `@me` in the guild slot.
 */
export function messageLink(params: {
  guildId: string | null;
  channelId: string;
  messageId: string;
}): string {
  return `https://discord.com/channels/${params.guildId ?? "@me"}/${params.channelId}/${params.messageId}`;
}

/**
 * Discord renders `<@123>` as a mention chip. The core's transcripts and the
 * model's text carry plain names, so an id that leaks into outgoing text
 * would render as a silent ping — strip any that the model invented, leaving
 * the readable part.
 */
export function stripRawMentions(text: string): string {
  return text.replace(/<@!?(\d{15,21})>/g, "").replace(/ {2,}/g, " ").trim();
}
