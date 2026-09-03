import { describe, expect, it } from "vitest";

import { findMessageRefs, messageLink, stripRawMentions } from "./ids";

describe("findMessageRefs", () => {
  it("finds a snowflake citation and keeps it a string", () => {
    const refs = findMessageRefs("as I said in #1183478562359283712, it depends");
    expect(refs).toEqual(["1183478562359283712"]);
    // The whole reason ids are strings: this one does not survive a number.
    expect(Number(refs[0]).toString()).not.toBe(refs[0]);
  });

  it("de-duplicates and keeps first-appearance order", () => {
    expect(
      findMessageRefs("#1183478562359283712 then #1183478562359283713 then #1183478562359283712"),
    ).toEqual(["1183478562359283712", "1183478562359283713"]);
  });

  it("leaves a URL fragment and a word-shaped hashtag alone", () => {
    expect(findMessageRefs("see example.com/a#12 and #weekend")).toEqual([]);
  });

  it("ignores something too short to be a snowflake", () => {
    expect(findMessageRefs("#42")).toEqual([]);
  });
});

describe("messageLink", () => {
  it("builds a guild message URL", () => {
    expect(messageLink({ guildId: "111", channelId: "222", messageId: "333" })).toBe(
      "https://discord.com/channels/111/222/333",
    );
  });

  it("uses @me for a direct message, which has no guild", () => {
    expect(messageLink({ guildId: null, channelId: "222", messageId: "333" })).toBe(
      "https://discord.com/channels/@me/222/333",
    );
  });
});

describe("stripRawMentions", () => {
  it("removes a mention token the model invented, leaving the sentence", () => {
    expect(stripRawMentions("<@1183478562359283712> sure, that works")).toBe(
      "sure, that works",
    );
  });

  it("handles the nickname form and collapses the gap it leaves", () => {
    expect(stripRawMentions("hi <@!1183478562359283712> there")).toBe("hi there");
  });

  it("leaves ordinary text untouched", () => {
    expect(stripRawMentions("costs $5 <not a mention>")).toBe("costs $5 <not a mention>");
  });
});
