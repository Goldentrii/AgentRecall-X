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
    hint:
      "Lite mode. Call recall(query) for memories. " +
      "Call session_start without mode='lite' for the full briefing.",
  };
}
