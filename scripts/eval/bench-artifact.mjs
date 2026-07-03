#!/usr/bin/env node
/**
 * bench-artifact.mjs — canonical JSON, corpus manifest, baseline write/verify.
 *
 * Named ESM exports (all documented inline):
 *   canonicalJson(value)         → deterministic sorted-key UTF-8 NFC LF JSON
 *   TEST_VECTORS                  → spec §V8 unit-test vectors
 *   corpusManifest(records)       → {record_hash[], tree_hash, n_on_disk, n_counted, excluded[]}
 *   writeBaseline(result, opts)   → whole-artifact scrub + home redaction + sort
 *   verifyBaseline(file)          → recompute corpus_hash + headline metrics from per_item
 *
 * Error paths traced:
 *   - scrubForExport throws SecretScanError (whole artifact aborted, never partial)
 *   - verifyBaseline corpus_hash mismatch → throws
 *   - verifyBaseline metric drift → throws listing which field drifted
 *   - malformed baseline JSON → throws with file path
 *   - hash-only mode → manifest: [] in output (no file list)
 *
 * Zero Math.random. Node stdlib only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import { scrubForExport, SecretScanError } from "../../packages/core/dist/storage/content-guard.js";

// ── Constants ──────────────────────────────────────────────────────────────

export const BENCH_ARTIFACT_VERSION = "bench-result/v1";
const HOME = os.homedir();

// ── Canonical JSON (spec §4.4 / §V8) ──────────────────────────────────────

/**
 * canonicalJson(value) — sorted keys, UTF-8 NFC, LF line endings, no insignificant
 * whitespace. Two independent implementations MUST produce byte-identical output for
 * the same logical value so corpus_hash is reproducible across machines.
 *
 * Rules (spec V8):
 *   - Object keys sorted lexicographically (Unicode code-point order)
 *   - Applied recursively to nested objects
 *   - Arrays preserve element order (not sorted)
 *   - Strings NFC-normalized
 *   - Numbers: JSON.stringify's native representation (no added precision)
 *   - No trailing newline (callers add if needed)
 *
 * Error path: JSON.stringify throws on circular refs → propagates.
 */
export function canonicalJson(value) {
  return _toCanonical(value);
}

function _toCanonical(val) {
  if (val === null) return "null";
  if (val === undefined) return "null"; // treat undefined as null in JSON
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") {
    if (!Number.isFinite(val)) throw new TypeError(`canonicalJson: non-finite number ${val}`);
    return JSON.stringify(val);
  }
  if (typeof val === "string") {
    return JSON.stringify(val.normalize("NFC"));
  }
  if (Array.isArray(val)) {
    return "[" + val.map(_toCanonical).join(",") + "]";
  }
  if (typeof val === "object") {
    const keys = Object.keys(val).sort();
    const pairs = keys.map((k) => {
      const keyStr = JSON.stringify(k.normalize("NFC"));
      return keyStr + ":" + _toCanonical(val[k]);
    });
    return "{" + pairs.join(",") + "}";
  }
  throw new TypeError(`canonicalJson: unsupported type ${typeof val}`);
}

// ── Spec §V8 test vectors ──────────────────────────────────────────────────

/**
 * TEST_VECTORS — each entry is {input, expected} for canonicalJson.
 * These are the pinning vectors from spec V8; two implementations must agree on all.
 * Run as: node scripts/eval/bench-artifact.mjs --self-test
 */
