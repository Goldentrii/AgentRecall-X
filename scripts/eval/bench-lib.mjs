#!/usr/bin/env node
/**
 * bench-lib.mjs — shared helpers for the latency / injection-size benches
 * (session-start-size.mjs, latency.mjs).
 *
 * Named ESM exports (all documented inline):
 *   SCRUBBED_ENV_VARS              → network env vars the benches delete
 *   scrubNetworkEnv()              → delete + return the list
 *   assertNetworkEnvScrubbed()     → throws if any scrubbed var is set
 *   estimateTokens(s)              → ceil(chars / 4) — the core convention
 *   cjkAdjustedTokens(s)           → sensitivity estimate (CJK char = 1 token)
 *   percentile(values, p)          → nearest-rank percentile (no interpolation)
 *   meanRounded(values)            → arithmetic mean, 3 decimal places
 *   round3(x)                      → 3-decimal rounding used for all ms values
 *   hashStoreTree(root)            → sha256 tree hash over the store files
 *   prepareTempStore(src)          → copy store into a fresh mkdtemp root
 *   resolveStore(cliStore)         → --store > golden-v1 > corpus-v1, FATAL else
 *   listProjects(root)             → sorted project slugs under <root>/projects/
 *   machineLabel()                 → BENCH_MACHINE env or os.hostname()
 *   gitCommitShort() / coreVersion() / utcNowIso() / utcDateStamp()
 *   assertNoHomeLeak(jsonString)   → throws on /Users/, /home/, C:\Users
 *
 * Determinism: no Math.random anywhere (CI grep gate applies to this file).
 * Node stdlib only — no new dependencies.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── Network env scrub ──────────────────────────────────────────────────────
//
// The 2026-08-18 eval found a contamination path where a bench run with live
// Supabase/embedding keys in the environment reached the network. These
// benches measure LOCAL store behavior only, so every var that could route a
// core call to Supabase or an embedding API is deleted before any core
// function runs. Superset of the four vars named in the task brief — the
// extra AGENT_RECALL_SUPABASE_URL / _EMBEDDING_PROVIDER / _EMBEDDINGS vars
// are the remaining knobs readSupabaseConfig() / the embedding seam honor
// (packages/core/src/supabase/config.ts:57-60, vector/embedding.ts:9).

export const SCRUBBED_ENV_VARS = [
  "AGENT_RECALL_SUPABASE_URL",
  "AGENT_RECALL_SUPABASE_KEY",
  "AGENT_RECALL_EMBEDDING_PROVIDER",
  "AGENT_RECALL_EMBEDDING_KEY",
  "AGENT_RECALL_EMBEDDINGS",
  "OPENAI_API_KEY",
  "VOYAGE_API_KEY",
  "ANTHROPIC_API_KEY",
];

/** Delete every network-capable env var. Returns the scrubbed list. */
export function scrubNetworkEnv() {
  for (const k of SCRUBBED_ENV_VARS) delete process.env[k];
  return [...SCRUBBED_ENV_VARS];
}

/** Throws if any scrubbed var is still set — called inside the measured path. */
export function assertNetworkEnvScrubbed() {
  for (const k of SCRUBBED_ENV_VARS) {
    if (process.env[k] !== undefined) {
      throw new Error(`env scrub failed: ${k} is still set inside the measured call`);
    }
  }
}

// ── Token estimation ───────────────────────────────────────────────────────
//
// chars/4 is the core-wide convention (packages/core/src/tools-logic/
// session-start.ts:174 budget doc, helpers/handoff.ts:275
// `Math.ceil(content.length / 4)`). Core does NOT export an estimator
// function, so this replicates handoff.ts:275 byte-for-byte: ceil, not round.
// Using the same estimator keeps these numbers comparable to the 1,489-token
// claim in UPDATE-LOG.md §C2. No real tokenizer is available without new
// dependencies (none allowed), so chars/4 is the documented method.

export function estimateTokens(s) {
  return Math.ceil(s.length / 4);
}

/**
 * Sensitivity estimate: CJK chars tokenize at roughly 1 token each, not 1/4.
 * Counts chars in the main CJK blocks (U+2E80–U+9FFF ideographs+kana,
 * U+F900–U+FAFF compat ideographs, U+FF00–U+FFEF fullwidth forms) as 1 token,
 * remaining chars at chars/4. Approximation — supplementary-plane ideographs
 * are not special-cased. Reported alongside estimateTokens, never instead.
 */
export function cjkAdjustedTokens(s) {
  const cjk = (s.match(/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/g) ?? []).length;
  return cjk + Math.ceil((s.length - cjk) / 4);
}

// ── Percentiles (nearest-rank, no interpolation) ───────────────────────────
//
// percentile(values, p) sorts ascending and returns the element at
// index ceil(p/100 * n) - 1 (clamped to [0, n-1]). Nearest-rank is chosen
// over interpolation so every reported value is an actually-observed sample
// (p50 of an even-length array is the lower middle, documented in the tests).
// verifyBaseline() recomputes with THIS function — keep them in lockstep.

