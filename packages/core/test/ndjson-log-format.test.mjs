/**
 * ndjson-log-format.test.mjs — A14 review FIX 1+2 pins for the append-only
 * NDJSON stores (alignment-log.json / feedback-log.json).
 *
 * The A14 structural fix (append-only NDJSON, see
 * helpers/alignment-patterns.ts header) landed with its invariants verified
 * by hand; this file transcribes them into regression pins:
 *   - shared dual-format parsers: legacy JSON array, NDJSON, CRLF endings,
 *     torn/partial last line (mid-append read), garbage lines — never throw,
 *     never drop parsable records;
 *   - read caps (newest 50 / 1000) and the feedback read-time dedupe
 *     (id-carrying entries by query+id+date, keep-first; id-less never
 *     deduped);
 *   - legacy array → NDJSON migration: content preserved + converted,
 *     idempotent, and correct when two PROCESSES race it under the lock;
 *   - compaction: size-gated, result is exactly the newest cap-many records
 *     in order — and it runs ONLY under the lock (A14 review FIX 2: the
 *     contention fallback is a pure append; two fallback writers during lock
 *     wreckage must never run a whole-file rewrite).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  parseAlignmentLogText,
  readAlignmentLog,
  appendAlignmentRecord,
  alignmentLogPath,
  ALIGNMENT_READ_CAP,
  ALIGNMENT_COMPACT_BYTES,
} from "../dist/helpers/alignment-patterns.js";
import {
  parseFeedbackLogText,
  appendFeedbackEntries,
  FEEDBACK_COMPACT_BYTES,
  FEEDBACK_READ_CAP,
} from "../dist/tools-logic/smart-recall.js";

const ALIGNMENT_DIST_URL = pathToFileURL(
  path.join(process.cwd(), "dist", "helpers", "alignment-patterns.js"),
).href;
const FILELOCK_DIST_URL = pathToFileURL(
  path.join(process.cwd(), "dist", "storage", "filelock.js"),
).href;

let testRoot;

beforeEach(() => {
  testRoot = path.join(
    tmpdir(),
    `ar-ndjson-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  fs.mkdirSync(testRoot, { recursive: true });
  process.env.AGENT_RECALL_ROOT = testRoot;
});

afterEach(() => {
  delete process.env.AGENT_RECALL_ROOT;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

const rec = (i, extra = "") => ({
  date: "2026-10-12",
  goal: `goal-${i}${extra}`,
  confidence: "medium",
  assumptions: [],
});

describe("parseAlignmentLogText — dual-format parser", () => {
  it("parses the legacy pretty-printed JSON array, order preserved", () => {
    const text = JSON.stringify([rec(1), rec(2), rec(3)], null, 2);
    const out = parseAlignmentLogText(text);
    assert.deepEqual(out.map((r) => r.goal), ["goal-1", "goal-2", "goal-3"]);
  });

  it("a corrupt legacy array returns [] instead of throwing", () => {
    assert.deepEqual(parseAlignmentLogText('[ {"date": "2026'), []);
  });

  it("parses NDJSON lines (LF), order preserved", () => {
    const text = [rec(1), rec(2)].map((r) => JSON.stringify(r)).join("\n") + "\n";
    const out = parseAlignmentLogText(text);
    assert.deepEqual(out.map((r) => r.goal), ["goal-1", "goal-2"]);
  });

  it("parses NDJSON with CRLF line endings", () => {
    const text = [rec(1), rec(2)].map((r) => JSON.stringify(r)).join("\r\n") + "\r\n";
    const out = parseAlignmentLogText(text);
    assert.deepEqual(out.map((r) => r.goal), ["goal-1", "goal-2"]);
  });

  it("a torn/partial last line (mid-append read) is skipped without throwing", () => {
    const text =
      JSON.stringify(rec(1)) + "\n" + JSON.stringify(rec(2)) + "\n" +
      '{"date":"2026-10-12","goal":"half-writ'; // no closing quote/brace/newline
    const out = parseAlignmentLogText(text);
    assert.deepEqual(out.map((r) => r.goal), ["goal-1", "goal-2"]);
  });

  it("a garbage line mid-file is skipped; surrounding records survive", () => {
    const text =
      JSON.stringify(rec(1)) + "\n" + "<<<not json at all>>>" + "\n" + JSON.stringify(rec(2)) + "\n";
    const out = parseAlignmentLogText(text);
    assert.deepEqual(out.map((r) => r.goal), ["goal-1", "goal-2"]);
  });

  it(`read cap: returns exactly the newest ${ALIGNMENT_READ_CAP}, in order`, () => {
    const lines = [];
    for (let i = 1; i <= ALIGNMENT_READ_CAP + 10; i++) lines.push(JSON.stringify(rec(i)));
    const out = parseAlignmentLogText(lines.join("\n") + "\n");
    assert.equal(out.length, ALIGNMENT_READ_CAP);
    assert.equal(out[0].goal, "goal-11");
    assert.equal(out[out.length - 1].goal, `goal-${ALIGNMENT_READ_CAP + 10}`);
  });
});

const fb = (i, { id, date = "2026-10-12", useful = true, query = "q" } = {}) => ({
  query,
  ...(id !== undefined ? { id } : {}),
  title: `t-${i}`,
  useful,
  date,
});

describe("parseFeedbackLogText — dual-format parser + read-time dedupe", () => {
  it("parses the legacy array; torn NDJSON tail skipped without throwing", () => {
    const legacy = parseFeedbackLogText(JSON.stringify([fb(1, { id: "a" }), fb(2)], null, 2));
    assert.equal(legacy.length, 2);
    const torn = parseFeedbackLogText(
      JSON.stringify(fb(1, { id: "a" })) + "\n" + '{"query":"q","id":"b","ti',
    );
    assert.deepEqual(torn.map((e) => e.id), ["a"]);
  });

  it("dedupes id-carrying entries by query+id+date, keep-first (mirrors the write-time rule)", () => {
    const text =
      JSON.stringify(fb(1, { id: "x", useful: true })) + "\n" +
      JSON.stringify(fb(2, { id: "x", useful: false })) + "\n" + // same query+id+date: dropped
      JSON.stringify(fb(3, { id: "x", date: "2026-10-11" })) + "\n"; // other date: kept
    const out = parseFeedbackLogText(text);
    assert.equal(out.length, 2);
    assert.equal(out[0].useful, true, "keep-FIRST: the earlier entry wins, as the old locked merge did");
  });

  it("id-less entries are never deduped (no reliable key — accumulation is intended)", () => {
    const text = JSON.stringify(fb(1)) + "\n" + JSON.stringify(fb(1)) + "\n";
    assert.equal(parseFeedbackLogText(text).length, 2);
  });

  it(`read cap: newest ${FEEDBACK_READ_CAP}`, () => {
    const lines = [];
    for (let i = 1; i <= FEEDBACK_READ_CAP + 5; i++) lines.push(JSON.stringify(fb(i)));
    const out = parseFeedbackLogText(lines.join("\n") + "\n");
    assert.equal(out.length, FEEDBACK_READ_CAP);
    assert.equal(out[0].title, "t-6");
  });
});

describe("appendAlignmentRecord — append, migration, compaction gating", () => {
  const PROJECT = "ndjson-append-proj";

  it("fresh store: appends NDJSON lines; readAlignmentLog returns them in order", () => {
    appendAlignmentRecord(PROJECT, rec(1), { locked: true });
    appendAlignmentRecord(PROJECT, rec(2), { locked: true });
    const p = alignmentLogPath(PROJECT);
    const raw = fs.readFileSync(p, "utf-8");
    assert.ok(!raw.trimStart().startsWith("["), "fresh store must be NDJSON, not a JSON array");
    assert.equal(raw.trim().split("\n").length, 2);
    assert.deepEqual(readAlignmentLog(PROJECT).map((r) => r.goal), ["goal-1", "goal-2"]);
  });

  it("legacy array on disk: first write migrates (content preserved + converted), then appends idempotently", () => {
    const p = alignmentLogPath(PROJECT);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify([rec(1), rec(2), rec(3)], null, 2), "utf-8");

    appendAlignmentRecord(PROJECT, rec(4), { locked: true });
    let raw = fs.readFileSync(p, "utf-8");
    assert.ok(!raw.trimStart().startsWith("["), "migration must convert the file to NDJSON");
    assert.deepEqual(
      readAlignmentLog(PROJECT).map((r) => r.goal),
      ["goal-1", "goal-2", "goal-3", "goal-4"],
      "every legacy record must survive the migration, in order",
    );

    // Idempotent: the next write is a plain append, never a second migration.
    appendAlignmentRecord(PROJECT, rec(5), { locked: true });
    raw = fs.readFileSync(p, "utf-8");
    assert.equal(raw.trim().split("\n").length, 5);
    assert.deepEqual(
      readAlignmentLog(PROJECT).map((r) => r.goal),
      ["goal-1", "goal-2", "goal-3", "goal-4", "goal-5"],
    );
  });

  it("two PROCESSES racing the legacy migration under the lock lose nothing", async () => {
    const p = alignmentLogPath(PROJECT);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify([rec(1), rec(2)], null, 2), "utf-8");

    const CHILD = `
(async () => {
  const [ , project, goal, apUrl, flUrl ] = process.argv;
  const { appendAlignmentRecord } = await import(apUrl);
  const { withLock } = await import(flUrl);
  await withLock("alignment-" + project, () => {
    appendAlignmentRecord(project, { date: "2026-10-12", goal, confidence: "low", assumptions: [] }, { locked: true });
  }, { waitForLiveHolder: true });
})().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
`;
    const run = (goal) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["-e", CHILD, "--", PROJECT, goal, ALIGNMENT_DIST_URL, FILELOCK_DIST_URL],
          { env: { ...process.env, AGENT_RECALL_ROOT: testRoot }, stdio: ["ignore", "ignore", "pipe"] },
        );
        let err = "";
        child.stderr.on("data", (d) => { err += d; });
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${err}`))));
      });

    await Promise.all([run("goal-A"), run("goal-B")]);

    const goals = readAlignmentLog(PROJECT).map((r) => r.goal);
    assert.equal(goals.length, 4, `expected 2 legacy + 2 new records, got: ${goals.join(", ")}`);
    for (const g of ["goal-1", "goal-2", "goal-A", "goal-B"]) {
      assert.ok(goals.includes(g), `record ${g} must survive the racing migration`);
    }
    assert.ok(!fs.readFileSync(p, "utf-8").trimStart().startsWith("["), "file must end up NDJSON");
  });

  /** Seed an NDJSON file just over the compaction gate. Returns line count. */
  function seedOversized(project) {
    const p = alignmentLogPath(project);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const pad = "x".repeat(20_000);
    const lines = [];
    let i = 0;
    while (lines.reduce((n, l) => n + l.length + 1, 0) <= ALIGNMENT_COMPACT_BYTES) {
      i += 1;
      lines.push(JSON.stringify(rec(i, " " + pad)));
    }
    fs.writeFileSync(p, lines.join("\n") + "\n", "utf-8");
    return i;
  }

  it(`compaction under the lock: size gate trips -> exactly the newest ${ALIGNMENT_READ_CAP}, in order`, () => {
    const seeded = seedOversized(PROJECT);
    appendAlignmentRecord(PROJECT, rec(seeded + 1), { locked: true });

    const p = alignmentLogPath(PROJECT);
    const lines = fs.readFileSync(p, "utf-8").trim().split("\n");
    assert.equal(lines.length, ALIGNMENT_READ_CAP, "compaction must keep exactly the read cap");
    const goals = lines.map((l) => JSON.parse(l).goal.split(" ")[0]);
    const expected = [];
    for (let i = seeded + 1 - (ALIGNMENT_READ_CAP - 1); i <= seeded + 1; i++) expected.push(`goal-${i}`);
    assert.deepEqual(goals, expected, "compaction result must be the newest records in original order");
  });

  it("A14 review FIX 2: the lock-free fallback NEVER compacts, even past the size gate", () => {
    const seeded = seedOversized(PROJECT);
    appendAlignmentRecord(PROJECT, rec(seeded + 1)); // no {locked:true} — the contention-fallback shape

    const p = alignmentLogPath(PROJECT);
    const lines = fs.readFileSync(p, "utf-8").trim().split("\n");
    assert.equal(
      lines.length,
      seeded + 1,
      "fallback must be a PURE append — a whole-file compaction rewrite without the lock can race a second fallback writer",
    );
    assert.ok(fs.statSync(p).size > ALIGNMENT_COMPACT_BYTES, "size still past the gate — untouched by design");
  });
});

