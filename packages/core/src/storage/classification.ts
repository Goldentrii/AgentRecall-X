// packages/core/src/storage/classification.ts
//
// Wave 1 — Privacy classification: the SINGLE source of truth for the
// personal-vs-project split. Pure, no IO.
//
// Two disjoint surfaces, by design:
//   - classifyStore() covers the SYNC surface. `awareness` and `corrections` (and
//     `_global` palace writes) are personal through the Supabase `store` union.
//     `corrections` requires the double opt-in (sync_personal AND sync_corrections)
//     before it flows through syncToSupabase — it is not silently ignored.
//   - classifyPath() covers the GIT/.gitignore surface — corrections,
//     behavior-policies.json, the future `personal/` tier.
//
// Keeping these explicit means the moment someone adds a new personal artifact
// they register it HERE, and the sync gate + (future) .gitignore both honor it.

export type Tier = "personal" | "project";

/**
 * The personal values reachable via the sync `store` union
 * ("journal" | "palace" | "awareness" | "digest" | "corrections"). Awareness
 * carries the corrections-derived behavioral layer (Blind Spots), so it is
 * personal. `corrections` is also personal — it is a PERSONAL_PATH_MARKER
 * (see below) and requires the double opt-in gate in supabase/sync.ts
 * (sync_personal AND sync_corrections) before leaving the machine.
 *
 * NB (single-source guarantee): every member here MUST classifyStore() =>
 * "personal" so the gate in supabase/sync.ts catches it. A unit test asserts
 * exactly that.
 */
export const PERSONAL_STORES: ReadonlySet<string> = new Set(["awareness", "corrections"]);

/**
 * Classify a Supabase sync `store` (+ optional project) onto the privacy tier.
 *
 * - `awareness` store ⇒ personal (the behavioral layer leak we are gating).
 * - `corrections` store ⇒ personal (PERSONAL_PATH_MARKER, double opt-in in sync.ts).
 * - any write tagged with the `_global` project ⇒ personal (bootstrap writes
 *   palace under the `_global` sentinel).
 * - everything else ⇒ project.
 *
 * Total over any input (unknown/undefined store ⇒ "project") — never throws.
 */
export function classifyStore(
  store: string | undefined,
  opts?: { project?: string }
): Tier {
  if (store !== undefined && PERSONAL_STORES.has(store)) return "personal";
  if (opts?.project === "_global") return "personal";
  return "project";
}

/**
 * Markers that mean a filesystem path holds personal data. Used by the
 * git/.gitignore surface (Wave 5 onward). Disjoint from classifyStore by design
 * — these artifacts do not flow through syncToSupabase.
 */
const PERSONAL_PATH_MARKERS: readonly string[] = [
  "/corrections/",
  "/awareness",
  "behavior-policies.json",
  "/projects/_global/",
  // No trailing slash (mirrors "/awareness") so it matches BOTH the bare
  // `projects/<slug>/personal` directory and every file under it. A path that
  // legitimately ends in "personal" inside a project is exactly the personal
  // tier we mean to gate.
  "/personal",
];

/**
 * Classify an absolute path onto the privacy tier. Substring match on the
 * personal markers; default project. Never throws.
 */
export function classifyPath(absPath: string): Tier {
  // Markers are written with forward slashes; normalize Windows separators
  // so a backslash path cannot dodge the personal-tier gate.
  const normalized = absPath.replace(/\\/g, "/");
  for (const marker of PERSONAL_PATH_MARKERS) {
    if (normalized.includes(marker)) return "personal";
  }
  return "project";
}

/** A project slug is personal iff it is the `_global` cross-project sentinel. */
export function isPersonalProject(slug: string): boolean {
  return slug === "_global";
}
