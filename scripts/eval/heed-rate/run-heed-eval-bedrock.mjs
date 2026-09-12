#!/usr/bin/env node
// scripts/eval/heed-rate/run-heed-eval-bedrock.mjs
//
// AWS Bedrock transport variant of run-heed-eval.mjs. Probe loop, arm
// construction, predicate evaluation, summary math, and the hard request cap
// are all the SHARED code (lib.mjs + run-heed-eval.mjs `liveRun`) — this file
// only swaps the transport: direct HTTPS to
//   https://bedrock-runtime.${AWS_REGION}.amazonaws.com/model/${MODEL_ID}/invoke
// with `Authorization: Bearer ${AWS_BEARER_TOKEN_BEDROCK}` and an
// anthropic-messages body (anthropic_version "bedrock-2023-05-31").
//
// SECRET HANDLING: the bearer token is read from the environment inside the
// transport function only. It is never logged, never written to the results
// file, and never appears in any error message (Bedrock error bodies do not
// echo credentials; only status + a body excerpt are surfaced).
//
// MODEL DISCOVERY: Bedrock model IDs differ from Anthropic API IDs, so
// fixture.model is overridden. Candidates (cheapest-first, per this machine's
// gateway env conventions):
//   1. $ANTHROPIC_DEFAULT_HAIKU_MODEL (with any trailing "[...]" annotation stripped)
//   2. region-prefixed / bare / global inference-profile IDs for haiku-4-5
//   3. $ANTHROPIC_MODEL as last resort
// A one-request smoke test (single attempt, max_tokens 16) picks the first
// candidate the endpoint accepts; 4xx -> next candidate. EVERY smoke attempt
// counts against the run's total request cap: the fixture cap passed to
// liveRun is reduced by the smoke requests already spent, so no more than
// fixture.max_requests HTTP requests can ever leave the machine.
//
// Usage:
//   node scripts/eval/heed-rate/run-heed-eval-bedrock.mjs --dry-run
//   AWS_BEARER_TOKEN_BEDROCK=... AWS_REGION=eu-central-1 \
//     node scripts/eval/heed-rate/run-heed-eval-bedrock.mjs [--out results.json] [--model <bedrock-id>]
//
// Exit codes match run-heed-eval.mjs: 0 = all planned arms scored,
// 2 = fixture/config error (incl. no token, or no candidate model accepted),
// 3 = one or more arms unscored (API failure after retry / cap hit).

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateProbesFixture } from "./lib.mjs";
import { liveRun, exitCodeForRun } from "./run-heed-eval.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_TOKENS = 1024;
const RETRIES_PER_REQUEST = 1; // one retry on 429/5xx/network; every attempt counts against the cap

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function region() {
  return process.env.AWS_REGION || "eu-central-1";
}

function endpoint(model) {
  return `https://bedrock-runtime.${region()}.amazonaws.com/model/${encodeURIComponent(model)}/invoke`;
}

/** Strip trailing context-window annotations like "[1M]" from gateway env values. */
export function stripAnnotation(v) {
  return typeof v === "string" ? v.replace(/\[[^\]]*\]\s*$/, "").trim() : "";
}

/** Ordered, deduped Bedrock model-ID candidates (see header). */
export function modelCandidates(env = process.env) {
  const c = [];
  const haiku = stripAnnotation(env.ANTHROPIC_DEFAULT_HAIKU_MODEL);
  if (haiku) c.push(haiku);
  c.push(
    "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
    "anthropic.claude-haiku-4-5-20251001-v1:0",
    "global.anthropic.claude-haiku-4-5-20251001-v1:0",
  );
  const last = stripAnnotation(env.ANTHROPIC_MODEL);
  if (last) c.push(last);
  return [...new Set(c)];
}

function bedrockBody({ system, user, maxTokens }) {
  return JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: maxTokens,
    temperature: 0,
    system,
    messages: [{ role: "user", content: user }],
  });
}

