#!/usr/bin/env node
// scripts/eval/heed-rate/run-heed-eval.mjs
//
// S0 forward heed-rate harness (10-probe pilot, 2 arms).
//
// For each probe in probes.json: run the task prompt on the target model
// (claude-haiku-4-5) in two arms — with-memory (the synthetic P0 rule injected
// exactly as the product renders it) and without-memory (control) — then score
// the response with an IFEval-style verifiable predicate. No LLM judge.
//
//   heed-given-hit  = predicate pass-rate in the with-memory arm (the golden
//                     rule is IN context by construction — retrieval is forced
//                     to 1.0, isolating the heeding step)
//   baseline        = predicate pass-rate in the control arm (the model's
//                     prior without memory)
//   memory effect   = heed-given-hit − baseline (per probe and aggregate)
//
// Usage:
//   node scripts/eval/heed-rate/run-heed-eval.mjs --dry-run              # validate + preview, no network
//   ANTHROPIC_API_KEY=... node scripts/eval/heed-rate/run-heed-eval.mjs [--out results.json]
//
// Hard cap: fixture.max_requests total API requests (attempts count, retries
// included). Temperature 0. Exit codes: 0 = run completed with ALL arms scored
// (regardless of heed numbers — this is measurement, not a gate),
// 2 = fixture/config error, 3 = one or more arms unscored (API failure after
// retry, or the request cap was hit — the cap itself always holds; hitting it
// short-circuits the remaining probes).

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateProbesFixture, evaluatePredicate, buildArms, renderMemoryBlock } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 512;
const RETRIES_PER_REQUEST = 1; // one retry on 429/5xx/network; every attempt counts against the cap

// ---------------------------------------------------------------------------

function loadFixture(file) {
  let fixture;
  try {
    fixture = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { fixture: null, validation: { ok: false, errors: [`cannot read/parse ${file}: ${e.message}`], warnings: [] } };
  }
  return { fixture, validation: validateProbesFixture(fixture) };
}

function printValidation(validation) {
  for (const w of validation.warnings) process.stderr.write(`  warning: ${w}\n`);
  for (const e of validation.errors) process.stderr.write(`  ERROR: ${e}\n`);
}

function dryRun(fixture) {
  process.stdout.write(`probes: ${fixture.probes.length} · model: ${fixture.model} · planned requests: ${fixture.probes.length * 2} (cap ${fixture.max_requests})\n\n`);
  for (const probe of fixture.probes) {
    const arms = buildArms(probe);
    process.stdout.write(`── ${probe.id} [${probe.rule_class}]\n`);
    process.stdout.write(`   memory block (as the product renders it):\n`);
    for (const line of renderMemoryBlock(probe.memory_rule).split("\n")) process.stdout.write(`     ${line}\n`);
    process.stdout.write(`   task: ${probe.task.split("\n")[0].slice(0, 100)}…\n`);
    process.stdout.write(`   predicate: must_match=${JSON.stringify(probe.predicate.must_match ?? [])} must_not_match=${JSON.stringify(probe.predicate.must_not_match ?? [])} flags=${probe.predicate.flags ?? "m"}\n`);
    process.stdout.write(`   arms differ only in user turn: with=${arms.with_memory.user.length}ch without=${arms.without_memory.user.length}ch, system identical=${arms.with_memory.system === arms.without_memory.system}\n`);
  }
  process.stdout.write(`\ndry-run OK — fixture valid, no requests sent.\n`);
}

// ---------------------------------------------------------------------------

async function callModel({ apiKey, model, system, user, budget }) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRIES_PER_REQUEST; attempt++) {
    if (budget.used >= budget.cap) {
      const err = new Error(`request cap ${budget.cap} reached (used ${budget.used})`);
      err.code = "CAP_EXHAUSTED";
      throw err;
    }
    budget.used++;
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: MAX_TOKENS,
          temperature: 0,
          system,
          messages: [{ role: "user", content: user }],
        }),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const data = await res.json();
      const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      return { text, usage: data.usage ?? null };
    } catch (e) {
      lastErr = e;
      if (attempt < RETRIES_PER_REQUEST) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error("request failed");
}

