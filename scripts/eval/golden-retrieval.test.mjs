/**
 * golden-retrieval.test.mjs — unit tests for golden-lib.mjs (the pure half
 * of the golden retrieval harness). Run standalone, same as every other
 * scripts/eval test:
 *
 *   node --test scripts/eval/golden-retrieval.test.mjs
 *
 * (scripts/eval tests are NOT part of `npm test` — that runs workspace
 * tests only; these run as an explicit CI step in bench-fixture.yml,
 * matching how the fixture lane gates its own harness logic.)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  wilson95,
  computeFixtureManifest,
  hashQueriesRaw,
  verifyGoldenLock,
  matchByPath,
  matchBySubstring,
  scoreQuery,
  aggregate,
  stripVolatile,
  findHomeLeak,
} from "./golden-lib.mjs";

// ── Wilson CI (shared implementation, known vectors) ────────────────────────

describe("wilson95", () => {
  it("matches the published test vectors", () => {
    const vectors = [
      { k: 0, n: 8, lo: 0.0, hi: 0.3244 },
      { k: 8, n: 8, lo: 0.6756, hi: 1.0 },
      { k: 0, n: 40, lo: 0.0, hi: 0.0876 },
    ];
    for (const v of vectors) {
      const [lo, hi] = wilson95(v.k, v.n);
      assert.ok(Math.abs(lo - v.lo) < 0.0005, `lo(${v.k}/${v.n}) = ${lo}`);
      assert.ok(Math.abs(hi - v.hi) < 0.0005, `hi(${v.k}/${v.n}) = ${hi}`);
    }
  });

  it("20/26 lands inside a sane interval", () => {
    const [lo, hi] = wilson95(20, 26);
    assert.ok(lo > 0.55 && lo < 0.78, `lo=${lo}`);
    assert.ok(hi > 0.78 && hi < 0.95, `hi=${hi}`);
  });
});

// ── Tree hash + lock verification ───────────────────────────────────────────

describe("fixture manifest + lock", () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "golden-lib-test-"));
    fs.mkdirSync(path.join(tmp, "projects", "p1", "journal"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "projects", "p1", "journal", "2026-06-01--manual--05L--a.md"), "# a\nhello\n");
    fs.writeFileSync(path.join(tmp, "insights-index.json"), '{"insights":[]}\n');
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("is deterministic across two computations", () => {
    const a = computeFixtureManifest(tmp);
    const b = computeFixtureManifest(tmp);
    assert.equal(a.corpus_hash, b.corpus_hash);
    assert.equal(a.n_files, 2);
  });

  it("CRLF and LF content hash identically (Windows checkout parity)", () => {
    const a = computeFixtureManifest(tmp);
    fs.writeFileSync(path.join(tmp, "insights-index.json"), '{"insights":[]}\r\n');
    const b = computeFixtureManifest(tmp);
    assert.equal(a.corpus_hash, b.corpus_hash);
  });

  it("content tamper changes the hash and verifyGoldenLock refuses", () => {
    const computed = computeFixtureManifest(tmp);
    const queriesRaw = '{"queries":[]}';
    const lock = {
      schema_version: "golden-fixture/v1",
      corpus_hash: computed.corpus_hash,
      n_files: computed.n_files,
      queries_hash: hashQueriesRaw(queriesRaw),
    };
    assert.deepEqual(verifyGoldenLock(lock, computed, queriesRaw), { ok: true });

    fs.appendFileSync(path.join(tmp, "projects", "p1", "journal", "2026-06-01--manual--05L--a.md"), "tampered\n");
    const tampered = computeFixtureManifest(tmp);
    const v = verifyGoldenLock(lock, tampered, queriesRaw);
    assert.equal(v.ok, false);
    assert.match(v.reason, /corpus_hash mismatch/);
  });

  it("rename changes the hash (path is part of the per-file hash)", () => {
    const a = computeFixtureManifest(tmp);
    fs.renameSync(path.join(tmp, "insights-index.json"), path.join(tmp, "insights-index2.json"));
    const b = computeFixtureManifest(tmp);
    assert.notEqual(a.corpus_hash, b.corpus_hash);
  });

  it("queries tamper is refused via queries_hash", () => {
    const computed = computeFixtureManifest(tmp);
    const lock = {
      schema_version: "golden-fixture/v1",
      corpus_hash: computed.corpus_hash,
      n_files: computed.n_files,
      queries_hash: hashQueriesRaw("original"),
    };
    const v = verifyGoldenLock(lock, computed, "tampered");
    assert.equal(v.ok, false);
    assert.match(v.reason, /queries_hash mismatch/);
  });

  it("unknown lock schema is refused", () => {
    const computed = computeFixtureManifest(tmp);
    const v = verifyGoldenLock({ schema_version: "nope/v9" }, computed, "x");
    assert.equal(v.ok, false);
    assert.match(v.reason, /schema_version/);
  });
});

// ── Path matching ───────────────────────────────────────────────────────────

describe("matchByPath", () => {
  it("palace: verbatimKey room/file resolves, with and without .md", () => {
    const target = "projects/alpha-platform/palace/rooms/decisions/queue-backend.md";
    const withMd = { source: "palace", verbatimKey: { kind: "palace", room: "decisions", file: "queue-backend.md" } };
    const noMd = { source: "palace", verbatimKey: { kind: "palace", room: "decisions", file: "queue-backend" } };
    assert.equal(matchByPath(withMd, target, "alpha-platform"), true);
    assert.equal(matchByPath(noMd, target, "alpha-platform"), true);
    assert.equal(matchByPath(withMd, target, "beta-api"), false);
    assert.equal(
      matchByPath(withMd, "projects/alpha-platform/palace/rooms/decisions/other.md", "alpha-platform"),
      false,
    );
  });

  it("journal: date-prefix match within the queried project's journal", () => {
    const item = { source: "journal", verbatimKey: { kind: "journal", date: "2026-08-20" } };
    assert.equal(
      matchByPath(item, "projects/alpha-platform/journal/2026-08-20--manual--11L--rate-limit-ship.md", "alpha-platform"),
      true,
    );
    assert.equal(
      matchByPath(item, "projects/alpha-platform/journal/2026-08-21--manual--11L--x.md", "alpha-platform"),
      false,
    );
    assert.equal(
      matchByPath(item, "projects/beta-api/journal/2026-08-20--manual--11L--x.md", "alpha-platform"),
      false,
    );
  });

  it("corrections: id resolves to corrections/<id>.json", () => {
    const item = { source: "corrections", id: "2026-07-02-never-run-migrations-on-friday-deploys" };
    assert.equal(
      matchByPath(item, "projects/alpha-platform/corrections/2026-07-02-never-run-migrations-on-friday-deploys.json", "alpha-platform"),
      true,
    );
    assert.equal(
      matchByPath(item, "projects/alpha-platform/corrections/other.json", "alpha-platform"),
      false,
    );
  });

  it("insight rows never path-match (substring-only identity)", () => {
    const item = { source: "insight", id: "abc", title: "Some insight" };
    assert.equal(matchByPath(item, "insights-index.json", "alpha-platform"), false);
  });
});

// ── Substring matching ──────────────────────────────────────────────────────

describe("matchBySubstring", () => {
  it("case-insensitive over title+excerpt", () => {
    const item = { title: "decisions/queue-backend", excerpt: "...Redis Streams WON on operational simplicity..." };
    assert.equal(matchBySubstring(item, "redis streams won on operational simplicity"), true);
    assert.equal(matchBySubstring(item, "kafka won"), false);
  });

  it("CJK exact substring", () => {
    const item = { title: "2026-08-11 / 结论", excerpt: "根因是显存碎片，启用显存池后修复" };
    assert.equal(matchBySubstring(item, "显存碎片"), true);
    assert.equal(matchBySubstring(item, "显存泄漏"), false);
  });
});

// ── scoreQuery ──────────────────────────────────────────────────────────────

const Q = {
  id: "C1",
  category: "freshness",
  project: "alpha-platform",
  query: "what rate limit did we actually ship",
  ground_truth: {
    target_paths: ["projects/alpha-platform/journal/2026-08-20--manual--11L--rate-limit-ship.md"],
    required_substring: "250 rps",
    trap_substring: "100 rps",
  },
};

function journalRow(date, excerpt) {
  return { source: "journal", title: `${date} / Summary`, excerpt, verbatimKey: { kind: "journal", date } };
}

describe("scoreQuery", () => {
  it("hit@1 via path identity", () => {
    const r = scoreQuery([journalRow("2026-08-20", "shipped the limit")], Q);
    assert.equal(r.hit1, true);
    assert.equal(r.hit5, true);
    assert.equal(r.rank_of_first_target, 1);
  });

  it("hit@5 (not @1) via required substring at rank 3", () => {
    const rows = [
      journalRow("2026-06-10", "proposal: 100 rps per key"),
      { source: "insight", title: "unrelated", excerpt: "[minor] x" },
      { source: "palace", title: "goals/evolution", excerpt: "we shipped 250 rps for the public api", verbatimKey: { kind: "palace", room: "goals", file: "evolution.md" } },
    ];
    const r = scoreQuery(rows, Q);
    assert.equal(r.hit1, false);
    assert.equal(r.hit5, true);
    assert.equal(r.rank_of_first_target, 3);
    // trap at top-1 but required IS present in top-5 → not stale-confident
    assert.equal(r.stale_confident, false);
  });

  it("stale-confident: trap at top-1, required absent from all of top-5", () => {
    const rows = [
      journalRow("2026-06-10", "proposal: 100 rps per key"),
      { source: "insight", title: "unrelated", excerpt: "[minor] x" },
    ];
    const r = scoreQuery(rows, Q);
    assert.equal(r.hit5, false);
    assert.equal(r.stale_confident, true);
  });

  it("limit respected: target at rank 6 is a miss at k=5", () => {
    const rows = [
      journalRow("2026-01-01", "a"), journalRow("2026-01-02", "b"), journalRow("2026-01-03", "c"),
      journalRow("2026-01-04", "d"), journalRow("2026-01-05", "e"),
      journalRow("2026-08-20", "shipped 250 rps"),
    ];
    const r = scoreQuery(rows, Q, 5);
    assert.equal(r.hit5, false);
    assert.equal(r.rank_of_first_target, null);
  });

  it("empty/error result list scores as a clean miss, never throws", () => {
    const r = scoreQuery([], Q);
    assert.equal(r.hit1, false);
    assert.equal(r.hit5, false);
    assert.equal(r.stale_confident, false);
  });
});

// ── aggregate ───────────────────────────────────────────────────────────────

describe("aggregate", () => {
  it("per-category + overall + CJK split + stale rate", () => {
    const perQuery = [
      { id: "A1", category: "known-decision", hit1: true, hit5: true, stale_confident: false },
      { id: "A2", category: "known-decision", hit1: false, hit5: true, stale_confident: false },
      { id: "B1", category: "cross-project", hit1: false, hit5: false, stale_confident: false },
      { id: "C1", category: "freshness", hit1: false, hit5: false, stale_confident: true },
      { id: "D1", category: "cjk", hit1: true, hit5: true, stale_confident: false },
    ];
    const a = aggregate(perQuery);
    assert.equal(a.overall.hit5.num, 3);
    assert.equal(a.overall.hit5.den, 5);
    assert.equal(a.by_category["known-decision"].hit5.num, 2);
    assert.equal(a.stale_return_rate.num, 1);
    assert.equal(a.stale_return_rate.den, 1);
    assert.equal(a.cjk_vs_ascii.cjk_hit5.num, 1);
    assert.equal(a.cjk_vs_ascii.cjk_hit5.den, 1);
    assert.equal(a.cjk_vs_ascii.ascii_hit5.num, 2);
    assert.equal(a.cjk_vs_ascii.ascii_hit5.den, 4);
    assert.ok(Array.isArray(a.overall.hit5.wilson95));
  });
});

// ── determinism strip + leak gate ───────────────────────────────────────────

describe("stripVolatile", () => {
  it("two runs differing only in generated_utc compare equal", () => {
    const a = JSON.stringify({ generated_utc: "2026-10-11T01:00:00Z", x: 1, per_query: [{ id: "A1" }] });
    const b = JSON.stringify({ generated_utc: "2026-10-11T02:00:00Z", x: 1, per_query: [{ id: "A1" }] });
    assert.equal(stripVolatile(a), stripVolatile(b));
  });

  it("a real field difference still diffs", () => {
    const a = JSON.stringify({ generated_utc: "t1", x: 1 });
    const b = JSON.stringify({ generated_utc: "t2", x: 2 });
    assert.notEqual(stripVolatile(a), stripVolatile(b));
  });
});

describe("findHomeLeak", () => {
  it("flags POSIX and Windows home paths, passes clean content", () => {
    assert.equal(findHomeLeak("all synthetic"), null);
    assert.notEqual(findHomeLeak("/Users/someone/x"), null);
    assert.notEqual(findHomeLeak("C:\\Users\\someone"), null);
    assert.notEqual(findHomeLeak("/home/ci/x"), null);
  });
});
