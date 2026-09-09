/**
 * correction-detector.ts
 *
 * Shared pattern-matching logic for the hook-correction and hook-ambient
 * commands. Exported so it can be unit-tested without spawning the CLI process.
 *
 * TWO-GATE DESIGN (+ one narrow bypass)
 * ──────────────
 * A prompt is captured when BOTH gates fire:
 *   • CORRECTION gate: text contradicts or negates something the agent did
 *   • BEHAVIORAL gate: text implies a durable rule, not a one-time task redirect
 * — OR when the THIRD, independent GATED_PROHIBITION_PATTERNS bypass fires
 *   (TOW2-326, see that list's own doc comment below): a narrow, structurally
 *   self-sufficient class of CONDITIONAL prohibition ("never do X without Y
 *   confirming first") that is a durable policy statement on its own, with no
 *   CORRECTION_PATTERNS partner required or possible (see the SCOPE NOTE
 *   above CORRECTION_PATTERNS for why that gate's contract cannot stretch to
 *   cover bare prohibitions in general).
 *
 * INVARIANT (C1 review, 2026-07-03): a pattern must live in exactly ONE gate.
 * If the same phrase fires both gates, the two-gate design filters nothing for
 * that phrase and it self-captures — measured 10/13 FP on realistic daily
 * traffic (scheduling reminders, research prose, encouragement). When a signal
 * is genuinely both corrective and durable, narrow it with context (accusatory
 * frame, format-domain scope) so the generic uses stay out.
 *
 * C1 FIX (2026-07-02, revised 2026-07-03): root causes of 11/17 durable misses:
 *   RC1 — Behavioral gate was too strict: required explicit frequency language
 *          ("again", "every time", "you always"). Durable rules stated ONCE as
 *          absolute commands were killed by the behavioral gate. Added signals
 *          for single-occurrence rule forms.
 *   RC2 — Correction patterns missed indirect phrasing: "you actually did
 *          not", "there is no X" (feature denial), "I should have",
 *          "this is not a website".
 * Known regex-hard misses (accepted): pure positive instructions (E10),
 * autonomy grants (E41), bare one-off preference redirects (E57 — lost when
 * "i don't want you to" was scoped to a single gate; see test file).
 */

export interface DetectionResult {
  /**
   * True when (the correction gate AND the behavioral gate both fire) OR the
   * GATED_PROHIBITION_PATTERNS bypass fires (TOW2-326) — and prompt is
   * non-trivial (length > 3).
   */
  captured: boolean;
  /** String form of the correction pattern that fired, or null */
  correctionHit: string | null;
  /** String form of the behavioral pattern that fired, or null */
  behavioralHit: string | null;
  /** String form of the GATED_PROHIBITION_PATTERNS bypass entry that fired (TOW2-326), or null */
  policyHit: string | null;
}

/**
 * Patterns that indicate the user is negating or correcting an agent output.
 * Necessary but not sufficient — a behavioral signal must also fire to
 * distinguish durable rules from one-time task redirects.
 *
 * SCOPE NOTE (2026-07-25, Codex audit follow-up): this gate's contract is
 * "the agent's output/action was wrong," not "here is a standing rule." A
 * pure forward-looking prohibition with no reference to something already
 * done — e.g. "不要在未经用户确认的情况下发布代码" ("do not publish code
 * without user confirmation first") — is prescriptive, not corrective: it
 * does not describe an agent output being negated, so it deliberately has
 * NO entry here. The nearest existing precedent, the "don't do that" /
 * "do not do that" family below, only qualifies because "that" is
 * anaphoric — it refers to a specific thing already said or done in
 * context. Generalizing this gate to fire on any bare prohibition would
 * mean treating "rule/policy statement" as synonymous with "correction of a
 * past action," which is not what this gate means; it would also reopen the
 * exact self-capture failure mode the two-gate INVARIANT above exists to
 * prevent (a prohibition is exactly the kind of phrase that also tends to
 * satisfy BEHAVIORAL_SIGNALS). Such prompts are still intentionally
 * uncapturable via this gate — see BEHAVIORAL_SIGNALS below for the CJK
 * absolute-prohibition additions that DO apply to them, and
 * correction-detector's own tests for what that leaves captured vs. not.
 */