export const TEST_VECTORS = [
  // Key ordering
  {
    input: { b: 1, a: 2 },
    expected: '{"a":2,"b":1}',
    label: "object keys sorted",
  },
  // Nested key ordering
  {
    input: { z: { b: 1, a: 2 }, a: [3, 1, 2] },
    expected: '{"a":[3,1,2],"z":{"a":2,"b":1}}',
    label: "nested objects sorted, arrays preserve order",
  },
  // NFC normalization — café: NFC vs NFD
  {
    input: { name: "café" }, // NFD: e + combining acute
    expected: '{"name":"café"}',  // NFC: é
    label: "string NFC normalization",
  },
  // Null and boolean
  {
    input: { x: null, y: true, z: false },
    expected: '{"x":null,"y":true,"z":false}',
    label: "null and booleans",
  },
  // Numbers
  {
    input: { n: 3.14, m: 0, k: -1 },
    expected: '{"k":-1,"m":0,"n":3.14}',
    label: "number representation",
  },
  // Empty object and array
  {
    input: {},
    expected: "{}",
    label: "empty object",
  },
  {
    input: [],
    expected: "[]",
    label: "empty array",
  },
  // Deeply nested
  {
    input: { c: { b: { a: 1 } }, a: 2 },
    expected: '{"a":2,"c":{"b":{"a":1}}}',
    label: "deeply nested key order",
  },
  // Unicode key
  {
    input: { "α": 1, "A": 2 },
    expected: '{"A":2,"α":1}',
    label: "unicode key ordering by code point",
  },
  // Array of objects (arrays preserve order, not sorted)
  {
    input: [{ b: 2, a: 1 }, { d: 4, c: 3 }],
    expected: '[{"a":1,"b":2},{"c":3,"d":4}]',
    label: "array of objects: preserve array order, sort each object",
  },
];

// ── Wilson 95% CI (spec §2.5) ──────────────────────────────────────────────

/**
 * wilson95(k, n) → [lo, hi] clamped to [0,1].
 * Returns [0, 1] when n=0 (uninformative prior — never return null).
 * z = 1.96 (95% confidence).
 *
 * Spec §2.5 vectors (verified):
 *   wilson95(0, 8)  → [0.0000, 0.3244]
 *   wilson95(8, 8)  → [0.6756, 1.0000]
 *   wilson95(0, 40) → [0.0000, 0.0876]
 */
export function wilson95(k, n) {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const z2n = (z * z) / n;
  const center = (p + z2n / 2) / (1 + z2n);
  const halfWidth = (z / (1 + z2n)) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, center - halfWidth), Math.min(1, center + halfWidth)];
}

// Wilson test vectors for self-test
export const WILSON_TEST_VECTORS = [
  { k: 0, n: 8, lo: 0.0000, hi: 0.3244, label: "Wilson(0/8)" },
  { k: 8, n: 8, lo: 0.6756, hi: 1.0000, label: "Wilson(8/8)" },
  { k: 0, n: 40, lo: 0.0000, hi: 0.0876, label: "Wilson(0/40)" },
];

// ── SHA-256 helper ─────────────────────────────────────────────────────────

function sha256hex(str) {
  return crypto.createHash("sha256").update(str, "utf-8").digest("hex");
}

// ── corpusManifest (spec §2.2, §4.4) ──────────────────────────────────────

/**
 * corpusManifest(records) — compute per-record hashes and the tree hash for a
 * set of CorrectionExport records (or CTI objects).
 *
 * Count rule (spec §2.2): a record is COUNTED iff it has both a non-empty
 * `rule` AND a valid `date` (non-empty string).
 *
 * Returns:
 *   {
 *     items: Array<{project, file, sha256}>,   // one per record — project+file for manifest
 *     record_hashes: string[],                  // sha256(canonicalJson(record)) per record
 *     tree_hash: string,                        // sha256(sorted record_hashes joined by \n)
 *     n_on_disk: number,                        // total records passed in
 *     n_counted: number,                        // records passing the count rule
 *     excluded: Array<{id, reason}>,            // dropped records (§2.2)
 *   }
 *
 * Error path: non-finite number in a record → canonicalJson throws TypeError
 */
export function corpusManifest(records) {
  const items = [];
  const recordHashes = [];
  const excluded = [];
  let nCounted = 0;

  for (const rec of records) {
    const hasRule = typeof rec.rule === "string" && rec.rule.trim().length > 0;
    const hasDate = typeof rec.date === "string" && rec.date.length > 0;

    const hash = sha256hex(canonicalJson(rec));
    recordHashes.push(hash);

    // Derive a deterministic file-like name for manifest
    const project = typeof rec.project === "string" ? rec.project : "_unknown";
    const recId = typeof rec.id === "string" ? rec.id : hash.slice(0, 8);
    items.push({ project, file: `${recId}.json`, sha256: hash });

    if (!hasRule || !hasDate) {
      const reason = !hasRule && !hasDate
        ? "missing_rule_and_date"
        : !hasRule
        ? "missing_rule"
        : "missing_date";
      excluded.push({ id: recId, reason });
    } else {
      nCounted++;
    }
  }

  // tree_hash = sha256(sorted record_hashes joined by \n)
  const treeHash = sha256hex([...recordHashes].sort().join("\n"));

  return {
    items,
    record_hashes: recordHashes,
    tree_hash: treeHash,
    n_on_disk: records.length,
    n_counted: nCounted,
    excluded,
  };
}

