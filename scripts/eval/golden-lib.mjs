/**
 * golden-lib.mjs — pure, unit-testable helpers for the golden retrieval
 * harness (golden-retrieval.mjs). No core imports, no network, no
 * randomness (Math.random is banned in scripts/eval/** — CI grep gate).
 *
 * Exports:
 *   computeFixtureManifest(rootDir)  — canonical tree hash over the fixture
 *   verifyGoldenLock(lock, manifest, queriesRaw) — refuse-on-mismatch check
 *   scoreQuery(results, query, limit) — HIT@k scoring (path OR substring)
 *   aggregate(perQuery)              — per-category + overall tables w/ Wilson
 *   stripVolatile(jsonString)        — determinism byte-diff normalizer
 *
 * SCORING RULE (automatable; differs from the 08-18 human grading):
 *   A result row counts as a target match when EITHER
 *     (a) its provenance identity resolves to one of ground_truth.target_paths
 *         (palace: verbatimKey.room/file → projects/<p>/palace/rooms/<room>/<file>;
 *          journal: verbatimKey.date → date-prefix match on a /journal/ target
 *          basename within the queried project; corrections: item id →
 *          corrections/<id>.json; insight items have no path identity), OR
 *     (b) its title+excerpt contains ground_truth.required_substring
 *         (case-insensitive; CJK unaffected by case folding).
 *   hit@k = any of the top-k rows matches. The 2026-08-18 eval instead used
 *   a HUMAN adversarial provenance check (re-read the cited source and
 *   verify the excerpt actually states the claim). The automatable rule is
 *   stricter in one way (a topically-similar row without the exact claim
 *   substring and without the right path is always a MISS) and weaker in
 *   another (a row that quotes the substring in a NEGATING context would
 *   still count as a hit — fixture content is authored so no such negating
 *   quote exists).
 *
 *   stale_confident (category C only, per the 08-18 "confident stale-return"
 *   metric): top-1's title+excerpt contains trap_substring AND no top-5
 *   row's title+excerpt contains required_substring.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { wilson95 } from "./bench-artifact.mjs";

export { wilson95 };

// ── Canonical tree hash ─────────────────────────────────────────────────────

function sha256hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function walkFiles(dir, base, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`cannot read fixture dir ${dir}: ${e.message}`);
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(abs, base, out);
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
}

/**
 * Walk every file under rootDir (sorted by forward-slash relative path) and
 * hash `relPath + "\0" + content` per file, so renames and content edits
 * both change the hash. corpus_hash = sha256 over the SORTED per-file
 * hashes joined with "\n" — the SAME aggregation bench-artifact.mjs's
 * verifyBaseline branch (a) recomputes from a stored manifest, so a
 * baseline embedding this manifest is independently re-verifiable.
 *
 * Content is hashed as raw bytes EXCEPT that CRLF is normalized to LF first:
 * the fixture is committed text and git's autocrlf would otherwise produce a
 * different corpus_hash on Windows checkouts than on Linux (A2 lesson).
 */
