#!/usr/bin/env node
/**
 * correction-triage.mjs — one-time correction quality sweep
 *
 * Walks all projects/<slug>/corrections/<id>.json, classifies each correction with
 * isLikelyRealCorrection (v2), and prints a table of verdicts.
 *
 * Usage:
 *   node scripts/correction-triage.mjs             # dry-run (prints table only)
 *   node scripts/correction-triage.mjs --apply     # retract noise records
 *   node scripts/correction-triage.mjs --selftest  # run calibration suite and exit
 *
 * Never deletes files. Retracted records get active:false + retract_reason.
 *
 * v2 (2026-06-12): classifies on record.rule ONLY (never rule+context concatenated —
 * that allowed long context to bypass the acknowledgment gate).
 *
 * Import source: packages/core/dist/ (run `npm run build` first), OR inline copy
 * used by --selftest when dist is unavailable.
 *
 * SYNC-COMMENT: the inline classifyRule() below is a verbatim copy of
 * isLikelyRealCorrection() from packages/core/src/storage/corrections.ts.
 * If you change one, change both. The --selftest flag validates both paths.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const APPLY = process.argv.includes("--apply");
const SELFTEST = process.argv.includes("--selftest");

// ---------------------------------------------------------------------------
// Inline classifier (SYNC with corrections.ts isLikelyRealCorrection v2)
// Used by --selftest and as fallback when dist is absent.
// ---------------------------------------------------------------------------

/**
 * @param {string} rule
 * @returns {{ ok: boolean, reason?: string }}
 */
function classifyRule(rule) {
  const r = (rule ?? "").trim();

  if (r.length < 12) {
    return { ok: false, reason: "too short" };
  }

  const acknowledgmentPattern =
    /^(no[,.]?\s*(that'?s\s+wrong[.!]?)?|ok(ay)?\b|good\b|great\b|nice\b|yes\b|yeah\b|right\b|wait\b|hmm+\b|sure\b|thanks?\b)[\s\S]{0,80}$/i;
  if (acknowledgmentPattern.test(r)) {
    return { ok: false, reason: "pure acknowledgment or fragment — no rule content" };
  }

  if (r.startsWith("<")) {
    return { ok: false, reason: "system/tool fragment (starts with '<')" };
  }
  if (/^\d+$/.test(r)) {
    return { ok: false, reason: "pure number — no rule content" };
  }
  if (!/\s/.test(r) && /[/\\]/.test(r) && !/\b[a-zA-Z]{4,}\b/.test(r)) {
    return { ok: false, reason: "looks like a bare file path — no rule content" };
  }

  const imperativePattern =
    /\b(never|always|don'?t|do not|must|should|use|stop|avoid|prefer|instead|make sure|remember to)\b/i;
  if (imperativePattern.test(r)) {
    return { ok: true };
  }

  const preferencePattern =
    /\b(user\s+(wants?|prefers?|likes?|needs?)|the\s+user\s+is|偏好|喜欢|要求)\b/i;
  if (preferencePattern.test(r)) {
    return { ok: true };
  }

  if (r.length >= 40) {
    const longWords = (r.match(/\b[a-zA-Z0-9]{5,}\b/g) ?? []).length;
    const verbIsh =
      /\b(bump|consolidate|release|phase|version|publish|push|format|palette|font|round|warm|side.by.side|bilingual|batch|clean|parse|build|compile|deploy|migrate|export|import|store|handle|return|check|verify|ensure)\b/i;
    if (longWords >= 2 && verbIsh.test(r)) {
      return { ok: true };
    }
  }

  return { ok: false, reason: "no actionable signal — rule lacks imperative/modal marker, preference statement, or substantive content" };
}

// ---------------------------------------------------------------------------
// --selftest: calibration suite (11 cases)
// ---------------------------------------------------------------------------

if (SELFTEST) {
  const REAL = [
    "User wants beige/warm color palette, round font (Nunito), and side-by-side EN/ZH",
    "one version bump per release, not per phase — consolidate",
    "Never push or publish without explicit approval",
    "Don't map to human memory — it was a useful lens",
    "Use Sonnet (not Opus) for routine coding tasks",
  ];
  const NOISE = [
    "No, that's wrong",
    "Yes, you are right",
    "Ok good, then we don't change anything. let's focus on novada-mcp",
    "<task-notification>",
    "3",
    "Okay, really good",
  ];

  let passed = 0;
  let failed = 0;

  console.log("\n=== Calibration suite (v2 inline classifier) ===\n");

  for (const rule of REAL) {
    const result = classifyRule(rule);
    const ok = result.ok === true;
    const mark = ok ? "PASS" : "FAIL";
    if (ok) passed++; else failed++;
    console.log(`[${mark}] EXPECT ok   | ${rule.slice(0, 70)}`);
    if (!ok) console.log(`       got: NOISE — ${result.reason}`);
  }

  for (const rule of NOISE) {
    const result = classifyRule(rule);
    const ok = result.ok === false;
    const mark = ok ? "PASS" : "FAIL";
    if (ok) passed++; else failed++;
    console.log(`[${mark}] EXPECT noise | ${rule.slice(0, 70)}`);
    if (!ok) console.log(`       got: OK (should have been noise)`);
  }

  console.log(`\n${passed}/${passed + failed} passed`);

  // Also test against dist if available
  const coreDist = path.join(repoRoot, "packages", "core", "dist", "index.js");
  if (fs.existsSync(coreDist)) {
    console.log("\n=== Re-running via dist (consistency check) ===\n");
    const { isLikelyRealCorrection } = await import(coreDist);
    let distPassed = 0;
    let distFailed = 0;
    for (const rule of REAL) {
      const result = isLikelyRealCorrection(rule);
      const ok = result.ok === true;
      const mark = ok ? "PASS" : "FAIL";
      if (ok) distPassed++; else distFailed++;
      console.log(`[${mark}] EXPECT ok   | ${rule.slice(0, 70)}`);
    }
    for (const rule of NOISE) {
      const result = isLikelyRealCorrection(rule);
      const ok = result.ok === false;
      const mark = ok ? "PASS" : "FAIL";
      if (ok) distPassed++; else distFailed++;
      console.log(`[${mark}] EXPECT noise | ${rule.slice(0, 70)}`);
    }
    console.log(`\n${distPassed}/${distPassed + distFailed} passed (dist)`);
    if (distFailed > 0) {
      console.error("\nWARNING: dist results differ from inline classifier. Did you rebuild after editing corrections.ts?");
      process.exit(1);
    }
  } else {
    console.log(`\n(dist not found at ${coreDist} — skipping dist consistency check)`);
  }

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Normal triage flow
// ---------------------------------------------------------------------------

// Resolve the core dist — prefer local build, fall back to inline classifier
const coreDist = path.join(repoRoot, "packages", "core", "dist", "index.js");

let isLikelyRealCorrection;
let retractCorrection;
let getRoot;

if (fs.existsSync(coreDist)) {
  const mod = await import(coreDist);
  isLikelyRealCorrection = mod.isLikelyRealCorrection;
  retractCorrection = mod.retractCorrection;
  getRoot = mod.getRoot;
} else {
  console.error(
    `ERROR: ${coreDist} not found.\nRun \`npm run build\` from the repo root first.\n(Tip: use --selftest to validate the classifier without a build.)`
  );
  process.exit(1);
}

const TRIAGE_REASON = "triage-2026-06-12: capture noise";

// Walk ~/.agent-recall/projects/*/corrections/*.json
const root = getRoot();
const projectsDir = path.join(root, "projects");

if (!fs.existsSync(projectsDir)) {
  console.log(`No projects directory found at ${projectsDir}. Nothing to triage.`);
  process.exit(0);
}

const projects = fs.readdirSync(projectsDir).filter((p) => {
  const full = path.join(projectsDir, p);
  return fs.statSync(full).isDirectory();
});

/** @type {Array<{slug: string, id: string, verdict: "ok"|"noise", reason?: string, rulePreview: string, active: boolean}>} */
const rows = [];

for (const slug of projects) {
  const corrDir = path.join(projectsDir, slug, "corrections");
  if (!fs.existsSync(corrDir)) continue;

  const files = fs.readdirSync(corrDir).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
  for (const file of files) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(corrDir, file), "utf-8"));
    } catch {
      continue; // skip malformed
    }

    const active = record.active !== false;
    // v2: classify on rule ONLY — never rule+context
    const gate = isLikelyRealCorrection(record.rule ?? "");

    rows.push({
      slug,
      id: record.id ?? file,
      verdict: gate.ok ? "ok" : "noise",
      reason: gate.reason,
      rulePreview: (record.rule ?? "(no rule)").slice(0, 60),
      active,
    });
  }
}

