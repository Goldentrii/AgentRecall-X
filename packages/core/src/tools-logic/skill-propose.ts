/**
 * skill-propose.ts — draft procedural skills from closed pipeline phases
 * (Wave 5, agent-as-author).
 *
 * Scans closed milestones' `how_solved` / `synthesis` for a repeated procedural
 * shape and emits DRAFT skills the agent can confirm. It NEVER calls writeSkill
 * — synthesis-to-disk is the agent's call (Decision: agent-as-author). The CLI /
 * reflect surface presents these drafts; the human/agent decides what to persist.
 */

import { resolveProject } from "../storage/project.js";
import { listMilestones } from "../palace/pipeline.js";
import { extractKeywords, generateSlug } from "../helpers/auto-name.js";
import type { SkillMeta, SkillBody } from "../palace/skills.js";

export interface ProposedSkill {
  meta: Omit<SkillMeta, "created" | "updated" | "fsrs"> & { created?: string; updated?: string };
  body: SkillBody;
  /** Always "auto_reflection" — these are drafts, not manual skills. */
  source: "auto_reflection";
  /** Pipeline phases this draft was distilled from (evidence). */
  from_phases: number[];
}

/** Split a synthesis/how-solved blob into candidate procedural steps. */
function toSteps(text: string): string[] {
  if (!text) return [];
  return text
    .split(/\n|(?<=[.;])\s+/)
    .map((s) => s.replace(/^[-*\d.\s]+/, "").trim())
    .filter((s) => s.length >= 8)
    .slice(0, 8);
}

/**
 * Propose DRAFT skills from a project's closed phases. Returns [] when there
 * is no closed phase with usable procedural content. Pure read — writes nothing.
 */
export async function proposeSkillsFromPhases(project?: string): Promise<ProposedSkill[]> {
  const slug = await resolveProject(project);
  const milestones = listMilestones(slug);
  const closed = milestones.filter((m) => m.meta.status === "closed");
  if (closed.length === 0) return [];

  const drafts: ProposedSkill[] = [];
  const PLACEHOLDER = "(in progress)";

  for (const m of closed) {
    const howSolved = (m.sections.how_solved ?? "").trim();
    const synthesis = (m.sections.synthesis ?? "").trim();
    const body = howSolved && howSolved !== PLACEHOLDER ? howSolved : synthesis;
    if (!body || body === PLACEHOLDER) continue;

    const steps = toSteps(body);
    if (steps.length < 2) continue; // need a real multi-step procedure

    const triggers = extractKeywords(`${m.meta.phase} ${m.sections.goal} ${body}`, 5);
    const slugResult = generateSlug(`${m.meta.phase} ${body}`, { room: "skills" });

    drafts.push({
      meta: {
        slug: slugResult.slug,
        name: m.meta.phase,
        topic: triggers[0] ?? "general",
        triggers,
      },
      body: {
        when: m.sections.goal && m.sections.goal !== PLACEHOLDER ? m.sections.goal : m.meta.phase,
        preconditions: [],
        steps,
        postconditions: synthesis && synthesis !== PLACEHOLDER ? [synthesis.slice(0, 200)] : [],
        evidence: [`pipeline phase ${m.meta.order} — ${m.meta.phase}`],
      },
      source: "auto_reflection",
      from_phases: [m.meta.order],
    });
  }

  return drafts;
}
