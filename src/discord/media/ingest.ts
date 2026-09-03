import {
  normalizeImageForChat,
  type TransportMedia,
} from "@assistant-hub-swarm/transport-sdk";
import type { Attachment, Message } from "discord.js";

/**
 * Media on an inbound message: what kind it is, and the bytes the core's
 * vision and voice passes need.
 *
 * Discord is kinder here than most platforms — an attachment arrives with a
 * public CDN URL, its own content type and its size, so there is no file-id
 * round trip and no token on the download. What this module still owns is the
 * judgement: which attachment is worth reading, and what to call it.
 *
 * The core describes ONE media item per message, so a message with several
 * attachments contributes its first readable one; the rest are named in the
 * text the core mirrors and are not lost, just not described.
 */

/** What the vision pass can read, in the core's vocabulary. */
export type MediaKind = "photo" | "sticker" | "animation" | "video" | "voice" | "file";

/** How much of an attachment this transport is willing to pull into memory. */
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

function kindOf(attachment: Attachment): MediaKind {
  const type = attachment.contentType ?? "";
  if (type.startsWith("image/gif")) return "animation";
  if (type.startsWith("image/")) return "photo";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "voice";
  return "file";
}

/** The attachment worth describing: the first image, else the first of anything. */
function pickAttachment(message: Message): Attachment | null {
  const all = [...message.attachments.values()];
  if (all.length === 0) return null;
  return all.find((a) => (a.contentType ?? "").startsWith("image/")) ?? all[0];
}

async function download(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > MAX_DOWNLOAD_BYTES ? null : buf;
  } catch {
    return null;
  }
}

/**
 * Media for one message, with bytes attached, or null when there is nothing
 * to read. A payload that could not be fetched is still reported —
 * `unavailable: true`, no frames — because the core must record that the
 * message HAD media rather than silently treating it as text.
 */
export async function loadMessageMedia(message: Message): Promise<TransportMedia | null> {
  const sticker = message.stickers.first();
  if (sticker) {
    // A sticker is an image with a name worth keeping: it is often the whole
    // message, and the name is the only text the model would otherwise see.
    const bytes = await download(sticker.url);
    const normalized = bytes ? await normalizeImage(bytes) : null;
    return {
      kind: "sticker",
      fileId: sticker.id,
      fileUniqueId: null,
      mimeType: "image/png",
      visionHint: `a sticker named "${sticker.name}"`,
      frames: normalized ? [normalized] : [],
      unavailable: normalized === null,
    };
  }

  const attachment = pickAttachment(message);
  if (!attachment) return null;

  const kind = kindOf(attachment);
  const bytes = await download(attachment.url);

  // Only still images are normalized for the vision endpoints. A video or an
  // audio blob rides as-is; the core decides what it can do with it, and a
  // transport that guessed here would be inventing policy.
  const frames: string[] = [];
  if (bytes) {
    if (kind === "photo" || kind === "animation") {
      const normalized = await normalizeImage(bytes);
      if (normalized) frames.push(normalized);
    } else {
      frames.push(bytes.toString("base64"));
    }
  }

  return {
    kind,
    fileId: attachment.id,
    fileUniqueId: null,
    mimeType: attachment.contentType,
    visionHint: attachment.description ?? null,
    frames,
    unavailable: frames.length === 0,
  };
}

async function normalizeImage(bytes: Buffer): Promise<string | null> {
  try {
    const { base64 } = await normalizeImageForChat(bytes.toString("base64"));
    return base64;
  } catch {
    return null;
  }
}

/** How the mirrored text names an attachment the model cannot read. */
export function attachmentNote(message: Message): string | null {
  const names = [...message.attachments.values()].map((a) => a.name);
  if (names.length <= 1) return null;
  return `(attachments: ${names.join(", ")})`;
}
