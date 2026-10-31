#!/usr/bin/env node
// Cards v1 bench fixture: golden-v1 copy + 1,600-char identity card + max state card per project.
// Usage: npm run build && node scripts/eval/cards-at-cap-fixture.mjs [out-dir]
//   No out-dir: a fresh mkdtemp dir under the OS temp dir (path printed). A new or empty out-dir is filled; a non-empty
//   one is regenerated ONLY if it holds the sentinel this script wrote (else exit 2). Nothing else is ever deleted.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SENTINEL = ".cards-at-cap-fixture";
const items = (n, len, tag) => Array.from({ length: n }, (_, i) => `${tag} ${i} `.padEnd(len, "x"));
export function seedCardsAtCap(core, slugs, now = new Date()) {
  core.writeIdentityCard(("# Owner\n" + "- reply in the owner's language; code in English\n".repeat(40)).slice(0, 1599) + ".", now);
  for (const slug of slugs) core.writeStateCard(slug, core.mergeStateCard({ previous: null, session: "cards-at-cap", now, summary: "s".repeat(300), state: { goal: "g".repeat(300), next: "n".repeat(300), open_decisions: items(5, 160, "decision"), blockers: items(5, 160, "blocker"), pointers: items(8, 200, "F:\\Projects\\pointer") } }).card);
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const arg = process.argv[2];
  const out = arg ? path.resolve(arg) : fs.mkdtempSync(path.join(os.tmpdir(), "cards-at-cap-"));
  if (fs.existsSync(out)) {
    const isDir = fs.statSync(out).isDirectory();
    if ((!isDir || fs.readdirSync(out).length > 0) && !(isDir && fs.existsSync(path.join(out, SENTINEL)))) {
      process.stderr.write(`refusing to touch ${out}: it is not an empty directory and holds no ${SENTINEL} sentinel (this script only regenerates directories it wrote). Pass a new or empty directory, or no argument for a temp dir.\n`);
      process.exit(2);
    }
    // Only an empty or sentinel-stamped directory gets here: clear its contents (never the directory itself).
    for (const entry of fs.readdirSync(out)) fs.rmSync(path.join(out, entry), { recursive: true, force: true });
  }
  const core = await import(pathToFileURL(path.join(HERE, "..", "..", "packages", "core", "dist", "index.js")).href);
  fs.cpSync(path.join(HERE, "fixtures", "golden-v1"), out, { recursive: true });
  fs.writeFileSync(path.join(out, SENTINEL), "written by scripts/eval/cards-at-cap-fixture.mjs; safe to regenerate\n");
  core.setRoot(out);
  seedCardsAtCap(core, fs.readdirSync(path.join(out, "projects")), new Date("2026-10-31T00:00:00Z"));
  process.stdout.write(`cards-at-cap fixture written: ${out}\n`);
}
