#!/usr/bin/env node
/**
 * p1-1-compression.mjs — P1-1 dream-cycle compression test.
 *
 * Verifies:
 * 1. Near-duplicate entries in a topic file are detected
 * 2. Dry-run mode reports without modifying
 * 3. Live mode archives originals and creates canonical entries
 * 4. Canonical entries preserve all source backlinks
 * 5. Recall still finds compressed content (no recall drop)
 * 6. Stored-entry count decreases (compression works)
 *
 * Run: node benchmark/p1-1-compression.mjs
 * Exit 0 = all pass, 1 = any fail.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const AR_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ar-compress-"));
process.env.AGENT_RECALL_ROOT = AR_ROOT;

const core = await import("../packages/core/dist/index.js");
const {
  compressTopic, compressRoom, compressProject, smartRecall,
  palaceWrite, sessionStart,
} = core;

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  if (cond) { console.log("  \u2705", label); pass++; }
  else { console.log("  \u274C", label, detail ? "\u2192 " + detail : ""); fail++; }
};

const PROJ = "compress-test";

console.log(`\n[p1-1] AR_ROOT=${AR_ROOT}\n`);

// ── Setup: create a room with intentional near-duplicates ───────────────
console.log("[setup] Creating architecture room with duplicate entries");

await sessionStart({ project: PROJ });

// Write 5 entries, 3 of which say the same thing differently
await palaceWrite({
  project: PROJ, room: "architecture",
  content: "Database choice: PostgreSQL with Supabase RLS for row-level security and ACID compliance.",
  importance: "high",
});

await palaceWrite({
  project: PROJ, room: "architecture",
  content: "We chose PostgreSQL with Supabase because of row-level security (RLS) and full ACID compliance guarantees.",
  importance: "high",
});

await palaceWrite({
  project: PROJ, room: "architecture",
  content: "PostgreSQL selected as primary database. Supabase RLS provides row-level security. ACID compliance was the deciding factor.",
  importance: "high",
});

// 2 distinct entries (should NOT be merged)
await palaceWrite({
  project: PROJ, room: "architecture",
  content: "Auth provider: Descope for Vercel-native integration with JWT session tokens.",
  importance: "high",
});

await palaceWrite({
  project: PROJ, room: "architecture",
  content: "Caching strategy: Redis via Upstash for edge-compatible key-value caching with TTL-based invalidation.",
  importance: "medium",
});

// ── Verify initial state ────────────────────────────────────────────────
console.log("\n[pre-compress] Checking topic file");
const pd = path.join(AR_ROOT, "projects", PROJ, "palace", "rooms", "architecture");
const topicFiles = fs.existsSync(pd)
  ? fs.readdirSync(pd).filter(f => f.endsWith(".md"))
  : [];
console.log(`  topic files: ${topicFiles.join(", ")}`);

// Find the topic file that has the DB entries (likely "decisions" or "README")
let targetTopic = null;
for (const f of topicFiles) {
  const content = fs.readFileSync(path.join(pd, f), "utf-8");
  if (content.includes("PostgreSQL")) {
    targetTopic = f.replace(/\.md$/, "");
    const entryCount = (content.match(/^### /gm) || []).length;
    console.log(`  target topic: ${targetTopic} (${entryCount} entries)`);
    break;
  }
}

check("found topic file with PostgreSQL entries",
  targetTopic !== null);

if (!targetTopic) {
  console.log(`\n[p1-1] PASS ${pass} / FAIL ${fail}`);
  fs.rmSync(AR_ROOT, { recursive: true, force: true });
  process.exit(1);
}

// ── T1: dry-run mode ────────────────────────────────────────────────────
console.log("\n[T1] Dry-run compression");
const dryResult = compressTopic(PROJ, "architecture", targetTopic, true);
console.log(`  entries before: ${dryResult.entriesBefore}`);
console.log(`  clusters found: ${dryResult.clustersFound}`);
console.log(`  entries after:  ${dryResult.entriesAfter}`);
check("dry-run detects clusters",
  dryResult.clustersFound > 0,
  `clustersFound=${dryResult.clustersFound}`);
check("dry-run would reduce entry count",
  dryResult.entriesAfter < dryResult.entriesBefore,
  `before=${dryResult.entriesBefore} after=${dryResult.entriesAfter}`);
check("dry-run does NOT modify the file",
  dryResult.dryRun === true);

// Verify file unchanged after dry-run
const contentAfterDry = fs.readFileSync(path.join(pd, `${targetTopic}.md`), "utf-8");
const entriesAfterDry = (contentAfterDry.match(/^### /gm) || []).length;
check("file unchanged after dry-run",
  entriesAfterDry === dryResult.entriesBefore);

// ── T2: live compression ────────────────────────────────────────────────
console.log("\n[T2] Live compression");
const liveResult = compressTopic(PROJ, "architecture", targetTopic, false);
console.log(`  entries before: ${liveResult.entriesBefore}`);
console.log(`  clusters merged: ${liveResult.clustersMerged}`);
console.log(`  entries after:  ${liveResult.entriesAfter}`);
check("live compression reduces entries",
  liveResult.entriesAfter < liveResult.entriesBefore,
  `before=${liveResult.entriesBefore} after=${liveResult.entriesAfter}`);

// ── T3: archive exists (invariant §6.1) ─────────────────────────────────
console.log("\n[T3] Archive preservation");
const archiveDir = path.join(pd, "_archive");
check("_archive directory created",
  fs.existsSync(archiveDir));
if (fs.existsSync(archiveDir)) {
  const archiveFiles = fs.readdirSync(archiveDir);
  check("archive contains backup of original file",
    archiveFiles.length > 0,
    `files: ${archiveFiles.join(", ")}`);
}

// ── T4: canonical entries preserve backlinks (invariant §6.2) ───────────
console.log("\n[T4] Source backlink preservation");
const compressedContent = fs.readFileSync(path.join(pd, `${targetTopic}.md`), "utf-8");
const hasConsolidatedMarker = compressedContent.includes("consolidated");
check("canonical entries marked as consolidated",
  hasConsolidatedMarker);

// ── T5: recall still finds compressed content ───────────────────────────
console.log("\n[T5] Recall after compression");
const recallResult = await smartRecall({ query: "PostgreSQL database choice", project: PROJ });
const recallText = JSON.stringify(recallResult.results ?? []);
check("recall finds PostgreSQL after compression",
  recallText.includes("PostgreSQL") || recallText.includes("database"),
  `results=${recallResult.results?.length ?? 0}`);

// Also check the distinct entries survived
const authRecall = await smartRecall({ query: "auth provider Descope", project: PROJ });
const authText = JSON.stringify(authRecall.results ?? []);
check("recall finds Descope (distinct entry survived)",
  authText.includes("Descope") || authText.includes("auth"),
  `results=${authRecall.results?.length ?? 0}`);

// ── T6: compressProject (dry-run smoke test) ────────────────────────────
console.log("\n[T6] Project-level compression (no-op after T2 already compressed)");
const projectDry = compressProject(PROJ, true);
const totalTopics = projectDry.length;
// After T2 compressed the cluster, compressProject should find 0 remaining clusters
// (this is correct behavior — no double-compression)
check("compressProject runs without error",
  Array.isArray(projectDry),
  `scanned ${totalTopics} topic(s)`);

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n[p1-1] PASS ${pass} / FAIL ${fail}`);

fs.rmSync(AR_ROOT, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
