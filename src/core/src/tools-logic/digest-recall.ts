/**
 * Tool logic: recall matching digests for a query.
 */

import { resolveProject } from "../storage/project.js";
import { findMatchingDigests } from "../digest/match.js";
import { recordAccess } from "../digest/store.js";
import type { DigestRecallInput, DigestRecallResult } from "../digest/types.js";

export type { DigestRecallInput, DigestRecallResult };

export async function digestRecall(input: DigestRecallInput): Promise<DigestRecallResult> {
  const project = await resolveProject(input.project ?? "auto");
  const limit = input.limit ?? 5;

  const digests = findMatchingDigests(input.query, project, {
    includeStale: input.include_stale ?? false,
    includeGlobal: input.include_global ?? true,
    limit,
  });

  // Record access for non-stale matches
  for (const d of digests) {
    if (!d.stale) {
      const isGlobal = d.project === "__global__";
      recordAccess(isGlobal ? "__global__" : d.project, d.id, isGlobal);
    }
  }

  const tokensSaved = digests
    .filter((d) => !d.stale)
    .reduce((sum, d) => sum + d.token_estimate, 0);

  return {
    query: input.query,
    digests,
    result_count: digests.length,
    tokens_saved_estimate: tokensSaved,
  };
}
