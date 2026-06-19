#!/usr/bin/env node
/**
 * room-slug-guards.mjs — v3.4.23 regression suite for empty/blank palace-room routing.
 *
 * Guards the bug surfaced 2026-06-13 by the war-room dashboard:
 *   An empty `room` arg silently created a blank palace room. `sanitizeSlug("")`
 *   returns "unnamed", so the on-disk dir was `unnamed/`, but `createRoom` persisted
 *   the RAW slug ("") into `_room.json`. Result: (a) meta.slug desynced from its dir,
 *   (b) 216 writes routed to a nameless room over time, (c) the Cytoscape palace graph
 *   crashed on the empty node id.
 *
 * Invariants locked here:
 *   - createRoom throws on empty/whitespace slug (root-cause guard).
 *   - palace_write throws on empty/whitespace room (boundary guard, no side effects).
 *   - journal_write with a whitespace-only palace_room succeeds and skips palace
 *     (the journal entry must NOT be aborted by the createRoom throw).
 *   - createRoom persists the SANITIZED slug into _room.json (meta.slug === dir name).
 *
 * Run: node benchmark/room-slug-guards.mjs
 * Exit 0 = all pass, 1 = any fail.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Point the storage root at a throwaway dir BEFORE importing core.
const AR_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ar-slug-guards-"));
process.env.AGENT_RECALL_ROOT = AR_ROOT;

const core = await import("../packages/core/dist/index.js");
const { palaceWrite, journalWrite, createRoom, listRooms } = core;

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  if (cond) { console.log("  ✅", label); pass++; }
  else { console.log("  ❌", label, detail ? "→ " + detail : ""); fail++; }
};
const throws = async (fn, re) => {
  try { await fn(); return false; }
  catch (e) { return re.test(e.message); }
};

const PROJ = "t";

console.log(`\n[room-slug-guards] AR_ROOT=${AR_ROOT}\n`);

// ── Root-cause guard: createRoom rejects empty/whitespace slug ────────────
console.log("[G1] createRoom rejects empty slug");
check("createRoom('') throws clear error",
  await throws(() => createRoom(PROJ, "", "N", "d"), /empty/i));
check("createRoom('   ') throws clear error",
  await throws(() => createRoom(PROJ, "   ", "N", "d"), /empty/i));

// ── Boundary guard: palace_write rejects empty/whitespace room ────────────
console.log("[G2] palace_write rejects empty room before side effects");
check("palace_write({room:''}) throws",
  await throws(() => palaceWrite({ project: PROJ, room: "", content: "x" }), /required|empty/i));
check("palace_write({room:'   '}) throws",
  await throws(() => palaceWrite({ project: PROJ, room: "   ", content: "x" }), /required|empty/i));

// ── journal_write must NOT abort on a whitespace-only palace_room ─────────
console.log("[G3] journal_write survives whitespace palace_room");
let jw;
let jwThrew = false;
try { jw = await journalWrite({ project: PROJ, content: "guard entry", palace_room: "   " }); }
catch (e) { jwThrew = true; }
check("journal_write(whitespace room) does not throw", !jwThrew);
check("journal_write(whitespace room) skips palace (palace === null)", jw?.palace === null);

// ── meta.slug consistency: sanitized slug persisted, surfaced to agent ────
console.log("[G4] createRoom persists sanitized slug; palace_write returns it");
const res = await palaceWrite({ project: PROJ, room: "My Room", content: "hello" });
check("palace_write('My Room').room === 'My-Room' (sanitized)", res.room === "My-Room",
  String(res.room));
const rooms = listRooms(PROJ);
const blank = rooms.filter((r) => !String(r.slug ?? "").trim());
check("no room in listRooms has an empty/blank slug", blank.length === 0,
  JSON.stringify(blank));
const myRoom = rooms.find((r) => r.slug === "My-Room");
check("listRooms reports the sanitized slug 'My-Room'", !!myRoom,
  JSON.stringify(rooms.map((r) => r.slug)));

// ── cleanup ───────────────────────────────────────────────────────────────
try { fs.rmSync(AR_ROOT, { recursive: true, force: true }); } catch {}

console.log(`\n[room-slug-guards] PASS ${pass} / FAIL ${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
