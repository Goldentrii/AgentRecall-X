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
import { readActiveCorrections, recordOutcome, readOutcomesForToday, type CorrectionRecord } from "./../storage/corrections.js";
import { readBehaviorPolicies, type BehaviorRule } from "../storage/behavior-policies.js";
import { readAwarenessState } from "../palace/awareness.js";

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

// Exported (Wave 4) so the prior-builder and predict-correction (Wave 5) reuse
// the SAME tokenizer/overlap grammar instead of forking it.
export function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9\s\-]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

export function overlap(a: Set<string>, b: Set<string>): string[] {
  const hits: string[] = [];
  for (const t of a) if (b.has(t)) hits.push(t);
  return hits.sort();
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
