#!/usr/bin/env node
/**
 * paraphrase-robustness.mjs — Loop 5, Part A.
 *
 * THE CONTROLLED LEXICAL-VS-SEMANTIC INSTRUMENT. It answers one question with a
 * number: "how much of the current matcher's power is pure lexical coincidence?"
 *
 * METHOD — take a set of real-correction THEMES. For each, hold an ORIGINAL
 * situation sentence and a meaning-preserving PARAPHRASE that shares ZERO content
 * tokens with it (verified at load time — the harness THROWS if any pair leaks a
 * shared token, so the "zero-overlap" claim is provable, not asserted). Then:
 *
 *   1. Build a blind spot from the ORIGINAL situation's correction.
 *   2. Fire the matcher at the PARAPHRASE.
 *   3. KEYWORD path firing rate on zero-overlap paraphrases is ~0 BY CONSTRUCTION
 *      — exact token overlap is zero, so the keyword floor can never pass. That is
 *      the whole point: it quantifies how lexical the matching is. A keyword rate
 *      near 0 with a semantic rate well above it is the evidence that the new path
 *      adds genuine paraphrase robustness rather than lexical luck.
 *
 * The paraphrases are a ONE-TIME, OFFLINE, hand-authored fixture (below). They are
 * NEVER generated at predict time — the production hot path does no paraphrase
 * generation and no LLM. This script only MEASURES; it changes no behavior.
 *
 * Usage:
 *   node scripts/eval/paraphrase-robustness.mjs            # human report
 *   node scripts/eval/paraphrase-robustness.mjs --json     # machine-readable
 */

import {
  matchesBlindSpot,
  BLIND_SPOT_MIN_OVERLAP,
  BLIND_SPOT_SEMANTIC_THRESHOLD,
} from "../../packages/core/dist/helpers/blind-spots.js";
import { tokenize, overlap } from "../../packages/core/dist/tools-logic/check-action.js";

/**
 * Hand-authored, OFFLINE paraphrase fixture. Each entry is a real-correction
 * theme from the ~/.agent-recall corpus expressed two ways:
 *   - `original`: the situation as it might appear in a correction's context.
 *   - `paraphrase`: the SAME meaning with DIFFERENT surface words (zero shared
 *      content tokens — enforced at load by assertZeroOverlap).
 *   - `triggers`: the cleaned keywords a blind spot derived from the original
 *      would carry (so the keyword path has a fair shot — and still fails, which
 *      is the finding).
 *
 * These are baked once. Adding a theme widens the instrument; it never runs at
 * predict time.
 */
export const PARAPHRASE_FIXTURE = [
  {
    theme: "publish-without-approval",
    original: "Publish the package to npm right now.",
    paraphrase: "Ship the release to the registry immediately.",
    triggers: ["publish", "package", "npm"],
  },
  {
    theme: "rename-the-product",
    original: "Update the product name across the README and title.",
    paraphrase: "Rebrand the offering throughout docs and headings.",
    triggers: ["product", "name", "readme", "title"],
  },
  {
    theme: "expose-secret-key",
    original: "Put the API key secret into the config store.",
    paraphrase: "Place the credential token inside the settings vault.",
    triggers: ["api-key", "secret", "config"],
  },
  {
    theme: "deploy-without-staging",
    original: "Deploy the build straight to the production cluster.",
    paraphrase: "Roll out the artifact directly onto the live environment.",
    triggers: ["deploy", "build", "production"],
  },
  {
    theme: "codex-needs-explicit-prompts",
    original: "The codex agent needs extremely detailed prompts.",
    paraphrase: "That model requires very thorough instruction text.",
    triggers: ["codex", "detailed", "prompts"],
  },
  {
    theme: "reveal-margin-to-customer",
    original: "Show the internal cost and margin to the customer.",
    paraphrase: "Expose our private pricing economics to the buyer.",
    triggers: ["cost", "margin", "customer"],
  },
];

/** Lowercased content-token set via the production tokenizer. */
function tok(s) {
  return tokenize(s || "");
}

/**
 * Fail loud if any fixture pair shares a content token — the "zero-overlap"
 * property must be PROVABLE, not assumed. Returns the validated fixture.
 */
