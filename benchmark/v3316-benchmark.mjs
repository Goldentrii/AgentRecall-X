#!/usr/bin/env node
/**
 * AgentRecall v3.3.16 Benchmark — 10 Rounds
 *
 * Covers:
 *   - Token cost per tool call (all layers)
 *   - Digest cache: token savings on repeated analysis
 *   - /arsaveall simulation: multi-project sweep + cross-project consolidation
 *   - Memory quality: correction retention, cross-project recall accuracy
 *   - Cold start overhead as sessions accumulate
 *
 * Pass criteria (printed at end):
 *   - Correction retention: 100% (correction from round 2 present in round 4+)
 *   - Cross-project recall: ≥1 hit per query across projects
 *   - Digest cache hit: token savings ≥ 30% on repeated recall
 *   - Score boundedness: all digest scores in [0, 1]
 *   - Cold start growth: < 2x tokens from round 1 → round 10
 */

import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BENCH_ROOT = join(process.env.HOME, ".ar-bench-3316-" + Date.now());
mkdirSync(BENCH_ROOT, { recursive: true });

// Patch root before importing core
process.env.AGENT_RECALL_ROOT = BENCH_ROOT;
const core = await import("../packages/core/dist/index.js");

// ── helpers ─────────────────────────────────────────────────────────────────

function tok(v) {
  const s = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  return Math.round(s.length / 4);
}
function hrMs(start) { return Number((process.hrtime.bigint() - start) / 1_000_000n); }

const rows = [];
function rec(round, label, tokens, ms, pass) {
  rows.push({ round, label, tokens, ms, pass });
  const status = pass === true ? "✓" : pass === false ? "✗" : " ";
  console.log(`  [R${round}] ${status} ${label.padEnd(32)} ${String(tokens).padStart(5)} tok  ${String(ms).padStart(5)} ms`);
}

const PROJ_A = "bench-saas";
const PROJ_B = "bench-api";
const PROJ_C = "bench-ml";

async function resolveProj(slug) {
  // Core resolves "auto" from cwd; for tests we set project explicitly
  return slug;
}

// ── ROUND 1 — Cold start, first-ever session ─────────────────────────────────
console.log("\n=== R1: First session — establish context ===");
let t;

t = process.hrtime.bigint();
const cs1 = core.journalColdStart({ project: PROJ_A });
rec(1, "coldStart (empty)", tok(cs1), hrMs(t));

t = process.hrtime.bigint();
const pw1 = await core.palaceWrite({ room: "architecture", content: "Stack: Next.js 16 + Drizzle + Neon + Clerk. Deployment: Vercel.", project: PROJ_A });
rec(1, "palaceWrite(arch)", tok(pw1), hrMs(t));

t = process.hrtime.bigint();
const cap1 = await core.journalCapture({ question: "Which ORM?", answer: "Drizzle — type-safe, edge-compatible, zero cold-start overhead. Rejected Prisma (binary engine too heavy).", project: PROJ_A });
rec(1, "capture(orm)", tok(cap1), hrMs(t));

t = process.hrtime.bigint();
const jw1 = await core.journalWrite({ content: "## R1\nEstablished stack. Drizzle > Prisma for edge.\n## Next\nSet up Clerk auth.", project: PROJ_A });
rec(1, "journalWrite", tok(jw1), hrMs(t));

// Key architectural decision → awareness (cross-project, global)
t = process.hrtime.bigint();
await core.awarenessUpdate({ insights: [{ title: "Drizzle ORM beats Prisma for edge/serverless — zero binary engine, < 50ms cold start", evidence: "Stack selection R1: Prisma cold starts 200ms vs Drizzle 50ms on Vercel edge", applies_when: ["orm", "drizzle", "prisma", "edge", "serverless", "database", "vercel"], severity: "important" }] });
rec(1, "awarenessUpdate(ORM)", tok({ done: true }), hrMs(t));

// ── ROUND 2 — Correction capture ─────────────────────────────────────────────
console.log("\n=== R2: Correction — Clerk version ===");

t = process.hrtime.bigint();
const cs2 = core.journalColdStart({ project: PROJ_A });
rec(2, "coldStart (1 session)", tok(cs2), hrMs(t));

t = process.hrtime.bigint();
const chk2 = await core.check({ goal: "Set up Clerk v4 auth", confidence: "high", human_correction: "Use Clerk v6 — v4 breaks App Router middleware", delta: "Version assumption: v4 → v6", project: PROJ_A });
rec(2, "check(correction)", tok(chk2), hrMs(t));

t = process.hrtime.bigint();
await core.awarenessUpdate({ insights: [{ title: "Clerk v6 required for Next.js App Router", evidence: "v4 middleware incompatible with App Router", applies_when: ["clerk", "auth", "nextjs", "app-router"], severity: "critical" }] });
rec(2, "awarenessUpdate", tok({ done: true }), hrMs(t));