describe("appendFeedbackEntries — compaction gating (same FIX 2 contract)", () => {
  const fbPath = () => path.join(testRoot, "feedback-log.json");

  function seedOversizedFeedback() {
    const pad = "y".repeat(2_000);
    const lines = [];
    let i = 0;
    while (lines.reduce((n, l) => n + l.length + 1, 0) <= FEEDBACK_COMPACT_BYTES) {
      i += 1;
      lines.push(JSON.stringify(fb(i, { id: `id-${i}`, query: pad })));
    }
    fs.writeFileSync(fbPath(), lines.join("\n") + "\n", "utf-8");
    return i;
  }

  it(`locked: compacts past the gate to the newest ${FEEDBACK_READ_CAP}`, () => {
    const seeded = seedOversizedFeedback();
    appendFeedbackEntries([fb(seeded + 1, { id: `id-${seeded + 1}` })], { locked: true });
    const lines = fs.readFileSync(fbPath(), "utf-8").trim().split("\n");
    assert.equal(lines.length, Math.min(seeded + 1, FEEDBACK_READ_CAP));
    assert.equal(JSON.parse(lines[lines.length - 1]).id, `id-${seeded + 1}`, "newest entry survives compaction");
  });

  it("A14 review FIX 2: lock-free fallback never compacts", () => {
    const seeded = seedOversizedFeedback();
    appendFeedbackEntries([fb(seeded + 1, { id: `id-${seeded + 1}` })]);
    const lines = fs.readFileSync(fbPath(), "utf-8").trim().split("\n");
    assert.equal(lines.length, seeded + 1, "fallback must be a pure append");
    assert.ok(fs.statSync(fbPath()).size > FEEDBACK_COMPACT_BYTES);
  });
});
