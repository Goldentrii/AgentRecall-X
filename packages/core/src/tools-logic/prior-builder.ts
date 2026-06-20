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

/** Minimal shape of a correction the prior-builder needs. */
export interface PriorCorrection {
  id?: string;
  rule: string;
  severity?: string;
  tags?: string[];
}

/** Minimum content-token overlap for a correction prior to fire (strict). */
const MIN_OVERLAP = 2;
/** Max priors emitted (kept tiny — these sit above the fact list). */
const MAX_PRIORS = 2;

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
        `⚠ [AgentRecall instinct] Resembles a past correction — ${c.rule.trim()}. Check before proceeding.`,
      );
    }
  }

  // 2. Blind-spot priors (softer — derived tendency, not a hard rule).
  for (const bs of blindSpots ?? []) {
    if (out.length >= MAX_PRIORS) break;
    if (!bs || !bs.trim()) continue;
    const bsTokens = tokenize(bs);
    const matched = overlap(promptTokens, bsTokens);
    if (matched.length >= MIN_OVERLAP) {
      out.push(
        `⚠ [AgentRecall] Watch a known tendency — ${bs.trim()}.`,
      );
    }
  }

  return out.slice(0, MAX_PRIORS);
}
