/**
 * Tool logic: store a digest (pre-computed context).
 */

import { resolveProject } from "../storage/project.js";
import { createDigest } from "../digest/store.js";
import type { DigestStoreInput, DigestStoreResult } from "../digest/types.js";

export type { DigestStoreInput, DigestStoreResult };

export async function digestStore(input: DigestStoreInput): Promise<DigestStoreResult> {
  const project = await resolveProject(input.project ?? "auto");
  return createDigest({ ...input, project });
}