async function bedrockFetch({ model, system, user, maxTokens }) {
  return fetch(endpoint(model), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${process.env.AWS_BEARER_TOKEN_BEDROCK}`,
    },
    body: bedrockBody({ system, user, maxTokens }),
  });
}

/**
 * Same contract as run-heed-eval.mjs `callModel` (retry + cap accounting),
 * Bedrock transport. `apiKey` from the shared loop is ignored — the bearer
 * token is read from the environment here and nowhere else.
 */
async function callModelBedrock({ model, system, user, budget }) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRIES_PER_REQUEST; attempt++) {
    if (budget.used >= budget.cap) {
      const err = new Error(`request cap ${budget.cap} reached (used ${budget.used})`);
      err.code = "CAP_EXHAUSTED";
      throw err;
    }
    budget.used++;
    try {
      const res = await bedrockFetch({ model, system, user, maxTokens: MAX_TOKENS });
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

/**
 * One-request smoke test per candidate — single attempt, no retry (a 4xx here
 * means "wrong model ID, try the next one", not a transient failure).
 * Counts against `budget`.
 */
async function smokeTest(model, budget) {
  if (budget.used >= budget.cap) return { ok: false, status: null, detail: "request cap reached before smoke test" };
  budget.used++;
  try {
    const res = await bedrockFetch({
      model,
      system: "You are a connectivity check.",
      user: "Reply with exactly: OK",
      maxTokens: 16,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, status: res.status, detail: body.slice(0, 200) };
    }
    const data = await res.json();
    const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    return { ok: true, status: res.status, detail: text.slice(0, 40) };
  } catch (e) {
    return { ok: false, status: null, detail: String(e.message).slice(0, 200) };
  }
}

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

async function main() {
  const args = process.argv.slice(2);
  let dry = false, outFile = null, probesFile = path.join(HERE, "probes.json"), modelOverride = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") dry = true;
    else if (args[i] === "--out") outFile = args[++i];
    else if (args[i] === "--probes") probesFile = args[++i];
    else if (args[i] === "--model") modelOverride = args[++i];
    else if (args[i] === "--help" || args[i] === "-h") {
      process.stdout.write("usage: run-heed-eval-bedrock.mjs [--dry-run] [--out results.json] [--probes probes.json] [--model <bedrock-id>]\n");
      process.exit(0);
    } else { process.stderr.write(`unknown argument ${args[i]}\n`); process.exit(2); }
  }

  const { fixture, validation } = loadFixture(probesFile);
  for (const w of validation.warnings) process.stderr.write(`  warning: ${w}\n`);
  for (const e of validation.errors) process.stderr.write(`  ERROR: ${e}\n`);
  if (!validation.ok) { process.stderr.write("fixture invalid — aborting.\n"); process.exit(2); }

  const candidates = modelOverride ? [modelOverride] : modelCandidates();

  if (dry) {
    process.stdout.write(`transport: bedrock (${region()}) · probes: ${fixture.probes.length} · planned requests: ${fixture.probes.length * 2} + smoke (cap ${fixture.max_requests} total)\n`);
    process.stdout.write(`model candidates (in order):\n`);
    for (const m of candidates) process.stdout.write(`  - ${m}\n`);
    process.stdout.write(`dry-run OK — fixture valid, no requests sent.\n`);
    process.exit(0);
  }

  if (!process.env.AWS_BEARER_TOKEN_BEDROCK) {
    process.stderr.write("AWS_BEARER_TOKEN_BEDROCK not set — cannot run live arms. Use --dry-run to validate.\n");
    process.exit(2);
  }

  // Model discovery: shared budget so smoke requests count against the cap.
  const smokeBudget = { used: 0, cap: fixture.max_requests };
  const attempts = [];
  let model = null;
  for (const candidate of candidates) {
    process.stderr.write(`smoke test: ${candidate} … `);
    const r = await smokeTest(candidate, smokeBudget);
    attempts.push({ model: candidate, ok: r.ok, status: r.status, detail: r.detail });
    process.stderr.write(r.ok ? `OK (${r.detail})\n` : `FAIL (HTTP ${r.status ?? "n/a"}: ${r.detail})\n`);
    if (r.ok) { model = candidate; break; }
  }
  if (!model) {
    process.stderr.write(`no candidate model accepted by bedrock-runtime.${region()} — aborting (requests spent: ${smokeBudget.used}).\n`);
    process.exit(2);
  }

  // Hand the REMAINING budget to the shared loop: total HTTP requests
  // (smoke + eval, retries included) can never exceed fixture.max_requests.
  const remaining = fixture.max_requests - smokeBudget.used;
  const planned = fixture.probes.length * 2;
  if (planned > remaining) {
    process.stderr.write(`ERROR: ${planned} planned arm requests exceed remaining cap ${remaining} after ${smokeBudget.used} smoke request(s).\n`);
    process.exit(2);
  }
  const runFixture = { ...fixture, model, max_requests: remaining };

  try {
    const summary = await liveRun(runFixture, /* apiKey (unused) */ null, outFile, callModelBedrock);
    summary.requests_used += smokeBudget.used; // account smoke requests in the reported total
    summary.request_cap = fixture.max_requests;
    if (outFile) {
      // Annotate the results file with transport + discovery trail (no secrets:
      // only model IDs, HTTP statuses, and Bedrock error-body excerpts).
      const payload = JSON.parse(readFileSync(outFile, "utf8"));
      payload.summary.requests_used = summary.requests_used;
      payload.summary.request_cap = fixture.max_requests;
      payload.transport = { kind: "bedrock", region: region(), endpoint: endpoint(model), model, smoke_attempts: attempts };
      writeFileSync(outFile, JSON.stringify(payload, null, 2));
    }
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
