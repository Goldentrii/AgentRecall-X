/**
 * corrections-confidence.test.mjs — P3 evidence-grounded proof_confidence.
 * Defaults to the authority weight; once outcomes accrue it becomes the Beta
 * posterior over (heeded, recurrence): heeded raises it, recurrence lowers it.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import {
  writeCorrection,
  recordOutcome,
  readCorrections,
} from "../dist/storage/corrections.js";

let testRoot;
const now = () => new Date().toISOString();
const conf = (project, id) => readCorrections(project).find((r) => r.id === id)?.proof_confidence;

beforeEach(async () => {
  testRoot = path.join(tmpdir(), `ar-conf-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(testRoot, { recursive: true });
  process.env.AGENT_RECALL_ROOT = testRoot;
});
afterEach(async () => {
  delete process.env.AGENT_RECALL_ROOT;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe("P3 evidence-grounded proof_confidence", () => {
  it("defaults to the authority weight before any outcome", async () => {
    await writeCorrection("p", {
      id: "2026-05-19-a", date: "2026-05-19", severity: "p0",
      project: "p", rule: "Always run the full suite before declaring done", context: "", tags: [],
    });
    assert.equal(conf("p", "2026-05-19-a"), 1.0); // p0 authority weight
  });

  it("rises with heeded, falls with recurrence (Beta posterior)", async () => {
    await writeCorrection("p", {
      id: "2026-05-19-b", date: "2026-05-19", severity: "p1",
      project: "p", rule: "Always keep pull requests small", context: "", tags: [],
    });
    await recordOutcome({ correction_id: "2026-05-19-b", project: "p", kind: "heeded", at: now() });
    await recordOutcome({ correction_id: "2026-05-19-b", project: "p", kind: "heeded", at: now() });
    assert.equal(conf("p", "2026-05-19-b"), 0.75); // beta(2,0) = 3/4

    await recordOutcome({ correction_id: "2026-05-19-b", project: "p", kind: "recurred", at: now() });
    assert.equal(conf("p", "2026-05-19-b"), 0.6); // beta(2,1) = 3/5
  });

  it("monotonic in heeded count", async () => {
    await writeCorrection("p", {
      id: "2026-05-19-c", date: "2026-05-19", severity: "p1",
      project: "p", rule: "Always write a failing test before the fix", context: "", tags: [],
    });
    await recordOutcome({ correction_id: "2026-05-19-c", project: "p", kind: "heeded", at: now() });
    const one = conf("p", "2026-05-19-c"); // beta(1,0) = 2/3 ≈ 0.667
    await recordOutcome({ correction_id: "2026-05-19-c", project: "p", kind: "heeded", at: now() });
    await recordOutcome({ correction_id: "2026-05-19-c", project: "p", kind: "heeded", at: now() });
    const three = conf("p", "2026-05-19-c"); // beta(3,0) = 4/5 = 0.8
    assert.ok(three > one, `expected ${three} > ${one}`);
    assert.equal(three, 0.8);
  });
});
