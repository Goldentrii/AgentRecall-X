#!/usr/bin/env node
/**
 * heeded-guard.mjs — regression suite for the "1 outcome per correction per day"
 * guard in session_end.
 *
 * Root cause it guards: `retrieved` is incremented at most once/day (session_start
 * guard via last_retrieved), but session_end used to record a "heeded" outcome for
 * EVERY correction retrieved today on EVERY session_end call. Multiple sessions in
 * one day therefore pushed heeded_count past retrieved_count, producing nonsensical
 * "11/10 heeded" / precision > 1.0. The guard skips a correction whose last_outcome
 * is already today, so heeded_count can never outrun retrieved_count.
 *
 * Run: node benchmark/heeded-guard.mjs
 * Exit 0 = all pass, 1 = any fail.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Throwaway storage root BEFORE importing core.
const AR_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ar-heeded-"));
process.env.AGENT_RECALL_ROOT = AR_ROOT;

const core = await import("../packages/core/dist/index.js");
const { sessionEnd, writeCorrection, recordOutcome, readCorrections } = core;

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  if (cond) { console.log("  ✅", label); pass++; }
  else { console.log("  ❌", label, detail ? "→ " + detail : ""); fail++; }
};

const PROJ = "heeded-guard-test";
console.log(`\n[heeded-guard] AR_ROOT=${AR_ROOT}\n`);

// ── Setup: one correction, retrieved once today ──────────────────────────────
console.log("[T1] one outcome per correction per day");

const RULE = "Always pin dependency versions in the lockfile before release";
const w = writeCorrection(PROJ, { id: "c-pin-deps", rule: RULE, context: "build broke from a floating minor bump" });
check("correction written (passes quality gate)", w.written === true, JSON.stringify(w));

// Simulate session_start surfacing it today → retrieved_count = 1, last_retrieved = now.
recordOutcome({ correction_id: "c-pin-deps", project: PROJ, kind: "retrieved", at: new Date().toISOString() });

const afterRetrieve = readCorrections(PROJ).find((c) => c.id === "c-pin-deps");
check("retrieved_count = 1 after one retrieval", afterRetrieve?.retrieved_count === 1,
  `got ${afterRetrieve?.retrieved_count}`);

// Two session_ends in the SAME day. Summary is unrelated to the rule (no recurrence),
// so each would record a "heeded" — but the 1/day guard must allow only the first.
const SUMMARY =
  "Shipped the new onboarding flow and fixed two layout bugs in the settings page. " +
  "Reviewed the API error handling and tidied up the logging configuration across services.";

await sessionEnd({ project: PROJ, summary: SUMMARY });
await sessionEnd({ project: PROJ, summary: SUMMARY + " Second save later the same day." });

const afterTwoEnds = readCorrections(PROJ).find((c) => c.id === "c-pin-deps");
const h = afterTwoEnds?.heeded_count ?? 0;
const r = afterTwoEnds?.retrieved_count ?? 0;

check("heeded_count = 1 after TWO same-day session_ends (guard held)", h === 1, `heeded=${h}`);
check("heeded_count never exceeds retrieved_count", h <= r, `heeded=${h} retrieved=${r}`);
check("precision is in [0,1]", afterTwoEnds?.precision == null || (afterTwoEnds.precision >= 0 && afterTwoEnds.precision <= 1),
  `precision=${afterTwoEnds?.precision}`);

// ── Cleanup ──────────────────────────────────────────────────────────────────
try { fs.rmSync(AR_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n[heeded-guard] PASS ${pass} / FAIL ${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
