import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import {
  writeCorrection,
  readRejectedCorrections,
  getRejectedStats,
  logRejectedCorrection,
  GATE_VERSION,
} from "../dist/storage/corrections.js";

let testRoot;

function rejectedPath(project) {
  return path.join(testRoot, "projects", project, "corrections", "_rejected.jsonl");
}

describe("capture-gate rejected log (survivorship-bias probe)", () => {
  beforeEach(async () => {
    testRoot = path.join(tmpdir(), `ar-rejected-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(testRoot, { recursive: true });
    process.env.AGENT_RECALL_ROOT = testRoot;
  });

  afterEach(async () => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("a rejected soft-correction lands EXACTLY ONE line with the right reason + full text", async () => {
    // "that's not what I meant" matches the acknowledgment/no-fragment gate.
    const softText = "no, that's not what I meant";
    const res = await writeCorrection("test-proj", {
      id: "2026-06-21-soft",
      date: "2026-06-21",
      severity: "p1",
      project: "test-proj",
      rule: softText,
      context: softText,
      tags: [],
    });

    assert.equal(res.written, false, "soft correction must be rejected by the gate");
    assert.ok(res.reason, "rejection must carry a reason");

    const rows = readRejectedCorrections("test-proj");
    assert.equal(rows.length, 1, "exactly one rejected row");
    assert.equal(rows[0].rule, softText, "FULL rejected text is preserved");
    assert.equal(rows[0].reason, res.reason, "logged reason matches gate.reason");
    assert.equal(rows[0].project, "test-proj");
    assert.equal(rows[0].gate_version, GATE_VERSION);
    assert.ok(rows[0].ts, "row carries an ISO timestamp");

    // And the raw file is one JSONL line.
    const raw = fs.readFileSync(rejectedPath("test-proj"), "utf-8");
    assert.equal(raw.split("\n").filter((l) => l.trim()).length, 1);
  });

  it("a short fragment is rejected and logged with the 'too short' reason", async () => {
    const res = await writeCorrection("test-proj", {
      id: "2026-06-21-short",
      date: "2026-06-21",
      severity: "p1",
      project: "test-proj",
      rule: "nope",
      context: "nope",
      tags: [],
    });
    assert.equal(res.written, false);
    const rows = readRejectedCorrections("test-proj");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, "too short");
  });

  it("an ACCEPTED correction lands NONE in the rejected log", async () => {
    const res = await writeCorrection("test-proj", {
      id: "2026-06-21-accepted",
      date: "2026-06-21",
      severity: "p0",
      project: "test-proj",
      rule: "Never push to main without explicit approval",
      context: "push gate",
      tags: [],
    });

    assert.equal(res.written, true, "real correction must pass the gate");
    assert.equal(fs.existsSync(rejectedPath("test-proj")), false, "no rejected log created");
    assert.equal(readRejectedCorrections("test-proj").length, 0);
  });

  it("the logger never throws even if the rejected file is unwritable — writeCorrection still returns its result", async () => {
    const dir = path.join(testRoot, "projects", "test-proj", "corrections");
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, "_rejected.jsonl");
    // Make the path itself a DIRECTORY so appendFileSync throws EISDIR.
    fs.mkdirSync(p);

    let res;
    // Retarget (fix6-locks): writeCorrection is async now — doesNotThrow on an
    // async fn neither awaits it nor observes rejections; doesNotReject does.
    await assert.doesNotReject(async () => {
      res = await writeCorrection("test-proj", {
        id: "2026-06-21-unwritable",
        date: "2026-06-21",
        severity: "p1",
        project: "test-proj",
        rule: "ok sure", // rejected (acknowledgment) → triggers logger path
        context: "ok sure",
        tags: [],
      });
    }, "writeCorrection must not propagate a logger failure");

    assert.equal(res.written, false, "gate result is still returned");
    assert.ok(res.reason, "reason still returned even when log write fails");
  });

  it("logRejectedCorrection in isolation never throws on an unwritable path", async () => {
    const dir = path.join(testRoot, "projects", "iso-proj", "corrections");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "_rejected.jsonl")); // dir blocks append
    assert.doesNotThrow(() => {
      logRejectedCorrection("iso-proj", "some rejected text", "too short");
    });
  });

  it("getRejectedStats aggregates discard count, rate, and top reasons", async () => {
    // 3 short, 1 acknowledgment → 4 rejections; 1 accepted.
    await writeCorrection("stats-proj", mk("nope"));        // too short
    await writeCorrection("stats-proj", mk("no"));          // too short
    await writeCorrection("stats-proj", mk("ok"));          // too short (len<12)
    await writeCorrection("stats-proj", mk("no, that's not what I meant")); // acknowledgment
    await writeCorrection("stats-proj", mk("Never delete local files after a push to remote")); // accepted

    const accepted = 1;
    const stats = getRejectedStats("stats-proj", accepted);
    assert.equal(stats.discarded, 4);
    assert.equal(stats.accepted, 1);
    // rate = 4 / (4 + 1) = 0.8
    assert.equal(stats.rate, 0.8);
    assert.ok(stats.top_reasons.length >= 1);
    // "too short" should be the most frequent reason (3 occurrences).
    assert.equal(stats.top_reasons[0].reason, "too short");
    assert.equal(stats.top_reasons[0].count, 3);
  });

  it("rotation cap holds — the log never grows past REJECTED_LOG_CAP rows", async () => {
    // Directly hammer the logger past the cap (2000). Use a smaller proxy by
    // writing well over the cap and asserting it is bounded.
    const N = 2100;
    for (let i = 0; i < N; i++) {
      logRejectedCorrection("rot-proj", `rejected candidate number ${i}`, "too short");
    }
    const rows = readRejectedCorrections("rot-proj");
    assert.ok(rows.length <= 2000, `expected <= 2000 rows, got ${rows.length}`);
    assert.ok(rows.length >= 1990, `expected near-cap retention, got ${rows.length}`);
    // Most-recent rows are kept (rotation keeps the tail).
    const last = rows[rows.length - 1];
    assert.equal(last.rule, `rejected candidate number ${N - 1}`);
  });
});

function mk(rule) {
  return {
    id: `id-${Math.random().toString(16).slice(2)}`,
    date: "2026-06-21",
    severity: "p1",
    project: "stats-proj",
    rule,
    context: rule,
    tags: [],
  };
}
