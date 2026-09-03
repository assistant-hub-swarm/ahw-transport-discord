import { MAX_MESSAGE_LENGTH } from "../discord/ids";

/**
 * Discord caps one message at 2000 characters. The core does not know that —
 * it says what to deliver and the transport decides how — so a long answer is
 * cut HERE, at natural boundaries (paragraph → line → sentence → word), and
 * delivered as a short sequence of messages rather than truncated or refused.
 * Every part is reported as its own `message.delivered`, so the core's mirror
 * holds the whole answer.
 *
 * The cap is less than half Telegram's, so this runs far more often than the
 * equivalent there: a reply of a few paragraphs already needs splitting, which
 * is why the boundaries matter rather than a blunt slice.
 */

/**
 * Where to cut the next chunk: the last paragraph break inside the limit, else
 * the last line break, else the last sentence end, else the last space — each
 * only if it doesn't leave a degenerately small chunk — else a hard cut.
 */
function findCut(text: string): number {
  // One past the limit, so a boundary sitting exactly at the limit is found.
  const window = text.slice(0, MAX_MESSAGE_LENGTH + 1);
  const floor = Math.floor(MAX_MESSAGE_LENGTH / 2);

  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph >= floor) return paragraph;
  const line = window.lastIndexOf("\n");
  if (line >= floor) return line;

  let sentence = -1;
  const sentenceEnd = /[.!?…]\s/g;
  for (let m = sentenceEnd.exec(window); m; m = sentenceEnd.exec(window)) {
    sentence = m.index + 1; // cut after the punctuation, before the whitespace
  }
  if (sentence >= floor) return sentence;

  const space = window.lastIndexOf(" ");
  if (space >= floor) return space;
  return MAX_MESSAGE_LENGTH;
}

/**
 * Split text into Discord-sized messages at natural boundaries, so a long
 * answer is delivered whole as a short sequence of messages instead of being
 * cut off. Empty input yields no chunks.
 */
export function splitMessage(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= MAX_MESSAGE_LENGTH) return [trimmed];

  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > MAX_MESSAGE_LENGTH) {
    const cut = findCut(rest);
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