export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("percentile: empty input");
  }
  if (typeof p !== "number" || p <= 0 || p > 100) {
    throw new Error(`percentile: p must be in (0, 100], got ${p}`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Round to 3 decimal places — the single rounding used for all ms values. */
export function round3(x) {
  return Math.round(x * 1000) / 1000;
}

/** Arithmetic mean rounded via round3. */
export function meanRounded(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("meanRounded: empty input");
  }
  return round3(values.reduce((a, b) => a + b, 0) / values.length);
}

// ── Store hashing / temp copies ────────────────────────────────────────────

function sha256hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * store_hash basis (documented in every artifact): sha256 over the sorted
 * list of "<relpath-forward-slashes>\n<sha256(file bytes)>" lines for every
 * file under the store root. A FILE-TREE hash — deliberately simpler than
 * run-bench's corpusManifest (which hashes the corrections-export/v1
 * projection): these benches measure whole-store payloads (journal, palace,
 * corrections, ...), not just the corrections corpus.
 */
export const STORE_HASH_BASIS =
  "sha256 over sorted '<relpath>\\n<sha256(LF-normalized bytes)>' lines for every file under the store root (forward-slash relpaths; CRLF->LF so git autocrlf checkouts hash identically)";

export function hashStoreTree(root) {
  const lines = walkFiles(root).map((f) => {
    const rel = path.relative(root, f).split(path.sep).join("/");
    // LF-normalize: a git autocrlf checkout on Windows yields CRLF fixture
    // bytes while Linux yields LF — the Linux-container cross-check caught
    // the raw-bytes hash drifting between byte-identical logical stores.
    const bytes = fs.readFileSync(f).toString("latin1").replaceAll("\r\n", "\n");
    return `${rel}\n${sha256hex(Buffer.from(bytes, "latin1"))}`;
  });
  lines.sort();
  return sha256hex(lines.join("\n"));
}

/**
 * Copy the fixture store into a fresh temp dir and return its path.
 * sessionStart()/smartRecall() WRITE to the store root (lifecycle telemetry,
 * outcome records, session locks) — the committed fixture and the user's real
 * ~/.agent-recall must never be touched, so every bench run points
 * AGENT_RECALL_ROOT at a disposable copy. Caller removes it (removeTempStore).
 */
export function prepareTempStore(src) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ar-bench-"));
  fs.cpSync(src, tmp, { recursive: true });
  return tmp;
}

/** Best-effort temp cleanup — never throws (bench result already captured). */
export function removeTempStore(tmp) {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// ── Store resolution ───────────────────────────────────────────────────────

const GOLDEN_V1 = path.join(HERE, "fixtures", "golden-v1");
const CORPUS_V1 = path.join(HERE, "fixtures", "corpus-v1");

/**
 * Resolve the store to bench against:
 *   --store <path>  → that path (label = the string the caller passed)
 *   (absent)        → fixtures/golden-v1 if present (A3's full synthetic
 *                     store: journal + palace + pipeline + corrections),
 *                     else fixtures/corpus-v1 (corrections-only, 26 records).
 * FATAL (throws) when the resolved store has no projects/ directory.
 */
export function resolveStore(cliStore) {
  if (cliStore) {
    const root = path.resolve(cliStore);
    if (!fs.existsSync(path.join(root, "projects"))) {
      throw new Error(`FATAL: store not found or has no projects/ dir: ${cliStore}`);
    }
    return { root, label: cliStore.split(path.sep).join("/") };
  }
  if (fs.existsSync(path.join(GOLDEN_V1, "projects"))) {
    return { root: GOLDEN_V1, label: "scripts/eval/fixtures/golden-v1" };
  }
  if (fs.existsSync(path.join(CORPUS_V1, "projects"))) {
    return { root: CORPUS_V1, label: "scripts/eval/fixtures/corpus-v1" };
  }
  throw new Error(
    "FATAL: no fixture store found (looked for scripts/eval/fixtures/golden-v1 and corpus-v1) and no --store given",
  );
}

/** Sorted project slugs under <root>/projects/. */
export function listProjects(root) {
  const dir = path.join(root, "projects");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

// ── Provenance stamps ──────────────────────────────────────────────────────

/**
 * Machine label for the artifact. BENCH_MACHINE env overrides; the fallback
 * os.hostname() is fine for the owner's machines — set BENCH_MACHINE when a
 * hostname would leak something private.
 */
export function machineLabel() {
  return process.env.BENCH_MACHINE || os.hostname();
}

/** Same helper run-bench.mjs uses (not exported there — small duplication). */
export function gitCommitShort() {
  try {
    return childProcess
      .execSync("git rev-parse --short HEAD", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
      .trim();
  } catch {
    return null;
  }
}

/** Same helper run-bench.mjs uses (not exported there — small duplication). */
export function coreVersion() {
  try {
    const pkgPath = path.join(HERE, "..", "..", "packages", "core", "package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version;
  } catch {
    return null;
  }
}

export function utcNowIso() {
  return new Date().toISOString();
}

export function utcDateStamp() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Home-path leak gate — mirrors run-bench.mjs's assertNoHomeLeak (security
 * review 2b) with the Windows variant added. Throws instead of process.exit
 * so library callers (tests) can assert it.
 */
export function assertNoHomeLeak(jsonString) {
  if (/\/Users\/|\/home\/|[A-Z]:\\+Users/.test(jsonString)) {
    throw new Error("FATAL: home-path leak detected in bench artifact");
  }
}
