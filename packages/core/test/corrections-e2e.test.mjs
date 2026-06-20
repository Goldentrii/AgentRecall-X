/**
 * corrections-e2e.test.mjs
 * End-to-end pipeline test: write → read → filter via the PUBLIC barrel export.
 * Verifies that writeCorrection / readCorrections / readActiveCorrections are
 * correctly re-exported from the top-level index and that the full pipeline
 * works end-to-end including backward-compat defaults.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

// Import through the PUBLIC barrel (not internal storage path)
import {
  writeCorrection,
  readCorrections,
  readActiveCorrections,
} from "../dist/index.js";

let testRoot;

function corrDir(project) {
  return path.join(testRoot, "projects", project, "corrections");
}

function writeRaw(project, filename, record) {
  const dir = corrDir(project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(record, null, 2), "utf-8");
}

describe("corrections pipeline e2e (via public index export)", () => {
  beforeEach(() => {
    testRoot = path.join(
      tmpdir(),
      `ar-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    fs.mkdirSync(testRoot, { recursive: true });
    process.env.AGENT_RECALL_ROOT = testRoot;
  });

  afterEach(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("full round-trip: write then read returns same correction", () => {
    writeCorrection("e2e-proj", {
      id: "2026-05-19-do-not-push",
      date: "2026-05-19",
      severity: "p0",
      project: "e2e-proj",
      rule: "Never push without permission",
      context: "Hard rule from human model.",
      tags: ["git", "safety"],
    });

    const results = readCorrections("e2e-proj");
    assert.equal(results.length, 1);
    assert.equal(results[0].rule, "Never push without permission");
    assert.equal(results[0].severity, "p0");
  });

  it("holder defaults to today's ISO date when not supplied", () => {
    const today = new Date().toISOString().slice(0, 10);
    writeCorrection("e2e-proj", {
      id: "2026-05-19-no-holder",
      date: today,
      severity: "p1",
      project: "e2e-proj",
      rule: "Use structured corrections",
      context: "Test that holder defaults to today.",
      tags: [],
    });

    const [record] = readCorrections("e2e-proj");
    assert.equal(record.holder, today);
  });

  it("kind defaults to 'correction' when not supplied", () => {
    writeCorrection("e2e-proj", {
      id: "2026-05-19-no-kind",
      date: "2026-05-19",
      severity: "p1",
      project: "e2e-proj",
      rule: "Default kind must be correction when not supplied",
      context: "Test kind default.",
      tags: [],
    });

    const [record] = readCorrections("e2e-proj");
    assert.equal(record.kind, "correction");
  });

  it("weight auto-derived from severity: p0→1.0, p1→0.7", () => {
    writeCorrection("e2e-proj", {
      id: "2026-05-19-p0",
      date: "2026-05-19",
      severity: "p0",
      project: "e2e-proj",
      rule: "Always use P0 weight derived from severity",
      context: "",
      tags: [],
    });
    writeCorrection("e2e-proj", {
      id: "2026-05-19-p1",
      date: "2026-05-18",
      severity: "p1",
      project: "e2e-proj",
      rule: "Always use P1 weight derived from severity",
      context: "",
      tags: [],
    });

    const records = readCorrections("e2e-proj");
    const p0 = records.find((r) => r.severity === "p0");
    const p1 = records.find((r) => r.severity === "p1");
    assert.equal(p0.weight, 1.0);
    assert.equal(p1.weight, 0.7);
  });

  it("explicit weight:0 and active:false survive default-filling (nullish coalescing)", () => {
    writeCorrection("e2e-proj", {
      id: "2026-05-19-explicit-false",
      date: "2026-05-19",
      severity: "p0",
      project: "e2e-proj",
      rule: "Always preserve explicit falsy values via nullish coalescing",
      context: "",
      tags: [],
      weight: 0,
      active: false,
    });

    const [record] = readCorrections("e2e-proj");
    assert.equal(record.weight, 0, "weight:0 must not be overwritten by default 1.0");
    assert.equal(record.active, false, "active:false must not be overwritten by default true");
  });

  it("readActiveCorrections filters out active:false records", () => {
    writeRaw("e2e-proj", "2026-05-19-active.json", {
      id: "active", date: "2026-05-19", severity: "p0",
      project: "e2e-proj", rule: "Active rule", context: "", tags: [], active: true,
    });
    writeRaw("e2e-proj", "2026-05-18-archived.json", {
      id: "archived", date: "2026-05-18", severity: "p0",
      project: "e2e-proj", rule: "Archived rule", context: "", tags: [], active: false,
    });

    const all = readCorrections("e2e-proj");
    const active = readActiveCorrections("e2e-proj");

    assert.equal(all.length, 2);
    assert.equal(active.length, 1);
    assert.equal(active[0].id, "active");
  });

  it("old records missing new fields get backward-compat defaults on read", () => {
    writeRaw("e2e-proj", "2026-01-01-legacy.json", {
      id: "legacy", date: "2026-01-01", severity: "p1",
      project: "e2e-proj", rule: "Legacy rule", context: "Old format.", tags: [],
      // No holder, kind, weight, active fields
    });

    const [record] = readCorrections("e2e-proj");
    assert.equal(record.holder, "2026-01-01"); // defaults to record.date
    assert.equal(record.kind, "correction");
    assert.equal(record.weight, 0.7);
    assert.equal(record.active, true);
  });
});
