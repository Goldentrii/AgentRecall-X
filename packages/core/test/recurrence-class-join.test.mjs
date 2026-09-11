/**
 * recurrence-class-join.test.mjs
 *
 * RD-1 (2026-07-14): recurrence-detector workpacket — failure_class schema +
 * capture-time keyword classifier + cross-project class join at session-end.
 * (docs/proposals/2026-07-13-recurrence-detector-workpacket.md §1–§2, owner
 * decisions 2026-07-14: 9-value enum incl. naming_violation; auto-derive at
 * capture; old records read as "other", never rewritten; recurred routes to
 * the originating correction's own project slug.)
 *
 * Tests:
 *  1. Classifier — one strict-winner test per real enum value (8 classes)
 *  2. Classifier — zero hits → other; tied max → other; empty text → other
 *  3. Capture wiring — check() with a human_correction stamps failure_class
 *  4. Join — cross-project fixture: shared failure_class + ≥1 signature-token
 *     overlap → "recurred" recorded under the ORIGINATING project's slug
 *  5. Join negative — same class, zero signature overlap → no fire
 *  6. Join negative — no genuine recurrence marker → join never runs
 *  7. Old record without failure_class — treated as "other" (never joins),
 *     never crashes, and the file is NEVER rewritten with the field
 *  8. Error path — malformed candidate JSON is skipped, join continues
 *  9. Dedup — second session_end same day does not double-book "recurred"
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import {
  writeCorrection,
  readCorrections,
  recordOutcome,
} from "../dist/storage/corrections.js";
import { classifyFailureClass, ruleSignature } from "../dist/tools-logic/check-action.js";
import { sessionEnd } from "../dist/tools-logic/session-end.js";
import { check } from "../dist/tools-logic/check.js";

const ALPHA = "rd1-proj-alpha"; // current-session project (seed side)
const BETA = "rd1-proj-beta";   // other project (candidate side)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testRoot;

beforeEach(async () => {
  testRoot = path.join(tmpdir(), `ar-rd1-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(testRoot, { recursive: true });
  process.env.AGENT_RECALL_ROOT = testRoot;
});

afterEach(async () => {
  delete process.env.AGENT_RECALL_ROOT;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

let seq = 0;
function makeCorrection(overrides = {}) {
  seq += 1;
  return {
    id: `2026-07-14-rd1-fixture-${seq}-${Math.random().toString(16).slice(2, 8)}`,
    date: new Date().toISOString().slice(0, 10),
    severity: "p1",
    project: ALPHA,
    rule: "Always dispatch a sonnet worker for execution",
    context: "Always dispatch a sonnet worker for execution",
    tags: [],
    ...overrides,
  };
}

/** Write a correction into `project` and stamp last_retrieved = today on its file. */
async function writeRetrievedToday(project, correction) {
  const result = await writeCorrection(project, { ...correction, project });
  assert.ok(result.written, `fixture correction must pass the capture gate: ${result.reason ?? ""}`);
  const id = result.id ?? correction.id;
  await recordOutcome({
    correction_id: id,
    project,
    kind: "retrieved",
    at: new Date().toISOString(),
    evidence: "test setup: simulated retrieval",
  });
  const dir = path.join(testRoot, "projects", project, "corrections");
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("_"))) {
    const fp = path.join(dir, f);
    const rec = JSON.parse(fs.readFileSync(fp, "utf-8"));
    if (rec.id === id) {
      rec.last_retrieved = new Date().toISOString();
      fs.writeFileSync(fp, JSON.stringify(rec, null, 2), "utf-8");
      break;
    }
  }
  return id;
}

/** Write a correction into `project` without any retrieval stamp. */
async function writePlain(project, correction) {
  const result = await writeCorrection(project, { ...correction, project });
  assert.ok(result.written, `fixture correction must pass the capture gate: ${result.reason ?? ""}`);
  return result.id ?? correction.id;
}

function readOutcomeLines(project) {
  const p = path.join(testRoot, "projects", project, "corrections", "_outcomes.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function findRecordFile(project, id) {
  const dir = path.join(testRoot, "projects", project, "corrections");
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("_"))) {
    const fp = path.join(dir, f);
    try {
      const rec = JSON.parse(fs.readFileSync(fp, "utf-8"));
      if (rec.id === id) return { path: fp, record: rec };
    } catch {
      /* skip */
    }
  }
  return null;
}

// A summary that carries a genuine (non-eval-meta) recurrence marker.
const RECURRENCE_SUMMARY =
  "Dispatched fable for the execution worker again — violated the model dispatch rule.";

// Candidates that are expected to FIRE must predate today: the §1c join skips
// corrections captured today (review fix HIGH-2 — no recurred on birth day).
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// 1. Classifier — one strict-winner test per enum value
// ---------------------------------------------------------------------------

