/**
 * check_action — pre-action proactive matcher.
 *
 * Solves items 3 + 5 of the feedback brief:
 *   - "watch_for is too generic" — needs to fire when the agent is about to do
 *     something a past correction warned against, mid-session.
 *   - "no mid-session recall hook" — insights surface at startup and are
 *     forgotten by turn 20.
 *
 * Both pains share the same primitive: "before doing X, return matching
 * rules / corrections / insights." This tool is that primitive.
 *
 * Deterministic keyword matching only (no LLM). The agent calls this before
 * any non-trivial action; the result is a short list of relevant memory items
 * that would otherwise have to be re-derived.
 */

import { resolveProject } from "../storage/project.js";
import { readActiveCorrections, recordOutcome, readOutcomesForToday, type CorrectionRecord, type FailureClass } from "./../storage/corrections.js";
import { readBehaviorPolicies, type BehaviorRule } from "../storage/behavior-policies.js";
import { readAwarenessState } from "../palace/awareness.js";
import { tokenize as sharedTokenize } from "../helpers/tokenize.js";

export interface CheckActionInput {
  /** What you're about to do — one sentence. Be specific. */
  action_description: string;
  project?: string;
  /** Match threshold — minimum overlapping tokens to count as a hit. Default 1. */
  min_overlap?: number;
}

export interface InsightMatch {
  title: string;
  confirmations: number;
  severity: string;
  matched_tokens: string[];
}

export interface CorrectionMatch {
  id: string;
  rule: string;
  severity: "p0" | "p1";
  date: string;
  matched_tokens: string[];
}

export interface RuleMatch {
  id: string;
  name: string;
  when: string;
  do: string;
  matched_tokens: string[];
}

export interface CheckActionResult {
  success: boolean;
  project: string;
  action: string;
  matching_rules: RuleMatch[];
  matching_corrections: CorrectionMatch[];
  matching_insights: InsightMatch[];
  /** Ready-to-paste warning string for the agent to read before acting. */
  warning: string | null;
  /**
   * Wave 5 — corrections are ground truth that can OVERRIDE a plan. `blocked`
   * fires ONLY when a matched correction is authoritative (`authoritative!==false`),
   * P0, and NOT a noise-candidate (`precision<0.3 && retrieved>=3`) — otherwise
   * stale/low-signal P0s would veto legitimate plans. Default `advisory`.
   */
  verdict: "advisory" | "blocked";
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would", "should",
  "could", "may", "might", "must", "shall", "can", "to", "of", "in", "on", "at",
  "by", "for", "with", "about", "against", "between", "into", "through", "during",
  "before", "after", "above", "below", "from", "up", "down", "out", "off", "over",
  "under", "again", "further", "then", "once", "here", "there", "when", "where",
  "why", "how", "all", "any", "both", "each", "few", "more", "most", "other",
  "some", "such", "no", "nor", "not", "only", "own", "same", "so", "than", "too",
  "very", "this", "that", "these", "those", "i", "you", "he", "she", "it", "we",
  "they", "them", "their", "what", "which", "who", "whom", "whose", "as", "if",
  "my", "your", "our", "let", "lets", "going", "make", "made", "go", "want", "need",
]);

// Latin-only strip: unchanged from the original grammar — collapses anything
// that isn't a-z0-9/space/hyphen to whitespace. Applied AFTER NFKD so accented
// Latin letters (e.g. "é" -> "e" + combining acute) decompose and the mark is
// stripped, same as before this file went CJK-aware.
const LATIN_STRIP_RE = /[^a-z0-9\s\-]+/g;

// Exported (Wave 4) so the prior-builder and predict-correction (Wave 5) reuse
// the SAME tokenizer/overlap grammar instead of forking it.
//
// CJK fix (2026-07-25, audit-cjk-check-action.test.mjs): the tokenizer used to
// be Latin-only — `[^a-z0-9\s\-]+` stripped every CJK character before any
// splitting happened, so pure-Chinese rules/actions always tokenized to an
// empty set (Layer 1). Fixing only that regex is not enough: the length>=3
// floor below exists for English noise-word suppression (STOPWORDS already
// removes literal stopwords; the floor additionally drops bare short tokens
// like acronyms/fragments that survive the stopword list — see the original
// 2026-06-03 commit message: "single-word matches ... produce too much
// noise"). Most meaningful Chinese words are 1-3 CHARACTERS (发布, 确认,
// 删除, 不要), so applying that same floor to CJK tokens would silently drop
// them right back to empty on ordinary short phrases (Layer 2). The fix
// below therefore keeps the length floor Latin-only and gives CJK tokens
// their own script-aware path with NO length floor (STOPWORDS also does not
// apply — it is an English word list) — Han-run extraction already excludes
// punctuation/whitespace, so there is no "stray punctuation counted as a
// token" risk to guard against per-token.
//
// P0-b (2026-08-18): this WAS the only correct tokenizer in the codebase —
// every other recall/search site independently reimplemented the broken
// whitespace-only grammar this function replaced (see the 2026-08-18 L1
// retrieval eval, CJK hit@5 = 0/6). The actual CJK-aware implementation now
// lives in ../helpers/tokenize.ts as the single shared source of truth;
// check-action.ts CONSUMES it here rather than keeping its own copy, so this
// class of bug (one correct impl, N broken forks) cannot recur. This wrapper
// reproduces the exact grammar documented above byte-for-byte — see
// packages/core/test/audit-cjk-check-action.test.mjs for the regression
// coverage that proves it.
export function tokenize(s: string): Set<string> {
  return sharedTokenize(s, { minLength: 3, stopwords: STOPWORDS, asciiStripRegex: LATIN_STRIP_RE });
}

