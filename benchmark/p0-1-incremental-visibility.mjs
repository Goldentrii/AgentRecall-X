#!/usr/bin/env node
/**
 * p0-1-incremental-visibility.mjs — P0-1 reproduction test.
 *
 * Tests the hypothesis: "Memories written via smart_remember mid-session
 * are not surfaced by a subsequent session_start unless session_end ran."
 *
 * Scenario:
 *   1. Fresh project → session_start (baseline)
 *   2. smart_remember("KEYSTONE-FACT-XYZ") mid-session (no session_end)
 *   3. session_start again
 *   4. Assert KEYSTONE-FACT-XYZ is visible in session_start payload
 *   5. Assert recall("KEYSTONE") finds it
 *
 * Each route of smart_remember is tested independently:
 *   - palace_write (architecture/decision keywords)
 *   - journal_capture (session/progress keywords)
 *   - knowledge_write (bug/fix keywords)
 *   - awareness_update (insight/pattern keywords)
 *
 * Run: node benchmark/p0-1-incremental-visibility.mjs
 * Exit 0 = all pass (bug not confirmed), 1 = any fail (bug confirmed).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Isolated throwaway root — BEFORE importing core.
const AR_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ar-p01-"));
process.env.AGENT_RECALL_ROOT = AR_ROOT;

const core = await import("../packages/core/dist/index.js");
const { smartRemember, sessionStart, smartRecall } = core;

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  if (cond) { console.log("  \u2705", label); pass++; }
  else { console.log("  \u274C", label, detail ? "\u2192 " + detail : ""); fail++; }
};

const PROJ = "p01-test";

console.log(`\n[p0-1] AR_ROOT=${AR_ROOT}\n`);

// ── Test 1: palace_write route ──────────────────────────────────────────
console.log("[T1] smart_remember \u2192 palace_write route");
{
  const r = await smartRemember({
    content: "Architecture decision KEYSTONE-PALACE-ABC: use event sourcing for audit trail",
    context: "architecture",
    project: PROJ,
  });
  check("smart_remember succeeded (palace route)",
    r.success && r.routed_to === "palace_write",
    `routed_to=${r.routed_to}`);

  // session_start without session_end
  const ss = await sessionStart({ project: PROJ });
  const ssJson = JSON.stringify(ss);
  check("session_start does NOT say 'No memory found' after palace write",
    !ssJson.includes("No memory found"),
    ss.empty_state || "");
  check("palace content visible in active_rooms or payload",
    ss.active_rooms.length > 0 || ssJson.includes("event sourcing") || ssJson.includes("KEYSTONE-PALACE-ABC"));
}

// ── Test 2: journal_capture route ───────────────────────────────────────
console.log("\n[T2] smart_remember \u2192 journal_capture route");
{
  const r = await smartRemember({
    content: "Today I completed the KEYSTONE-JOURNAL-DEF migration and made good progress on the dashboard",
    context: "session",
    project: PROJ,
  });
  check("smart_remember succeeded (journal_capture route)",
    r.success && r.routed_to === "journal_capture",
    `routed_to=${r.routed_to}`);

  const ss = await sessionStart({ project: PROJ });
  const ssJson = JSON.stringify(ss);
  check("capture visible in recent_captures",
    ss.recent_captures.length > 0 || ssJson.includes("KEYSTONE-JOURNAL-DEF"),
    `recent_captures.length=${ss.recent_captures.length}`);
}

// ── Test 3: knowledge_write route ───────────────────────────────────────
console.log("\n[T3] smart_remember \u2192 knowledge_write route");
{
  const r = await smartRemember({
    content: "Bug fix: KEYSTONE-KNOWLEDGE-GHI. The root cause was a null pointer in the auth middleware. Exception thrown on every request.",
    context: "bug",
    project: PROJ,
  });
  check("smart_remember succeeded (knowledge_write route)",
    r.success && r.routed_to === "knowledge_write",
    `routed_to=${r.routed_to}`);

  const ss = await sessionStart({ project: PROJ });
  const ssJson = JSON.stringify(ss);
  // knowledge_write also writes to palace room "knowledge"
  check("knowledge content visible in session_start (via palace 'knowledge' room)",
    ssJson.includes("knowledge") || ss.active_rooms.some(r => r.name.toLowerCase().includes("knowledge")),
    `active_rooms=${JSON.stringify(ss.active_rooms.map(r => r.name))}`);
}

// ── Test 4: awareness_update route ──────────────────────────────────────
console.log("\n[T4] smart_remember \u2192 awareness_update route");
{
  const r = await smartRemember({
    content: "Across all projects I always observed the pattern KEYSTONE-AWARENESS-JKL that retry logic without exponential backoff causes cascading failures in distributed systems.",
    context: "insight",
    project: PROJ,
  });
  check("smart_remember succeeded (awareness_update route)",
    r.success && r.routed_to === "awareness_update",
    `routed_to=${r.routed_to}`);

  const ss = await sessionStart({ project: PROJ });
  const ssJson = JSON.stringify(ss);
  check("insight visible in session_start insights",
    ss.insights.length > 0 || ssJson.includes("KEYSTONE-AWARENESS-JKL") || ssJson.includes("cascading failures"),
    `insights=${JSON.stringify(ss.insights.map(i => i.title))}`);
}

// ── Test 5: recall finds content written via smart_remember ─────────────
console.log("\n[T5] recall finds smart_remember content (no session_end)");
{
  const r = await smartRecall({ query: "KEYSTONE", project: PROJ });
  check("recall returns results for 'KEYSTONE'",
    r.results && r.results.length > 0,
    `results.length=${r.results?.length ?? 0}`);

  // At least one result should contain one of our keystone markers
  const allText = JSON.stringify(r.results ?? []);
  const hasAny = ["KEYSTONE-PALACE-ABC", "KEYSTONE-JOURNAL-DEF", "KEYSTONE-KNOWLEDGE-GHI", "KEYSTONE-AWARENESS-JKL"]
    .some(k => allText.includes(k));
  check("recall result contains at least one KEYSTONE marker",
    hasAny,
    `first result excerpt: ${JSON.stringify(r.results?.[0])?.slice(0, 200)}`);
}

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n[p0-1] PASS ${pass} / FAIL ${fail}`);

// Cleanup
fs.rmSync(AR_ROOT, { recursive: true, force: true });

process.exit(fail > 0 ? 1 : 0);