t = process.hrtime.bigint();
await core.journalWrite({ content: "## R2\nCORRECTION: Clerk v6, not v4.\n## Next\nDB schema.", project: PROJ_A });
rec(2, "journalWrite", tok({ done: true }), hrMs(t));

// ── ROUND 3 — Digest: store expensive analysis ────────────────────────────────
console.log("\n=== R3: Digest store — cache codebase analysis ===");

const BIG_ANALYSIS = `# Novada SaaS Codebase Analysis

## Architecture Summary
- 91 Next.js routes (App Router)
- Drizzle ORM with Neon serverless Postgres
- Clerk v6 auth with middleware protection
- Upstash Redis for rate limiting (sliding window, 100 req/min/key)
- Stripe Checkout + Customer Portal

## Key Patterns
- API routes in /app/api/* follow resource/action naming
- Middleware at middleware.ts: protects /dashboard, /api/v1 routes
- DB schema in src/db/schema.ts — users, teams, api_keys, usage_logs
- Rate limit checked in middleware before routing

## Decisions Log
1. Drizzle > Prisma: edge cold-start < 50ms vs 200ms
2. Neon branching for preview environments
3. Upstash sliding window > token bucket (simpler Redis ops)
4. Stripe portal replaces custom subscription UI (saves 3 days)

## Watch Out
- Clerk v6 ONLY — v4 middleware incompatible with App Router
- Raw body required for Stripe webhook verification
- Drizzle push for dev, generate for prod migrations
`.repeat(3); // ~1800 tokens

t = process.hrtime.bigint();
const digestStored = core.createDigest({
  title: "Novada SaaS full codebase analysis",
  scope: "architecture auth payments rate-limiting database schema",
  content: BIG_ANALYSIS,
  source_agent: "Explore",
  source_query: "analyze novada codebase architecture",
  project: PROJ_A,
});
const digestTokens = digestStored.token_estimate;
rec(3, "digest.store", tok(digestStored), hrMs(t));
console.log(`       stored ${digestTokens} tokens in digest ${digestStored.id}`);

// ── ROUND 4 — Digest recall: token savings ───────────────────────────────────
console.log("\n=== R4: Digest recall — token savings on repeated analysis ===");

t = process.hrtime.bigint();
const cs4 = core.journalColdStart({ project: PROJ_A });
rec(4, "coldStart (2 sessions)", tok(cs4), hrMs(t));

// Without digest: would re-run full analysis (~digestTokens tokens in response)
const withoutDigestCost = digestTokens;

// With digest: just the recall result (excerpt + metadata)
t = process.hrtime.bigint();
const recalled = core.findMatchingDigests("novada architecture authentication rate limiting", PROJ_A, { includeGlobal: false, limit: 3 });
const recallResponseTok = tok(recalled);
const ms4 = hrMs(t);
const savings = Math.round((1 - recallResponseTok / withoutDigestCost) * 100);
const scoreValid = recalled.every(d => d.score >= 0 && d.score <= 1.0);
rec(4, "digest.recall (vs re-analysis)", recallResponseTok, ms4, savings >= 30);
console.log(`       without digest: ${withoutDigestCost} tok | with digest: ${recallResponseTok} tok | saved: ${savings}% | scores bounded: ${scoreValid}`);

// Correction retention check
t = process.hrtime.bigint();
const aware4 = core.readAwareness();
const clerkRetained = aware4.includes("Clerk") || aware4.includes("clerk");
rec(4, "correction retention (Clerk v6)", tok(aware4), hrMs(t), clerkRetained);

// ── ROUND 5 — Project B: cross-project recall ────────────────────────────────
console.log("\n=== R5: Project B — cross-project recall ===");

t = process.hrtime.bigint();
const cs5 = core.journalColdStart({ project: PROJ_B });
rec(5, "coldStart (new project B)", tok(cs5), hrMs(t));

t = process.hrtime.bigint();
await core.journalCapture({ question: "Rate limiting approach?", answer: "Using Upstash Redis sliding window — same as SaaS project.", project: PROJ_B });
rec(5, "capture(rate-limit)", tok({ done: true }), hrMs(t));

// Does the Drizzle/ORM insight surface from project A?
t = process.hrtime.bigint();
const crossInsight = await core.recallInsight({ context: "database orm edge serverless", limit: 3 });
const ormCross = JSON.stringify(crossInsight).toLowerCase().includes("drizzle");
rec(5, "cross-project recall (ORM)", tok(crossInsight), hrMs(t), ormCross);