describe("RD-1 classifyFailureClass: one test per enum value", () => {
  it("publish_gate", async () => {
    assert.equal(
      classifyFailureClass("Never push or deploy to production without explicit approval"),
      "publish_gate",
    );
  });

  it("naming_violation", async () => {
    assert.equal(
      classifyFailureClass("Wrong repo — always use the canonical naming, never rename it"),
      "naming_violation",
    );
  });

  it("model_dispatch", async () => {
    assert.equal(
      classifyFailureClass("Always dispatch a sonnet worker, never fable as the subagent"),
      "model_dispatch",
    );
  });

  it("skipped_verify", async () => {
    assert.equal(
      classifyFailureClass("Always verify and review your work before claiming done"),
      "skipped_verify",
    );
  });

  it("confidential_leak", async () => {
    assert.equal(
      classifyFailureClass("Never reveal internal margin or customer cost basis to anyone"),
      "confidential_leak",
    );
  });

  it("framing_error", async () => {
    assert.equal(
      classifyFailureClass("Don't map AgentRecall to human memory neuroscience analogies"),
      "framing_error",
    );
  });

  it("scope_violation", async () => {
    assert.equal(
      classifyFailureClass("Focus only on this session's scope, never mix unrelated projects"),
      "scope_violation",
    );
  });

  it("wrong_ref", async () => {
    assert.equal(
      classifyFailureClass("The api endpoint param is stale — wrong query shape"),
      "wrong_ref",
    );
  });

  it("other — zero keyword hits", async () => {
    assert.equal(classifyFailureClass("Prefer the blue button on the landing hero"), "other");
  });

  it("other — tied max score (one publish_gate token vs one wrong_ref token)", async () => {
    // "push" → publish_gate (1), "stale" → wrong_ref (1), nothing else scores.
    assert.equal(classifyFailureClass("push the stale one"), "other");
  });

  it("other — empty / whitespace / non-string-safe input", async () => {
    assert.equal(classifyFailureClass(""), "other");
    assert.equal(classifyFailureClass("   "), "other");
  });
});

// ---------------------------------------------------------------------------
// 2. Capture wiring — check() auto-derives failure_class at capture
// ---------------------------------------------------------------------------

describe("RD-1 capture: check() stamps failure_class on the stored record", () => {
  it("human_correction with publish-gate language stores failure_class publish_gate", async () => {
    await check({
      goal: "Ship the release",
      confidence: "high",
      human_correction: "Never push or deploy without explicit approval from the owner.",
      project: ALPHA,
    });

    const records = readCorrections(ALPHA);
    assert.equal(records.length, 1, "correction should have been captured");
    assert.equal(records[0].failure_class, "publish_gate");
    // The field must be ON DISK (capture-time stamp), not a read-time default.
    const onDisk = findRecordFile(ALPHA, records[0].id);
    assert.ok(onDisk, "record file should exist");
    assert.equal(onDisk.record.failure_class, "publish_gate");
  });
});

// ---------------------------------------------------------------------------
// 3. Cross-project class join at session-end
// ---------------------------------------------------------------------------

