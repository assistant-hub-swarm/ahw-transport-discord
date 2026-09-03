import { type Addressing } from "@assistant-hub-swarm/transport-sdk";

/**
 * The STRUCTURAL half of addressing — whether the Discord wire shape alone
 * says the message targets this bot (a mention, a reply to one of its
 * messages, a DM). That is exactly why it lives in this transport: the
 * verdict crosses the contract, the wire format never does.
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

/** Minimal identity the structural check needs (the bot ACCOUNT's). */
export interface BotAddressIdentity {
  /** The bot user's snowflake, verbatim. */
  id: string;
  /** The bot's username, for the literal-text fallback. */
  username: string;
}

/** What this transport sees of one message, with no discord.js types attached. */
export interface AddressableMessage {
  /** Message text (Discord has no separate caption). */
  content: string;
  /** Whether the channel is a DM. */
  direct: boolean;
  /** Snowflakes this message mentions directly — not via a role or @everyone. */
  mentionedUserIds: readonly string[];
  /** The author of the message this one replies to, when it replies at all. */
  replyToAuthorId: string | null;
}

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
  crossFedReply: "this assistant's own message was answered",
  crossFedMention: "the other assistant's message mentions this bot's username",
  undecided: "nothing in the message structure names this bot — over to the name check",
} as const;

/** Literal `@username` in the text — for the cross-fed case, which has no mention list. */
function textMentionsUsername(text: string, username: string): boolean {
  const user = username.toLowerCase();
  return user.length > 0 && text.toLowerCase().includes(`@${user}`);
}

/**
 * Decide as much as the wire shape can; a channel message that carries text
 * but targets nothing structurally comes back `needsAnalyzer` — the core runs
 * the name check (against the assistant's name) and, behind it, the LLM
 * analyzer. `transcript` is the spoken text of a voice message.
 */
export function checkAddressed(
  message: AddressableMessage,
  bot: BotAddressIdentity,
  transcript?: string,
): Addressing {
  if (message.direct) {
    return { addressed: true, source: "private", needsAnalyzer: false, reason: REASONS.direct };
  }
  if (!bot.id) return NOT_ADDRESSED;

  if (message.replyToAuthorId != null && message.replyToAuthorId === bot.id) {
    return { addressed: true, source: "reply", needsAnalyzer: false, reason: REASONS.reply };
  }
  if (message.mentionedUserIds.includes(bot.id)) {
    return { addressed: true, source: "mention", needsAnalyzer: false, reason: REASONS.mention };
  }

  const text = message.content || transcript?.trim() || "";
  if (text.trim()) {
    return { addressed: false, needsAnalyzer: true, reason: REASONS.undecided };
  }
  return NOT_ADDRESSED;
}

/**
 * The same structural verdict for a message the cross-feed hands to another
 * assistant. It never came off the gateway for THIS bot, so there is no
 * mention list to read: what remains is whether the author answered one of
 * this assistant's own messages, and whether the text spells its username.
 * Everything else is undecided — the core runs the name check against the
 * assistant's name and, behind it, the analyzer.
 */
export function checkCrossFedAddressed(input: {
  /** The authoring assistant's delivered text. */
  text: string;
  /** The receiving connection's username. */
  botUsername: string;
  /** True when the author replied to a message this assistant wrote. */
  repliesToOwnMessage: boolean;
}): Addressing {
  if (input.repliesToOwnMessage) {
    return {
      addressed: true,
      source: "reply",
      needsAnalyzer: false,
      reason: REASONS.crossFedReply,
    };
  }
  if (input.botUsername && textMentionsUsername(input.text, input.botUsername)) {
    return {
      addressed: true,
      source: "mention",
      needsAnalyzer: false,
      reason: REASONS.crossFedMention,
    };
  }
  if (input.text.trim()) {
    return { addressed: false, needsAnalyzer: true, reason: REASONS.undecided };
  }
  return NOT_ADDRESSED;
}
