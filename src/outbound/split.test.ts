import { describe, expect, it } from "vitest";

import { MAX_MESSAGE_LENGTH } from "../discord/ids";
import { splitMessage } from "./split";

describe("splitMessage", () => {
  it("returns short text as a single chunk, and empty text as none", () => {
    expect(splitMessage("  hello  ")).toEqual(["hello"]);
    expect(splitMessage("   ")).toEqual([]);
  });

  it("splits at a paragraph boundary and loses no content", () => {
    const a = "a".repeat(1500);
    const b = "b".repeat(1500);
    expect(splitMessage(`${a}\n\n${b}`)).toEqual([a, b]);
  });

  it("falls back to a sentence boundary when there are no line breaks", () => {
    const sentence = "This is a fairly ordinary sentence about nothing much. ";
    const text = sentence.repeat(100).trim(); // ~5.5k chars, no newlines
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
      expect(chunk.length).toBeGreaterThan(0);
    }
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.endsWith(".")).toBe(true);
    }
  });

  it("hard-cuts text with no boundary at all rather than refusing it", () => {
    const wall = "x".repeat(MAX_MESSAGE_LENGTH * 2 + 50);
    const chunks = splitMessage(wall);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    }
    expect(chunks.join("").length).toBe(wall.length);
  });

  it("keeps every character of the original, in order", () => {
    const paragraphs = Array.from(
      { length: 12 },
      (_, i) => `Paragraph ${i}. ${"word ".repeat(60).trim()}`,
    ).join("\n\n");
    const chunks = splitMessage(paragraphs);
    expect(chunks.length).toBeGreaterThan(1);
    // Whitespace at the seams is trimmed; nothing else may be lost.
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(paragraphs.replace(/\s+/g, " "));
  });

  it("cuts at Discord's cap, which is far below Telegram's", () => {
    // Worth pinning: the same helper on the other transport allows 4096, and
    // a copied constant would silently make every long reply fail to send.
    expect(MAX_MESSAGE_LENGTH).toBe(2000);
  });
});
