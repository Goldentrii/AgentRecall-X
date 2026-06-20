import { resolveProject } from "../storage/project.js";
import { recallSkillsByIntent, reinforceSkillFsrs, type Skill } from "../palace/skills.js";
import type { FsrsScore } from "../palace/fsrs.js";

export interface SkillRecallInput {
  project?: string;
  /** What the agent is about to do — used for trigger keyword match. */
  intent: string;
  limit?: number;
}

export interface SkillRecallHit {
  slug: string;
  name: string;
  topic: string;
  score: number;
  matched_triggers: string[];
  when: string;
  steps: string[];
  postconditions: string[];
  pitfalls?: string[];
  file_path: string;
  /** Wave 3: FSRS retrievability (0..1) of this skill at recall time. */
  retrievability: number;
  /** Wave 3: FSRS health bucket. */
  status: FsrsScore["status"];
}

export interface SkillRecallResult {
  success: boolean;
  project: string;
  intent: string;
  hits: SkillRecallHit[];
}

function toHit(x: {
  skill: Skill;
  score: number;
  matched_triggers: string[];
  retrievability: number;
  status: FsrsScore["status"];
}): SkillRecallHit {
  return {
    slug: x.skill.meta.slug,
    name: x.skill.meta.name,
    topic: x.skill.meta.topic,
    score: x.score,
    matched_triggers: x.matched_triggers,
    when: x.skill.body.when,
    steps: x.skill.body.steps,
    postconditions: x.skill.body.postconditions,
    pitfalls: x.skill.body.pitfalls,
    file_path: x.skill.file_path,
    retrievability: x.retrievability,
    status: x.status,
  };
}

export async function skillRecall(input: SkillRecallInput): Promise<SkillRecallResult> {
  const slug = await resolveProject(input.project);
  const intent = (input.intent ?? "").trim();
  if (!intent) {
    return { success: false, project: slug, intent: "", hits: [] };
  }
  const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 20) : 5;
  const ranked = recallSkillsByIntent(slug, intent, limit);

  // Wave 3: reinforce-on-recall — a recall hit grows the skill's FSRS stability
  // (revives the dormant reinforcement loop). Throttled internally to bound
  // write-amplification; best-effort so a write error never breaks recall.
  for (const r of ranked) {
    try {
      reinforceSkillFsrs(slug, r.skill.meta.slug);
    } catch {
      // swallow — recall must never throw on a reinforcement failure
    }
  }

  return {
    success: true,
    project: slug,
    intent,
    hits: ranked.map(toHit),
  };
}
