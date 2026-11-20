/**
 * prior-builder.ts — the "push a calibrated prior EARLY" half of the Bridge (Wave 4).
 *
 * hook-ambient fires before the agent reasons. Instead of only surfacing a fact
 * list pulled late, we push a correction-derived PRIOR above it: "this resembles
 * a past correction — check before proceeding." Memory becoming understanding.
 *
 * Pure + exported so it is unit-testable WITHOUT spawning the CLI. The CLI passes
 * in the prompt, the project's P0 corrections, and the awareness blind-spots.
 *
 * Overlap gate starts STRICT (>=2 content tokens) to avoid noise (Risk #8). The
 * tokenizer/overlap grammar is REUSED from check-action.ts — do not fork it.
 */

import { tokenize, overlap } from "./check-action.js";
import { displayRule } from "../storage/corrections.js";

/** Minimal shape of a correction the prior-builder needs. */
export interface PriorCorrection {
  id?: string;
  rule: string;
  /** Rule + "\n\nWhy: " + evidence; lets displayRule derive a rule 3.5.3 stored cut. */
  context?: string;
  severity?: string;
  tags?: string[];
}

/** Minimum content-token overlap for a correction prior to fire (strict). */
const MIN_OVERLAP = 2;
/** Max priors emitted (kept tiny — these sit above the fact list). */
const MAX_PRIORS = 2;

/**
 * Domain-noise tokens for blind-spot matching (FIX 2).
 *
 * These are high-frequency dev-context words that survive the generic English
 * stop-word filter but are not discriminating enough to count as signal for a
 * blind-spot prior. A blind spot like "… blocked on competitor API keys" should
 * NOT fire just because a prompt asks "check the API keys configuration" — the
 * co-occurrence of `api`+`keys` is too common in any engineering session.
 *
 * CORRECTION priors are NOT filtered through this set — corrections are ground-
 * truth rules with specific rule text (longer, more distinctive). Only blind
 * spots (derived tendency summaries) use the extended filter.
 *
 * Rationale for each token:
 *   api, keys, key   — appear in nearly every auth/integration prompt
 *   product, projects, project — appear whenever discussing roadmap or work items
 *   build, test, run, code, file, use, check — ubiquitous dev verbs/nouns
 *   data, info, user, users — too generic to discriminate any tendency
 */
const BLIND_SPOT_DOMAIN_NOISE = new Set([
  "api", "key", "keys",
  "product", "project", "projects",
  "build", "test", "run", "code", "file", "files", "use", "check",
  "data", "info", "user", "users",
]);

/**
 * Build the early-prior lines for a prompt.
 * Corrections fire a hard "resembles a past correction" instinct; blind-spots
 * fire a softer "tends to" nudge. Corrections take precedence.
 */
export function buildPriors(
  prompt: string,
  corrections: PriorCorrection[],
  blindSpots: string[],
): string[] {
  const out: string[] = [];
  if (!prompt || !prompt.trim()) return out;

  const promptTokens = tokenize(prompt);
  if (promptTokens.size === 0) return out;

  // 1. Correction priors (authoritative ground truth — strongest signal).
  for (const c of corrections ?? []) {
    if (out.length >= MAX_PRIORS) break;
    if (!c || !c.rule) continue;
    const ruleTokens = tokenize(`${c.rule} ${(c.tags ?? []).join(" ")}`);
    const matched = overlap(promptTokens, ruleTokens);
    if (matched.length >= MIN_OVERLAP) {
      out.push(
        `⚠ [AgentRecall instinct] Resembles a past correction — ${displayRule(c).replace(/\.$/, "")}. Check before proceeding.`,
      );
    }
  }

  // 2. Blind-spot priors (softer — derived tendency, not a hard rule).
  // Domain-noise filter: blind spots are broad tendency summaries, so their
  // token set often includes generic dev terms (api, keys, projects...) that
  // co-occur in unrelated prompts. Strip BLIND_SPOT_DOMAIN_NOISE from both
  // sides before counting overlap — the MIN_OVERLAP=2 gate must be met by
  // genuinely discriminating content tokens only.
  for (const bs of blindSpots ?? []) {
    if (out.length >= MAX_PRIORS) break;
    if (!bs || !bs.trim()) continue;
    const bsTokens = tokenize(bs);
    // Build noise-filtered token sets for the overlap test
    const filteredBsTokens = new Set([...bsTokens].filter((t) => !BLIND_SPOT_DOMAIN_NOISE.has(t)));
    const filteredPromptTokens = new Set([...promptTokens].filter((t) => !BLIND_SPOT_DOMAIN_NOISE.has(t)));
    const matched = overlap(filteredPromptTokens, filteredBsTokens);
    if (matched.length >= MIN_OVERLAP) {
      out.push(
        `⚠ [AgentRecall] Watch a known tendency — ${bs.trim()}.`,
      );
    }
  }

  return out.slice(0, MAX_PRIORS);
}