function assertZeroOverlap(fixture) {
  for (const f of fixture) {
    const shared = overlap(tok(f.original), tok(f.paraphrase));
    if (shared.length > 0) {
      throw new Error(
        `paraphrase fixture "${f.theme}" leaks shared tokens [${shared.join(", ")}] — not a zero-overlap pair`,
      );
    }
  }
  return fixture;
}

/**
 * Run the diagnostic: for each pair, build a blind spot from the ORIGINAL's
 * trigger keywords + original text, then fire the matcher at the PARAPHRASE under
 * (a) keyword-only and (b) keyword+semantic. Report firing rates.
 */
export function runParaphraseRobustness(opts = {}) {
  const fixture = assertZeroOverlap(opts.fixture ?? PARAPHRASE_FIXTURE);
  const threshold = opts.threshold ?? BLIND_SPOT_SEMANTIC_THRESHOLD;

  let keywordFires = 0;
  let semanticFires = 0;
  const details = [];

  for (const f of fixture) {
    const bs = {
      tendency: f.original,
      example_rule: f.original,
      trigger_keywords: f.triggers,
    };

    // Keyword-only: pass an impossible semantic threshold so only exact overlap
    // can fire. On a zero-overlap paraphrase this is ~0 by construction.
    const kw = matchesBlindSpot(f.paraphrase, bs, BLIND_SPOT_MIN_OVERLAP, Number.POSITIVE_INFINITY);
    // Keyword + LOCAL semantic widen at the tuned threshold.
    const sem = matchesBlindSpot(f.paraphrase, bs, BLIND_SPOT_MIN_OVERLAP, threshold);

    if (kw.fired) keywordFires += 1;
    if (sem.fired) semanticFires += 1;

    details.push({
      theme: f.theme,
      keyword_fired: kw.fired,
      semantic_fired: sem.fired,
      semantic_via: sem.via,
      semantic_score: Number(sem.semanticScore.toFixed(3)),
    });
  }

  const n = fixture.length;
  return {
    n,
    threshold,
    keyword_firing_rate: n > 0 ? keywordFires / n : null,
    semantic_firing_rate: n > 0 ? semanticFires / n : null,
    keyword_fires: keywordFires,
    semantic_fires: semanticFires,
    details,
  };
}

function fmtPct(x) {
  return x === null ? "n/a" : `${(x * 100).toFixed(1)}%`;
}

function renderReport(r) {
  const lines = [];
  lines.push("══════════════════════════════════════════════════════════════");
  lines.push("  AgentRecall — Paraphrase-robustness diagnostic (Loop 5, Part A)");
  lines.push("  How lexical is the matcher? Fire on ZERO-OVERLAP paraphrases.");
  lines.push("══════════════════════════════════════════════════════════════");
  lines.push(`  pairs (zero shared tokens, proven)   ${r.n}`);
  lines.push(`  semantic threshold                   ${r.threshold}`);
  lines.push("");
  lines.push(`  KEYWORD firing rate   ${fmtPct(r.keyword_firing_rate)}  (${r.keyword_fires}/${r.n})  ← ~0 by construction (lexical only)`);
  lines.push(`  SEMANTIC firing rate  ${fmtPct(r.semantic_firing_rate)}  (${r.semantic_fires}/${r.n})  ← paraphrase robustness added by the local matcher`);
  lines.push("");
  lines.push("  ── per theme ──");
  for (const d of r.details) {
    lines.push(
      `    ${d.theme.padEnd(32)} kw=${d.keyword_fired ? "FIRE" : "—   "}  sem=${d.semantic_fired ? "FIRE" : "—   "}  (sim=${d.semantic_score}, via=${d.semantic_via ?? "none"})`,
    );
  }
  lines.push("══════════════════════════════════════════════════════════════");
  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const thrIdx = args.indexOf("--threshold");
  const threshold = thrIdx >= 0 ? Number(args[thrIdx + 1]) : undefined;
  const report = runParaphraseRobustness({ threshold });
  process.stdout.write(asJson ? JSON.stringify(report, null, 2) + "\n" : renderReport(report) + "\n");
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) main();