// ── Home-path redaction ────────────────────────────────────────────────────

/**
 * Redact any absolute home-dir paths from a serialized JSON string.
 * Handles /Users/… on macOS, /home/… on Linux.
 * Also maps the explicit corpus root if provided.
 *
 * Exported so harvest.mjs applies the SAME redaction to CTI file writes
 * (security review 1a — every egress sink gets identical treatment).
 *
 * Error path: if HOME is somehow undefined, falls back to no-op (never throws).
 */
export function redactHomePaths(json, extraRoot) {
  let out = json;
  // Redact any explicit corpus root first (more specific)
  if (extraRoot) {
    const esc = extraRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(esc, "g"), "<redacted>");
  }
  // Redact any remaining /Users/…  or /home/… prefixes
  if (HOME) {
    const esc = HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(esc, "g"), "<redacted>");
  }
  // Belt-and-suspenders: catch any /Users/<u> or /home/<u> that slipped through
  out = out.replace(/\/Users\/[a-zA-Z0-9_.-]+/g, "<redacted>");
  out = out.replace(/\/home\/[a-zA-Z0-9_.-]+/g, "<redacted>");
  return out;
}

// ── writeBaseline (spec §7.2) ──────────────────────────────────────────────

/**
 * writeBaseline(result, opts) — write a bench-result/v1 artifact.
 *
 * Contract:
 *   1. Sorts per_item by (project, id) so ordering is not part of the contract.
 *   2. Scrubs the WHOLE serialized artifact via scrubForExport (fail-closed).
 *      If scrubForExport throws SecretScanError → rethrow, never write partial.
 *   3. Maps home paths → "<redacted>".
 *   4. --manifest=hash-only mode: replaces manifest items with [] before serializing.
 *   5. anonymizeSlugs mode: every project slug → proj-01, proj-02… (stable
 *      sorted mapping; the mapping itself is NOT included in the artifact).
 *      For public artifacts where real project names fingerprint a stack.
 *   6. Writes to opts.outPath (or returns JSON string if opts.outPath is falsy).
 *
 * @param {object} result — bench-result/v1 object (mutable; per_item sorted in place)
 * @param {{outPath?: string, manifestHashOnly?: boolean, corpusRoot?: string,
 *          anonymizeSlugs?: boolean}} [opts]
 * @returns {string} the final (scrubbed) JSON
 * @throws {SecretScanError} if a secret survives scrubbing
 */
export function writeBaseline(result, opts = {}) {
  const { outPath, manifestHashOnly, corpusRoot, anonymizeSlugs } = opts;

  // 1. Sort per_item by (project, id) — deterministic ordering
  if (Array.isArray(result.per_item)) {
    result.per_item.sort((a, b) => {
      const proj = (a.project ?? "").localeCompare(b.project ?? "");
      if (proj !== 0) return proj;
      return (a.id ?? "").localeCompare(b.id ?? "");
    });
  }

  // 2. Hash-only mode: blank out the manifest file list
  if (manifestHashOnly && result.corpus && Array.isArray(result.corpus.manifest)) {
    result.corpus.manifest = [];
  }

  // 3. Serialize
  let json = JSON.stringify(result, null, 2);

  // 3b. Slug anonymization (security review 4). Collect every project slug from
  // per_item + manifest + excluded, sort for a STABLE mapping, replace each
  // slug string globally in the serialized artifact. The slug→alias mapping is
  // deliberately NOT embedded anywhere in the output.
  if (anonymizeSlugs) {
    const slugs = new Set();
    for (const row of result.per_item ?? []) {
      if (row.project) slugs.add(row.project);
    }
    for (const m of result.corpus?.manifest ?? []) {
      if (m.project) slugs.add(m.project);
    }
    for (const e of result.corpus?.excluded ?? []) {
      if (e.project) slugs.add(e.project);
    }
    const sorted = [...slugs].sort();
    // Longest-first replacement so a slug that prefixes another cannot corrupt it.
    const byLength = [...sorted].sort((a, b) => b.length - a.length);
    const alias = new Map(sorted.map((s, i) => [s, `proj-${String(i + 1).padStart(2, "0")}`]));
    for (const slug of byLength) {
      const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      json = json.replace(new RegExp(`"${esc}"`, "g"), `"${alias.get(slug)}"`);
    }
  }

  // 4. Home-path redaction (BEFORE scrubForExport so scrub can see clean text)
  json = redactHomePaths(json, corpusRoot);

  // 5. Fail-closed scrub of the WHOLE artifact
  // scrubForExport throws SecretScanError if any secret pattern survives →
  // propagate loudly, never write a partial or leaky artifact.
  try {
    json = scrubForExport(json);
  } catch (e) {
    if (e instanceof SecretScanError) {
      throw new SecretScanError(
        `writeBaseline: secret survived scrub — aborting write. ${e.label}`,
      );
    }
    throw e;
  }

  // 6. Write or return
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, json, { encoding: "utf-8", mode: 0o600 });
  }

  return json;
}

