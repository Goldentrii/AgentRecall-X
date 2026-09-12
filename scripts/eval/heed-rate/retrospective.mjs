#!/usr/bin/env node
// scripts/eval/heed-rate/retrospective.mjs
//
// Retrospective heed audit (S0, offline): mine an AgentRecall store's
// correction records + _outcomes.jsonl ledgers READ-ONLY and answer, per
// correction with ≥1 recorded surfacing: did subsequent recorded behavior
// comply? Emits per-correction evidence trails + the aggregate
// heed-given-surfaced numbers. See README.md (this directory) for what these
// numbers do and do not prove.
//
// Usage:
//   node scripts/eval/heed-rate/retrospective.mjs --store <path-to-CLONE> [--json <out.json>] [--evidence]
//
// SAFETY: this script opens files for reading only (readdir/readFile — no
// write API is imported). It still REFUSES to run against the live store
// (~/.agent-recall or $AGENT_RECALL_ROOT): measurement policy for this repo
// is clones-only (see the golden-eval observer-effect finding, evaluation
// standard 2026-09-11). Clone first:
//   TMP=$(mktemp -d) && cp -cR ~/.agent-recall "$TMP/store"

import { readdirSync, readFileSync, existsSync, statSync, writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { classifyEvent, classifyCorrection, aggregate, dayOf } from "./lib.mjs";

// ---------------------------------------------------------------------------
// Store readers (read-only)
// ---------------------------------------------------------------------------

function listProjects(storeRoot) {
  const projectsDir = path.join(storeRoot, "projects");
  if (!existsSync(projectsDir)) return [];
  return readdirSync(projectsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith("."))
    .map((d) => d.name);
}

/** Read one project's correction records + outcome ledger. Read-only. */
export function readProjectCorrections(storeRoot, project) {
  const dir = path.join(storeRoot, "projects", project, "corrections");
  const records = [];
  const events = [];
  const parseFailures = [];
  if (!existsSync(dir)) return { records, events, parseFailures };
  for (const f of readdirSync(dir)) {
    if (f.startsWith("_") || !f.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
      if (rec && typeof rec.id === "string") records.push(rec);
      else parseFailures.push({ file: f, reason: "no id field" });
    } catch (e) {
      parseFailures.push({ file: f, reason: e.message });
    }
  }
  const ledger = path.join(dir, "_outcomes.jsonl");
  if (existsSync(ledger)) {
    const lines = readFileSync(ledger, "utf8").split("\n");
    lines.forEach((line, i) => {
      const t = line.trim();
      if (!t) return;
      try {
        const evt = JSON.parse(t);
        if (evt && typeof evt.correction_id === "string" && typeof evt.kind === "string") events.push(evt);
        else parseFailures.push({ file: "_outcomes.jsonl", line: i + 1, reason: "missing correction_id/kind" });
      } catch (e) {
        parseFailures.push({ file: "_outcomes.jsonl", line: i + 1, reason: e.message });
      }
    });
  }
  return { records, events, parseFailures };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export function runAudit(storeRoot) {
  const projects = listProjects(storeRoot);
  const rows = [];
  const orphanEvents = []; // events whose correction record file no longer exists
  const parseFailures = [];
  const dreamAuditByDay = new Map(); // C3b cross-check
  const kindCounts = {};

  for (const project of projects) {
    const { records, events, parseFailures: pf } = readProjectCorrections(storeRoot, project);
    for (const f of pf) parseFailures.push({ project, ...f });
    const byId = new Map();
    for (const evt of events) {
      kindCounts[evt.kind] = (kindCounts[evt.kind] ?? 0) + 1;
      if (!byId.has(evt.correction_id)) byId.set(evt.correction_id, []);
      byId.get(evt.correction_id).push(evt);
      if ((evt.evidence ?? "").toLowerCase().startsWith("dream-audit:")) {
        const day = dayOf(evt.at) ?? "unknown";
        if (!dreamAuditByDay.has(day)) dreamAuditByDay.set(day, {});
        const bucket = dreamAuditByDay.get(day);
        bucket[evt.kind] = (bucket[evt.kind] ?? 0) + 1;
      }
    }
    const recordIds = new Set(records.map((r) => r.id));
    for (const [cid, evts] of byId) {
      if (!recordIds.has(cid)) {
        orphanEvents.push({ project, correction_id: cid, events: evts.length, kinds: [...new Set(evts.map((e) => e.kind))] });
      }
    }
    for (const rec of records) {
      const evts = byId.get(rec.id) ?? [];
      rows.push({
        id: rec.id,
        project,
        rule: rec.rule ?? "",
        severity: rec.severity ?? null,
        retracted: Boolean(rec.retracted_at || rec.retract_reason),
        retract_reason: rec.retract_reason ?? null,
        counters: {
          retrieved: rec.retrieved_count ?? null,
          heeded: rec.heeded_count ?? null,
          recurred: rec.recurrence_count ?? null,
          not_violated: rec.not_violated_count ?? null,
        },
        result: classifyCorrection(evts),
      });
    }
  }

  const agg = aggregate(rows);
  return { projects: projects.length, rows, aggregate: agg, orphanEvents, parseFailures, kindCounts, dreamAuditByDay: Object.fromEntries([...dreamAuditByDay.entries()].sort()) };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function pct(x) {
  return x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(1)}%`;
}

function renderSummary(audit, storeRoot, opts) {
  const a = audit.aggregate;
  const out = [];
  out.push(`# Retrospective heed audit — ${new Date().toISOString()}`);
  out.push(`store: ${storeRoot} (read-only) · projects scanned: ${audit.projects}`);
  out.push("");
  out.push(`corrections: ${a.corrections_total} total = ${a.corrections_live} live + ${a.corrections_retracted} retracted (retractions in this store are noise-triage exclusions, NOT violations — every retract_reason is a capture-noise triage)`);
  out.push(`surfaced (≥1 "retrieved" event): ${a.surfaced} of ${a.corrections_live} live corrections`);
  out.push("");
  out.push("## Per-correction verdicts (surfaced, live)");
  for (const [v, n] of Object.entries(a.by_verdict).sort()) out.push(`  ${v.padEnd(12)} ${n}`);
  out.push("");
  out.push("## Heed-given-surfaced");
  out.push(`  STRICT (correction-level): ${pct(a.heed_given_surfaced_strict)}  — heeded ${a.heed_given_surfaced_strict_detail.heeded} / mixed ${a.heed_given_surfaced_strict_detail.mixed} / violated ${a.heed_given_surfaced_strict_detail.violated}  (denominator: ${a.strict_evidence_corrections} corrections with any strict evidence)`);
  out.push(`  STRICT (event-level):      ${pct(a.event_level.strict)}  — heeded ${a.event_level.strict_detail.heeded} vs recurred ${a.event_level.strict_detail.recurred}`);
  out.push(`  LEDGER formula (shipped):  ${pct(a.event_level.ledger_formula)}  — heeded_all ${a.event_level.ledger_detail.heeded_all} (of which ${a.event_level.ledger_detail.heeded_default_share} are pre-C3 default-heeded, i.e. absence-of-evidence credit) vs recurred ${a.event_level.ledger_detail.recurred}`);
  out.push("");
  out.push("## Absence-of-evidence (the honest denominator problem)");
  out.push(`  weak-only (default-heeded / not_violated signals only): ${a.no_evidence.weak_only}`);
  out.push(`  silent (surfaced, zero compliance signal of any tier):  ${a.no_evidence.silent}`);
  out.push(`  → ${pct(a.no_evidence.share_of_surfaced)} of surfaced corrections have NO strict compliance evidence either way; the ledgers cannot say whether they were heeded.`);
  out.push("");
  out.push("## C3b dream-audit cross-check (verdicts by audited day)");
  const days = Object.entries(audit.dreamAuditByDay);
  if (days.length === 0) out.push("  (no dream-audit events found)");
  for (const [day, kinds] of days.slice(-14)) {
    const parts = Object.entries(kinds).map(([k, n]) => `${k}=${n}`).join(" ");
    out.push(`  ${day}: ${parts}`);
  }
  if (days.length > 14) out.push(`  (… ${days.length - 14} earlier days elided; full table in --json output)`);
  out.push("");
  out.push(`ledger kind counts: ${JSON.stringify(audit.kindCounts)}`);
  if (audit.orphanEvents.length > 0) {
    out.push(`orphan events (ledger lines whose correction record file is gone): ${audit.orphanEvents.length} correction ids — ${audit.orphanEvents.map((o) => `${o.project}/${o.correction_id}(${o.events})`).join(", ")}`);
  }
  if (audit.parseFailures.length > 0) {
    out.push(`parse failures: ${audit.parseFailures.length} (quarantined from all counts)`);
  }

  if (opts.evidence) {
    out.push("");
    out.push("## Evidence trail (surfaced live corrections with any compliance-bearing or pre-surfacing events)");
    for (const r of audit.rows) {
      if (r.retracted || r.result.verdict === "not-surfaced") continue;
      if (r.result.evidence.length === 0 && r.result.pre_surfacing.length === 0) continue;
      out.push(`- ${r.project}/${r.id} [${r.result.verdict}] surfaced×${r.result.surfaced_count} first=${r.result.first_surfaced}`);
      out.push(`  rule: ${String(r.rule).slice(0, 90)}`);
      for (const e of r.result.evidence) {
        if (e.tier === "no_signal") continue; // keep the trail readable; counts are in tiers
        out.push(`    ${e.tier.padEnd(19)} ${dayOf(e.at) ?? e.at}  ${String(e.evidence).replace(/\s+/g, " ").slice(0, 140)}`);
      }
      for (const e of r.result.pre_surfacing) {
        out.push(`    PRE-SURFACING ${e.tier} ${dayOf(e.at) ?? e.at} (excluded)  ${String(e.evidence).replace(/\s+/g, " ").slice(0, 100)}`);
      }
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function fail(msg, code = 2) {
  process.stderr.write(`retrospective: ${msg}\n`);
  process.exit(code);
}

export function assertNotLiveStore(storePath) {
  const resolve = (p) => {
    try { return realpathSync(p); } catch { return path.resolve(p); }
  };
  const target = resolve(storePath);
  const liveCandidates = [path.join(os.homedir(), ".agent-recall")];
  if (process.env.AGENT_RECALL_ROOT) liveCandidates.push(process.env.AGENT_RECALL_ROOT);
  for (const live of liveCandidates) {
    if (!existsSync(live)) continue;
    if (resolve(live) === target) {
      return `refusing to run against the live store (${storePath}). Measurement policy is clones-only — clone first: TMP=$(mktemp -d) && cp -cR ~/.agent-recall "$TMP/store"`;
    }
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  let store = null, jsonOut = null, evidence = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--store") store = args[++i];
    else if (args[i] === "--json") jsonOut = args[++i];
    else if (args[i] === "--evidence") evidence = true;
    else if (args[i] === "--help" || args[i] === "-h") {
      process.stdout.write("usage: retrospective.mjs --store <path-to-CLONE> [--json out.json] [--evidence]\n");
      process.exit(0);
    } else fail(`unknown argument ${args[i]}`);
  }
  if (!store) fail("--store <path> is required (a CLONE of the live store, never the live store)");
  if (!existsSync(store) || !statSync(store).isDirectory()) fail(`store path not found or not a directory: ${store}`);
  const liveErr = assertNotLiveStore(store);
  if (liveErr) fail(liveErr);
  if (!existsSync(path.join(store, "projects"))) fail(`${store} does not look like an AgentRecall store (no projects/ dir)`);

  const audit = runAudit(store);
  process.stdout.write(renderSummary(audit, store, { evidence }) + "\n");
  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(audit, null, 2));
    process.stderr.write(`retrospective: full audit JSON written to ${jsonOut}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