describe("RD-1 join: cross-project failure_class recurrence", () => {
  it("shared class + ≥1 signature token overlap → recurred under the ORIGINATING slug", async () => {
    // Seed in ALPHA (current project) — retrieved today, classified.
    const seedId = await writeRetrievedToday(ALPHA, makeCorrection({
      rule: "Always dispatch a sonnet worker for execution",
      context: "Always dispatch a sonnet worker for execution",
      tags: ["model"],
      failure_class: "model_dispatch",
    }));

    // Candidate in BETA — same class, signature shares tokens (sonnet/worker/model/dispatch).
    // Dated yesterday: candidates captured today never fire (HIGH-2 fix).
    const candId = await writePlain(BETA, makeCorrection({
      project: BETA,
      date: YESTERDAY,
      rule: "Never route work through fable — sonnet stays the worker model",
      context: "Never route work through fable — sonnet stays the worker model",
      tags: ["dispatch"],
      failure_class: "model_dispatch",
    }));

    // Sanity: the fixture overlaps on RULE-TEXT tokens (what the join checks
    // post the 2026-07-14 tag-token fix) — sonnet/worker shared in rule text.
    const seedSig = ruleSignature({ rule: "Always dispatch a sonnet worker for execution" });
    const candSig = ruleSignature({ rule: "Never route work through fable — sonnet stays the worker model" });
    const shared = [...seedSig].filter((t) => candSig.has(t));
    assert.ok(shared.length >= 1, "fixture must share at least one RULE-TEXT token");

    await sessionEnd({ summary: RECURRENCE_SUMMARY, project: ALPHA });

    const betaOutcomes = readOutcomeLines(BETA);
    const recurred = betaOutcomes.filter((o) => o.kind === "recurred" && o.correction_id === candId);
    assert.equal(recurred.length, 1, "exactly one recurred event for the BETA candidate");
    // Owner decision 3: outcome routes to the ORIGINATING correction's own slug.
    assert.equal(recurred[0].project, BETA);
    assert.match(recurred[0].evidence ?? "", /cross-project class join/);
    assert.match(recurred[0].evidence ?? "", new RegExp(seedId));

    // Counter side-effect landed on the BETA record, not an ALPHA one.
    const onDisk = findRecordFile(BETA, candId);
    assert.ok(onDisk);
    assert.equal(onDisk.record.recurrence_count, 1);
    assert.equal(findRecordFile(ALPHA, seedId).record.id, seedId, "seed record intact");
  });

  it("same class but ZERO signature overlap → no fire", async () => {
    await writeRetrievedToday(ALPHA, makeCorrection({
      rule: "Always dispatch via sonnet.",
      context: "Always dispatch via sonnet.",
      tags: [],
      failure_class: "model_dispatch",
    }));
    const candId = await writePlain(BETA, makeCorrection({
      project: BETA,
      rule: "Never fable for subagent duty.",
      context: "Never fable for subagent duty.",
      tags: [],
      failure_class: "model_dispatch",
    }));

    await sessionEnd({
      summary: "I broke the rule again by skipping the checklist before running things.",
      project: ALPHA,
    });

    const recurred = readOutcomeLines(BETA).filter(
      (o) => o.kind === "recurred" && o.correction_id === candId,
    );
    assert.equal(recurred.length, 0, "zero-overlap candidate must not fire");
  });

  it("same class, overlap ONLY via shared tags, disjoint rule text → join must NOT fire", async () => {
    // Regression for the 2026-07-14 live-corpus eval finding: auto-tags like
    // "correction"/"deployment" recur across unrelated corrections, so a
    // tags-inclusive signature made overlap ≥ 1 trivially satisfiable. The
    // join now requires the overlap to come from rule text alone.
    await writeRetrievedToday(ALPHA, makeCorrection({
      rule: "Always dispatch via sonnet.",
      context: "Always dispatch via sonnet.",
      tags: ["correction", "deployment"],
      failure_class: "model_dispatch",
    }));
    const candId = await writePlain(BETA, makeCorrection({
      project: BETA,
      rule: "Never fable for subagent duty.",
      context: "Never fable for subagent duty.",
      tags: ["correction", "deployment"],
      failure_class: "model_dispatch",
    }));

    // Sanity: rule texts are disjoint; only the tags are shared.
    const seedSig = ruleSignature({ rule: "Always dispatch via sonnet." });
    const candSig = ruleSignature({ rule: "Never fable for subagent duty." });
    assert.equal(
      [...seedSig].filter((t) => candSig.has(t)).length,
      0,
      "fixture rule texts must share zero tokens",
    );

    await sessionEnd({ summary: RECURRENCE_SUMMARY, project: ALPHA });

    const recurred = readOutcomeLines(BETA).filter(
      (o) => o.kind === "recurred" && o.correction_id === candId,
    );
    assert.equal(recurred.length, 0, "tag-only overlap must not fire the join");
  });

  it("no genuine recurrence marker in the summary → join never runs", async () => {
    await writeRetrievedToday(ALPHA, makeCorrection({
      rule: "Always dispatch a sonnet worker for execution",
      tags: ["model"],
      failure_class: "model_dispatch",
    }));
    const candId = await writePlain(BETA, makeCorrection({
      project: BETA,
      rule: "Never route work through fable — sonnet stays the worker model",
      tags: ["dispatch"],
      failure_class: "model_dispatch",
    }));

    await sessionEnd({
      summary: "Implemented the feature and wrote tests. Everything worked smoothly.",
      project: ALPHA,
    });

    const recurred = readOutcomeLines(BETA).filter(
      (o) => o.kind === "recurred" && o.correction_id === candId,
    );
    assert.equal(recurred.length, 0, "join requires the genuine recurrence marker");
  });

  it("old record without failure_class → treated as other: never joins, never crashes, never rewritten", async () => {
    await writeRetrievedToday(ALPHA, makeCorrection({
      rule: "Always dispatch a sonnet worker for execution",
      tags: ["model"],
      failure_class: "model_dispatch",
    }));
    // Pre-RD-1-style candidate: NO failure_class, but heavy signature overlap.
    const oldId = await writePlain(BETA, makeCorrection({
      project: BETA,
      rule: "Never use fable for the sonnet worker dispatch",
      context: "Never use fable for the sonnet worker dispatch",
      tags: ["model"],
    }));

    await sessionEnd({ summary: RECURRENCE_SUMMARY, project: ALPHA });

    const recurred = readOutcomeLines(BETA).filter(
      (o) => o.kind === "recurred" && o.correction_id === oldId,
    );
    assert.equal(recurred.length, 0, "unclassified (implicit other) records never join");

    // Never rewritten with the field — not by the join, and not by a later
    // recordOutcome read-modify-write (applyCorrectionDefaults must NOT stamp it).
    await recordOutcome({
      correction_id: oldId,
      project: BETA,
      kind: "retrieved",
      at: new Date().toISOString(),
      evidence: "test: force a counter RMW rewrite of the old record",
    });
    const onDisk = findRecordFile(BETA, oldId);
    assert.ok(onDisk);
    assert.ok(
      !("failure_class" in onDisk.record),
      "old record file must never gain failure_class on read/RMW paths",
    );
  });

  it("malformed candidate JSON is skipped and the join continues", async () => {
    await writeRetrievedToday(ALPHA, makeCorrection({
      rule: "Always dispatch a sonnet worker for execution",
      tags: ["model"],
      failure_class: "model_dispatch",
    }));
    const candId = await writePlain(BETA, makeCorrection({
      project: BETA,
      date: YESTERDAY,
      rule: "Never route work through fable — sonnet stays the worker model",
      tags: ["dispatch"],
      failure_class: "model_dispatch",
    }));
    // Malformed sibling in the same corrections dir.
    fs.writeFileSync(
      path.join(testRoot, "projects", BETA, "corrections", "2026-07-14-garbage.json"),
      "{ not json at all",
      "utf-8",
    );

    await sessionEnd({ summary: RECURRENCE_SUMMARY, project: ALPHA });

    const recurred = readOutcomeLines(BETA).filter(
      (o) => o.kind === "recurred" && o.correction_id === candId,
    );
    assert.equal(recurred.length, 1, "valid candidate still fires despite the malformed sibling");
  });

  it("same-project candidate → 1c never fires (1b owns within-project)", async () => {
    // Review fix HIGH-2: a correction in the CURRENT project that 1b has
    // already judged (or lacks 1b-grade evidence) must not get a second,
    // weaker bite from the 1c class join.
    await writeRetrievedToday(ALPHA, makeCorrection({
      rule: "Always dispatch a sonnet worker for execution",
      tags: ["model"],
      failure_class: "model_dispatch",
    }));
    const sameProjCandId = await writePlain(ALPHA, makeCorrection({
      date: YESTERDAY,
      rule: "Never route work through fable — sonnet stays the worker model",
      context: "Never route work through fable — sonnet stays the worker model",
      tags: ["dispatch"],
      failure_class: "model_dispatch",
    }));

    await sessionEnd({ summary: RECURRENCE_SUMMARY, project: ALPHA });

    const joinRecurred = readOutcomeLines(ALPHA).filter(
      (o) =>
        o.kind === "recurred" &&
        o.correction_id === sameProjCandId &&
        /cross-project class join/.test(o.evidence ?? ""),
    );
    assert.equal(joinRecurred.length, 0, "1c must skip candidates in the current project");
  });

  it("candidate captured TODAY → never marked recurred on its birth day", async () => {
    await writeRetrievedToday(ALPHA, makeCorrection({
      rule: "Always dispatch a sonnet worker for execution",
      tags: ["model"],
      failure_class: "model_dispatch",
    }));
    // Same class, strong rule-text overlap — but captured today.
    const bornTodayId = await writePlain(BETA, makeCorrection({
      project: BETA,
      rule: "Never route work through fable — sonnet stays the worker model",
      context: "Never route work through fable — sonnet stays the worker model",
      tags: ["dispatch"],
      failure_class: "model_dispatch",
    }));

    await sessionEnd({ summary: RECURRENCE_SUMMARY, project: ALPHA });

    const recurred = readOutcomeLines(BETA).filter(
      (o) => o.kind === "recurred" && o.correction_id === bornTodayId,
    );
    assert.equal(recurred.length, 0, "recurred means AFTER the record existed — birth-day fires are false positives");
  });

  it("1/day dedup: a second session_end does not double-book recurred", async () => {
    await writeRetrievedToday(ALPHA, makeCorrection({
      rule: "Always dispatch a sonnet worker for execution",
      tags: ["model"],
      failure_class: "model_dispatch",
    }));
    const candId = await writePlain(BETA, makeCorrection({
      project: BETA,
      date: YESTERDAY,
      rule: "Never route work through fable — sonnet stays the worker model",
      tags: ["dispatch"],
      failure_class: "model_dispatch",
    }));

    await sessionEnd({ summary: RECURRENCE_SUMMARY, project: ALPHA });
    await sessionEnd({ summary: RECURRENCE_SUMMARY, project: ALPHA });

    const recurred = readOutcomeLines(BETA).filter(
      (o) => o.kind === "recurred" && o.correction_id === candId,
    );
    assert.equal(recurred.length, 1, "recurred must be booked at most once per day per candidate");
  });
});