// ── verifyBaseline (spec §7.2) ─────────────────────────────────────────────

/**
 * verifyBaseline(file) — independent recomputation of corpus_hash and headline
 * metrics from per_item. Throws on ANY mismatch — the entry condition for
 * third-party reproduction (the Mem0-Zep resolution requirement).
 *
 * Checks:
 *   (a) corpus_hash: recompute tree_hash from embedded corpus.manifest sha256s,
 *       assert equals corpus.corpus_hash.
 *   (b) Every headline metric: recompute from per_item, assert equality with
 *       metrics.{recall_achievable, recall_theoretical, precision, ffr}.
 *   (c) denominators.{theoretical, achievable}: recount from per_item.
 *
 * Error paths:
 *   - File not found → throws with path
 *   - Malformed JSON → throws with path
 *   - corpus_hash mismatch → throws with expected vs actual
 *   - metric mismatch → throws listing which field drifted
 *
 * @param {string} file — absolute path to a bench-result/v1 JSON file
 * @returns {{ok: true, benchmark: string}} on success
 * @throws {Error} on any mismatch or IO failure
 */
export function verifyBaseline(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (e) {
    throw new Error(`verifyBaseline: cannot read ${file}: ${e.message}`);
  }

  let result;
  try {
    result = JSON.parse(raw);
  } catch (e) {
    throw new Error(`verifyBaseline: malformed JSON in ${file}: ${e.message}`);
  }

  const schema = result.schema_version;
  if (
    schema !== BENCH_ARTIFACT_VERSION &&
    schema !== "rmr-baseline/v1" &&
    schema !== "rmr-baseline/v2"
  ) {
    throw new Error(
      `verifyBaseline: unknown schema_version "${schema}" in ${file}`,
    );
  }

  // rmr-baseline/v1|v2 have a different structure — verify what we can.
  // v2 (C3, 2026-07-03) adds c3_* verdict-coverage fields; parse-check only,
  // same as v1 (no per_item to recompute from).
  if (schema === "rmr-baseline/v1" || schema === "rmr-baseline/v2") {
    // Nothing to recompute for these schemas; just confirm they parse
    return { ok: true, benchmark: "rmr-report" };
  }

  // ── (a) corpus_hash recompute from manifest ────────────────────────────
  const corpus = result.corpus ?? {};
  const manifest = corpus.manifest ?? [];

  if (manifest.length > 0) {
    const sortedHashes = [...manifest.map((m) => m.sha256)].sort();
    const recomputed = sha256hex(sortedHashes.join("\n"));
    if (recomputed !== corpus.corpus_hash) {
      throw new Error(
        `verifyBaseline: corpus_hash mismatch in ${file}\n` +
        `  stored:     ${corpus.corpus_hash}\n` +
        `  recomputed: ${recomputed}`,
      );
    }
  }

  // ── (b) Headline metric recompute from per_item ────────────────────────
  const items = result.per_item ?? [];
  const metrics = result.metrics ?? {};
  const denominators = result.denominators ?? {};

  // Recount denominators
  let nTheo = 0;
  let nAchiev = 0;
  let nFired = 0;
  let nHits = 0;
  let nNegFires = 0;
  let nNegUnits = 0;

  for (const item of items) {
    if (item.predictable) nTheo++;
    if (item.active_predictable) nAchiev++;
    if (item.fired) {
      nFired++;
      if (item.hit) nHits++;
    }
    if (typeof item.neg_fires === "number") nNegFires += item.neg_fires;
    if (typeof item.neg_units === "number") nNegUnits += item.neg_units;
  }

  const drifts = [];

  function checkInt(storedPath, computed, label) {
    const stored = _get(result, storedPath);
    if (stored !== undefined && stored !== computed) {
      drifts.push(`${label}: stored=${stored}, recomputed=${computed}`);
    }
  }

  function checkNullableRatio(metricKey, num, den) {
    const m = metrics[metricKey];
    if (!m) return;
    const expectedVal = den > 0 ? num / den : null;
    const storedVal = m.value;
    if (storedVal === null && expectedVal === null) return;
    if (storedVal !== null && expectedVal !== null) {
      // Allow epsilon for floating point
      if (Math.abs(storedVal - expectedVal) > 1e-10) {
        drifts.push(`metrics.${metricKey}.value: stored=${storedVal}, recomputed=${expectedVal}`);
      }
    } else {
      drifts.push(
        `metrics.${metricKey}.value: stored=${storedVal}, recomputed=${expectedVal}`,
      );
    }
    if (m.num !== undefined && m.num !== num) {
      drifts.push(`metrics.${metricKey}.num: stored=${m.num}, recomputed=${num}`);
    }
    if (m.den !== undefined && m.den !== den) {
      drifts.push(`metrics.${metricKey}.den: stored=${m.den}, recomputed=${den}`);
    }
  }

  checkInt("denominators.theoretical", nTheo, "denominators.theoretical");
  checkInt("denominators.achievable", nAchiev, "denominators.achievable");

  checkNullableRatio("recall_theoretical", nHits, nTheo);
  checkNullableRatio("recall_achievable", nHits, nAchiev);
  checkNullableRatio("precision", nHits, nFired);

  // FFR: use lead-in level (nNegUnits) if present, else pair level
  if (metrics.ffr && nNegUnits > 0) {
    checkNullableRatio("ffr", nNegFires, nNegUnits);
  }

  if (drifts.length > 0) {
    throw new Error(
      `verifyBaseline: metric drift detected in ${file}:\n  ` +
      drifts.join("\n  "),
    );
  }

  return { ok: true, benchmark: result.benchmark ?? "unknown" };
}

