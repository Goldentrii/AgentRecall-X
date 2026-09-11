/**
 * corrections-consolidate.test.mjs — P1 on-write consolidation.
 * A re-stated rule folds into the most-similar ACTIVE correction (proof_count++)
 * instead of accumulating a new dated file. Unrelated rules never merge.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import {
  writeCorrection,
  readCorrections,
} from "../dist/storage/corrections.js";

let testRoot;

beforeEach(async () => {
  testRoot = path.join(tmpdir(), `ar-consol-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(testRoot, { recursive: true });
  process.env.AGENT_RECALL_ROOT = testRoot;
});

afterEach(async () => {
  delete process.env.AGENT_RECALL_ROOT;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe("P1 on-write consolidation", () => {
  const RULE = "Never push to the main branch without explicit human approval";

  it("a re-stated rule merges into the existing record (proof_count++, one file)", async () => {
    const a = await writeCorrection("proj", {
      id: "2026-05-19-push", date: "2026-05-19", severity: "p0",
      project: "proj", rule: RULE, context: "First time the human said this.", tags: ["git"],
    });
    assert.equal(a.written, true);
    assert.equal(a.merged, false);

    // Same rule, different day → without merge this would be a second file.
    const b = await writeCorrection("proj", {
      id: "2026-05-20-push", date: "2026-05-20", severity: "p0",
      project: "proj", rule: RULE, context: "Human repeated it.", tags: ["safety"],
    });
    assert.equal(b.merged, true, "second identical rule must merge");
    assert.equal(b.id, "2026-05-19-push", "merge folds into the existing record's id");

    const all = readCorrections("proj");
    assert.equal(all.length, 1, "merge must not create a second file");
    assert.equal(all[0].proof_count, 2, "proof_count bumped on merge");
    assert.deepEqual(all[0].merged_from, ["2026-05-20-push"]);
    // tags unioned
    assert.deepEqual([...all[0].tags].sort(), ["git", "safety"]);
  });

  it("keeps the stronger severity and authority on merge", async () => {
    await writeCorrection("proj", {
      id: "2026-05-19-x", date: "2026-05-19", severity: "p1",
      project: "proj", rule: RULE, context: "stated mildly", tags: [], authoritative: false,
    });
    await writeCorrection("proj", {
      id: "2026-05-20-x", date: "2026-05-20", severity: "p0",
      project: "proj", rule: RULE, context: "stated as a hard rule", tags: [], authoritative: true,
    });
    const [rec] = readCorrections("proj");
    assert.equal(rec.severity, "p0", "p0 wins over p1 on merge");
    assert.equal(rec.authoritative, true, "authoritative escalates on merge");
    assert.equal(rec.weight, 1.0, "weight takes the max (p0 default 1.0)");
  });

  it("unrelated rules do NOT merge — distinct files preserved", async () => {
    await writeCorrection("proj", {
      id: "2026-05-19-push", date: "2026-05-19", severity: "p0",
      project: "proj", rule: RULE, context: "git rule", tags: [],
    });
    const d = await writeCorrection("proj", {
      id: "2026-05-20-react", date: "2026-05-20", severity: "p1",
      project: "proj", rule: "Prefer functional components over class components in React",
      context: "frontend style preference", tags: [],
    });
    assert.equal(d.merged, false, "an unrelated rule must not be swallowed");
    assert.equal(readCorrections("proj").length, 2);
  });

  it("backward-compat: a freshly written record defaults proof_count=1", async () => {
    await writeCorrection("proj", {
      id: "2026-05-19-solo", date: "2026-05-19", severity: "p0",
      project: "proj", rule: "Always run the test suite before declaring done", context: "", tags: [],
    });
    const [rec] = readCorrections("proj");
    assert.equal(rec.proof_count, 1);
    assert.equal(rec.proof_confidence, 1.0); // = weight (p0)
  });
});