async function liveRun(fixture, apiKey, outFile) {
  const budget = { used: 0, cap: fixture.max_requests };
  const results = [];
  let capExhausted = false;
  for (const probe of fixture.probes) {
    if (capExhausted) break; // remaining probes are unscored; exit code 3 below
    const arms = buildArms(probe);
    const row = { id: probe.id, rule_class: probe.rule_class, arms: {} };
    for (const armName of ["with_memory", "without_memory"]) {
      const arm = arms[armName];
      try {
        const { text, usage } = await callModel({ apiKey, model: fixture.model, system: arm.system, user: arm.user, budget });
        const verdict = evaluatePredicate(probe.predicate, text);
        row.arms[armName] = { pass: verdict.pass, failures: verdict.failures, response: text, usage };
      } catch (e) {
        row.arms[armName] = { pass: null, error: e.message };
        if (e.code === "CAP_EXHAUSTED") capExhausted = true;
      }
      process.stderr.write(`  ${probe.id} ${armName}: ${row.arms[armName].pass === null ? `ERROR (${row.arms[armName].error})` : row.arms[armName].pass ? "PASS" : "FAIL"} (requests used: ${budget.used}/${budget.cap})\n`);
    }
    results.push(row);
  }

  const scored = (arm) => results.filter((r) => r.arms[arm]?.pass !== null && r.arms[arm]?.pass !== undefined);
  const passed = (arm) => results.filter((r) => r.arms[arm]?.pass === true);
  const summary = {
    model: fixture.model,
    at: new Date().toISOString(),
    requests_used: budget.used,
    request_cap: budget.cap,
    probes: results.length,
    heed_given_hit: scored("with_memory").length ? passed("with_memory").length / scored("with_memory").length : null,
    heed_given_hit_detail: { pass: passed("with_memory").length, scored: scored("with_memory").length },
    baseline_no_memory: scored("without_memory").length ? passed("without_memory").length / scored("without_memory").length : null,
    baseline_detail: { pass: passed("without_memory").length, scored: scored("without_memory").length },
    probes_planned: fixture.probes.length,
    cap_exhausted: capExhausted,
    errors: results.filter((r) => r.arms.with_memory?.pass === null || r.arms.without_memory?.pass === null).length
      + (fixture.probes.length - results.length), // probes skipped after cap exhaustion are unscored too
  };
  summary.memory_effect = summary.heed_given_hit !== null && summary.baseline_no_memory !== null
    ? summary.heed_given_hit - summary.baseline_no_memory : null;

  process.stdout.write("\n# S0 forward heed-rate — results\n");
  process.stdout.write(`model: ${summary.model} · requests: ${summary.requests_used}/${summary.request_cap}\n\n`);
  process.stdout.write("probe                          with-memory  without-memory\n");
  for (const r of results) {
    const f = (a) => (r.arms[a]?.pass === null || r.arms[a]?.pass === undefined) ? "ERROR" : r.arms[a].pass ? "PASS " : "FAIL ";
    process.stdout.write(`${r.id.padEnd(30)} ${f("with_memory").padEnd(12)} ${f("without_memory")}\n`);
  }
  const pc = (x) => (x === null ? "n/a" : `${(x * 100).toFixed(0)}%`);
  process.stdout.write(`\nheed-given-hit (with-memory arm): ${pc(summary.heed_given_hit)} (${summary.heed_given_hit_detail.pass}/${summary.heed_given_hit_detail.scored})\n`);
  process.stdout.write(`baseline (no-memory control):     ${pc(summary.baseline_no_memory)} (${summary.baseline_detail.pass}/${summary.baseline_detail.scored})\n`);
  process.stdout.write(`memory effect (delta):            ${summary.memory_effect === null ? "n/a" : `${(summary.memory_effect * 100).toFixed(0)}pt`}\n`);

  if (outFile) {
    writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2));
    process.stderr.write(`full results (incl. raw responses) written to ${outFile}\n`);
  }
  return summary;
}

/**
 * Exit-code contract for a completed live run (pure — unit-tested):
 * 0 = every planned arm scored; 3 = any arm unscored (API failure after
 * retry, or request cap hit). Fixture/config problems exit 2 before this.
 */
export function exitCodeForRun(summary) {
  return summary.errors > 0 || summary.cap_exhausted ? 3 : 0;
}

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  let dry = false, outFile = null, probesFile = path.join(HERE, "probes.json");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") dry = true;
    else if (args[i] === "--out") outFile = args[++i];
    else if (args[i] === "--probes") probesFile = args[++i];
    else if (args[i] === "--help" || args[i] === "-h") {
      process.stdout.write("usage: run-heed-eval.mjs [--dry-run] [--out results.json] [--probes probes.json]\n");
      process.exit(0);
    } else { process.stderr.write(`unknown argument ${args[i]}\n`); process.exit(2); }
  }

  const { fixture, validation } = loadFixture(probesFile);
  printValidation(validation);
  if (!validation.ok) { process.stderr.write("fixture invalid — aborting.\n"); process.exit(2); }

  if (dry) { dryRun(fixture); process.exit(0); }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    process.stderr.write("ANTHROPIC_API_KEY not set — cannot run live arms. Use --dry-run to validate the fixture.\n");
    process.exit(2);
  }
  try {
    const summary = await liveRun(fixture, apiKey, outFile);
    const code = exitCodeForRun(summary);
    if (code !== 0) process.stderr.write(`exit 3: ${summary.errors} arm(s) unscored${summary.cap_exhausted ? " (request cap hit)" : ""}\n`);
    process.exit(code);
  } catch (e) {
    process.stderr.write(`live run aborted: ${e.message}\n`);
    process.exit(3);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
