#!/usr/bin/env node
/**
 * session-start-size.mjs — measures the session_start injection payload size
 * on a fixture store, per project, and writes a dated baseline artifact.
 *
 * Usage:
 *   npm run bench:injection                       # golden-v1 if present, else corpus-v1
 *   node scripts/eval/session-start-size.mjs --store <path>
 *   node scripts/eval/session-start-size.mjs --json              # artifact on stdout
 *   node scripts/eval/session-start-size.mjs --no-artifact       # don't write baselines/
 *   node scripts/eval/session-start-size.mjs --check-determinism # double-run byte-diff
 *
 * WHAT IS MEASURED (the exact client-visible payload):
 *   For each project in the store, this calls the SAME code path the MCP
 *   `session_start` tool executes at its registration defaults
 *   (packages/mcp-server/src/tools/session-start.ts — mode="full",
 *   verbose=false):
 *       text = formatTerse(await sessionStart({ project }))
 *   `sessionStart` is packages/core/src/tools-logic/session-start.ts:505;
 *   `formatTerse` is the mcp-server renderer the tool returns as its single
 *   content[0].text block — that text string IS the injection the client
 *   sees, and is what gets measured (chars, then chars/4 tokens). The CLI
 *   lifecycle hook (`ar hook-start`, packages/cli/src/index.ts:1571) calls the
 *   same core.sessionStart({project}) full-mode payload and renders a terse
 *   text that deliberately mirrors formatTerse field-for-field, so the MCP
 *   default measured here is also representative of the hook injection.
 *   mode="lite" and verbose=true are NOT measured — neither is a default.
 *
 * TOKEN ESTIMATOR: ceil(chars/4) — the core-wide convention (session-start.ts
 * :174, handoff.ts:275; core exports no estimator, bench-lib replicates it).
 * A cjk-adjusted sensitivity figure (CJK char = 1 token) is reported per row.
 *
 * P0 SURVIVAL CHECK: the payload budget guarantees P0 corrections survive the
 * char cap (applyCorrectionBudget, session-start.ts:216), and the section is
 * assembled from rankCorrections(readP0Corrections(slug), 10) — i.e. capped
 * at 10 ITEMS pre-budget. The check therefore asserts, per project:
 *   p0_in_payload === min(p0_active_in_store, 10)
 * A violation FAILS the run (exit 1) — that would be a real budget-logic bug.
 *
 * ISOLATION: the fixture is copied into a FRESH mkdtemp AGENT_RECALL_ROOT per
 * project row (sessionStart writes telemetry/outcome records — a shared copy
 * would let row N's writes bleed into row N+1's payload), and all network env
 * vars are scrubbed before any core function runs (bench-lib SCRUBBED_ENV_VARS;
 * the 2026-08-18 eval found the Supabase contamination path this closes).
 * ~/.agent-recall is never touched.
 *
 * The "auto" project case is measured and PRINTED but excluded from the
 * artifact: resolveProject("auto") derives the slug from the caller's cwd, so
 * its row is machine/cwd-dependent and would break artifact determinism.
 *
 * DETERMINISM: size numbers on a fixed store are deterministic (TZ pinned to
 * UTC like run-bench §7.3; fresh temp root per row; no Math.random). The only
 * run-to-run variance is calendar-day drift in relative-date strings ("8mo
 * ago"), which is stable within a CI job — --check-determinism double-runs
 * the full measurement and byte-diffs the canonicalJson artifacts excluding
 * generated_utc, and is a CI gate. VALUES are never gated (bench-fixture.yml
 * policy).
 *
 * Error paths:
 *   - store missing / no projects → FATAL, exit 1
 *   - sessionStart throws for a project → FATAL with the project named, exit 1
 *     (deterministic bench on a committed fixture: a throw is a real bug)
 *   - P0 survival violation → FAIL, exit 1
 *   - home-path leak in artifact → FATAL, exit 1
 *   - determinism diff → FAIL with first differing line, exit 1
 *
 * Zero Math.random. Node stdlib only. Run tests:
 *   node --test scripts/eval/session-start-size.test.mjs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  scrubNetworkEnv,
  assertNetworkEnvScrubbed,
  estimateTokens,
  cjkAdjustedTokens,
  percentile,
  hashStoreTree,
  prepareTempStore,
  removeTempStore,
  resolveStore,
  listProjects,
  machineLabel,
  gitCommitShort,
  coreVersion,
  utcNowIso,
  utcDateStamp,
  assertNoHomeLeak,
  STORE_HASH_BASIS,
} from "./bench-lib.mjs";
import { canonicalJson } from "./bench-artifact.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINES_DIR = path.join(HERE, "baselines");

export const SCHEMA_VERSION = "injection-baseline/v1";
export const BENCH_VERSION = "session-start-size-v1";

/** Keys every injection artifact must carry — verifyBaseline checks these too. */
export const REQUIRED_KEYS = [
  "schema_version",
  "bench_version",
  "generated_utc",
  "git_commit",
  "core_version",
  "node",
  "platform",
  "machine",
  "store",
  "store_hash",
  "store_hash_basis",
  "estimator",
  "payload",
  "per_project",
  "median_tokens",
  "p95_tokens",
  "max_tokens",
  "median_chars",
];

