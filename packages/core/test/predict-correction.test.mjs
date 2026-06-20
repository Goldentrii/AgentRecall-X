import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { predictCorrection } from "../dist/tools-logic/predict-correction.js";
import { writeCorrection, readCorrections } from "../dist/storage/corrections.js";

let testRoot;
const PROJECT = "predict-proj";

function correction(id, rule, severity = "p1") {
  return {
    id,
    date: id.slice(0, 10),
    severity,
    project: PROJECT,
    rule,
    context: rule,
    tags: [],
  };
}

describe("Wave 5 — predictCorrection", () => {
  beforeEach(() => {
    testRoot = path.join(tmpdir(), `ar-predict-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(testRoot, { recursive: true });
    process.env.AGENT_RECALL_ROOT = testRoot;
  });

  afterEach(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("empty store → low likelihood, no throw, no risks", async () => {
    const result = await predictCorrection({ plan: "deploy the production database migration tonight", project: PROJECT });
    assert.equal(result.likelihood, "low");
    assert.deepEqual(result.top_risks, []);
  });

  it("high-recurrence correction + overlapping plan → high likelihood", async () => {
    // Several corrections forming a strong cluster, with recurrence weight.
    writeCorrection(PROJECT, { ...correction("2026-06-01-infra-a", "Never build infrastructure over revenue features", "p0") });
    writeCorrection(PROJECT, { ...correction("2026-06-02-infra-b", "Avoid infrastructure detours, prioritize revenue") });
    writeCorrection(PROJECT, { ...correction("2026-06-03-infra-c", "Infrastructure must serve revenue first") });

    // bump recurrence on disk to lift the score (recurrence weight in predictor)
    const dir = path.join(testRoot, "projects", PROJECT, "corrections");
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const fp = path.join(dir, f);
      const rec = JSON.parse(fs.readFileSync(fp, "utf-8"));
      rec.recurrence_count = 4;
      fs.writeFileSync(fp, JSON.stringify(rec, null, 2), "utf-8");
    }

    const result = await predictCorrection({
      plan: "Spend this sprint on infrastructure tooling and ignore the revenue dashboard work",
      project: PROJECT,
    });
    assert.equal(result.likelihood, "high", `expected high, got ${result.likelihood}`);
    assert.ok(result.top_risks.length >= 1);
    assert.ok(typeof result.suggested_guard === "string");
  });

  it("records a 'predicted' outcome for fired risks (instrumentation)", async () => {
    writeCorrection(PROJECT, { ...correction("2026-06-01-infra-a", "Never build infrastructure over revenue features", "p0") });
    writeCorrection(PROJECT, { ...correction("2026-06-02-infra-b", "Avoid infrastructure detours, prioritize revenue") });
    writeCorrection(PROJECT, { ...correction("2026-06-03-infra-c", "Infrastructure must serve revenue first") });

    await predictCorrection({
      plan: "build more infrastructure instead of revenue features this week",
      project: PROJECT,
    });

    const after = readCorrections(PROJECT);
    const anyPredicted = after.some((c) => (c.predicted_count ?? 0) > 0);
    assert.ok(anyPredicted, "at least one correction should have predicted_count incremented");
  });

  it("empty plan does not throw and returns low", async () => {
    const result = await predictCorrection({ plan: "", project: PROJECT });
    assert.equal(result.likelihood, "low");
  });
});