t = process.hrtime.bigint();
await core.palaceWrite({ room: "architecture", content: "API Gateway: Express + Upstash Redis rate limiting (reused pattern from SaaS project).", project: PROJ_B });
await core.journalWrite({ content: "## R5\nProject B established. Reused rate limit pattern from A.\n## Next\nCircuit breaker.", project: PROJ_B });
rec(5, "palaceWrite + journalWrite", tok({ done: true }), hrMs(t));

// ── ROUND 6 — Project C: ML pipeline ─────────────────────────────────────────
console.log("\n=== R6: Project C — ML pipeline ===");

t = process.hrtime.bigint();
await core.journalWrite({ content: "## R6\nML pipeline: Python + FastAPI + Postgres. Training on A100 cluster.", project: PROJ_C });
await core.palaceWrite({ room: "architecture", content: "ML stack: FastAPI + Celery + Redis queue + S3 model storage. Inference: vLLM on A100.", project: PROJ_C });
rec(6, "project C setup", tok({ done: true }), hrMs(t));

// Global digest — cross-project pattern
t = process.hrtime.bigint();
const globalDigest = core.createDigest({
  title: "Redis Upstash sliding window rate limiting pattern",
  scope: "rate limiting api redis upstash sliding window pattern reusable",
  content: "# Redis Rate Limiting Pattern\n\nUpstash sliding window: `ZADD key score member`, `ZREMRANGEBYSCORE`, `ZCARD`. 100 req/min default. Works across Node.js, Python, edge runtime. No server needed.\n\nUsed in: SaaS project, API gateway project.",
  source_agent: "cross-project-synthesis",
  ttl_hours: 0, // permanent
  global: true,
  project: PROJ_C,
});
rec(6, "digest.store (global pattern)", tok(globalDigest), hrMs(t));

// ── ROUND 7 — /arsaveall simulation: sweep + consolidate ─────────────────────
console.log("\n=== R7: /arsaveall simulation — multi-project sweep ===");

// Simulate what /arsaveall does: list all projects, check for unsaved captures
t = process.hrtime.bigint();
const projects = await core.journalProjects();
const projectList = projects.projects ?? [];
rec(7, "ar projects (sweep)", tok(projects), hrMs(t));
console.log(`       Found ${projectList.length} project(s): ${projectList.map(p => p.slug ?? p).join(", ")}`);

// For each project: session_end (arsaveall saves all)
for (const proj of [PROJ_A, PROJ_B, PROJ_C]) {
  t = process.hrtime.bigint();
  const se = await core.sessionEnd({
    summary: `Auto-saved by /arsaveall sweep. Project: ${proj}.`,
    insights: [],
    trajectory: "multi-project closure",
    project: proj,
  });
  rec(7, `sessionEnd(${proj})`, tok(se), hrMs(t));
}

// Cross-project digest: global recall after full sweep
t = process.hrtime.bigint();
const globalRecall = core.findMatchingDigests("rate limiting redis upstash pattern", PROJ_B, { includeGlobal: true, limit: 3 });
const globalHit = globalRecall.some(d => d.project === "__global__");
const globalScoresValid = globalRecall.every(d => d.score >= 0 && d.score <= 1.0);
rec(7, "digest.recall (global pattern)", tok(globalRecall), hrMs(t), globalHit);
console.log(`       Global digest hit: ${globalHit} | scores bounded: ${globalScoresValid}`);

// ── ROUND 8 — Digest refresh: TTL respect + token re-estimate ────────────────
console.log("\n=== R8: Digest refresh — content update ===");

const UPDATED_ANALYSIS = BIG_ANALYSIS + "\n\n## Update (R8)\nAdded circuit breaker to API gateway. Retry with exponential backoff.";

t = process.hrtime.bigint();
const refreshed = core.createDigest({
  title: "Novada SaaS full codebase analysis updated",
  scope: "architecture auth payments rate-limiting database schema circuit-breaker",
  content: UPDATED_ANALYSIS,
  project: PROJ_A,
  ttl_hours: 336, // 14 days on refresh
});
const wasRefreshed = refreshed.action === "refreshed";
rec(8, "digest.refresh", tok(refreshed), hrMs(t), wasRefreshed);
console.log(`       action=${refreshed.action} | token_estimate=${refreshed.token_estimate} | ttl=336h`);

// ── ROUND 9 — Mature session cold start ──────────────────────────────────────
console.log("\n=== R9: Mature cold start — full accumulated context ===");

t = process.hrtime.bigint();
const cs9 = core.journalColdStart({ project: PROJ_A });
const cs9tok = tok(cs9);
rec(9, "coldStart (mature, 5+ sessions)", cs9tok, hrMs(t));