export function assertArtifactShape(artifact) {
  const missing = REQUIRED_KEYS.filter((k) => !(k in artifact));
  if (missing.length > 0) {
    throw new Error(`injection artifact missing keys: ${missing.join(", ")}`);
  }
  if (!Array.isArray(artifact.per_project) || artifact.per_project.length === 0) {
    throw new Error("injection artifact: per_project must be a non-empty array");
  }
  for (const row of artifact.per_project) {
    for (const k of ["project", "chars", "tokens", "tokens_cjk_adjusted", "p0_in_store", "p0_in_payload", "p0_survival_ok"]) {
      if (!(k in row)) throw new Error(`injection artifact: per_project row missing ${k}`);
    }
  }
}

/** Lazy dist imports — AFTER env scrub, so no module can capture live keys. */
async function loadShipped() {
  const coreSessionStart = await import(
    new URL("../../packages/core/dist/tools-logic/session-start.js", import.meta.url).href
  );
  const mcpSessionStart = await import(
    new URL("../../packages/mcp-server/dist/tools/session-start.js", import.meta.url).href
  );
  const corrections = await import(
    new URL("../../packages/core/dist/storage/corrections.js", import.meta.url).href
  );
  return {
    sessionStart: coreSessionStart.sessionStart,
    formatTerse: mcpSessionStart.formatTerse,
    readP0Corrections: corrections.readP0Corrections,
  };
}

/**
 * Measure one project on a FRESH temp copy of the store.
 * Returns the artifact row. Exported for the test file.
 */
export async function measureProject(shipped, storeRoot, project) {
  const tmp = prepareTempStore(storeRoot);
  process.env.AGENT_RECALL_ROOT = tmp;
  try {
    assertNetworkEnvScrubbed();
    const p0InStore = shipped.readP0Corrections(project).length;
    const result = await shipped.sessionStart({ project });
    const text = shipped.formatTerse(result);
    const p0InPayload = (result.corrections ?? []).filter((c) => c.severity === "p0").length;
    const expected = Math.min(p0InStore, 10);
    return {
      project,
      chars: text.length,
      tokens: estimateTokens(text),
      tokens_cjk_adjusted: cjkAdjustedTokens(text),
      p0_in_store: p0InStore,
      p0_in_payload: p0InPayload,
      p0_survival_ok: p0InPayload === expected,
    };
  } finally {
    delete process.env.AGENT_RECALL_ROOT;
    removeTempStore(tmp);
  }
}

