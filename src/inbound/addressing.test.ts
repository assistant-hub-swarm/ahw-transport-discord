import { describe, expect, it } from "vitest";

import { checkAddressed, checkCrossFedAddressed, type AddressableMessage } from "./addressing";

const BOT = { id: "900000000000000001", username: "helper" };
const SOMEONE = "100000000000000002";

function message(overrides: Partial<AddressableMessage> = {}): AddressableMessage {
  return {
    content: "hello there",
    direct: false,
    mentionedUserIds: [],
    replyToAuthorId: null,
    ...overrides,
  };
}

describe("checkAddressed", () => {
  it("addresses every direct message, whatever it says", () => {
    const verdict = checkAddressed(message({ direct: true, content: "" }), BOT);
    expect(verdict).toMatchObject({ addressed: true, source: "private", needsAnalyzer: false });
    expect(verdict.reason).toBeTruthy();
  });

  it("addresses a reply to one of this bot's own messages", () => {
    expect(checkAddressed(message({ replyToAuthorId: BOT.id }), BOT)).toMatchObject({
      addressed: true,
      source: "reply",
      needsAnalyzer: false,
    });
  });

  it("does not address a reply to somebody else", () => {
    expect(checkAddressed(message({ replyToAuthorId: SOMEONE }), BOT)).toMatchObject({
      addressed: false,
      needsAnalyzer: true,
    });
  });

  it("addresses a direct mention of this bot", () => {
    expect(checkAddressed(message({ mentionedUserIds: [BOT.id] }), BOT)).toMatchObject({
      addressed: true,
      source: "mention",
      needsAnalyzer: false,
    });
  });

  it("ignores a mention of somebody else in the same message", () => {
    expect(checkAddressed(message({ mentionedUserIds: [SOMEONE] }), BOT)).toMatchObject({
      addressed: false,
      needsAnalyzer: true,
    });
  });

  it("hands an undecided channel message to the analyzer, with a reason", () => {
    const verdict = checkAddressed(message({ content: "does anyone know?" }), BOT);
    expect(verdict).toMatchObject({ addressed: false, needsAnalyzer: true });
    expect(verdict.reason).toContain("name check");
  });

  it("decides nothing about an empty channel message", () => {
    expect(checkAddressed(message({ content: "" }), BOT)).toEqual({
      addressed: false,
      needsAnalyzer: false,
    });
  });

  it("reads a voice transcript as the text when the message carries none", () => {
    expect(checkAddressed(message({ content: "" }), BOT, "  spoken words  ")).toMatchObject({
      addressed: false,
      needsAnalyzer: true,
    });
  });

  it("says why, in words that name the evidence rather than the branch", () => {
    const reasons = [
      checkAddressed(message({ direct: true }), BOT).reason,
      checkAddressed(message({ replyToAuthorId: BOT.id }), BOT).reason,
      checkAddressed(message({ mentionedUserIds: [BOT.id] }), BOT).reason,
    ];
    for (const reason of reasons) {
      expect(reason).toBeTruthy();
      // A verdict that addresses never reaches the analyzer, so this sentence
      // is the whole account of why the bot answered.
      expect(reason!.length).toBeGreaterThan(20);
    }
  });
});

describe("checkCrossFedAddressed", () => {
  it("addresses the assistant whose own message was answered", () => {
    expect(
      checkCrossFedAddressed({
        text: "thanks!",
        botUsername: "helper",
        repliesToOwnMessage: true,
      }),
    ).toMatchObject({ addressed: true, source: "reply" });
  });

  it("addresses a literal @username, which is all a cross-fed message carries", () => {
    expect(
      checkCrossFedAddressed({
        text: "@Helper what do you think?",
        botUsername: "helper",
        repliesToOwnMessage: false,
      }),
    ).toMatchObject({ addressed: true, source: "mention" });
  });

  it("leaves anything else to the core", () => {
    expect(
      checkCrossFedAddressed({
        text: "some unrelated chatter",
        botUsername: "helper",
        repliesToOwnMessage: false,
      }),
    ).toMatchObject({ addressed: false, needsAnalyzer: true });
  });
});