export const CORRECTION_PATTERNS: readonly RegExp[] = [
  // ── Original patterns ────────────────────────────────────────────────────
  /\bthat'?s\s+wrong\b/i,
  /\byou\s+(missed|didn'?t|forgot|skipped)\b/i,
  /\bnot\s+what\s+i\s+(asked|wanted|meant|said)\b/i,
  /\bagain\s+you\b/i,
  /\bstop\s+(doing|adding|making)\b/i,
  /\bwrong\s+(approach|direction|file|function)\b/i,
  /\bi\s+said\b.*\bnot\b/i,
  /\bdon'?t\s+(do\s+that|change|delete|add)\b/i,
  /\bno[,!.]\s+(don'?t|that|you|i\s+meant)\b/i,
  // Chinese — original
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

  // ── C1 additions: indirect phrasing missed by original set ──────────────
  // "there is no X" / "there's no X" — denial of a claimed feature (E11)
  /\bthere('?s|\s+is)\s+no\b/i,
  // "you actually did not apply" / "you did not do" (E28)
  /\byou\s+(?:actually\s+)?did\s+not\b/i,
  // "do not do that" — split form; "don't do that" was already covered (E28)
  /\bdo\s+not\s+do\s+that\b/i,
  // "I don't want you to open it" — preference redirect (E57-class).
  // CORRECTION gate ONLY (C1-rev): encouragement/scoping uses ("I don't want
  // you to rush/worry/spend too long") must not self-capture; a behavioral
  // signal must fire independently for this to persist.
  /\bi\s+don'?t\s+want\s+you\s+to\b/i,
  // "this is not a website" / "this is only in the flyer" — format-domain
  // constraint (E26). Scoped to output-medium nouns (C1-rev): the generic
  // "this is only a draft/suggestion" must not fire.
  /\bthis\s+is\s+(?:not\s+a\s+web\s?(?:site|page)|only\s+(?:a\s+|in\s+(?:the\s+|a\s+)?)?(?:flyer|poster|print|document|pdf))\b/i,
  // "there's nothing like this" — feature denial companion (E11)
  /\bnothing\s+like\s+this\b/i,
  // "pipeline/interface/code wrong" (E56)
  /\b(?:pipeline|interface|code)\s+wrong\b|\bwrong\b.*\b(?:pipeline|interface)\b/i,
  // "not really good" / "not good" — quality negation (E12)
  /\bnot\s+(?:really\s+)?good\b/i,
  // "I should have flagged" / "you should have used" — regret/correction
  // frame (E22). Person-scoped (C1-rev): bare "should have" fires on spec
  // language ("each endpoint should have validation").
  /\b(?:i|you)\s+should\s+have\b/i,
  // "you submit everything in 1 PR" — implied wrong action (E47)
  /\byou\s+submit(?:ted)?\s+(?:all|everything)\b/i,
];

/**
 * Patterns that indicate the correction encodes a reusable rule, not a
 * one-time task redirect. Both a correction AND a behavioral signal must fire
 * for the prompt to be stored in the alignment log.
 */
export const BEHAVIORAL_SIGNALS: readonly RegExp[] = [
  // ── Original signals ─────────────────────────────────────────────────────
  /\bagain\b/i,               // "you did it again"
  /\bkeep\s+\w+ing\b/i,       // "you keep doing..."
  /\balways\b/i,               // "you always add..."
  /\bevery\s+time\b/i,         // "every time you..."
  /\byou\s+still\b/i,          // "you still..."
  /\bhow\s+many\s+times\b/i,
  /\bi\s+told\s+you\b/i,       // "I told you already"
  /\bnever\s+do\b/i,            // "never do this" = rule
  /\bdon'?t\s+ever\b/i,
  /\btend\s+to\b/i,             // "you tend to..."
  /\bthis\s+is\s+a\s+(?:rule|pattern)\b/i,
  /\bremember\s+(?:this\s+rule|for\s+next\s+time)\b/i,
  // Chinese frequency / behavioral — original
  /你总是/, /每次/, /又来了/, /反复/, /多少次/, /你老是/, /一直都/, /还是在做/,

  // ── C1 additions: single-occurrence rule forms that imply durability ─────
  // "please remember" — forward-facing durability marker (E26).
  // BEHAVIORAL gate ONLY (C1-rev): scheduling reminders ("please remember
  // standup is at 9:30") must not self-capture; a correction signal must
  // fire independently.
  /\bplease\s+remember\b/i,
  // "you need to learn more" — explicit learning correction (E12)
  /\bneed\s+to\s+learn\b/i,
  // "please do it for every page" — scope-of-always rule (E28)
  /\bfor\s+every\b/i,
  // "everytime" — typo form without space (E56)
  /\beverytime\b/i,
  // "not every time I give feedback and you change" — pattern negation (E12)
  /\bnot\s+every(?:\s+time|time)\b/i,
  // "instead of defaulting to sparse" — names a behavioral pattern (E22)
  /\bdefaulting\s+to\b/i,
  // "one project per PR" — unit rule ("one X per Y") (E47)
  /\bone\s+\w+\s+per\s+\w+\b/i,
  // "don't make mistakes for customers" — quality rule (E35)
  /\bdon'?t\s+make\s+mistakes\b/i,
  // Hallucination ACCUSATION — durable lesson "never invent features" (E11).
  // Accusatory frame required (C1-rev): technical prose that merely mentions
  // the word ("hallucination rate dropped to 3%") must not fire.
  /\b(?:is\s+this|that'?s|another)\s+(?:a\s+)?hallucination\b/i,

  // ── CJK addition (2026-07-25, Codex audit gap): absolute prohibition ────
  // markers, the Chinese semantic equivalent of the existing "never do" /
  // "don't ever" signals above — a single-occurrence forward-looking
  // prohibition is a durable rule even with no frequency language attached.
  // Placed in BEHAVIORAL (not CORRECTION_PATTERNS): these say what must not
  // happen going forward, they do not describe something the agent already
  // did wrong, so they carry no correction-gate semantics of their own — see
  // the note above CORRECTION_PATTERNS for why that gate's contract does not
  // stretch to cover them.
  //
  // 禁止 ("prohibited") — formal register, essentially never used for
  // anything except a standing ban; left unscoped.
  /禁止/,
  // 不得 ("must not", contract/policy register) — excludes 不得不 ("have no
  // choice but to" / "can't help but"), a common idiom with the OPPOSITE
  // meaning (compulsion, not prohibition). Residual known miss: 不得 also
  // appears inside 迫不得已 ("forced into it") without a trailing 不, so that
  // idiom is not excluded — accepted, low-traffic edge case (mirrors the
  // file's existing "known regex-hard misses" acceptance above).
  /不得(?!不)/,
  // 不能 ("cannot" / "must not") — person-scoped to "你不能" (C1-rev style,
  // matches the "should have" narrowing above): bare 不能 is routinely used
  // for plain capability/limitation statements about code or systems, not
  // the agent's behavior — "这个不能这样跑，报错了" (this doesn't run this
  // way, it errored) is an ordinary bug report, and its "报错了" ALSO
  // contains the existing CORRECTION_PATTERNS substring "错了" (报-错了),
  // so bare 不能 would have self-captured plain bug reports through the
  // AND gate (found empirically while building this fix's negative
  // fixtures — see cjk-prohibition-signals.test.mjs N12). Scoping to
  // second-person "你不能" keeps this to direct address ("you must not..."),
  // matching the durable-rule reading, while excluding 你不能不 (rare
  // double-negative idiom = "must", opposite polarity).
  /你不能(?!不)/,
  // 不要 ("don't / do not") — the audit's target verb, and also the single
  // most common Chinese way to phrase reassurance/encouragement, NOT a rule:
  // 不要担心 (don't worry), 不要客气 (don't be so polite/you're welcome),
  // 不要急 / 不要着急 (don't rush, relax), 不要紧张 (don't be nervous), 不要
  // 见外 (don't be so formal). Narrowed with a negative lookahead over this
  // closed set of benign completions so ordinary encouragement does not
  // fire — mirrors the person-scoping / accusatory-frame narrowing pattern
  // used elsewhere in this file (see "should have", "hallucination" above).
  // The audit string "不要在未经用户确认的情况下发布代码" has none of these
  // completions immediately after 不要 and still matches.
  /不要(?!担心|客气|急|着急|紧张|见外)/,
];

/**
 * GATED_PROHIBITION_PATTERNS — TOW2-326 third bypass path.
 *
 * The two-gate AND (CORRECTION_PATTERNS ∩ BEHAVIORAL_SIGNALS) cannot capture
 * a bare forward-looking prohibition like "不要在未经用户确认的情况下发布代码"
 * ("do not publish code without first getting user confirmation") — see the
 * SCOPE NOTE above CORRECTION_PATTERNS: that gate's contract is "the agent's
 * output/action was wrong," and a bare prohibition has NO CORRECTION_PATTERNS
 * partner there BY DESIGN (adding one would reopen the exact self-capture
 * failure mode the two-gate INVARIANT at the top of this file exists to
 * prevent — a prohibition is exactly the kind of phrase that also tends to
 * satisfy BEHAVIORAL_SIGNALS, so an unconditioned "any prohibition passes"
 * rule would defeat the AND gate for that whole phrase class).
 *
 * What makes THIS narrow class of prohibition safe to capture on its own,
 * with no independent CORRECTION_PATTERNS partner, is its CONDITIONAL shape:
 * "never/don't <do X> WITHOUT <a confirmation event happening first>" /
 * "不要/禁止/不得/不能 ... 未经/没有/经过 ... 确认/同意/许可/批准/审核 ...". The
 * condition clause is what separates a durable POLICY statement from a bare
 * one-off redirect — e.g. "这个功能不要做了，先做另一个" ("don't do this
 * feature anymore, do the other one first") has no condition clause and
 * correctly stays uncaptured (see cjk-prohibition-signals.test.mjs N09);
 * "不要在未经用户确认的情况下发布代码" has one, and is exactly the shape a
 * "don't push/merge/deploy without approval" house rule takes in either
 * language. Ordinary encouragement ("不要担心"/"don't worry") and one-time
 * redirects never carry a "without X first" clause, so this bypass does not
 * reopen the self-capture risk the SCOPE NOTE above warns about.
 *
 * English + CJK rows in ONE table (class-not-instance, not a CJK-only special
 * case) so a mixed-language prompt ("不要在没有 approval 的情况下 merge") still
 * matches via the CJK skeleton with an English confirmation noun.
 *
 * This is a THIRD, INDEPENDENT capture path — `captured` is true when this
 * list fires, regardless of whether CORRECTION_PATTERNS/BEHAVIORAL_SIGNALS
 * also fire. The existing two-gate AND is completely unchanged for every
 * other phrase; see detectCorrection() below.
 *
 * INDEPENDENT-REVIEW FIX (2026-09-09): pure surface-token matching over a
 * generous character gap let ordinary reassurance sentences slip through —
 * e.g. "不要担心，我还没有收到你的确认邮件" ("don't worry, I still haven't
 * received your confirmation email") matches the CJK skeleton on paper (不要
 * ... 没有 ... 确认 all present), but is not a policy statement at all; same
 * for "Don't worry, we can merge without further approval since legal already
 * signed off" in English. BEHAVIORAL_SIGNALS already solved this exact problem
 * for its own 不要 entry with a closed-list negative lookahead over common
 * benign completions (担心/客气/急/着急/紧张/见外) — this bypass had NOT
 * reused that guard, reopening the self-capture risk the SCOPE NOTE above
 * warns about. Fixed by applying the SAME exclusion to the opener in both
 * rows (English: worry/hesitate/mind/sweat/fret — the closest English
 * equivalents of that closed reassurance set).
 *
 * ROUND-2 INDEPENDENT-REVIEW FIX (2026-09-09): the closed exclusion list is
 * NOT exhaustive by construction (an open-ended reassurance vocabulary can
 * never be fully enumerated) — new openers outside the first list (慌/害怕/
 * 在意 CJK; stress/panic English) reproduced the same false-positive class.
 * Widened both lists AND added defense-in-depth on the CJK 没有 branch:
 * excluding 没有(?!收到|接到) targets the SPECIFIC personal-status framing
 * ("我没有收到/接到你的X") that keeps colliding with the confirmation-noun
 * check, independent of which reassurance word opened the sentence — this
 * does not claim to close the class exhaustively (accepted residual risk,
 * same "known regex-hard miss, accepted" posture as 不得不/不能不 elsewhere
 * in this file), but meaningfully narrows it beyond opener-enumeration alone.
 */
export const GATED_PROHIBITION_PATTERNS: readonly RegExp[] = [
  // English: "never/don't/do not/must not/should not <verb...> without <confirmation-noun>"
  // — excluding a closed set of benign-reassurance completions (worry/
  // hesitate/mind/sweat it/fret/stress/panic) so "don't worry/stress/panic,
  // ... without approval" (encouragement, not policy) does not fire.
  /\b(?:never|don'?t|do\s+not|must\s+not|should\s+not)\b(?!\s+(?:worry|hesitate|mind|sweat|fret|stress|panic))[^.!?\n]{0,40}\bwithout\b[^.!?\n]{0,40}\b(?:confirm\w*|approval|permission|sign[- ]?off|review\w*|asking)\b/i,
  // CJK skeleton: (不要|禁止|不得|不能|永远不要|绝不) ... (未经|没有|经过) ... (确认|同意|许可|批准|审核 or an English confirmation noun, for mixed prompts)
  // — 不要 excludes a widened benign-completion set (BEHAVIORAL_SIGNALS'
  // original 担心/客气/急/着急/紧张/见外 plus 慌/害怕/在意), so "不要担心/
  // 不要慌/不要害怕/不要在意" openers never reach the confirmation-noun
  // check at all. 没有 additionally excludes 收到/接到 (received/gotten) —
  // the personal-status framing ("我没有收到你的确认") that reads as "I
  // haven't gotten X yet," not "the policy waives X" — kept separate from
  // 未经/经过, which are formal/literary markers with no such collision risk.
  // 不能 scoped to second-person 你不能, NOT bare 不能 — mirrors
  // BEHAVIORAL_SIGNALS' own /你不能(?!不)/ entry above (and its documented
  // reasoning): bare 不能 collides with plain capability/bug-report
  // statements ("系统现在不能在没有审核权限的情况下显示这个按钮" — a bug
  // report, not a policy), and this bypass's confirmation-noun clause
  // (未经/没有...确认/审核/...) makes that exact collision common in
  // practice — a bug report about permission-gated UI reads almost
  // identically to a permission-gated POLICY. Found via independent review.
  /(?:不要(?!担心|客气|急|着急|紧张|见外|慌|害怕|在意)|禁止|不得(?!不)|你不能(?!不)|永远不要|绝不)[^。！？\n]{0,20}(?:未经|没有(?!收到|接到)|经过)[^。！？\n]{0,20}(?:确认|同意|许可|批准|审核|approval|confirm\w*)[^。！？\n]{0,10}/i,
];

/**
 * Determine whether a user prompt should be captured as a behavioral correction.
 *
 * Note: `correctionHit`/`behavioralHit` are reported even for prompts of
 * length ≤ 3 (hook-ambient uses the correction gate alone as a feedback
 * signal, e.g. a bare "不对" reply); only `captured` enforces the length floor.
 *
 * @param prompt The raw user message text.
 * @returns DetectionResult with `captured=true` when both gates fire.
 */
export function detectCorrection(prompt: string): DetectionResult {
  if (!prompt) {
    return { captured: false, correctionHit: null, behavioralHit: null, policyHit: null };
  }

  const corrPat = CORRECTION_PATTERNS.find((p) => p.test(prompt));
  const behPat = BEHAVIORAL_SIGNALS.find((p) => p.test(prompt));
  const policyPat = GATED_PROHIBITION_PATTERNS.find((p) => p.test(prompt));

  const twoGateFires = corrPat !== undefined && behPat !== undefined;

  return {
    // TOW2-326: the two-gate AND OR the independent policy-prohibition bypass.
    captured: (twoGateFires || policyPat !== undefined) && prompt.length > 3,
    correctionHit: corrPat ? corrPat.toString() : null,
    behavioralHit: behPat ? behPat.toString() : null,
    policyHit: policyPat ? policyPat.toString() : null,
  };
}
