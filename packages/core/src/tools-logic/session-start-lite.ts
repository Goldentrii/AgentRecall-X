/**
 * session_start lite mode — V6 finding.
 *
 * The full session_start payload runs 3-8k tokens, violating Anthropic
 * 2026 context-engineering guidance ("smallest high-signal set").
 * `lite` returns ≤500 tokens — just enough for the agent to form a plan
 * and decide what to recall on demand.
 *
 * Default behavior unchanged. Set mode="lite" to opt in.
 */

import { resolveProject } from "../storage/project.js";
import { readIdentity } from "../palace/identity.js";
import { listJournalFiles } from "../helpers/journal-files.js";
import { readActiveCorrections } from "../storage/corrections.js";
import { listMilestones } from "../palace/pipeline.js";
import { listSkills } from "../palace/skills.js";
import { runStoreDoctor, storeDoctorBanner } from "./store-doctor.js";
import { readRecentSessions, formatAgo } from "../storage/recency-index.js";
import { isRescueSourceTag } from "../helpers/journal-filter.js";

export interface SessionStartLiteInput {
  project?: string;
}

export interface SessionStartLiteResult {
  project: string;
  identity_oneliner: string;
  last_session_date: string | null;
  active_phase: string | null;
  active_phase_goal: string | null;
  open_corrections_p0_count: number;
  total_sessions: number;
  total_skills: number;
  /** Store-integrity one-liner; null (and silent) when the store is healthy. */
  store_doctor: string | null;
  /**
   * F2 (continuity wave 2026-07-31) — single-line cross-project recency
   * pointer: the most recent entry across ANY project's recency ledger,
   * rendered as one line. Null (and silent) when the ledger is empty.
   */
  continuity: string | null;
  hint: string;
}

export async function sessionStartLite(input: SessionStartLiteInput): Promise<SessionStartLiteResult> {
  const slug = await resolveProject(input.project);

  const raw = readIdentity(slug);
  const firstMeaningful = raw.split("\n").find((l) => {
    const t = l.trim();
    return t && !t.startsWith("---") && !t.startsWith(">") && !/^[a-z_]+:\s/.test(t) && !t.startsWith("_(");
  });
  const identityLine = (firstMeaningful ?? slug).replace(/^#+\s*/, "").trim().slice(0, 140);

  const journals = listJournalFiles(slug);
  const lastDate = journals[0]?.date ?? null;

  const milestones = listMilestones(slug);
  const active = milestones.find((m) => m.meta.status === "active");

  const corrections = readActiveCorrections(slug);
  const p0 = corrections.filter((c) => c.severity === "p0").length;

  const skills = listSkills(slug);

  // Store-integrity one-liner; null & silent on a healthy store. Best-effort.
  let storeDoctorLine: string | null = null;
  try {
    storeDoctorLine = storeDoctorBanner(runStoreDoctor());
  } catch {
    storeDoctorLine = null;
  }

  // Continuity — single-line cross-project recency pointer (F2). Best-effort:
  // a missing/corrupt ledger must never break the lite briefing.
  let continuityLine: string | null = null;
  try {
    // Identity-trust (CRITICAL-1 followup, 2026-08-20): the same
    // working-memory-rescue signal as the full session_start's `continuity`
    // field (see session-start.ts's continuity-assembly comment for the
    // full rationale) — a small over-fetch lets a genuinely trusted,
    // slightly-older entry win the single lite-mode line instead of an
    // untrusted top-of-ledger row. If every recent row is untrusted, still
    // fall back to the top one (lite mode's own genuine-crash-recovery use
    // case), but VISIBLY labeled rather than silently presented as verified.
    const candidates = readRecentSessions(5);
    const top = candidates.find((s) => !isRescueSourceTag(s.source)) ?? candidates[0];
    if (top) {
      const next = top.next_step ? ` → next: ${top.next_step.slice(0, 100)}` : "";
      const trustFlag = isRescueSourceTag(top.source) ? " [unverified — rescued from a crashed session]" : "";
      continuityLine = `${formatAgo(top.ts)} [${top.slug}] ${top.title.slice(0, 120)}${next}${trustFlag}`;
    }
  } catch {
    continuityLine = null;
  }

  return {
    project: slug,
    identity_oneliner: identityLine,
    last_session_date: lastDate,
    active_phase: active?.meta.phase ?? null,
    active_phase_goal: active?.sections.goal && active.sections.goal !== "(in progress)" ? active.sections.goal : null,
    open_corrections_p0_count: p0,
    total_sessions: journals.length,
    total_skills: skills.length,
    store_doctor: storeDoctorLine,
    continuity: continuityLine,
    hint:
      "Lite mode. Call recall(query) for memories. " +
      "Call session_start without mode='lite' for the full briefing.",
  };
}
