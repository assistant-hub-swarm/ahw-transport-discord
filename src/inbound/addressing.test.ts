import type { BotIdentity } from "@assistant-hub-swarm/transport-sdk";
import type { Message } from "discord.js";
import { describe, expect, it } from "vitest";

import { addressing } from "./addressing";

/**
 * The structural verdict, on Discord's own wire shape. Only the handful of
 * fields the rule reads are built here — a whole discord.js `Message` is a
 * live object with a client behind it, and faking one would test the fake.
 */

const BOT_ID = "900000000000000001";
const bot: BotIdentity = {
  id: BOT_ID,
  identity: { botUsername: "helper", botDisplayName: "Helper" },
};

function message(input: {
  content?: string;
  direct?: boolean;
  mentions?: string[];
  repliesTo?: string | null;
  repliedAuthorId?: string | null;
}): Message {
  const mentioned = new Set(input.mentions ?? []);
  return {
    content: input.content ?? "",
    channel: { isDMBased: () => input.direct ?? false },
    reference: input.repliesTo ? { messageId: input.repliesTo } : null,
    mentions: {
      users: { has: (id: string) => mentioned.has(id) },
      repliedUser: input.repliedAuthorId ? { id: input.repliedAuthorId } : null,
    },
  } as unknown as Message;
}

describe("addressing", () => {
  it("addresses every direct message", () => {
    expect(addressing(message({ direct: true, content: "hey" }), bot)).toMatchObject({
      addressed: true,
      source: "private",
      needsAnalyzer: false,
    });
  });

  it("addresses a reply to one of this bot's messages", () => {
    const verdict = addressing(
      message({ content: "thanks", repliesTo: "5", repliedAuthorId: BOT_ID }),
      bot,
    );
    expect(verdict).toMatchObject({ addressed: true, source: "reply", needsAnalyzer: false });
  });

  it("does not address a reply to someone else", () => {
    const verdict = addressing(
      message({ content: "thanks", repliesTo: "5", repliedAuthorId: "900000000000000002" }),
      bot,
    );
    expect(verdict).toMatchObject({ addressed: false, needsAnalyzer: true });
  });

  it("addresses a direct mention", () => {
    expect(
      addressing(message({ content: `<@${BOT_ID}> hello`, mentions: [BOT_ID] }), bot),
    ).toMatchObject({ addressed: true, source: "mention", needsAnalyzer: false });
  });

  it("leaves an ordinary channel message to the name check", () => {
    expect(addressing(message({ content: "what do you all think?" }), bot)).toMatchObject({
      addressed: false,
      needsAnalyzer: true,
    });
  });

  it("does not send an empty channel message to the analyzer", () => {
    expect(addressing(message({ content: "   " }), bot)).toEqual({
      addressed: false,
      needsAnalyzer: false,
    });
  });

  it("refuses to guess when the bot has no identity yet", () => {
    expect(addressing(message({ content: "hi" }), { ...bot, id: "" })).toEqual({
      addressed: false,
      needsAnalyzer: false,
    });
  });
});