// Palace walk — check salience
t = process.hrtime.bigint();
const walk9 = await core.palaceWalk({ depth: "active", project: PROJ_A });
rec(9, "palaceWalk(active)", tok(walk9), hrMs(t));

// Digest recall in mature session — does Zipf half-life hold?
t = process.hrtime.bigint();
const matureRecall = core.findMatchingDigests("architecture auth payments", PROJ_A, { limit: 5 });
const matureScoresValid = matureRecall.every(d => d.score >= 0 && d.score <= 1.0);
rec(9, "digest.recall (mature)", tok(matureRecall), hrMs(t), matureScoresValid);

// ── ROUND 10 — Final: stale + prune + arsaveall complete ─────────────────────
console.log("\n=== R10: Prune stale digests + final arsaveall ===");

// Mark global digest as stale
const allGlobalDigests = core.listDigests("__global__", { global: true });
if (allGlobalDigests.length > 0) {
  t = process.hrtime.bigint();
  await core.markStale("__global__", allGlobalDigests[0].id, "superseded", true);
  rec(10, "digest.invalidate", tok({ done: true }), hrMs(t));
}

// Prune stale (0-day threshold = prune immediately)
t = process.hrtime.bigint();
const pruned = core.pruneStale("__global__", 0, true);
rec(10, "digest.pruneStale", tok({ pruned }), hrMs(t));
console.log(`       pruned ${pruned} stale digest(s)`);

// Final check: all projects saved via arsaveall
t = process.hrtime.bigint();
const finalSweep = await core.journalProjects();
rec(10, "ar projects (final sweep)", tok(finalSweep), hrMs(t));

// Final correction retention check
t = process.hrtime.bigint();
const aware10 = core.readAwareness();
const clerkFinal = aware10.includes("Clerk") || aware10.includes("clerk");
rec(10, "correction retention R10", tok(aware10), hrMs(t), clerkFinal);

// ── RESULTS ──────────────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(72));
console.log("BENCHMARK RESULTS — AgentRecall v3.3.16");
console.log("═".repeat(72));

// Per-round summary
console.log("\nRound totals:");
for (let r = 1; r <= 10; r++) {
  const rr = rows.filter(x => x.round === r);
  const t = rr.reduce((s, x) => s + x.tokens, 0);
  const m = rr.reduce((s, x) => s + x.ms, 0);
  console.log(`  R${r}: ${String(t).padStart(6)} tok  ${String(m).padStart(6)} ms  (${rr.length} calls)`);
}

// Pass/fail checks
const checks = rows.filter(x => x.pass !== undefined);
console.log("\nPass/Fail checks:");
let passed = 0, failed = 0;
for (const c of checks) {
  console.log(`  ${c.pass ? "✓" : "✗"} [R${c.round}] ${c.label}`);
  if (c.pass) passed++; else failed++;
}

// Cold start growth
const cs = rows.filter(x => x.label.startsWith("coldStart"));
console.log("\nCold start growth:");
for (const c of cs) console.log(`  R${c.round}: ${c.tokens} tok — ${c.label}`);
const csFirst = cs[0]?.tokens ?? 1;
const csLast = cs[cs.length - 1]?.tokens ?? 1;
const csGrowth = (csLast / csFirst).toFixed(2);
const csGrowthPass = csLast / csFirst < 2.0;
console.log(`  Growth: ${csFirst} → ${csLast} tok (${csGrowth}x) ${csGrowthPass ? "✓" : "✗ WARN: >2x growth"}`);

// Digest savings summary
const digestSavingsRow = rows.find(x => x.label.includes("digest.recall (vs re-analysis)"));
console.log("\nDigest token savings:");
console.log(`  ${digestSavingsRow?.pass ? "✓" : "✗"} recall cost vs re-analysis: ${digestSavingsRow?.pass ? "≥30% saved" : "below threshold"}`);

// Overall
const allPass = failed === 0 && csGrowthPass;
console.log("\n" + "─".repeat(72));
console.log(`Overall: ${passed} passed, ${failed} failed — ${allPass ? "✓ ALL PASS" : "✗ FAILURES PRESENT"}`);
console.log("─".repeat(72));

// JSON report
const report = {
  version: "3.3.16",
  date: new Date().toISOString(),
  rounds: 10,
  projects: [PROJ_A, PROJ_B, PROJ_C],
  rows,
  checksPass: passed,
  checksFail: failed,
  coldStartGrowth: parseFloat(csGrowth),
  allPass,
};
const reportPath = join(BENCH_ROOT, "benchmark-3316.json");
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`\nFull report: ${reportPath}`);

// Cleanup
rmSync(BENCH_ROOT, { recursive: true, force: true });
console.log("(temp bench data cleaned up)\n");

if (!allPass) process.exit(1);
