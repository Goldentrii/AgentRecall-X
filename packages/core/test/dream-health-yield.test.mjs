/**
 * fix10 (2026-09-12) — dream-health measures YIELD, not just uptime.
 *
 * Pre-fix, 22 consecutive zero-output nights were all green because health
 * only checked "did the log say Dream complete". These tests pin that a
 * zero-output night is now classifiable ("corpus genuinely thin" vs "math
 * filtered everything" vs "no instrumentation") and that silent streaks
 * banner — making a repeat of the 22 silent nights structurally impossible.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_ROOT = path.join(os.tmpdir(), "ar-dream-health-" + Date.now());
const AAM_DIR = path.join(TEST_ROOT, "aam-dreams");

let core;

function dayStr(nDaysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - nDaysAgo);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function writeRunLog(nDaysAgo, ok = true) {
  fs.writeFileSync(
    path.join(AAM_DIR, `run-${dayStr(nDaysAgo)}.log`),
    ok ? "…\nDream complete\n" : "auth error\n",
    "utf-8",
  );
}

function writeYield(nDaysAgo, fields) {
  const date = dayStr(nDaysAgo);
  const rec = {
    version: 1,
    date,
    generated_at: new Date().toISOString(),
    candidates_seen: 0,
    admitted: 0,
    promoted: 0,
    already_known: 0,
    rejected: 0,
    discarded_by_reason: {},
    decisions: [],
    promoted_titles: [],
    ...fields,
  };
  core.writeDreamYield(rec);
}

function resetDirs() {
  fs.rmSync(path.join(TEST_ROOT, "dreams"), { recursive: true, force: true });
  fs.rmSync(AAM_DIR, { recursive: true, force: true });
  fs.mkdirSync(AAM_DIR, { recursive: true });
}

describe("classifyNight — the zero-output taxonomy", () => {
  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    core = await import("../dist/index.js");
  });

  after(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("distinguishes thin corpus from math-filtered from already-known from missing data", () => {
    const base = {
      version: 1, date: "2026-09-11", generated_at: "", already_known: 0,
      discarded_by_reason: {}, decisions: [], promoted_titles: [],
    };
    assert.equal(core.classifyNight(null), "no-yield-data");
    assert.equal(
      core.classifyNight({ ...base, candidates_seen: 0, admitted: 0, promoted: 0, rejected: 0 }),
      "empty-corpus",
    );
    assert.equal(
      core.classifyNight({ ...base, candidates_seen: 5, admitted: 0, promoted: 0, rejected: 5 }),
      "filtered",
    );
    assert.equal(
      core.classifyNight({ ...base, candidates_seen: 3, admitted: 0, promoted: 0, rejected: 0, already_known: 3 }),
      "already-known",
    );
    assert.equal(
      core.classifyNight({ ...base, candidates_seen: 3, admitted: 1, promoted: 1, rejected: 1 }),
      "productive",
    );
  });

  it("MEDIUM-2: errors[] influences the class — an errored zero-yield night is never benign", () => {
    const base = {
      version: 1, date: "2026-09-11", generated_at: "", already_known: 0,
      discarded_by_reason: {}, decisions: [], promoted_titles: [],
    };
    // errored outranks empty-corpus AND already-known…
    assert.equal(
      core.classifyNight({ ...base, candidates_seen: 0, admitted: 0, promoted: 0, rejected: 0, errors: ["ledger was corrupt"] }),
      "errored",
    );
    assert.equal(
      core.classifyNight({ ...base, candidates_seen: 2, admitted: 0, promoted: 0, rejected: 0, already_known: 2, errors: ["promotion pass failed: lock contention"] }),
      "errored",
    );
    // …but real yield stays productive (errors ride along in the record).
    assert.equal(
      core.classifyNight({ ...base, candidates_seen: 2, admitted: 1, promoted: 0, rejected: 0, errors: ["ledger write failed"] }),
      "productive",
    );
  });
});

describe("getDreamHealth — yield streaks and banners", () => {
  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    core = await import("../dist/index.js");
  });

  after(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  beforeEach(resetDirs);

  it("REGRESSION: uptime failure streak still banners (pre-fix behavior preserved)", () => {
    writeRunLog(1, false);
    writeRunLog(2, false);
    writeRunLog(3, true);
    const h = core.getDreamHealth({ aamDreamsDir: AAM_DIR });
    assert.equal(h.consecutive_failures, 2);
    assert.match(h.banner, /failed 2 nights/);
    assert.equal(h.banner_kind, "failure", "store-doctor REDs only on this kind");
  });

  it("a productive night reports healthy with yield fields populated", () => {
    writeRunLog(1, true);
    writeYield(1, { candidates_seen: 4, admitted: 2, promoted: 1, rejected: 1 });
    const h = core.getDreamHealth({ aamDreamsDir: AAM_DIR });
    assert.equal(h.banner, null);
    assert.equal(h.consecutive_zero_yield, 0);
    assert.equal(h.last_night_class, "productive");
    assert.deepEqual(h.yield_last_night, {
      date: dayStr(1), candidates_seen: 4, admitted: 2, promoted: 1, already_known: 0, rejected: 1,
    });
  });

  it("3 'filtered' nights banner as MATH failure — the 22-silent-nights regression pin", () => {
    for (const n of [1, 2, 3]) {
      writeRunLog(n, true); // green per the old uptime-only check
      writeYield(n, { candidates_seen: 3, rejected: 3 });
    }
    writeRunLog(4, true);
    writeYield(4, { candidates_seen: 2, admitted: 1 }); // productive — breaks the streak
    const h = core.getDreamHealth({ aamDreamsDir: AAM_DIR });
    assert.equal(h.consecutive_failures, 0, "uptime says green…");
    assert.equal(h.consecutive_zero_yield, 3, "…but yield says three silent nights");
    assert.equal(h.zero_yield_causes["filtered"], 3);
    assert.ok(h.banner, "silent filtering MUST banner");
    assert.match(h.banner, /admission math rejected every candidate/);
    assert.match(h.banner, /9 candidates seen/);
    assert.equal(h.banner_kind, "zero-yield");
  });

  it("MEDIUM-2: 3 errored nights banner red — errors are never a quiet corpus", () => {
    for (const n of [1, 2, 3]) {
      writeRunLog(n, true);
      writeYield(n, { candidates_seen: 0, errors: ["promotion pass failed: awareness-state lock contention"] });
    }
    const h = core.getDreamHealth({ aamDreamsDir: AAM_DIR });
    assert.equal(h.consecutive_zero_yield, 3);
    assert.equal(h.zero_yield_causes["errored"], 3);
    assert.ok(h.banner, "errored streak MUST banner at 3 nights");
    assert.match(h.banner, /ran with errors/);
    assert.equal(h.banner_kind, "zero-yield");
  });

  it("3 ran-but-no-yield-record nights banner as instrumentation gap (SOP not repointed)", () => {
    for (const n of [1, 2, 3]) writeRunLog(n, true); // old prompt: completes, writes nothing
    writeRunLog(4, true);
    writeYield(4, { candidates_seen: 1, admitted: 1 });
    const h = core.getDreamHealth({ aamDreamsDir: AAM_DIR });
    assert.equal(h.consecutive_zero_yield, 3);
    assert.equal(h.zero_yield_causes["no-yield-data"], 3);
    assert.ok(h.banner);
    assert.match(h.banner, /without writing a yield record/);
  });

  it("a genuinely thin corpus does NOT banner at 3 nights…", () => {
    for (const n of [1, 2, 3]) {
      writeRunLog(n, true);
      writeYield(n, { candidates_seen: 0 });
    }
    const h = core.getDreamHealth({ aamDreamsDir: AAM_DIR });
    assert.equal(h.banner, null, "a quiet 3 days is legitimate");
    assert.equal(h.consecutive_zero_yield, 3);
    assert.equal(h.last_night_class, "empty-corpus", "…but the cause is still visible");
  });

  it("…and DOES banner at 7 nights, saying the corpus is thin (not the math)", () => {
    for (let n = 1; n <= 7; n++) {
      writeRunLog(n, true);
      writeYield(n, { candidates_seen: 0 });
    }
    const h = core.getDreamHealth({ aamDreamsDir: AAM_DIR });
    assert.equal(h.consecutive_zero_yield, 7);
    assert.ok(h.banner);
    assert.match(h.banner, /corpus genuinely thin/);
    assert.doesNotMatch(h.banner, /admission math/, "thin corpus must not be blamed on the math");
    assert.equal(h.banner_kind, "thin-corpus", "informational, never doctor-RED");
  });

  it("cron-dead nights belong to the uptime streak and do not fake a yield streak", () => {
    // no logs, no yield at all
    const h = core.getDreamHealth({ aamDreamsDir: AAM_DIR });
    assert.equal(h.consecutive_zero_yield, 0);
    assert.equal(h.last_night_class, null);
    assert.ok(h.consecutive_failures >= 2, "missing logs count as cron failures (pre-fix behavior)");
  });
});