/** Full measurement pass → { artifact, autoRow }. Exported for the test file. */
export async function runMeasurement(storeArg) {
  const store = resolveStore(storeArg);
  const projects = listProjects(store.root);
  if (projects.length === 0) {
    throw new Error(`FATAL: store has no projects: ${store.label}`);
  }
  const storeHash = hashStoreTree(store.root);
  const shipped = await loadShipped();

  const perProject = [];
  for (const project of projects) {
    try {
      perProject.push(await measureProject(shipped, store.root, project));
    } catch (e) {
      throw new Error(`FATAL: sessionStart failed for project "${project}": ${e?.message ?? e}`);
    }
  }

  // "auto" row — printed only, never in the artifact (cwd-dependent slug).
  let autoRow = null;
  const tmp = prepareTempStore(store.root);
  process.env.AGENT_RECALL_ROOT = tmp;
  try {
    const result = await shipped.sessionStart({ project: "auto" });
    const text = shipped.formatTerse(result);
    autoRow = { resolved: result.project, chars: text.length, tokens: estimateTokens(text) };
  } catch (e) {
    autoRow = { resolved: "(auto failed)", error: String(e?.message ?? e) };
  } finally {
    delete process.env.AGENT_RECALL_ROOT;
    removeTempStore(tmp);
  }

  const tokens = perProject.map((r) => r.tokens);
  const chars = perProject.map((r) => r.chars);

  const artifact = {
    schema_version: SCHEMA_VERSION,
    bench_version: BENCH_VERSION,
    generated_utc: utcNowIso(),
    git_commit: gitCommitShort(),
    core_version: coreVersion(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    machine: machineLabel(),
    store: store.label,
    store_hash: storeHash,
    store_hash_basis: STORE_HASH_BASIS,
    estimator: "chars/4 (ceil) — replicates packages/core handoff.ts:275; no real tokenizer without new deps",
    payload:
      "MCP session_start default: formatTerse(sessionStart({project})) — mode=full, verbose=false; content[0].text string",
    per_project: perProject,
    median_tokens: percentile(tokens, 50),
    p95_tokens: percentile(tokens, 95),
    max_tokens: Math.max(...tokens),
    median_chars: percentile(chars, 50),
  };
  assertArtifactShape(artifact);
  return { artifact, autoRow };
}

function printTable(artifact, autoRow) {
  const w = (s, n) => String(s).padEnd(n);
  process.stdout.write(`session-start-size — store: ${artifact.store} (hash ${artifact.store_hash.slice(0, 12)}…)\n`);
  process.stdout.write(`payload: ${artifact.payload}\n`);
  process.stdout.write(`${w("project", 24)}${w("chars", 8)}${w("tokens", 8)}${w("cjk-adj", 9)}${w("P0 store", 10)}${w("P0 payload", 12)}survival\n`);
  for (const r of artifact.per_project) {
    process.stdout.write(
      `${w(r.project, 24)}${w(r.chars, 8)}${w(r.tokens, 8)}${w(r.tokens_cjk_adjusted, 9)}${w(r.p0_in_store, 10)}${w(r.p0_in_payload, 12)}${r.p0_survival_ok ? "OK" : "FAIL"}\n`,
    );
  }
  if (autoRow) {
    const extra = autoRow.error ? ` (${autoRow.error})` : ` chars=${autoRow.chars} tokens=${autoRow.tokens}`;
    process.stdout.write(`auto → ${autoRow.resolved}${extra}  [printed only — cwd-dependent, excluded from artifact]\n`);
  }
  process.stdout.write(
    `median ${artifact.median_tokens} tokens | p95 ${artifact.p95_tokens} | max ${artifact.max_tokens} (estimator: chars/4, over ${artifact.per_project.length} projects)\n`,
  );
}

/** Strip the one non-deterministic field before byte-diffing double runs. */
function deterministicBytes(artifact) {
  const clone = { ...artifact };
  delete clone.generated_utc;
  return canonicalJson(clone);
}

async function main() {
  // Scrub FIRST — before TZ pin, before any dist import runs.
  scrubNetworkEnv();
  process.env.TZ = "UTC"; // run-bench §7.3 — day-bucketing determinism

  const args = process.argv.slice(2);
  const storeIdx = args.indexOf("--store");
  const storeArg = storeIdx >= 0 ? args[storeIdx + 1] : undefined;
  const asJson = args.includes("--json");
  const noArtifact = args.includes("--no-artifact");
  const checkDeterminism = args.includes("--check-determinism");

  if (checkDeterminism) {
    const a = deterministicBytes((await runMeasurement(storeArg)).artifact);
    const b = deterministicBytes((await runMeasurement(storeArg)).artifact);
    if (a !== b) {
      const aLines = a.split('","');
      const bLines = b.split('","');
      let firstDiff = "(unknown)";
      for (let i = 0; i < Math.max(aLines.length, bLines.length); i++) {
        if (aLines[i] !== bLines[i]) {
          firstDiff = `run1: ${aLines[i] ?? "(absent)"}\nrun2: ${bLines[i] ?? "(absent)"}`;
          break;
        }
      }
      process.stderr.write(`FAIL: injection determinism byte-diff (excluding generated_utc)\n${firstDiff}\n`);
      process.exit(1);
    }
    process.stdout.write("session-start-size: determinism OK (double-run byte-identical excluding generated_utc)\n");
    return;
  }

  const { artifact, autoRow } = await runMeasurement(storeArg);
  const json = JSON.stringify(artifact, null, 2) + "\n";
  assertNoHomeLeak(json);

  if (!noArtifact) {
    fs.mkdirSync(BASELINES_DIR, { recursive: true });
    const file = path.join(BASELINES_DIR, `injection-${utcDateStamp()}.json`);
    fs.writeFileSync(file, json);
    process.stdout.write(`artifact: ${path.relative(path.join(HERE, "..", ".."), file).split(path.sep).join("/")}\n`);
  }
  if (asJson) {
    process.stdout.write(json);
  } else {
    printTable(artifact, autoRow);
  }

  const failed = artifact.per_project.filter((r) => !r.p0_survival_ok);
  if (failed.length > 0) {
    process.stderr.write(`FAIL: P0 survival violated for: ${failed.map((r) => r.project).join(", ")}\n`);
    process.exit(1);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`${e?.message ?? e}\n`);
    process.exit(1);
  });
}
