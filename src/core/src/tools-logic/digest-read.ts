/**
 * Tool logic: read full content of a specific digest.
 */

import { resolveProject } from "../storage/project.js";
import { readDigest as readDigestFromStore, recordAccess } from "../digest/store.js";
import type { DigestReadInput, DigestReadResult } from "../digest/types.js";

export type { DigestReadInput, DigestReadResult };

export async function digestRead(input: DigestReadInput): Promise<DigestReadResult> {
  const project = await resolveProject(input.project ?? "auto");

  const CAP = 15000;
  const capContent = (r: typeof result) => {
    if (r.content && r.content.length > CAP) {
      return { ...r, content: r.content.slice(0, CAP) + "\n\n...(truncated, use digest recall for excerpts)" };
    }
    return r;
  };

  // Try project-scoped first
  let result = readDigestFromStore(project, input.digest_id, false);
  if (result.meta) {
    recordAccess(project, input.digest_id, false);
    return { success: true, ...capContent(result) };
  }

  // Try global
  result = readDigestFromStore(project, input.digest_id, true);
  if (result.meta) {
    recordAccess("__global__", input.digest_id, true);
    return { success: true, ...capContent(result) };
  }

  return { success: false, meta: null, content: null };
}
