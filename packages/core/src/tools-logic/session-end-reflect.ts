/**
 * Reflect — Park-2023-style aggregation step.
 *
 * The V2 finding: AgentRecall only promotes insights from CORRECTIONS.
 * Successful patterns never become semantic knowledge. Generative Agents
 * (Park et al. 2023) showed that periodic LLM-driven distillation of raw
 * memories into "high-level questions + derived insights" is the move
 * that makes memory compound.
 *
 * Design choice: this tool does NOT call an LLM directly. Core is meant
 * to stay deterministic + dependency-free of any model API. Instead, we
 * package the necessary inputs + prompt template into a structured
 * payload that the calling MCP tool returns to the LLM in the loop, and
 * the LLM does the synthesis on its own turn. The result can then be
 * fed back via `skill_write` or `awareness_update`.
 *
 * Why: this matches AgentRecall's "agent-as-author" stance — the agent
 * already in the conversation writes its own reflection, we just give it
 * the inputs.
 */

import { resolveProject } from "../storage/project.js";
import { readCorrections } from "../storage/corrections.js";
import { listJournalFiles } from "../helpers/journal-files.js";
import { listMilestones } from "../palace/pipeline.js";
import { findCrystallizationCandidates, type CrystallizationCandidate } from "../palace/awareness.js";
import { archiveRawDir } from "../storage/paths.js";
import { readJsonSafe } from "../storage/fs-utils.js";
import { buildConsolidationPrompt } from "../prompts/consolidation-prompt.js";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ReflectInput {
  project?: string;
  /** Look back this many days of journal entries. Default 7. */
  lookback_days?: number;
}

export interface ReflectInputBundle {
  /** Journal entries (file path + first 800 chars) within lookback window. */
  recent_journals: Array<{ date: string; file: string; excerpt: string }>;
  /** Active corrections relevant to the lookback window. */
  active_corrections: Array<{ id: string; rule: string; severity: string; precision: number | null }>;
  /** Last 3 closed pipeline phases with their synthesis. */
  recent_phases: Array<{ order: number; phase: string; synthesis: string }>;
  /**
   * Wave 2: lossless raw archive segments not yet consumed by compression
   * (files newer than the `.consumed.json` marker). The in-loop LLM is asked to
   * distill these upward and advance the marker. Core stays deterministic — it
   * only surfaces the raw material; it makes NO LLM call itself.
   */
  raw_unconsumed?: Array<{ file: string; excerpt: string; bytes: number }>;
  /**
   * Wave 3: clusters of related awareness insights that are candidates for
   * crystallization into a single principle. Raw material ONLY — core does NOT
   * synthesize the principle (the in-loop LLM does, per Decision #3).
   */
  crystallization_candidates?: CrystallizationCandidate[];
}

export interface ReflectResult {
  success: boolean;
  project: string;
  bundle: ReflectInputBundle;
  /** Ready-to-paste prompt the calling LLM can use to write reflection back. */
  prompt: string;
  /** Suggested follow-up tool calls. */
  next_actions: string[];
}

const EXCERPT_CHARS = 800;

export async function sessionEndReflect(input: ReflectInput): Promise<ReflectResult> {
  const slug = await resolveProject(input.project);
  const lookback = input.lookback_days && input.lookback_days > 0 ? input.lookback_days : 7;
  const cutoff = new Date(Date.now() - lookback * 86400000);

  // Collect recent journal excerpts
  const journals = listJournalFiles(slug);
  const recentJournals: ReflectInputBundle["recent_journals"] = [];
  for (const j of journals) {
    const d = new Date(j.date);
    if (Number.isNaN(d.getTime()) || d < cutoff) continue;
    let excerpt = "";
    try {
      const content = fs.readFileSync(path.join(j.dir, j.file), "utf-8");
      excerpt = content.slice(0, EXCERPT_CHARS);
    } catch {
      // skip unreadable
    }
    recentJournals.push({ date: j.date, file: j.file, excerpt });
    if (recentJournals.length >= 7) break;
  }

  // Active corrections + precision
  const corrections = readCorrections(slug)
    .filter((r) => r.active !== false)
    .slice(0, 20)
    .map((r) => ({
      id: r.id,
      rule: r.rule,
      severity: r.severity,
      precision: r.precision ?? null,
    }));

  // Last 3 closed phases
  const allPhases = listMilestones(slug);
  const recentPhases = allPhases
    .filter((p) => p.meta.status === "closed")
    .slice(-3)
    .map((p) => ({
      order: p.meta.order,
      phase: p.meta.phase,
      synthesis: p.sections.synthesis,
    }));

  const rawUnconsumed = collectRawUnconsumed(slug);

  // Wave 3: surface crystallization candidates (best-effort; never throws).
  let crystallizationCandidates: CrystallizationCandidate[] = [];
  try {
    crystallizationCandidates = findCrystallizationCandidates();
  } catch {
    crystallizationCandidates = [];
  }

  const bundle: ReflectInputBundle = {
    recent_journals: recentJournals,
    active_corrections: corrections,
    recent_phases: recentPhases,
    ...(rawUnconsumed.length > 0 ? { raw_unconsumed: rawUnconsumed } : {}),
    ...(crystallizationCandidates.length > 0
      ? { crystallization_candidates: crystallizationCandidates }
      : {}),
  };

  const prompt = buildPrompt(slug, bundle, lookback);
  const nextActions = [
    "After reading the bundle, write any IF-THEN production rule worth saving to palace/skills/ via ar palace write skills/<slug>.",
    "Call session_end again with insights[] containing distilled cross-session patterns.",
    "If a correction's precision < 0.3 across ≥3 retrievals, suggest archiving it (set active:false).",
  ];

  return { success: true, project: slug, bundle, prompt, next_actions: nextActions };
}

// Wave 5: the prompt body is now generated by the SINGLE versioned source
// (prompts/consolidation-prompt.ts), so `ar consolidate` and `session_end_reflect`
// render identically. This wrapper exists only to keep the call signature stable.
function buildPrompt(slug: string, bundle: ReflectInputBundle, lookback: number): string {
  return buildConsolidationPrompt(slug, bundle, lookback);
}

/**
 * Wave 2: collect lossless raw-archive files newer than the `.consumed.json`
 * marker so the reflect bundle can hand them to the LLM for distillation.
 * Deterministic and best-effort — never throws.
 */
function collectRawUnconsumed(
  slug: string,
): NonNullable<ReflectInputBundle["raw_unconsumed"]> {
  const out: NonNullable<ReflectInputBundle["raw_unconsumed"]> = [];
  try {
    const rawDir = archiveRawDir(slug);
    if (!fs.existsSync(rawDir)) return out;

    const marker = readJsonSafe<{ lastConsumedAt?: string | null }>(
      path.join(rawDir, ".consumed.json"),
    );
    const cutoffMs = marker?.lastConsumedAt
      ? new Date(marker.lastConsumedAt).getTime()
      : 0;

    const files = fs
      .readdirSync(rawDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse();

    for (const file of files) {
      const full = path.join(rawDir, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (Number.isFinite(cutoffMs) && cutoffMs > 0 && stat.mtimeMs <= cutoffMs) {
        continue; // already consumed
      }
      let excerpt = "";
      try {
        excerpt = fs.readFileSync(full, "utf-8").slice(0, EXCERPT_CHARS);
      } catch {
        continue;
      }
      out.push({ file, excerpt, bytes: stat.size });
      if (out.length >= 5) break; // cap — bound the bundle size
    }
  } catch {
    // best-effort
  }
  return out;
}
