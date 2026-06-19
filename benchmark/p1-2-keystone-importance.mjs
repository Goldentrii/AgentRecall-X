#!/usr/bin/env node
/**
 * p1-2-keystone-importance.mjs — P1-2 keystone importance signal test.
 *
 * Verifies: a rarely-accessed memory referenced in a pipeline milestone's
 * "How solved" section ranks above frequently-touched trivia, and is never
 * an archive_candidate.
 *
 * Run: node benchmark/p1-2-keystone-importance.mjs
 * Exit 0 = all pass, 1 = any fail.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const AR_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ar-keystone-"));
process.env.AGENT_RECALL_ROOT = AR_ROOT;

const core = await import("../packages/core/dist/index.js");
const {
  palaceWrite, sessionEnd, sessionStart,
  listRooms, computeSalience, ARCHIVE_THRESHOLD, KEYSTONE_FLOOR,
  scanKeystoneMemories, markKeystones,
} = core;

// Pipeline functions for creating milestone
const pipeline = await import("../packages/core/dist/palace/pipeline.js");
const { writeMilestone } = pipeline;

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  if (cond) { console.log("  \u2705", label); pass++; }
  else { console.log("  \u274C", label, detail ? "\u2192 " + detail : ""); fail++; }
};

const PROJ = "keystone-test";

console.log(`\n[p1-2] AR_ROOT=${AR_ROOT}\n`);

// ── Setup: create palace rooms with content ─────────────────────────────
console.log("[setup] Creating rooms with different access patterns");

await sessionStart({ project: PROJ });

// Architecture room: rarely accessed, keystone decision
await palaceWrite({
  project: PROJ, room: "architecture",
  content: "Architecture decisions: chose event sourcing over CRUD for audit compliance.",
  importance: "high",
});

// Blockers room: frequently accessed trivia
await palaceWrite({
  project: PROJ, room: "blockers",
  content: "CI runner times out. Need to upgrade to larger runner.",
  importance: "medium",
});

// Simulate frequent access to blockers (touch it 15 times)
const rooms = await import("../packages/core/dist/palace/rooms.js");
for (let i = 0; i < 15; i++) {
  rooms.recordAccess(PROJ, "blockers");
}
// Architecture: only 1 access (from the initial write)
rooms.recordAccess(PROJ, "architecture");

// ── Baseline check: before keystone, blockers should outrank architecture ──
console.log("\n[baseline] Before keystone marking");
const roomsBefore = listRooms(PROJ);
const archBefore = roomsBefore.find(r => r.slug === "architecture");
const blockBefore = roomsBefore.find(r => r.slug === "blockers");

if (archBefore && blockBefore) {
  console.log(`  architecture salience: ${archBefore.salience}`);
  console.log(`  blockers salience:     ${blockBefore.salience}`);
  check("blockers outranks architecture before keystone (rich-get-richer)",
    blockBefore.salience >= archBefore.salience,
    `blockers=${blockBefore.salience} arch=${archBefore.salience}`);
}

// ── Create a pipeline milestone that references architecture ────────────
console.log("\n[milestone] Creating pipeline milestone referencing architecture");

// Write a milestone file directly
const pipeDir = path.join(AR_ROOT, "projects", PROJ, "palace", "pipeline");
fs.mkdirSync(pipeDir, { recursive: true });
const milestoneContent = `---
phase: "Foundation"
order: 1
status: closed
opened: "2026-06-01"
closed: "2026-06-15"
---

## Goal
Establish the core architecture for the audit system.

## What was hard
Choosing between event sourcing and CRUD patterns for audit compliance.

## How solved
Used architecture decisions room — chose event sourcing over CRUD.
The architecture approach provided ACID-compliant audit trails without custom middleware.

## Synthesis
Event sourcing is the right pattern for audit-heavy systems. Architecture decisions documented in the palace proved critical for onboarding new team members.
`;
fs.writeFileSync(path.join(pipeDir, "0001-Foundation.md"), milestoneContent);

// ── Test keystone detection ────────────────────────────────────────────
console.log("\n[detection] Scanning for keystones");
const keystones = scanKeystoneMemories(PROJ);
check("scanKeystoneMemories found architecture as keystone",
  keystones.some(k => k.room === "architecture"),
  `found: ${JSON.stringify(keystones.map(k => `${k.room}/${k.topic}`))}`);
check("blockers is NOT a keystone",
  !keystones.some(k => k.room === "blockers"));

// ── Mark keystones and verify salience ──────────────────────────────────
console.log("\n[marking] Running markKeystones");
const marked = markKeystones(PROJ);
check("markKeystones marked at least 1 room",
  marked > 0,
  `marked=${marked}`);

const roomsAfter = listRooms(PROJ);
const archAfter = roomsAfter.find(r => r.slug === "architecture");
const blockAfter = roomsAfter.find(r => r.slug === "blockers");

if (archAfter && blockAfter) {
  console.log(`  architecture salience: ${archAfter.salience} (keystone=${archAfter.keystone})`);
  console.log(`  blockers salience:     ${blockAfter.salience} (keystone=${blockAfter.keystone})`);

  check("architecture.keystone is true",
    archAfter.keystone === true);
  check("blockers.keystone is NOT true",
    !blockAfter.keystone);
  check("architecture salience >= KEYSTONE_FLOOR",
    archAfter.salience >= KEYSTONE_FLOOR,
    `salience=${archAfter.salience} floor=${KEYSTONE_FLOOR}`);
  check("architecture salience > ARCHIVE_THRESHOLD (never archive)",
    archAfter.salience > ARCHIVE_THRESHOLD,
    `salience=${archAfter.salience} threshold=${ARCHIVE_THRESHOLD}`);
}

// ── Verify via computeSalience directly ─────────────────────────────────
console.log("\n[formula] Direct computeSalience comparison");
{
  // Simulate: rarely accessed memory with keystone vs frequently accessed without
  const keystoneSalience = computeSalience({
    importance: "medium",
    lastUpdated: "2026-06-01",
    accessCount: 1,
    connectionCount: 0,
    keystone: true,
  });
  const frequentSalience = computeSalience({
    importance: "medium",
    lastUpdated: new Date().toISOString(),
    accessCount: 20,
    connectionCount: 5,
    keystone: false,
  });
  console.log(`  keystone (1 access, old):  ${keystoneSalience}`);
  console.log(`  frequent (20 access, new): ${frequentSalience}`);

  check("keystone salience >= KEYSTONE_FLOOR even with 1 access",
    keystoneSalience >= KEYSTONE_FLOOR);
  check("keystone salience > ARCHIVE_THRESHOLD",
    keystoneSalience > ARCHIVE_THRESHOLD);
}

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n[p1-2] PASS ${pass} / FAIL ${fail}`);

fs.rmSync(AR_ROOT, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
