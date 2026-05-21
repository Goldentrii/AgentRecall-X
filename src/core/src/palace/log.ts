/**
 * Palace operation log — parseable audit trail.
 * Inspired by llm_wiki's wiki/log.md pattern.
 *
 * Every palace operation (write, consolidate, lint, archive) is logged
 * in a structured, grep-friendly format.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { palaceDir } from "../storage/paths.js";
import { ensureDir } from "../storage/fs-utils.js";

export function appendToLog(
  project: string,
  operation: string,
  details: Record<string, unknown>
): void {
  const pd = palaceDir(project);
  ensureDir(pd);
  const logPath = path.join(pd, "log.md");

  const timestamp = new Date().toISOString();
  const detailStr = Object.entries(details)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");

  const line = `[${timestamp}] ${operation}: ${detailStr}\n`;

  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, `# Palace Operation Log\n\n${line}`, "utf-8");
  } else {
    fs.appendFileSync(logPath, line, "utf-8");
  }
}
