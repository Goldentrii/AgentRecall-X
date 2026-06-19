#!/usr/bin/env node
/**
 * p0-2-archive-reachability.mjs — P0-2 reproduction test.
 *
 * After journal rollup archives entries to journal/archive/, verify:
 *   (a) recall finds content from archived entries
 *   (b) listJournalFiles includes archived entries
 *   (c) readJournalFile resolves dates whose files moved to archive/
 *
 * Run: node benchmark/p0-2-archive-reachability.mjs
 * Exit 0 = all pass, 1 = any fail.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Isolated throwaway root — BEFORE importing core.
const AR_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ar-p02-"));
process.env.AGENT_RECALL_ROOT = AR_ROOT;

const core = await import("../packages/core/dist/index.js");
const {
  journalCapture, journalRollup, smartRecall,
  listJournalFiles, readJournalFile,
} = core;

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  if (cond) { console.log("  \u2705", label); pass++; }
  else { console.log("  \u274C", label, detail ? "\u2192 " + detail : ""); fail++; }
};

const PROJ = "p02-test";

console.log(`\n[p0-2] AR_ROOT=${AR_ROOT}\n`);

// ── Fixture: create journal entries with old dates ──────────────────────
// We need entries old enough to pass the min_age_days filter.
// Write them directly to simulate entries from 14+ days ago.
const journalDir = path.join(AR_ROOT, "projects", PROJ, "journal");
fs.mkdirSync(journalDir, { recursive: true });

const oldDate1 = "2026-05-01";
const oldDate2 = "2026-05-02";
const oldDate3 = "2026-05-04";  // same week as 01/02

const content1 = `# ${oldDate1} — ${PROJ}\n\n## Brief\nArchived entry about UNIQUE-ARCHIVE-ALPHA architecture decisions.\n\n## Next\nContinue with ALPHA work.\n`;
const content2 = `# ${oldDate2} — ${PROJ}\n\n## Brief\nArchived entry about UNIQUE-ARCHIVE-BETA performance improvements.\n\n## Next\nOptimize BETA further.\n`;
const content3 = `# ${oldDate3} — ${PROJ}\n\n## Brief\nArchived entry about UNIQUE-ARCHIVE-GAMMA security hardening.\n\n## Next\nAudit GAMMA results.\n`;

fs.writeFileSync(path.join(journalDir, `${oldDate1}.md`), content1);
fs.writeFileSync(path.join(journalDir, `${oldDate2}.md`), content2);
fs.writeFileSync(path.join(journalDir, `${oldDate3}.md`), content3);

// ── Pre-rollup baseline ────────────────────────────────────────────────
console.log("[baseline] Pre-rollup checks");
const preFiles = listJournalFiles(PROJ);
check("pre-rollup: 3 journal files visible",
  preFiles.length === 3,
  `found ${preFiles.length}`);

const preRead = readJournalFile(PROJ, oldDate1);
check("pre-rollup: readJournalFile finds 2026-05-01",
  preRead && preRead.includes("UNIQUE-ARCHIVE-ALPHA"));

// ── Force rollup (min_age=0 to bypass age check) ──────────────────────
console.log("\n[rollup] Running journalRollup with min_age_days=0");
const rollupResult = await journalRollup({
  project: PROJ,
  min_age_days: 0,
  min_entries: 2,
  dry_run: false,
});
check("rollup executed",
  rollupResult.entriesArchived > 0,
  `archived=${rollupResult.entriesArchived}, weeks=${rollupResult.weeksRolledUp}`);

// Verify files actually moved to archive/
const archiveDir = path.join(journalDir, "archive");
const archiveExists = fs.existsSync(archiveDir);
check("archive/ directory created",
  archiveExists);

if (archiveExists) {
  const archivedFiles = fs.readdirSync(archiveDir).filter(f => f.endsWith(".md"));
  check("archived files exist in journal/archive/",
    archivedFiles.length > 0,
    `files: ${archivedFiles.join(", ")}`);
}

// Verify originals removed from top-level
const remainingTopLevel = fs.readdirSync(journalDir)
  .filter(f => f.endsWith(".md") && f !== "index.md" && !f.startsWith("W"));
// W-prefix files are the weekly summaries created by rollup
console.log(`  (top-level remaining: ${remainingTopLevel.join(", ") || "(none)"})`);

// ── Post-rollup: the actual P0-2 tests ─────────────────────────────────
console.log("\n[P0-2a] listJournalFiles includes archived entries");
const postFiles = listJournalFiles(PROJ);
const hasArchivedInList = postFiles.some(e =>
  e.date === oldDate1 || e.date === oldDate2 || e.date === oldDate3
);
check("listJournalFiles returns entries from archive/",
  hasArchivedInList,
  `found ${postFiles.length} total, dates: ${postFiles.map(e => e.date).join(", ")}`);

console.log("\n[P0-2b] readJournalFile resolves archived dates");
const postRead1 = readJournalFile(PROJ, oldDate1);
check("readJournalFile(2026-05-01) finds archived entry",
  postRead1 !== null && postRead1.includes("UNIQUE-ARCHIVE-ALPHA"),
  postRead1 === null ? "returned null" : "content doesn't match");

const postRead2 = readJournalFile(PROJ, oldDate2);
check("readJournalFile(2026-05-02) finds archived entry",
  postRead2 !== null && postRead2.includes("UNIQUE-ARCHIVE-BETA"),
  postRead2 === null ? "returned null" : "content doesn't match");

console.log("\n[P0-2c] recall finds content from archived entries");
const recallResult = await smartRecall({ query: "UNIQUE-ARCHIVE-ALPHA", project: PROJ });
const recallText = JSON.stringify(recallResult.results ?? []);
check("recall returns results for archived content",
  recallResult.results && recallResult.results.length > 0,
  `results.length=${recallResult.results?.length ?? 0}`);
check("recall result contains ALPHA marker",
  recallText.includes("UNIQUE-ARCHIVE-ALPHA") || recallText.includes("ALPHA"),
  `first result: ${JSON.stringify(recallResult.results?.[0])?.slice(0, 200)}`);

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n[p0-2] PASS ${pass} / FAIL ${fail}`);

// Cleanup
fs.rmSync(AR_ROOT, { recursive: true, force: true });

process.exit(fail > 0 ? 1 : 0);