export function overlap(a: Set<string>, b: Set<string>): string[] {
  const hits: string[] = [];
  for (const t of a) if (b.has(t)) hits.push(t);
  return hits.sort();
}

// ---------------------------------------------------------------------------
// RD-1 — failure-class keyword classifier (recurrence-detector workpacket §1)
// ---------------------------------------------------------------------------

/**
 * Per-class keyword sets — ADOPTED VERBATIM from the eval-frozen table in
 * scripts/eval/failure-class-matchfn.mjs (frozen 2026-07-14 BEFORE the first
 * eval run; passed the workpacket's Phase-0 acceptance gates on the live
 * corpus). Review finding HIGH-1 (2026-07-14): the earlier taxonomy-derived
 * table carried ambient tokens ("wrong", "work", "memory", "human", "api",
 * "customer") that misclassified realistic rules on single hits — and a
 * stored failure_class is durable (stored-wins on merge), so classifier
 * precision matters more here than recall. The eval table deliberately
 * excludes ambient tokens and carries surface variants (pushed/deployment/
 * renamed…) because tokenize does no stemming. Change one table → re-run
 * scripts/eval/failure-class-eval.mjs and update both.
 *
 * `naming_violation` beyond the workpacket's 7 classes: owner decision
 * 2026-07-14 (highest-phantom class in the taxonomy validation).
 */
const FAILURE_CLASS_KEYWORDS: ReadonlyArray<
  readonly [Exclude<FailureClass, "other">, readonly string[]]
> = [
  ["publish_gate", [
    "push", "pushed", "pushes", "pushing",
    "publish", "published", "publishing",
    "deploy", "deployed", "deploys", "deployment",
    "release", "released", "releases",
    "version", "versions", "bump", "bumped",
    "approval", "approve", "approved",
    "permission", "permissions",
  ]],
  ["naming_violation", [
    "naming", "rename", "renamed", "renames", "renaming",
    "repo", "repos", "repository", "repositories",
    "slug", "slugs", "filename", "filenames",
    "folder", "folders", "directory", "directories",
    "kebab-case", "canonical", "alias", "aliases",
    "spelling", "spelled", "misspelled",
  ]],
  ["model_dispatch", [
    "opus", "sonnet", "haiku", "fable", "codex",
    "model", "models",
    "dispatch", "dispatched", "dispatching",
    "sub-agent", "sub-agents", "subagent", "subagents",
    "orchestrate", "orchestrates", "orchestrator", "orchestration",
    "worker", "workers", "reviewer", "reviewers",
    "sequential", "parallel", "routing",
  ]],
  ["skipped_verify", [
    "verify", "verifying", "verifies", "verification",
    "self-review", "self-verify", "self-check",
    "unverified", "re-verify",
  ]],
  ["confidential_leak", [
    "confidential", "secret", "secrets",
    "internal", "internals",
    "leak", "leaked", "leaks", "leaking",
    "expose", "exposed", "exposes", "exposure",
    "reveal", "reveals", "revealed", "revealing",
    "margin", "margins", "cost", "costs", "economics",
    "credential", "credentials", "api-key", "api-keys",
  ]],
  ["framing_error", [
    "frame", "framed", "frames", "framing", "reframe",
    "lens", "lenses",
    "conceptual", "concept", "concepts",
    "metaphor", "metaphors", "paradigm",
    "analogy", "analogies",
    "neuroscience", "philosophy", "philosophical", "mental",
  ]],
  ["scope_violation", [
    "scope", "scopes", "scoped", "out-of-scope",
    "session", "sessions",
    "focus", "focuses", "focused",
    "unrelated", "mix", "mixing",
    "boundary", "boundaries",
    "conversation", "conversations",
  ]],
  ["wrong_ref", [
    "stale", "outdated", "deprecated",
    "param", "params", "parameter", "parameters",
    "endpoint", "endpoints", "ref", "refs",
    "mismatch", "mismatched",
  ]],
];

