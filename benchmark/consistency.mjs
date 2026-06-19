#!/usr/bin/env node
/**
 * consistency.mjs — v3.4.22 "Trust" regression suite.
 *
 * Guards the core invariant surfaced by the 2026-06-11 external evaluation:
 *   "anything saved must be acknowledged as existing at orientation time,
 *    100% deterministically — with no session_end prerequisite."
 *
 * Reproduces the exact live-eval sequence. If any assertion fails, the
 * specific trust-break it covers has regressed.
 *
 * Run: node benchmark/consistency.mjs
 * Exit 0 = all pass, 1 = any fail.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Point the storage root at a throwaway dir BEFORE importing core.
const AR_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ar-consistency-"));
process.env.AGENT_RECALL_ROOT = AR_ROOT;

const core = await import("../packages/core/dist/index.js");
const {
  journalCapture, palaceWrite, sessionEnd, sessionStart,
  listRooms, countRoomEntries, readPalaceIndex,
} = core;

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  if (cond) { console.log("  ✅", label); pass++; }
  else { console.log("  ❌", label, detail ? "→ " + detail : ""); fail++; }
};

const PROJ = "t";

console.log(`\n[consistency] AR_ROOT=${AR_ROOT}\n`);

// ── Fixture: the exact live-eval sequence ────────────────────────────────
// 1. Incremental capture (CLI `ar capture` equivalent — journal_capture)
await journalCapture({ project: PROJ, question: "Q1", answer: "A1" });

// 2. High-importance palace write
await palaceWrite({
  project: PROJ, room: "architecture",
  content: "Decision X: use Supabase RLS for per-table isolation.",
  importance: "high",
});

// ── P0-1: session_start sees incremental writes, no session_end ──────────
console.log("[P0-1] session_start blind to incremental writes");
const ss1 = await sessionStart({ project: PROJ });
const ss1json = JSON.stringify(ss1);
check("session_start does NOT say 'No memory found'",
  !ss1json.includes("No memory found"),
  ss1.empty_state || "");
check("captured answer 'A1' is visible in session_start payload",
  ss1json.includes("A1"));

// ── P0-2: salience — content room outranks empty rooms ───────────────────
console.log("[P0-2] salience inversion");
const rooms = listRooms(PROJ);
check("top room is 'architecture' (content beats empty defaults)",
  rooms[0]?.slug === "architecture",
  "got: " + rooms.map(r => r.slug).join(", "));
check("no empty room ranks above a non-empty room", (() => {
  let sawEmpty = false;
  for (const r of rooms) {
    const empty = countRoomEntries(PROJ, r.slug) === 0;
    if (empty) sawEmpty = true;
    else if (sawEmpty) return false; // a non-empty room appeared after an empty one
  }
  return true;
})());
const idx = readPalaceIndex(PROJ);
const archCount = idx?.rooms?.architecture?.memory_count
  ?? idx?.architecture?.memory_count;
check("palace-index architecture.memory_count === 1", archCount === 1,
  "got: " + archCount);

// ── P0-3: session-1 insight surfaces at session-2 ────────────────────────
console.log("[P0-3] session-1 insight invisible at session-2");
await sessionEnd({
  project: PROJ,
  summary: "Closed the first working session on project t — wired the stack.",
  insights: [{
    title: "Supabase RLS is the per-table isolation mechanism for this app",
    evidence: "Chose it during architecture decision X",
    applies_when: ["supabase", "multi-tenant"],
    severity: "important",
  }],
});
const ss2 = await sessionStart({ project: PROJ });
const ss2json = JSON.stringify(ss2);
check("insight title surfaces in next session_start",
  ss2json.includes("Supabase RLS is the per-table isolation"));

// ── P0-2b: NAMED-TOPIC first write must count as content (reviewer HIGH #1) ─
// The happy path above writes to a room README (auto-target). A write to a
// NEW named topic file took a different code path that omitted the `### ` entry
// header, so countRoomEntries saw 0 and sorted the room empty. Guard it.
console.log("[P0-2b] named-topic first write counts as content");
await palaceWrite({
  project: PROJ, room: "decisions", topic: "auth-choice",
  content: "Chose Clerk over Auth0 for OTP support.", importance: "high",
});
check("named-topic room 'decisions' counts >= 1 entry",
  countRoomEntries(PROJ, "decisions") >= 1,
  "got: " + countRoomEntries(PROJ, "decisions"));

// ── P0-3b: session-1 insight surfaces even when awareness already full ──────
// (reviewer HIGH #2) Stuff 3+ confirmed global insights, then add a fresh
// project insight via session_end, and confirm it still appears — the project
// budget must be independent of the awareness top-3 cap.
console.log("[P0-3b] fresh project insight surfaces past a full awareness cap");
for (let i = 1; i <= 3; i++) {
  await sessionEnd({
    project: PROJ,
    summary: `Filler session ${i} to populate awareness with confirmed insights.`,
    insights: [{
      title: `Filler awareness insight number ${i} for cap testing`,
      evidence: "synthetic", applies_when: ["filler", "test"], severity: "important",
    }],
  });
}
await sessionEnd({
  project: PROJ,
  summary: "Session that adds the one fresh insight we must still see next time.",
  insights: [{
    title: "FRESH-MARKER insight that must survive a full awareness cap",
    evidence: "added last", applies_when: ["fresh", "marker"], severity: "important",
  }],
});
const ss3 = await sessionStart({ project: PROJ });
check("fresh session-1 insight visible despite full awareness top-3",
  JSON.stringify(ss3).includes("FRESH-MARKER"));

// ── P0-4: no promotional link in tool output ────────────────────────────
console.log("[P0-4] promotional link in tool output");
check("session_start payload contains no t.me / telegram URL",
  !/t\.me|telegram/i.test(ss2json));

// ── P1-1: no raw markdown header leak in rendered fields ─────────────────
console.log("[P1-1] markdown leak in card fields");
const traj = ss2.resume?.last_trajectory ?? "";
check("trajectory field has no leading '##' header", !/^\s*#{1,6}\s/m.test(traj),
  JSON.stringify(traj).slice(0, 60));

// ── cleanup ──────────────────────────────────────────────────────────────
try { fs.rmSync(AR_ROOT, { recursive: true, force: true }); } catch {}

console.log(`\n[consistency] PASS ${pass} / FAIL ${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
