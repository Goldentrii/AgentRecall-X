#!/usr/bin/env node
// Cards v1 bench fixture: golden-v1 copy + 1,600-char identity card + max state card per project.
// Usage: npm run build && node scripts/eval/cards-at-cap-fixture.mjs <out-dir>
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const items = (n, len, tag) => Array.from({ length: n }, (_, i) => `${tag} ${i} `.padEnd(len, "x"));
export function seedCardsAtCap(core, slugs, now = new Date()) {
  core.writeIdentityCard(("# Owner\n" + "- reply in the owner's language; code in English\n".repeat(40)).slice(0, 1599) + ".", now);
  for (const slug of slugs) core.writeStateCard(slug, core.mergeStateCard({ previous: null, session: "cards-at-cap", now, summary: "s".repeat(300), state: { goal: "g".repeat(300), next: "n".repeat(300), open_decisions: items(5, 160, "decision"), blockers: items(5, 160, "blocker"), pointers: items(8, 200, "F:\\Projects\\pointer") } }).card);
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const out = process.argv[2];
  if (!out) { process.stderr.write("usage: node scripts/eval/cards-at-cap-fixture.mjs <out-dir>\n"); process.exit(1); }
  const core = await import(pathToFileURL(path.join(HERE, "..", "..", "packages", "core", "dist", "index.js")).href);
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(path.join(HERE, "fixtures", "golden-v1"), out, { recursive: true });
  core.setRoot(path.resolve(out));
  seedCardsAtCap(core, fs.readdirSync(path.join(out, "projects")), new Date("2026-10-31T00:00:00Z"));
  process.stdout.write(`cards-at-cap fixture written: ${out}\n`);
}