/** Tokenized once at module load — fixed array order keeps scoring deterministic. */
const FAILURE_CLASS_TOKENSETS: ReadonlyArray<
  readonly [Exclude<FailureClass, "other">, Set<string>]
> = FAILURE_CLASS_KEYWORDS.map(
  ([cls, kws]) => [cls, tokenize(kws.join(" "))] as const,
);

/**
 * RD-1 — derive `failure_class` from correction text at capture time.
 *
 * Built ONLY from the existing tokenize/overlap grammar above — no new deps,
 * no ML, no embeddings (the embedding-declined ruling stands). Scoring is a
 * plain token-overlap count per class, resolved highest-first:
 *   strict max score > 0            → that class
 *   zero hits OR tied max           → "other"   (owner decision 2026-07-14)
 *
 * NOTE: tokenize does no stemming — "worker" matches the token "worker", not
 * "workers". That is the same deliberate literalness check-action matching has.
 */
export function classifyFailureClass(text: string): FailureClass {
  const tokens = tokenize(typeof text === "string" ? text : "");
  if (tokens.size === 0) return "other";
  let best: FailureClass = "other";
  let bestScore = 0;
  let tiedAtBest = false;
  for (const [cls, kwTokens] of FAILURE_CLASS_TOKENSETS) {
    const score = overlap(tokens, kwTokens).length;
    if (score > bestScore) {
      best = cls;
      bestScore = score;
      tiedAtBest = false;
    } else if (score === bestScore && score > 0) {
      tiedAtBest = true;
    }
  }
  return bestScore > 0 && !tiedAtBest ? best : "other";
}

/**
 * RD-1 — cluster signature for the cross-project class join (workpacket §2).
 * MIRRORS clusterSignature in scripts/eval/predict-loo.mjs — rule + tags through
 * the shared tokenize grammar — so the eval harness and the production join
 * agree on the join key. Change one → change both.
 */
export function clusterSignature(c: Pick<CorrectionRecord, "rule" | "tags">): Set<string> {
  return tokenize(`${c.rule ?? ""} ${(c.tags ?? []).join(" ")}`);
}

/**
 * RD-1 fix (live-corpus eval finding, 2026-07-14) — rule-text-only signature
 * for the §1c production join. Auto-tags ("rule", "correction", "deployment")
 * recur across unrelated corrections, so a tags-inclusive overlap ≥ 1 is
 * trivially satisfiable — 18/23 cross-project edges in the eval rode partly on
 * tag tokens; one edge joined on sig∩=["rule"] alone. The production join
 * therefore requires its ≥1-token overlap to come from RULE TEXT only.
 * clusterSignature above stays byte-identical — the eval mirror depends on it.
 */
export function ruleSignature(c: Pick<CorrectionRecord, "rule">): Set<string> {
  return tokenize(c.rule ?? "");
}