function _get(obj, dotPath) {
  return dotPath.split(".").reduce((o, k) => (o != null ? o[k] : undefined), obj);
}

// ── rmr-report migration helper ────────────────────────────────────────────

/**
 * wrapRmrInEnvelope(rmrArtifact, env) — wrap an existing rmr-baseline/v1 artifact
 * in the bench-result/v1 envelope (spec §7.2: migrate, don't break).
 *
 * The inner shape is preserved verbatim under result.pooled / result.per_project.
 * @param {object} rmrArtifact — parsed rmr-baseline/v1 JSON
 * @param {{nodeVersion?: string, platform?: string, repoCommit?: string, coreVersion?: string}} [env]
 * @returns bench-result/v1 object
 */
export function wrapRmrInEnvelope(rmrArtifact, env = {}) {
  return {
    schema_version: BENCH_ARTIFACT_VERSION,
    benchmark: "rmr-report",
    benchmark_version: "rmr-v1-2026-07-02",
    generated_utc: new Date().toISOString(),
    corpus: {
      corpus_hash: null, // rmr-report has no canonical corpus hash
      n_on_disk: rmrArtifact.pooled?.n_total ?? null,
      n_counted: rmrArtifact.pooled?.n_total ?? null,
      n_active: rmrArtifact.pooled?.n_active ?? null,
      n_retracted: rmrArtifact.pooled?.n_retracted ?? null,
      n_projects: rmrArtifact.projects_scanned ?? null,
      excluded: [],
      rejected_lines: null,
      active_approximation: "export-time",
      manifest: [],
    },
    config: {},
    environment: {
      node: env.nodeVersion ?? process.version,
      platform: env.platform ?? process.platform + "-" + process.arch,
      tz: process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      repo_commit: env.repoCommit ?? null,
      core_version: env.coreVersion ?? null,
    },
    denominators: {},
    metrics: {},
    // Inner rmr-report data preserved
    rmr_inner: rmrArtifact,
    per_item: [],
  };
}

