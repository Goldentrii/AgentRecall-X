#!/usr/bin/env node
/**
 * clean-project-slugs.mjs
 *
 * One-time (idempotent) cleanup: moves invalid project directories under
 * ~/.agent-recall/projects/ into a _quarantine/ sub-directory.
 *
 * Usage:
 *   node scripts/clean-project-slugs.mjs          # dry-run (default)
 *   node scripts/clean-project-slugs.mjs --apply   # actually move dirs
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── Slug validation (mirrors packages/core/src/storage/project.ts) ──────────

const SLUG_DENY_LIST = new Set([
  "build", "runtime", "palace", "mcp", "default",
  "phase-1", "monitor", "test",
]);

function isValidProjectSlug(slug) {
  if (!slug) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slug)) return false;
  if (slug.endsWith(".md")) return false;
  if (slug.startsWith("_")) return false;
  if (slug.startsWith(".")) return false; // hidden dirs (.aam, .agent-recall, .DS_Store)
  if (SLUG_DENY_LIST.has(slug.toLowerCase())) return false;
  if (slug.includes("..") || slug.includes("/") || slug.includes("\\")) return false;
  if (!/[a-zA-Z]/.test(slug)) return false;
  return true;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const PROJECTS_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".agent-recall",
  "projects"
);

const dryRun = !process.argv.includes("--apply");

if (!fs.existsSync(PROJECTS_DIR)) {
  console.error(`Projects dir not found: ${PROJECTS_DIR}`);
  process.exit(1);
}

const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
const valid = [];
const invalid = [];

for (const entry of entries) {
  const name = entry.name;

  // Skip non-directories, _quarantine itself, and .DS_Store
  if (!entry.isDirectory()) continue;
  if (name === "_quarantine") continue;

  if (isValidProjectSlug(name)) {
    valid.push(name);
  } else {
    invalid.push(name);
  }
}

// ── Summary table ────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`  Project slug cleanup  ${dryRun ? "(DRY RUN)" : "(APPLYING)"}`);
console.log(`${"─".repeat(60)}\n`);

console.log(`  Valid slugs:   ${valid.length}`);
console.log(`  Invalid slugs: ${invalid.length}\n`);

if (invalid.length > 0) {
  console.log("  INVALID (will be quarantined):");
  for (const slug of invalid.sort()) {
    let reason = "";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(slug)) reason = "UUID";
    else if (slug.endsWith(".md")) reason = ".md suffix";
    else if (slug.startsWith("_")) reason = "_ prefix";
    else if (slug.startsWith(".")) reason = "hidden dir";
    else if (slug.includes("..")) reason = "path traversal";
    else if (SLUG_DENY_LIST.has(slug.toLowerCase())) reason = "deny-listed";
    else if (!/[a-zA-Z]/.test(slug)) reason = "no letters";
    else reason = "unknown";

    console.log(`    ${slug.padEnd(50)} [${reason}]`);
  }
  console.log();
}

if (valid.length > 0) {
  console.log("  VALID (keeping):");
  for (const slug of valid.sort()) {
    console.log(`    ${slug}`);
  }
  console.log();
}

// ── Move invalid dirs ────────────────────────────────────────────────────────

if (invalid.length === 0) {
  console.log("  Nothing to clean up.\n");
  process.exit(0);
}

if (dryRun) {
  console.log("  Pass --apply to actually move invalid dirs to _quarantine/.\n");
  process.exit(0);
}

const quarantine = path.join(PROJECTS_DIR, "_quarantine");
if (!fs.existsSync(quarantine)) {
  fs.mkdirSync(quarantine, { recursive: true });
}

let moved = 0;
for (const slug of invalid) {
  const src = path.join(PROJECTS_DIR, slug);
  const dst = path.join(quarantine, slug);

  // Idempotent: skip if already quarantined (re-run safety)
  if (fs.existsSync(dst)) {
    console.log(`  SKIP (already quarantined): ${slug}`);
    continue;
  }

  try {
    fs.renameSync(src, dst);
    console.log(`  MOVED: ${slug}`);
    moved++;
  } catch (err) {
    console.error(`  ERROR moving ${slug}: ${err.message}`);
  }
}

console.log(`\n  Done. Moved ${moved}/${invalid.length} directories to _quarantine/.\n`);
