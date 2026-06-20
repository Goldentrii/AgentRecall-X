import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { checkAction } from "../dist/tools-logic/check-action.js";
import { writeCorrection } from "../dist/storage/corrections.js";

let testRoot;
const PROJECT = "verdict-proj";

function correctionsDir() {
  return path.join(testRoot, "projects", PROJECT, "corrections");
}

function bumpCorrection(id, patch) {
  const dir = correctionsDir();
  const f = fs.readdirSync(dir).find((x) => x.endsWith(".json") && JSON.parse(fs.readFileSync(path.join(dir, x), "utf-8")).id === id);
  const fp = path.join(dir, f);
  const rec = JSON.parse(fs.readFileSync(fp, "utf-8"));
  fs.writeFileSync(fp, JSON.stringify({ ...rec, ...patch }, null, 2), "utf-8");
}

describe("Wave 5 — check_action verdict (authoritative override gated against noise)", () => {
  beforeEach(() => {
    testRoot = path.join(tmpdir(), `ar-verdict-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(testRoot, { recursive: true });
    process.env.AGENT_RECALL_ROOT = testRoot;
  });

  afterEach(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("authoritative P0 (not noise) → verdict 'blocked' + CONFLICT line", async () => {
    writeCorrection(PROJECT, {
      id: "2026-06-01-no-publish",
      date: "2026-06-01",
      severity: "p0",
      project: PROJECT,
      rule: "Never run npm publish without explicit approval",
      context: "publish gate — npm publish requires a human yes",
      tags: ["publish", "redline"],
    });

    const result = await checkAction({
      action_description: "run npm publish to release the package",
      project: PROJECT,
    });

    assert.equal(result.verdict, "blocked");
    assert.ok(result.warning, "warning must be present");
    assert.match(result.warning, /CONFLICT/);
    assert.match(result.warning, /OVERRIDES/);
  });

  it("noise-candidate P0 (precision<0.3, retrieved>=3) → verdict 'advisory'", async () => {
    writeCorrection(PROJECT, {
      id: "2026-06-01-noisy-publish",
      date: "2026-06-01",
      severity: "p0",
      project: PROJECT,
      rule: "Never run npm publish without explicit approval",
      context: "publish gate — npm publish requires a human yes",
      tags: ["publish"],
    });
    // Make it a noise candidate: retrieved 5, heeded 1 → precision 0.2 (<0.3, retrieved>=3)
    bumpCorrection("2026-06-01-noisy-publish", {
      retrieved_count: 5,
      heeded_count: 1,
      precision: 0.2,
    });

    const result = await checkAction({
      action_description: "run npm publish to release the package",
      project: PROJECT,
    });

    assert.equal(result.verdict, "advisory");
    // Still surfaces a warning, just doesn't block.
    assert.ok(result.warning);
    assert.doesNotMatch(result.warning, /OVERRIDES/);
  });

  it("no matches → verdict 'advisory', null warning", async () => {
    const result = await checkAction({
      action_description: "open the settings panel and toggle dark mode",
      project: PROJECT,
    });
    assert.equal(result.verdict, "advisory");
    assert.equal(result.warning, null);
  });

  it("authoritative:false explicit P0 → not blocked (advisory)", async () => {
    writeCorrection(PROJECT, {
      id: "2026-06-01-soft-p0",
      date: "2026-06-01",
      severity: "p0",
      project: PROJECT,
      rule: "Never run npm publish without explicit approval",
      context: "publish gate — npm publish requires a human yes",
      tags: ["publish"],
    });
    bumpCorrection("2026-06-01-soft-p0", { authoritative: false });

    const result = await checkAction({
      action_description: "run npm publish to release the package",
      project: PROJECT,
    });
    assert.equal(result.verdict, "advisory");
  });
});
