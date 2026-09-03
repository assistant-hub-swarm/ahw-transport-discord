import type { AddressingRule, Addressing, BotIdentity } from "@assistant-hub-swarm/transport-sdk";
import type { Message } from "discord.js";

/**
 * The STRUCTURAL half of addressing — whether the Discord wire shape alone
 * says a message targets this bot (a mention, a reply to one of its messages,
 * a DM). That is exactly why it lives in this transport: the verdict crosses
 * the contract, the wire format never does.
 *
 * The NAME half belongs to the core: people summon the ASSISTANT by its name,
 * which lives in the core's store and can be renamed there at any time, never
 * by the bot account's profile name. A channel message this check cannot
 * decide comes back `needsAnalyzer`, and the core runs its own name check
 * before the LLM analyzer.
 *
 * Discord makes this simpler than most platforms: a mention is a structured
 * `<@id>` token rather than a name to match, so there is no entity table to
 * read and no case folding to get wrong. A role mention that happens to
 * include the bot is deliberately NOT addressing — it targets a group of
 * people, and answering every `@everyone` would make the bot a nuisance.
 */

const NOT_ADDRESSED: Addressing = { addressed: false, needsAnalyzer: false };

/**
 * What each structural verdict says for itself, carried to the core and onto
 * the turn's trace. A message these checks address never reaches the LLM
 * analyzer, so there is no exchange to read afterwards — this sentence is the
 * whole account of why the bot answered, and it names the evidence rather
 * than the branch that fired.
 */
const REASONS = {
  direct: "a direct message — every message in it is for this bot",
  reply: "the sender replied to one of this bot's messages",
  mention: "the message mentions this bot",
  undecided: "nothing in the message structure names this bot — over to the name check",
} as const;

export const addressing: AddressingRule<Message> = (message, bot: BotIdentity): Addressing => {
  if (message.channel.isDMBased()) {
    return { addressed: true, source: "private", needsAnalyzer: false, reason: REASONS.direct };
  }
  if (!bot.id) return NOT_ADDRESSED;

  // `mentions.repliedUser` is only meaningful when this message replies.
  if (message.reference?.messageId && message.mentions.repliedUser?.id === bot.id) {
    return { addressed: true, source: "reply", needsAnalyzer: false, reason: REASONS.reply };
  }
  // `mentions.users` holds direct mentions only: a role ping or @everyone
  // targets a group of people, not this bot.
  if (message.mentions.users.has(bot.id)) {
    return { addressed: true, source: "mention", needsAnalyzer: false, reason: REASONS.mention };
  }
  if (message.content.trim()) {
    return { addressed: false, needsAnalyzer: true, reason: REASONS.undecided };
  }
  return NOT_ADDRESSED;
};