export async function checkAction(input: CheckActionInput): Promise<CheckActionResult> {
  const slug = await resolveProject(input.project);
  const action = (input.action_description ?? "").trim();
  if (!action) {
    return {
      success: false,
      project: slug,
      action: "",
      matching_rules: [],
      matching_corrections: [],
      matching_insights: [],
      warning: null,
      verdict: "advisory",
    };
  }
  // Default min_overlap=2 — with a populated awareness store, 1-token matches
  // produce too many false positives (single common word in dozens of insights
  // → noise). 2 requires the action and the memory item to share at least two
  // distinct content words, which is the right floor for relevance.
  const minOverlap = input.min_overlap && input.min_overlap > 0 ? input.min_overlap : 2;
  const actionTokens = tokenize(action);

  // 1. Behavior rules — match on rule.when + rule.do + rule.name
  const ruleMatches: RuleMatch[] = [];
  const rules = readBehaviorPolicies(slug).rules;
  for (const r of rules) {
    const ruleTokens = tokenize(`${r.name} ${r.when} ${r.do}`);
    const matched = overlap(actionTokens, ruleTokens);
    if (matched.length >= minOverlap) {
      ruleMatches.push({ id: r.id, name: r.name, when: r.when, do: r.do, matched_tokens: matched });
    }
  }

  // 2. Corrections — match on rule + context
  const correctionMatches: CorrectionMatch[] = [];
  // Wave 5: keep the full matched records (authoritative + precision/retrieved)
  // so the override gate can decide `blocked` vs `advisory` without re-reading.
  const matchedRecords = new Map<string, CorrectionRecord>();
  const corrections: CorrectionRecord[] = readActiveCorrections(slug);
  for (const c of corrections) {
    const cTokens = tokenize(`${c.rule} ${c.context} ${(c.tags ?? []).join(" ")}`);
    const matched = overlap(actionTokens, cTokens);
    if (matched.length >= minOverlap) {
      correctionMatches.push({
        id: c.id,
        rule: c.rule,
        severity: c.severity,
        date: c.date,
        matched_tokens: matched,
      });
      matchedRecords.set(c.id, c);
    }
  }

  // 3. Insights — match on insight.title
  const insightMatches: InsightMatch[] = [];
  const awareness = readAwarenessState();
  for (const i of awareness?.topInsights ?? []) {
    const iTokens = tokenize(i.title);
    const matched = overlap(actionTokens, iTokens);
    if (matched.length >= minOverlap) {
      insightMatches.push({
        title: i.title,
        confirmations: i.confirmations ?? 1,
        severity: i.severity ?? "important",
        matched_tokens: matched,
      });
    }
  }

  // Sort each by relevance (matched_tokens.length DESC, then severity)
  ruleMatches.sort((a, b) => b.matched_tokens.length - a.matched_tokens.length);
  correctionMatches.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "p0" ? -1 : 1;
    return b.matched_tokens.length - a.matched_tokens.length;
  });
  insightMatches.sort((a, b) => {
    if (b.matched_tokens.length !== a.matched_tokens.length) {
      return b.matched_tokens.length - a.matched_tokens.length;
    }
    return b.confirmations - a.confirmations;
  });

  // Cap to keep output small
  const topRules = ruleMatches.slice(0, 5);
  const topCorrections = correctionMatches.slice(0, 5);
  const topInsights = insightMatches.slice(0, 3);

  // Wave 5: authoritative override. A matched correction `blocks` the plan ONLY
  // when it is authoritative (authoritative!==false), P0, and NOT a noise
  // candidate. Noise = the existing getCorrectionKPIs signal: precision<0.3 with
  // retrieved>=3 (a low-signal P0 that keeps firing without being heeded). Gating
  // on noise prevents stale P0s from vetoing legitimate plans (Risk #6).
  const isNoiseCandidate = (rec: CorrectionRecord): boolean => {
    const ret = rec.retrieved_count ?? 0;
    const p = rec.precision;
    return p !== undefined && p !== null && ret >= 3 && p < 0.3;
  };
  const authoritativeP0 = topCorrections.find((c) => {
    const rec = matchedRecords.get(c.id);
    if (!rec) return false;
    return rec.authoritative !== false && rec.severity === "p0" && !isNoiseCandidate(rec);
  });
  const verdict: "advisory" | "blocked" = authoritativeP0 ? "blocked" : "advisory";

  // Build human-readable warning if anything matched
  let warning: string | null = null;
  if (topRules.length + topCorrections.length + topInsights.length > 0) {
    const parts: string[] = [`Before "${action.slice(0, 80)}":`];
    for (const r of topRules) {
      parts.push(`  📜 RULE [${r.name}] WHEN ${r.when} → DO ${r.do}`);
    }
    for (const c of topCorrections) {
      parts.push(`  ⛔ ${c.severity.toUpperCase()} (${c.date}): ${c.rule}`);
    }
    for (const i of topInsights) {
      parts.push(`  💡 [${i.confirmations}×] ${i.title}`);
    }
    warning = parts.join("\n");
    // A blocked plan leads with the override banner — corrections OVERRIDE the model.
    if (verdict === "blocked") {
      warning = `⛔ CONFLICT: a human correction OVERRIDES this plan — reconcile before proceeding.\n${warning}`;
    }
  }

  // C3 (2026-07-03): record a "triggered" outcome for each matched correction.
  // This is the authoritative trigger signal — the agent consulted this correction
  // before acting. Session-end uses this to determine heeded/recurred without
  // falling back to the default-heeded bias.
  // One-per-day dedup: if a "triggered" event already fired today for this correction,
  // skip to avoid log inflation on repeated check-action calls in the same session.
  // Best-effort: trigger recording must NEVER affect the check-action result.
  if (topCorrections.length > 0) {
    try {
      const nowISO = new Date().toISOString();
      const todayOut = readOutcomesForToday(slug);
      for (const c of topCorrections) {
        const firedToday = todayOut.get(c.id);
        // Skip if a triggered (or stronger) outcome already exists today
        if (firedToday && firedToday.has("triggered")) continue;
        recordOutcome({
          correction_id: c.id,
          project: slug,
          kind: "triggered",
          at: nowISO,
          evidence: `check-action consulted before "${action.slice(0, 60)}" (tokens: ${c.matched_tokens.join(", ")})`,
        });
      }
    } catch {
      // Trigger recording is fire-and-forget — never affect the result
    }
  }

  return {
    success: true,
    project: slug,
    action,
    matching_rules: topRules,
    matching_corrections: topCorrections,
    matching_insights: topInsights,
    warning,
    verdict,
  };
}