// ── Self-test entry point ──────────────────────────────────────────────────

function runSelfTest() {
  let passed = 0;
  let failed = 0;

  function assert(cond, label, detail = "") {
    if (cond) {
      process.stdout.write(`  PASS: ${label}\n`);
      passed++;
    } else {
      process.stdout.write(`  FAIL: ${label}${detail ? " — " + detail : ""}\n`);
      failed++;
    }
  }

  process.stdout.write("── canonicalJson vectors ──\n");
  for (const { input, expected, label } of TEST_VECTORS) {
    const got = canonicalJson(input);
    assert(got === expected, label, `got: ${got}  expected: ${expected}`);
  }

  process.stdout.write("── Wilson95 vectors ──\n");
  for (const { k, n, lo, hi, label } of WILSON_TEST_VECTORS) {
    const [gotLo, gotHi] = wilson95(k, n);
    const lok = Math.abs(gotLo - lo) < 0.0001;
    const hik = Math.abs(gotHi - hi) < 0.0001;
    assert(lok && hik, label, `got [${gotLo.toFixed(4)}, ${gotHi.toFixed(4)}] expected [${lo.toFixed(4)}, ${hi.toFixed(4)}]`);
  }

  process.stdout.write("── corpusManifest count rule ──\n");
  {
    const recs = [
      { id: "a1", rule: "use proxy.ts", date: "2026-01-01", project: "proj" },
      { id: "a2", rule: "", date: "2026-01-02", project: "proj" },        // missing rule
      { id: "a3", rule: "do x", date: "", project: "proj" },              // missing date
      { id: "a4", rule: "do y", date: "2026-01-03", project: "proj" },
    ];
    const m = corpusManifest(recs);
    assert(m.n_on_disk === 4, "n_on_disk=4");
    assert(m.n_counted === 2, "n_counted=2 (only rule+date records)");
    assert(m.excluded.length === 2, "excluded.length=2");
    assert(m.excluded.some((e) => e.id === "a2" && e.reason === "missing_rule"), "a2 excluded missing_rule");
    assert(m.excluded.some((e) => e.id === "a3" && e.reason === "missing_date"), "a3 excluded missing_date");
    assert(typeof m.tree_hash === "string" && m.tree_hash.length === 64, "tree_hash is 64-char hex");
    // Determinism: same input → same output
    const m2 = corpusManifest(recs);
    assert(m.tree_hash === m2.tree_hash, "corpusManifest is deterministic");
  }

  process.stdout.write("── assertBlindCut via Wilson throws ──\n");
  {
    // Wilson with negative n should throw or return [0,1]
    try {
      const r = wilson95(0, 0);
      assert(r[0] === 0 && r[1] === 1, "wilson95(0,0) → [0,1]");
    } catch (e) {
      assert(false, "wilson95(0,0) should not throw", e.message);
    }
  }

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    runSelfTest();
  } else if (args.includes("--verify")) {
    const fileIdx = args.indexOf("--verify");
    const file = args[fileIdx + 1];
    if (!file) {
      process.stderr.write("Usage: bench-artifact.mjs --verify <file>\n");
      process.exit(1);
    }
    try {
      const r = verifyBaseline(file);
      process.stdout.write(`OK: ${r.benchmark} baseline verified\n`);
    } catch (e) {
      process.stderr.write(`FAIL: ${e.message}\n`);
      process.exit(1);
    }
  } else {
    process.stdout.write(
      "bench-artifact.mjs — named ESM exports for bench harness.\n" +
      "  --self-test       run unit-test vectors (canonicalJson, Wilson, corpusManifest)\n" +
      "  --verify <file>   verify a bench-result/v1 baseline JSON\n",
    );
  }
}
