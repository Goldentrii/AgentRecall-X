/**
 * Palace identity card — ~50 token project summary.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { palaceDir } from "../storage/paths.js";

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
}