export function computeFixtureManifest(rootDir) {
  const files = [];
  walkFiles(rootDir, rootDir, files);
  const manifest = files
    .map((abs) => {
      const rel = path.relative(rootDir, abs).split(path.sep).join("/");
      const content = fs.readFileSync(abs).toString("utf-8").replace(/\r\n/g, "\n");
      return { path: rel, sha256: sha256hex(rel + "\0" + content) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const corpus_hash = sha256hex(manifest.map((m) => m.sha256).sort().join("\n"));
  return { manifest, corpus_hash, n_files: manifest.length };
}

/** Hash the queries file (CRLF-normalized) so the query set is lock-pinned too. */
export function hashQueriesRaw(raw) {
  return sha256hex(raw.replace(/\r\n/g, "\n"));
}

/**
 * Verify the lock against a freshly computed manifest + queries file.
 * Returns { ok: true } or { ok: false, reason } — caller decides to exit.
 */
export function verifyGoldenLock(lock, computed, queriesRaw) {
  if (!lock || typeof lock !== "object") return { ok: false, reason: "lock missing or not an object" };
  if (lock.schema_version !== "golden-fixture/v1") {
    return { ok: false, reason: `unknown lock schema_version "${lock.schema_version}"` };
  }
  if (lock.corpus_hash !== computed.corpus_hash) {
    return {
      ok: false,
      reason: `corpus_hash mismatch:\n  lock:   ${lock.corpus_hash}\n  actual: ${computed.corpus_hash}`,
    };
  }
  if (lock.n_files !== computed.n_files) {
    return { ok: false, reason: `n_files mismatch: lock=${lock.n_files} actual=${computed.n_files}` };
  }
  const qh = hashQueriesRaw(queriesRaw);
  if (lock.queries_hash !== qh) {
    return { ok: false, reason: `queries_hash mismatch:\n  lock:   ${lock.queries_hash}\n  actual: ${qh}` };
  }
  return { ok: true };
}

// ── Scoring ─────────────────────────────────────────────────────────────────

function norm(s) {
  return (s ?? "").toLowerCase();
}

function resultHaystack(item) {
  return `${item.title ?? ""}\n${item.excerpt ?? ""}`;
}

/**
 * Does ONE result row's provenance identity resolve to targetPath?
 * targetPath is fixture-root-relative, forward slashes.
 * `project` is the QUERY's scope — the project smartRecall searched.
 */
export function matchByPath(item, targetPath, project) {
  const t = targetPath.split("\\").join("/");
  const vk = item.verbatimKey;
  if (item.source === "palace" && vk?.kind === "palace" && vk.room && vk.file) {
    const file = vk.file.endsWith(".md") ? vk.file : `${vk.file}.md`;
    const built = `projects/${project}/palace/rooms/${vk.room}/${file}`;
    return built === t;
  }
  if (item.source === "journal" && vk?.kind === "journal" && vk.date) {
    if (!t.startsWith(`projects/${project}/journal/`)) return false;
    const basename = t.slice(t.lastIndexOf("/") + 1);
    return basename.startsWith(vk.date);
  }
  if (item.source === "corrections" && item.id) {
    return t === `projects/${project}/corrections/${item.id}.json`;
  }
  if (item.source === "archive" && vk?.kind === "archive" && vk.file) {
    return t === `projects/${project}/journal/archive/raw/${vk.file}`;
  }
  // insight rows carry no file identity — they can only match via
  // required_substring (rule (b)); "insights-index.json" target_paths are
  // deliberately NOT path-matchable.
  return false;
}

export function matchBySubstring(item, requiredSubstring) {
  if (!requiredSubstring) return false;
  return norm(resultHaystack(item)).includes(norm(requiredSubstring));
}

function isTargetMatch(item, groundTruth, project) {
  for (const tp of groundTruth.target_paths ?? []) {
    if (matchByPath(item, tp, project)) return true;
  }
  return matchBySubstring(item, groundTruth.required_substring);
}

/**
 * Score one query's result list.
 * `results` — SmartRecallResultItem-shaped rows (only id/source/title/
 * excerpt/verbatimKey are read). `query` — one row of golden-v1.queries.json.
 */
export function scoreQuery(results, query, limit = 5) {
  const gt = query.ground_truth;
  const top = (results ?? []).slice(0, limit);
  let rankOfFirstTarget = null;
  for (let i = 0; i < top.length; i++) {
    if (isTargetMatch(top[i], gt, query.project)) {
      rankOfFirstTarget = i + 1;
      break;
    }
  }
  const hit1 = rankOfFirstTarget === 1;
  const hit5 = rankOfFirstTarget !== null;

  let staleConfident = false;
  if (query.category === "freshness" && gt.trap_substring && top.length > 0) {
    const anyRequired = top.some((it) => matchBySubstring(it, gt.required_substring));
    staleConfident = matchBySubstring(top[0], gt.trap_substring) && !anyRequired;
  }

  return {
    id: query.id,
    category: query.category,
    project: query.project,
    hit1,
    hit5,
    rank_of_first_target: rankOfFirstTarget,
    stale_confident: staleConfident,
    top5_sources: top.map((it) => ({
      source: it.source,
      title: it.title ?? "",
      id: it.id ?? "",
    })),
  };
}

// ── Aggregation ─────────────────────────────────────────────────────────────

const CATEGORY_ORDER = ["known-decision", "cross-project", "freshness", "cjk"];

function ratio(num, den) {
  const [lo, hi] = wilson95(num, den);
  return { num, den, value: den === 0 ? null : num / den, wilson95: [lo, hi] };
}

export function aggregate(perQuery) {
  const by_category = {};
  for (const cat of CATEGORY_ORDER) {
    const rows = perQuery.filter((r) => r.category === cat);
    by_category[cat] = {
      hit1: ratio(rows.filter((r) => r.hit1).length, rows.length),
      hit5: ratio(rows.filter((r) => r.hit5).length, rows.length),
    };
  }
  const cRows = perQuery.filter((r) => r.category === "freshness");
  const cjkRows = perQuery.filter((r) => r.category === "cjk");
  const asciiRows = perQuery.filter((r) => r.category !== "cjk");
  return {
    overall: {
      hit1: ratio(perQuery.filter((r) => r.hit1).length, perQuery.length),
      hit5: ratio(perQuery.filter((r) => r.hit5).length, perQuery.length),
    },
    by_category,
    stale_return_rate: ratio(cRows.filter((r) => r.stale_confident).length, cRows.length),
    cjk_vs_ascii: {
      cjk_hit5: ratio(cjkRows.filter((r) => r.hit5).length, cjkRows.length),
      ascii_hit5: ratio(asciiRows.filter((r) => r.hit5).length, asciiRows.length),
    },
  };
}

// ── Determinism strip ───────────────────────────────────────────────────────

/**
 * Strip the ONLY contractually volatile field (generated_utc) before a
 * byte-diff of two runs. Everything else — per_query, aggregates, hashes,
 * environment — must be identical for the determinism gate to pass.
 */
export function stripVolatile(jsonString) {
  const obj = JSON.parse(jsonString);
  delete obj.generated_utc;
  return JSON.stringify(obj, null, 2);
}

// ── Artifact leak gate ──────────────────────────────────────────────────────

/** Mirrors run-bench's assertNoHomeLeak, extended for Windows paths. */
export function findHomeLeak(content) {
  for (const marker of ["/Users/", "/home/", "C:\\Users", "C:/Users"]) {
    if (content.includes(marker)) return marker;
  }
  return null;
}
