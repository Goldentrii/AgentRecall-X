#!/usr/bin/env node
/**
 * replay-benchmark.mjs — §5 replay benchmark for the v3.5 improvement plan.
 *
 * Creates a synthetic multi-session project history, then queries at
 * session N+1 and measures 4 metrics:
 *
 *   1. Recall      — did the needed memory surface in results?
 *   2. Precision   — was surfaced content relevant (no noise)?
 *   3. Staleness   — was surfaced content still true (not superseded)?
 *   4. Correction-correctness — after a correction, does the latest fact win?
 *
 * Uses core APIs directly (same paths as MCP tools).
 * Gates all P1 work — changes must not lower these scores.
 *
 * Run: node benchmark/replay-benchmark.mjs
 * Exit 0 = baseline recorded, 1 = any metric at 0% (total failure).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const AR_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ar-replay-"));
process.env.AGENT_RECALL_ROOT = AR_ROOT;

const core = await import("../packages/core/dist/index.js");
const {
  sessionStart, sessionEnd, smartRemember, smartRecall,
  palaceWrite, journalCapture,
} = core;

// Also need corrections for correction-correctness test
const corrections = await import("../packages/core/dist/storage/corrections.js");
const { writeCorrection, readP0Corrections } = corrections;

const PROJ = "replay-bench";

const metrics = { recall: 0, recallTotal: 0, precision: 0, precisionTotal: 0,
                  staleness: 0, stalenessTotal: 0, correctionCorrectness: 0, correctionTotal: 0 };

function pct(n, d) { return d === 0 ? "N/A" : `${Math.round(n / d * 100)}%`; }

console.log(`\n[replay-benchmark] AR_ROOT=${AR_ROOT}\n`);

// ═══════════════════════════════════════════════════════════════════════
// SESSION 1 — Establish architecture decisions
// ═══════════════════════════════════════════════════════════════════════
console.log("── Session 1: establish context ──");

await sessionStart({ project: PROJ });

await palaceWrite({
  project: PROJ, room: "architecture",
  content: "Database choice: PostgreSQL with Supabase RLS for row-level security. Chosen over MongoDB for ACID compliance.",
  importance: "high",
});

await palaceWrite({
  project: PROJ, room: "architecture",
  content: "Auth strategy: Clerk middleware for Next.js with JWT session tokens. Chosen over Auth0 for Vercel-native integration.",
  importance: "high",
});

await palaceWrite({
  project: PROJ, room: "design",
  content: "Color scheme: dark mode primary, accent #6366F1 (indigo). No pure black backgrounds per user preference.",
  importance: "medium",
});

await journalCapture({
  project: PROJ,
  question: "Session 1 progress",
  answer: "Set up project scaffolding with Next.js 16, PostgreSQL, Clerk auth. All architecture decisions documented.",
});

await sessionEnd({
  project: PROJ,
  summary: "Established architecture: PostgreSQL+Supabase, Clerk auth, Next.js 16. Dark mode with indigo accent.",
  trajectory: "Implement API routes and database schema next.",
  insights: [{
    title: "Supabase RLS provides row-level security without custom middleware",
    evidence: "Evaluated 3 auth patterns; RLS eliminated 200 lines of custom authorization code",
    applies_when: ["database", "authorization", "multi-tenant"],
  }],
});

// ═══════════════════════════════════════════════════════════════════════
// SESSION 2 — Add a correction that supersedes session 1 content
// ═══════════════════════════════════════════════════════════════════════
console.log("── Session 2: correction + superseding fact ──");

await sessionStart({ project: PROJ });

// Correction: change auth strategy (supersedes Session 1)
await palaceWrite({
  project: PROJ, room: "architecture",
  content: "Auth strategy UPDATED: migrated from Clerk to Descope. Clerk had billing issues with our usage tier. Descope provides same Vercel integration with better pricing.",
  importance: "high",
});

// Save a correction about the auth change
writeCorrection(PROJ, {
  id: "2026-06-18-auth-descope",
  date: "2026-06-18",
  severity: "p0",
  project: PROJ,
  rule: "Use Descope for auth, not Clerk. Clerk was replaced due to billing issues.",
  context: "Clerk pricing escalated unexpectedly at our usage tier. All new auth code must use Descope SDK. Remove Clerk references.",
  tags: ["auth", "descope", "correction"],
});

await journalCapture({
  project: PROJ,
  question: "Session 2 progress",
  answer: "Migrated auth from Clerk to Descope. Updated all middleware references.",
});

await sessionEnd({
  project: PROJ,
  summary: "Auth migration: Clerk → Descope. Pricing was the driver. All middleware updated.",
  trajectory: "Test Descope integration in staging.",
});

// ═══════════════════════════════════════════════════════════════════════
// SESSION 3 — Add noise (unrelated content) to test precision
// ═══════════════════════════════════════════════════════════════════════
console.log("── Session 3: add noise content ──");

await sessionStart({ project: PROJ });

await palaceWrite({
  project: PROJ, room: "goals",
  content: "Q3 goal: launch beta with 50 users. Marketing landing page needed.",
});

await palaceWrite({
  project: PROJ, room: "blockers",
  content: "CI pipeline flaky: GitHub Actions runner times out on E2E tests. Need to switch to larger runner.",
});

await journalCapture({
  project: PROJ,
  question: "Unrelated session work",
  answer: "Spent time debugging CI runner timeouts. Not related to auth or database.",
});

await sessionEnd({
  project: PROJ,
  summary: "Fixed CI pipeline timeout issues. Unrelated to core architecture.",
  trajectory: "Deploy to staging.",
});

// ═══════════════════════════════════════════════════════════════════════
// SESSION 4 — Query session (measures all 4 metrics)
// ═══════════════════════════════════════════════════════════════════════
console.log("\n── Session 4: measurement queries ──\n");

const ss = await sessionStart({ project: PROJ });

// ── METRIC 1: Recall ──────────────────────────────────────────────────
// Can we find the database decision from Session 1?
console.log("[Recall]");
{
  const r = await smartRecall({ query: "what database did we choose", project: PROJ });
  const text = JSON.stringify(r.results ?? []);
  const found = text.includes("PostgreSQL") || text.includes("Supabase");
  metrics.recallTotal++;
  if (found) metrics.recall++;
  console.log(`  ${found ? "\u2705" : "\u274C"} "what database" → ${found ? "found PostgreSQL" : "MISSED"} (${r.results?.length ?? 0} results)`);
}
{
  const r = await smartRecall({ query: "color scheme and design decisions", project: PROJ });
  const text = JSON.stringify(r.results ?? []);
  const found = text.includes("indigo") || text.includes("6366F1") || text.includes("dark mode");
  metrics.recallTotal++;
  if (found) metrics.recall++;
  console.log(`  ${found ? "\u2705" : "\u274C"} "color scheme" → ${found ? "found design" : "MISSED"} (${r.results?.length ?? 0} results)`);
}
{
  // Test recall of insight from Session 1
  const r = await smartRecall({ query: "row-level security benefits", project: PROJ });
  const text = JSON.stringify(r.results ?? []);
  const found = text.includes("RLS") || text.includes("row-level") || text.includes("authorization");
  metrics.recallTotal++;
  if (found) metrics.recall++;
  console.log(`  ${found ? "\u2705" : "\u274C"} "row-level security" → ${found ? "found RLS insight" : "MISSED"} (${r.results?.length ?? 0} results)`);
}

// ── METRIC 2: Precision ───────────────────────────────────────────────
// When querying "auth strategy", do we get relevant results (not CI noise)?
console.log("\n[Precision]");
{
  const r = await smartRecall({ query: "authentication strategy and provider", project: PROJ });
  const results = r.results ?? [];
  metrics.precisionTotal += results.length;
  for (const item of results) {
    const text = JSON.stringify(item).toLowerCase();
    const relevant = text.includes("auth") || text.includes("clerk") || text.includes("descope")
      || text.includes("jwt") || text.includes("session token");
    if (relevant) metrics.precision++;
  }
  const prcn = results.length > 0 ? Math.round(metrics.precision / results.length * 100) : 0;
  console.log(`  ${results.length} results, ${metrics.precision} relevant → ${prcn}% precision`);
}

// ── METRIC 3: Staleness ───────────────────────────────────────────────
// When querying "auth", does the LATEST fact (Descope) rank above the old one (Clerk)?
console.log("\n[Staleness]");
{
  const r = await smartRecall({ query: "current auth provider", project: PROJ });
  const results = r.results ?? [];
  const text = JSON.stringify(results);
  // Check that Descope appears (current fact)
  const hasDescope = text.includes("Descope");
  const hasClerk = text.includes("Clerk");
  metrics.stalenessTotal++;
  if (hasDescope) {
    metrics.staleness++;
    // Bonus check: if both present, Descope should rank first
    if (hasClerk && results.length >= 2) {
      const descopeIdx = results.findIndex(r => JSON.stringify(r).includes("Descope"));
      const clerkIdx = results.findIndex(r => JSON.stringify(r).includes("Clerk") && !JSON.stringify(r).includes("Descope"));
      if (clerkIdx >= 0 && descopeIdx < clerkIdx) {
        console.log("  \u2705 Descope ranks above Clerk (staleness-aware ordering)");
      } else if (clerkIdx >= 0) {
        console.log("  \u26A0\uFE0F  Both present but Clerk ranks equal/above Descope");
      }
    }
  }
  console.log(`  ${hasDescope ? "\u2705" : "\u274C"} "current auth" → ${hasDescope ? "found Descope (current)" : "MISSED current fact"}`);
  if (hasClerk && !hasDescope) console.log("  \u274C returned STALE fact (Clerk) without current (Descope)");
}

// ── METRIC 4: Correction-correctness ──────────────────────────────────
// After the P0 correction "use Descope not Clerk", does session_start show it?
console.log("\n[Correction-correctness]");
{
  const correctionText = JSON.stringify(ss.corrections);
  const hasDescopeCorrection = correctionText.includes("Descope");
  metrics.correctionTotal++;
  if (hasDescopeCorrection) metrics.correctionCorrectness++;
  console.log(`  ${hasDescopeCorrection ? "\u2705" : "\u274C"} session_start corrections include Descope rule`);

  // Also verify via recall
  const r = await smartRecall({ query: "which auth provider should we use", project: PROJ });
  const recallText = JSON.stringify(r.results ?? []);
  const recallHasDescope = recallText.includes("Descope");
  metrics.correctionTotal++;
  if (recallHasDescope) metrics.correctionCorrectness++;
  console.log(`  ${recallHasDescope ? "\u2705" : "\u274C"} recall for "which auth provider" → ${recallHasDescope ? "Descope (correct)" : "MISSED correction"}`);
}

// ═══════════════════════════════════════════════════════════════════════
// SCORECARD
// ═══════════════════════════════════════════════════════════════════════
console.log("\n══════════════════════════════════════════════════════");
console.log("  REPLAY BENCHMARK SCORECARD");
console.log("══════════════════════════════════════════════════════");
console.log(`  Recall                ${pct(metrics.recall, metrics.recallTotal).padStart(6)}  (${metrics.recall}/${metrics.recallTotal})`);
console.log(`  Precision             ${pct(metrics.precision, metrics.precisionTotal).padStart(6)}  (${metrics.precision}/${metrics.precisionTotal})`);
console.log(`  Staleness             ${pct(metrics.staleness, metrics.stalenessTotal).padStart(6)}  (${metrics.staleness}/${metrics.stalenessTotal})`);
console.log(`  Correction-correct    ${pct(metrics.correctionCorrectness, metrics.correctionTotal).padStart(6)}  (${metrics.correctionCorrectness}/${metrics.correctionTotal})`);
console.log("══════════════════════════════════════════════════════\n");

// Write results to file for comparison
const resultPath = path.join(import.meta.dirname, "replay-results.json");
const resultData = {
  date: new Date().toISOString().slice(0, 10),
  version: "3.4.27",
  recall: { score: metrics.recall, total: metrics.recallTotal, pct: metrics.recallTotal > 0 ? metrics.recall / metrics.recallTotal : null },
  precision: { score: metrics.precision, total: metrics.precisionTotal, pct: metrics.precisionTotal > 0 ? metrics.precision / metrics.precisionTotal : null },
  staleness: { score: metrics.staleness, total: metrics.stalenessTotal, pct: metrics.stalenessTotal > 0 ? metrics.staleness / metrics.stalenessTotal : null },
  correction_correctness: { score: metrics.correctionCorrectness, total: metrics.correctionTotal, pct: metrics.correctionTotal > 0 ? metrics.correctionCorrectness / metrics.correctionTotal : null },
};
fs.writeFileSync(resultPath, JSON.stringify(resultData, null, 2) + "\n");
console.log(`Results written to ${resultPath}`);

// Cleanup
fs.rmSync(AR_ROOT, { recursive: true, force: true });

// Exit 1 only if any metric is at 0% (total system failure)
const anyZero = (metrics.recallTotal > 0 && metrics.recall === 0)
  || (metrics.precisionTotal > 0 && metrics.precision === 0)
  || (metrics.stalenessTotal > 0 && metrics.staleness === 0)
  || (metrics.correctionTotal > 0 && metrics.correctionCorrectness === 0);

process.exit(anyZero ? 1 : 0);