// Print table
const colW = [20, 36, 7, 60, 60];
const header = ["slug", "id", "active", "verdict/reason", "rule-preview"];
const divider = colW.map((w) => "-".repeat(w)).join(" | ");

function padRight(s, w) {
  const str = String(s);
  return str.length >= w ? str.slice(0, w) : str + " ".repeat(w - str.length);
}

console.log("");
console.log(header.map((h, i) => padRight(h, colW[i])).join(" | "));
console.log(divider);

for (const r of rows) {
  const verdictCell = r.verdict === "noise" ? `NOISE: ${r.reason ?? ""}` : "ok";
  console.log(
    [
      padRight(r.slug, colW[0]),
      padRight(r.id, colW[1]),
      padRight(r.active ? "yes" : "no", colW[2]),
      padRight(verdictCell, colW[3]),
      padRight(r.rulePreview, colW[4]),
    ].join(" | ")
  );
}

console.log(divider);

const total = rows.length;
const noiseRows = rows.filter((r) => r.verdict === "noise");
const noiseActive = noiseRows.filter((r) => r.active);
const ok = rows.filter((r) => r.verdict === "ok").length;

console.log(`\nSummary: ${total} corrections — ${ok} ok, ${noiseRows.length} noise (${noiseActive.length} currently active)`);

if (!APPLY) {
  if (noiseActive.length > 0) {
    console.log(`\nDry-run. Pass --apply to retract ${noiseActive.length} active noise correction(s).`);
  } else {
    console.log("\nDry-run. No active noise corrections to retract.");
  }
  process.exit(0);
}

// Apply: retract active noise records
let retracted = 0;
let errors = 0;
for (const r of noiseActive) {
  try {
    const result = retractCorrection(r.slug, r.id, TRIAGE_REASON);
    if (result.success) {
      retracted++;
      console.log(`  retracted: [${r.slug}] ${r.id}`);
    } else {
      errors++;
      console.error(`  ERROR retracting [${r.slug}] ${r.id}: ${result.error}`);
    }
  } catch (err) {
    errors++;
    console.error(`  EXCEPTION retracting [${r.slug}] ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(`\nApplied: ${retracted} retracted, ${errors} errors.`);
