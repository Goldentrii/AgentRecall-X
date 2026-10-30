import { resolveProject } from "../storage/project.js";
import { writeSkill, type SkillBody } from "../palace/skills.js";
import { appendLedgerEvent } from "../ledger/append.js";
import { flushLedgerQueue } from "../storage/ledger-queue.js";

export interface SkillWriteInput {
  project?: string;
  name: string;
  topic: string;
  triggers: string[];
  file_globs?: string[];
  when: string;
  preconditions?: string[];
  steps: string[];
  postconditions?: string[];
  pitfalls?: string[];
  evidence?: string[];
  source?: "manual" | "promoted_from_correction" | "promoted_from_pipeline" | "auto_reflection";
}

export interface SkillWriteResult {
  success: boolean;
  project: string;
  slug: string;
  file_path: string;
  error?: string;
}

export async function skillWrite(input: SkillWriteInput): Promise<SkillWriteResult> {
  const slug = await resolveProject(input.project);
  const name = (input.name ?? "").trim();
  const topic = (input.topic ?? "").trim();
  const when = (input.when ?? "").trim();
  if (!name) return { success: false, project: slug, slug: "", file_path: "", error: "name required" };
  if (!topic) return { success: false, project: slug, slug: "", file_path: "", error: "topic required (e.g. 'deploy', 'git')" };
  if (!when) return { success: false, project: slug, slug: "", file_path: "", error: "when (trigger description) required" };
  if (!input.steps || input.steps.length === 0) {
    return { success: false, project: slug, slug: "", file_path: "", error: "steps must have at least one entry" };
  }
  if (!input.triggers || input.triggers.length === 0) {
    return { success: false, project: slug, slug: "", file_path: "", error: "triggers must have at least one keyword" };
  }

  const now = new Date().toISOString();
  const body: SkillBody = {
    when,
    preconditions: input.preconditions ?? [],
    steps: input.steps,
    postconditions: input.postconditions ?? [],
    pitfalls: input.pitfalls,
    evidence: input.evidence,
  };
  const filePath = writeSkill(slug, {
    slug: "", // writeSkill will derive from name via sanitizeSlug
    name,
    topic,
    triggers: input.triggers,
    file_globs: input.file_globs,
    created: now,
    updated: now,
    source: input.source ?? "manual",
  }, body, undefined, { ledger: false });

  // Provenance (ledger): the skill file write has definitely succeeded.
  await appendLedgerEvent({ type: "skill.write", project: slug, target: filePath, meta: { file: filePath.split(/[\\/]/).pop(), skill: name, topic } });
  await flushLedgerQueue();

  return {
    success: true,
    project: slug,
    slug: filePath.split("/").pop()!.replace(/^\d+-|\.md$/g, ""),
    file_path: filePath,
  };
}
