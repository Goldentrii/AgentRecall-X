/**
 * Which files under the store are ledgered-class (spec §8). verify reports an
 * orphan for any of them without an event; backfill writes the missing event.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { PROJECTS_DIRNAME } from "../storage/paths.js";

/** Human-readable form of the ledgered-class globs (spec §8). */
export const LEDGERED_GLOBS: readonly string[] = [
  "projects/*/journal/*.md (except index.md, _index.md)",
  "projects/*/palace/**/*.md (except log.md, _index.md)",
  "projects/*/palace/corrections.json",
  "projects/*/corrections/*.json (except _-prefixed: _index.md, _outcomes.jsonl, _rejected.jsonl are derived)",
  "projects/*/skills/**",
  "insights-index.json",
];

/** Derived / ignored paths (spec §8) — never a finding. Entries ending in "/" are directory prefixes. */
export const DERIVED_PATHS: readonly string[] = [
  "index.jsonl",
  "palace-index.json",
  "_room.json",
  "graph.json",
  "recent-sessions.jsonl",
  "cwd-allowlist.json",
  "owner.json",
  "index/",
  "telemetry/",
  "ledger/",
];

function isDerived(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  return DERIVED_PATHS.some((d) => (d.endsWith("/") ? rel.startsWith(d) : base === d));
}

/** rel = store-relative, "/" separated. */
export function isLedgeredTarget(rel: string): boolean {
  if (isDerived(rel)) return false;
  if (rel === "insights-index.json") return true;
  const m = rel.match(/^projects\/([^/]+)\/(.+)$/);
  if (!m) return false;
  const inner = m[2];
  const base = inner.slice(inner.lastIndexOf("/") + 1);
  if (/^journal\/[^/]+\.md$/.test(inner)) return base !== "index.md" && base !== "_index.md";
  if (/^corrections\/[^/]+\.json$/.test(inner)) return !base.startsWith("_");
  if (inner === "palace/corrections.json") return true;
  // palace/log.md is the operation log; every _index.md is a regenerated index
  if (inner.startsWith("palace/")) return base.endsWith(".md") && base !== "_index.md" && inner !== "palace/log.md";
  if (inner.startsWith("skills/")) return true;
  return false;
}

function walkDir(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkDir(full, out);
    else if (e.isFile()) out.push(full);
  }
}

/** Ledgered-class files on disk, sorted by target. insights-index.json belongs to project "_global". */
export function walkLedgeredFiles(
  root: string = getRoot(),
  project?: string,
): Array<{ target: string; project: string; mtimeMs: number }> {
  const out: Array<{ target: string; project: string; mtimeMs: number }> = [];
  const add = (abs: string, proj: string): void => {
    const target = path.relative(root, abs).replaceAll("\\", "/");
    if (!isLedgeredTarget(target)) return;
    try {
      out.push({ target, project: proj, mtimeMs: fs.statSync(abs).mtimeMs });
    } catch {
      // vanished between readdir and stat
    }
  };
  const projectsDir = path.join(root, PROJECTS_DIRNAME);
  let slugs: string[] = [];
  try {
    slugs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    // no projects dir
  }
  for (const slug of slugs) {
    if (project !== undefined && slug !== project) continue;
    const files: string[] = [];
    walkDir(path.join(projectsDir, slug), files);
    for (const f of files) add(f, slug);
  }
  if (project === undefined || project === "_global") {
    const ins = path.join(root, "insights-index.json");
    if (fs.existsSync(ins)) add(ins, "_global");
  }
  return out.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
}
