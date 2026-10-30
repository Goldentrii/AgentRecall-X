/**
 * Palace identity card — ~50 token project summary.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { palaceDir } from "../storage/paths.js";
import { appendLedgerEvent } from "../ledger/append.js";
import { enqueueLedger } from "../storage/ledger-queue.js";

export function readIdentity(project: string): string {
  const idPath = path.join(palaceDir(project), "identity.md");
  if (!fs.existsSync(idPath)) {
    return `# ${project}\n\n> No identity card yet. Use palace_write to add one.`;
  }
  return fs.readFileSync(idPath, "utf-8");
}

export function writeIdentity(project: string, content: string): void {
  const idPath = path.join(palaceDir(project), "identity.md");
  fs.writeFileSync(idPath, content, "utf-8");
  // Provenance (ledger): sync write path, queued (never throws).
  enqueueLedger(() => appendLedgerEvent({
    type: "palace.write",
    project,
    target: idPath,
    sha256: createHash("sha256").update(Buffer.from(content, "utf-8")).digest("hex"),
    bytes: Buffer.byteLength(content, "utf-8"),
    meta: { kind: "identity" },
  }));
}
