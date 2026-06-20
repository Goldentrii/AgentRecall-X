/**
 * consolidation-prompt.ts — the versioned, in-repo consolidation prompt
 * (Wave 5, the compression remainder).
 *
 * This is the single source for the "reflect on recent work → surface
 * crystallization candidates" prompt that the dreaming loop runs. It ports ONLY
 * Phase B (candidate-finding) of the external ~/.aam T1 Step 4.5 prompt; Phase C
 * (synthesis) deliberately stays the LLM's job (Decision #3 — core never
 * synthesizes). `session-end-reflect.ts:buildPrompt()` imports `buildConsolidationPrompt`
 * so there is exactly one prompt generator.
 *
 * The template is VERSIONED so a change to the consolidation contract is
 * observable (and the `ar consolidate` CLI / dreaming repoint can pin a version).
 */

import type { ReflectInputBundle } from "../tools-logic/session-end-reflect.js";

/** Bump when the consolidation contract changes. */
export const CONSOLIDATION_PROMPT_VERSION = "v1";

export const CONSOLIDATION_PROMPT_TEMPLATE = `# AgentRecall consolidation prompt ${CONSOLIDATION_PROMPT_VERSION}

You are the agent reviewing your own recent work. From the inputs below, produce:

1. **Three high-level questions** this period raised (Park 2023 style).
2. **Procedural skills** that crystallized — anything repeated >=2x is a candidate (call skill_write).
3. **Cross-session patterns** not yet in awareness — distilled insights worth promoting.
4. **Noise to archive** — corrections with low precision that should be retired.

PHASE B (candidate-finding) is done for you: crystallization candidates below are
clusters of related insights. PHASE C (synthesis) is YOURS — the system does NOT
synthesize a principle for you; decide whether/how to crystallize each cluster.

Be terse. One bullet per finding. Cite journal dates / phase orders / correction ids as evidence.
`;

/**
 * Build the consolidation prompt for a project from a reflect bundle. Mirrors
 * the structured sections the reflect tool previously inlined — now shared so
 * `ar consolidate` and `session_end_reflect` render identically.
 */
export function buildConsolidationPrompt(
  slug: string,
  bundle: ReflectInputBundle,
  lookbackDays?: number,
): string {
  const lines: string[] = [];
  const header = lookbackDays
    ? `# Consolidate ${slug} — last ${lookbackDays} days (${CONSOLIDATION_PROMPT_VERSION})`
    : `# Consolidate ${slug} (${CONSOLIDATION_PROMPT_VERSION})`;
  lines.push(header);
  lines.push("");
  lines.push(CONSOLIDATION_PROMPT_TEMPLATE.trim());
  lines.push("");
  lines.push("---");
  lines.push("");

  lines.push(`## Journals (${bundle.recent_journals.length})`);
  for (const j of bundle.recent_journals) {
    lines.push(`### ${j.date} — ${j.file}`);
    lines.push(j.excerpt);
    lines.push("");
  }

  lines.push(`## Active corrections (${bundle.active_corrections.length})`);
  for (const c of bundle.active_corrections) {
    const p = c.precision !== null && c.precision !== undefined ? ` p=${c.precision}` : "";
    lines.push(`- [${c.id}] (${c.severity}${p}) ${c.rule}`);
  }
  lines.push("");

  lines.push(`## Recent closed phases (${bundle.recent_phases.length})`);
  for (const ph of bundle.recent_phases) {
    lines.push(`- Phase ${ph.order} — ${ph.phase}: ${ph.synthesis}`);
  }

  if (bundle.raw_unconsumed && bundle.raw_unconsumed.length > 0) {
    lines.push("");
    lines.push(`## Unconsumed raw archive (${bundle.raw_unconsumed.length})`);
    lines.push(
      "These verbatim session dumps have NOT been distilled yet. Read them, " +
        "extract any reusable pattern/decision/skill, then advance the " +
        "journal/archive/raw/.consumed.json marker so they aren't re-processed.",
    );
    for (const r of bundle.raw_unconsumed) {
      lines.push(`### ${r.file} (${r.bytes} bytes)`);
      lines.push(r.excerpt);
      lines.push("");
    }
  }

  if (bundle.crystallization_candidates && bundle.crystallization_candidates.length > 0) {
    lines.push("");
    lines.push(`## Crystallization candidates (${bundle.crystallization_candidates.length})`);
    lines.push(
      "These insight clusters share >=2 trigger keywords and enough confirmations to " +
        "be worth crystallizing into ONE principle. Decide whether to synthesize each " +
        "(awareness_update) — the system does not synthesize for you.",
    );
    for (const c of bundle.crystallization_candidates) {
      lines.push(
        `### [${c.shared_keywords.join(" + ")}] — ${c.size} insights, ${c.total_confirmations}x confirmed`,
      );
      for (const t of c.insight_titles) lines.push(`- ${t}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}
