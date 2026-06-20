import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { readActiveCorrections, readCorrections, writeCorrection } from "../dist/storage/corrections.js";

let testRoot;

function correctionsDir(project) {
  return path.join(testRoot, "projects", project, "corrections");
}

function writeRawCorrection(project, filename, record) {
  const dir = correctionsDir(project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(record, null, 2), "utf-8");
}

describe("corrections storage", () => {
  beforeEach(() => {
    testRoot = path.join(tmpdir(), `ar-corrections-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(testRoot, { recursive: true });
    process.env.AGENT_RECALL_ROOT = testRoot;
  });

  afterEach(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("writeCorrection persists structured fields to JSON", () => {
    writeCorrection("test-proj", {
      id: "2026-05-18-use-structured-corrections",
      date: "2026-05-18",
      severity: "p1",
      project: "test-proj",
      rule: "Use structured corrections",
      context: "Persist the GBrain-inspired correction metadata.",
      tags: ["corrections"],
      holder: "phase-2-worker",
      kind: "insight",
      weight: 0.42,
      active: false,
    });

    const files = fs.readdirSync(correctionsDir("test-proj"));
    assert.equal(files.length, 1);
    const stored = JSON.parse(fs.readFileSync(path.join(correctionsDir("test-proj"), files[0]), "utf-8"));

    assert.equal(stored.holder, "phase-2-worker");
    assert.equal(stored.kind, "insight");
    assert.equal(stored.weight, 0.42);
    assert.equal(stored.active, false);
  });

  it("readCorrections applies defaults to old-format records", () => {
    writeRawCorrection("test-proj", "2026-05-18-old-p0.json", {
      id: "2026-05-18-old-p0",
      date: "2026-05-18",
      severity: "p0",
      project: "test-proj",
      rule: "Always preserve old P0 corrections",
      context: "Old records have no structured metadata.",
      tags: ["legacy"],
    });
    writeRawCorrection("test-proj", "2026-05-17-old-p1.json", {
      id: "2026-05-17-old-p1",
      date: "2026-05-17",
      severity: "p1",
      project: "test-proj",
      rule: "Preserve old P1 corrections",
      context: "Old records have no structured metadata.",
      tags: ["legacy"],
    });

    const records = readCorrections("test-proj");
    const p0 = records.find((record) => record.severity === "p0");
    const p1 = records.find((record) => record.severity === "p1");

    assert.equal(p0.active, true);
    assert.equal(p0.weight, 1.0);
    assert.equal(p0.kind, "correction");
    assert.equal(p0.holder, "2026-05-18");

    assert.equal(p1.active, true);
    assert.equal(p1.weight, 0.7);
    assert.equal(p1.kind, "correction");
    assert.equal(p1.holder, "2026-05-17");
  });

  it("readActiveCorrections excludes inactive records", () => {
    writeRawCorrection("test-proj", "2026-05-18-active.json", {
      id: "2026-05-18-active",
      date: "2026-05-18",
      severity: "p0",
      project: "test-proj",
      rule: "Load active corrections",
      context: "Active corrections remain visible.",
      tags: ["active"],
      active: true,
    });
    writeRawCorrection("test-proj", "2026-05-17-inactive.json", {
      id: "2026-05-17-inactive",
      date: "2026-05-17",
      severity: "p0",
      project: "test-proj",
      rule: "Archive inactive corrections",
      context: "Inactive corrections should not be returned.",
      tags: ["inactive"],
      active: false,
    });

    const records = readActiveCorrections("test-proj");

    assert.equal(records.length, 1);
    assert.equal(records[0].id, "2026-05-18-active");
  });

  it("writeCorrection derives weight from severity when omitted", () => {
    writeCorrection("test-proj", {
      id: "2026-05-18-derived-p0",
      date: "2026-05-18",
      severity: "p0",
      project: "test-proj",
      rule: "Always derive P0 weight from severity",
      context: "P0 corrections default to full weight.",
      tags: ["weight"],
    });
    writeCorrection("test-proj", {
      id: "2026-05-17-derived-p1",
      date: "2026-05-17",
      severity: "p1",
      project: "test-proj",
      rule: "Always derive P1 weight from severity",
      context: "P1 corrections default to partial weight.",
      tags: ["weight"],
    });

    const records = readCorrections("test-proj");
    const p0 = records.find((record) => record.severity === "p0");
    const p1 = records.find((record) => record.severity === "p1");

    assert.equal(p0.weight, 1.0);
    assert.equal(p1.weight, 0.7);
  });
});
