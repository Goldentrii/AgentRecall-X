import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { deriveBlindSpots } from "../dist/helpers/blind-spots.js";
import {
  writeBlindSpots,
  readBlindSpots,
  recomputeBlindSpots,
} from "../dist/storage/blind-spots-store.js";
import { writeCorrection } from "../dist/storage/corrections.js";
import { classifyPath } from "../dist/storage/classification.js";
import { personalDir } from "../dist/storage/paths.js";

let testRoot;

function correction(id, rule, severity = "p1") {
  return {
    id,
    date: id.slice(0, 10),
    severity,
    project: "bs-proj",
    rule,
    context: rule,
    tags: [],
  };
}

describe("Wave 5 — deriveBlindSpots", () => {
  beforeEach(() => {
    testRoot = path.join(tmpdir(), `ar-blindspots-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(testRoot, { recursive: true });
    process.env.AGENT_RECALL_ROOT = testRoot;
  });

  afterEach(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("3 corrections sharing >=2 keywords cluster into 1 blind spot", () => {
    const corrections = [
      { ...correction("2026-06-01-infra-revenue", "Never build infrastructure over revenue features", "p1"), recurrence_count: 1 },
      { ...correction("2026-06-02-infra-revenue", "Avoid infrastructure detours, prioritize revenue", "p1"), recurrence_count: 2 },
      { ...correction("2026-06-03-infra-revenue", "Infrastructure work must serve revenue first", "p1"), recurrence_count: 1 },
    ];
    const profile = deriveBlindSpots(corrections, []);
    assert.ok(profile.blind_spots.length >= 1, "should produce at least one blind spot");
    const top = profile.blind_spots[0];
    assert.ok(top.evidence_count >= 3, `evidence_count should be >=3, got ${top.evidence_count}`);
    assert.ok(top.trigger_keywords.length >= 2, "should have >=2 shared trigger keywords");
    assert.ok(top.trigger_keywords.includes("infrastructure") || top.trigger_keywords.includes("revenue"));
  });

  it("a single P0 correction still yields a blind spot (>=1-if-P0 rule)", () => {
    const corrections = [correction("2026-06-01-no-push", "Never push without explicit approval", "p0")];
    const profile = deriveBlindSpots(corrections, []);
    assert.ok(profile.blind_spots.length >= 1, "single P0 must still produce a blind spot");
    assert.equal(profile.blind_spots[0].severity, "p0");
  });

  it("two unrelated single P1 corrections produce no cluster", () => {
    const corrections = [
      correction("2026-06-01-blue", "Use the blue button on the login page", "p1"),
      correction("2026-06-02-cache", "Clear the redis cache after deploy", "p1"),
    ];
    const profile = deriveBlindSpots(corrections, []);
    // Neither clusters (no shared >=2 keywords, neither P0) — expect zero.
    assert.equal(profile.blind_spots.length, 0);
  });

  it("normalizes alignment-log entries (corrections[]/delta) alongside records (.rule)", () => {
    const alignmentLog = [
      { date: "2026-06-01", goal: "x", confidence: "high", assumptions: [], corrections: ["Never build infrastructure over revenue"] },
      { date: "2026-06-02", goal: "y", confidence: "high", assumptions: [], delta: "infrastructure detour again, revenue ignored" },
    ];
    const corrections = [correction("2026-06-03-infra", "Infrastructure must serve revenue", "p1")];
    const profile = deriveBlindSpots(corrections, alignmentLog);
    assert.ok(profile.blind_spots.length >= 1, "alignment-log + records should combine into a cluster");
  });

  it("writeBlindSpots persists ONLY to personalDir/blind-spots.json (0600), classifyPath===personal", () => {
    const profile = deriveBlindSpots(
      [
        { ...correction("2026-06-01-infra", "Never build infrastructure over revenue"), recurrence_count: 1 },
        { ...correction("2026-06-02-infra", "Avoid infrastructure detours for revenue"), recurrence_count: 1 },
        { ...correction("2026-06-03-infra", "Infrastructure should serve revenue") },
      ],
      [],
    );
    writeBlindSpots("bs-proj", profile);

    const file = path.join(personalDir("bs-proj"), "blind-spots.json");
    assert.ok(fs.existsSync(file), "blind-spots.json must exist under personalDir");
    // privacy invariant — the file is classified personal
    assert.equal(classifyPath(file), "personal");
    // mode 0600
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    // NEVER under palace/
    assert.ok(!file.includes(`${path.sep}palace${path.sep}`), "must not live under palace/");

    const read = readBlindSpots("bs-proj");
    assert.ok(read);
    assert.equal(read.blind_spots.length, profile.blind_spots.length);
  });

  it("readBlindSpots returns null when absent", () => {
    assert.equal(readBlindSpots("never-written"), null);
  });

  it("recomputeBlindSpots derives from stored corrections and writes the profile", () => {
    writeCorrection("bs-proj", correction("2026-06-01-infra-one", "Never build infrastructure over revenue features", "p1"));
    writeCorrection("bs-proj", correction("2026-06-02-infra-two", "Avoid infrastructure detours, ship revenue", "p1"));
    writeCorrection("bs-proj", correction("2026-06-03-infra-three", "Infrastructure must serve revenue first", "p1"));
    const profile = recomputeBlindSpots("bs-proj");
    assert.ok(profile.blind_spots.length >= 1);
    assert.ok(readBlindSpots("bs-proj"));
  });
});
