/**
 * durable-intent.ts — vocabulary and classifier for durable save intents.
 *
 * Extracted from packages/cli/src/index.ts SAVE_PATTERNS so the single-arbiter
 * (saveTriggerKind) can be used by both the hook-save hook AND the
 * cross-surface capture-path two-lane router, without duplicating patterns.
 *
 * Design notes:
 *  - "explicit-save" requires a CLEAR, unhedged save directive (English + CJK).
 *  - Hedged / task-reminder phrasings ("remind me to save", "maybe remember",
 *    "I should probably save") are DEMOTED to 'none' — they express uncertainty
 *    or scheduling intent, not a committed save order. This is the hedge-demotion
 *    rule: precision over recall for the save lane.
 *  - "correction-signal" is assigned when the text carries a correction marker
 *    (from CORRECTION_PATTERNS) regardless of whether a save intent is present.
 *  - A text that matches both save-intent AND correction-intent routes as
 *    'explicit-save' (save lane wins; the correction payload is captured locally
 *    rather than pushed through the full correction pipeline again).
 *
 * LOCAL-ONLY module: no Supabase imports, no journal-write imports. Must stay that way.
 */

// ---------------------------------------------------------------------------
// DURABLE_INTENT_PATTERNS — the canonical EN + CJK save-intent vocabulary
// ---------------------------------------------------------------------------

/**
 * Patterns that signal a clear, committed save directive.
 * All patterns must be robust to minor phrasing variation.
 *
 * Hedge-demotion: a hedging opener before the save phrase moves the intent out
 * of this list — see HEDGE_DEMOTE_PATTERN applied in saveTriggerKind().
 */
export const DURABLE_INTENT_PATTERNS: ReadonlyArray<RegExp> = [
  // English — explicit save commands
  /\bsave\s+(?:the\s+|this\s+)?session\b/i,
  /\bsave\s+this\b/i,
  /\bretain\s+this\b/i,
  /\bcheckpoint\b/i,
  /\bdon'?t\s+forget\s+this\b/i,
  /\bkeep\s+a\s+note\b/i,
  /\bwrite\s+(?:this\s+)?down\b/i,
  /\bremember\s+(?:this|that|what we did)\b/i,
  /\bbookmark\s+this\b/i,
  /\blog\s+this\b/i,
  // CJK — explicit save commands
  /保存|记录一下|存档|别忘了|记住这个|写下来/,
];

/**
 * Hedge / scheduling openers that DEMOTE an otherwise-matching save phrase to 'none'.
 * "remind me to save", "maybe remember this", "I should probably save later",
 * "I will eventually checkpoint" are scheduling intents, not committed save orders.
 *
 * Anchored at ^ to catch the OPENER only — a hedged sentence followed by an
 * unhedged save directive is NOT demoted ("Actually wait, save this." stays 'explicit-save'
 * because the split-sentence logic of the caller would see "save this" in fragment 2).
 * This function tests the WHOLE text, so we rely on hedging being in the first clause.
 */
const HEDGE_DEMOTE_PATTERN =
  /^[\s\S]{0,60}?\b(remind\s+me\s+to|maybe\s+(?:remember|save|checkpoint|log)\b|perhaps\s+(?:remember|save|log)\b|i\s+should\s+(?:probably\s+)?(?:save|remember|checkpoint|log)\b|i\s+might\s+want\s+to\s+(?:save|remember|log)\b|we\s+(?:should|might|could)\s+(?:probably\s+)?(?:save|checkpoint|remember|log)\b|don'?t\s+forget\s+to\b|note\s+to\s+self\b|(?:i|you|one)\s+could\s+(?:save|remember|log|checkpoint)\b|you\s+might\s+want\s+to\s+(?:save|remember|log)\b)/i;

/**
 * Correction-signal vocabulary — behavioral corrections from check.ts / hook-correction.
 * Kept in sync with the CORRECTION_PATTERNS in packages/cli/src/index.ts:969-993.
 * These are the patterns that indicate the user is correcting the agent's behaviour.
 */
const CORRECTION_SIGNAL_PATTERNS: ReadonlyArray<RegExp> = [
  // English patterns
  /\bthat'?s\s+wrong\b/i,
  /\byou\s+(missed|didn'?t|forgot|skipped)\b/i,
  /\bnot\s+what\s+i\s+(asked|wanted|meant|said)\b/i,
  /\bagain\s+you\b/i,
  /\bstop\s+(doing|adding|making)\b/i,
  /\bwrong\s+(approach|direction|file|function)\b/i,
  /\bi\s+said\b.*\bnot\b/i,
  /\bdon'?t\s+(do\s+that|change|delete|add)\b/i,
  /\bno[,!.]\s+(don'?t|that|you|i\s+meant)\b/i,
  // Chinese patterns
  /不对/,
  /错了/,
  /不要这样/,
  /不是这个/,
  /你搞错了/,
  /我说的不是/,
  /别这样做/,
  /重新来/,
  /你忘了/,
  /不是我要的/,
  /搞反了/,
  /方向不对/,
];

// ---------------------------------------------------------------------------
// saveTriggerKind — single arbiter for the two-lane router
// ---------------------------------------------------------------------------

/**
 * Classify a user message as one of three intent kinds:
 *
 *   'explicit-save'      — clear, unhedged save directive → LANE 1 (local archive)
 *   'correction-signal'  — behavioral correction marker → LANE 2 (corrections.ts)
 *   'none'               — neither; skip capture entirely
 *
 * Hedge-demotion rule: if the text matches a save intent BUT also matches the
 * HEDGE_DEMOTE_PATTERN (e.g. "remind me to save", "maybe remember this",
 * "I should probably save"), the intent is demoted from 'explicit-save' to 'none'
 * (or 'correction-signal' if the correction check also fires). Hedged phrases
 * express scheduling intent, not a committed save order.
 *
 * Arbiter precedence:
 *   1. Test for save intent (DURABLE_INTENT_PATTERNS) — if matched AND not hedged → 'explicit-save'
 *   2. Test for correction signal (CORRECTION_SIGNAL_PATTERNS) → 'correction-signal'
 *   3. Neither → 'none'
 */
export function saveTriggerKind(text: string): "explicit-save" | "correction-signal" | "none" {
  const t = (typeof text === "string" ? text : "").trim();
  if (!t) return "none";

  const hasSaveIntent = DURABLE_INTENT_PATTERNS.some((p) => p.test(t));
  const isHedged = HEDGE_DEMOTE_PATTERN.test(t);
  if (hasSaveIntent && !isHedged) {
    return "explicit-save";
  }

  const hasCorrectionSignal = CORRECTION_SIGNAL_PATTERNS.some((p) => p.test(t));
  if (hasCorrectionSignal) {
    return "correction-signal";
  }

  return "none";
}
