// packages/core/test/session-end-insight-gate.test.mjs
//
// Fix #2 (plan-v2, 2026-09-11) — dual-channel capture gate, L2:
// session_end insights[] pass the SAME completeness validation as check()'s
// structured human_correction (full-sentence title, non-empty evidence,
// applies_when made of REAL tokens, not fragments). Failing insights are
// STAGED to corrections/_pending/ — never silently dropped, never active
// (never reach the insights index / awareness store, and therefore never the
// recall corpus).
//
// EVALUATION EXEMPLAR E2 (regression fixture from the 2026-09-11 eval):
// an insight whose applies_when is the fragment array ["good,","then","don't"]
// must be staged pending, not admitted to awareness.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { sessionEnd } from "../dist/tools-logic/session-end.js";
import { readInsightsIndex } from "../dist/palace/insights-index.js";
import { listPendingCorrections, validateInsightCompleteness } from "../dist/storage/pending.js";

let testRoot;

beforeEach(() => {
  testRoot = path.join(tmpdir(), `ar-insight-gate-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(testRoot, { recursive: true });
  process.env.AGENT_RECALL_ROOT = testRoot;
});

afterEach(() => {
  delete process.env.AGENT_RECALL_ROOT;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

const VALID_INSIGHT = {
  title: "Token-bucket rate limiting absorbs bursts better than fixed windows",
  evidence: "Load test dropped 0 requests vs 12% with fixed windows",
  applies_when: ["rate limiting", "api gateway"],
};

describe("L2: session_end insights completeness gate", () => {
  it("E2: fragment applies_when ([\"good,\",\"then\",\"don't\"]) → staged pending, never active", async () => {
    const project = "l2-fragment";
    const result = await sessionEnd({
      summary: "Wrapped up the pricing experiment session with mixed results",
      insights: [{
        title: "Good approach worked well here today for the pricing flow",
        evidence: "it went fine",
        applies_when: ["good,", "then", "don't"],
      }],
      project,
    });
    assert.equal(result.success, true);
    assert.equal(result.insights_pending, 1, "the failing insight must be counted as pending");
    assert.equal(result.awareness_updated, false, "no valid insights → awareness must not be touched");

    // NEVER active: the insights index must not contain it.
    const index = readInsightsIndex();
    assert.ok(
      !index.insights.some((i) => i.title.includes("Good approach worked well")),
      "a fragment-applies_when insight must never reach the insights index",
    );

    // NEVER silently dropped: staged with provenance + reason.
    const pending = listPendingCorrections(project);
    assert.equal(pending.length, 1, `expected the insight staged in _pending/, got: ${JSON.stringify(pending)}`);
    assert.equal(pending[0].kind, "insight");
    assert.equal(pending[0].channel, "session_end_insight");
    assert.ok(/applies_when/.test(pending[0].reason), `the pending reason must name the failing field, got: ${pending[0].reason}`);
  });

  it("mixed batch: the valid insight flows to awareness, the invalid one pends", async () => {
    const project = "l2-mixed";
    const result = await sessionEnd({
      summary: "Shipped the limiter and captured two candidate insights",
      insights: [
        VALID_INSIGHT,
        { title: "fixed bug", evidence: "", applies_when: [] },
      ],
      project,
    });
    assert.equal(result.insights_pending, 1);
    assert.equal(result.awareness_updated, true);
    assert.equal(result.insights_added, 1, "only the VALID insight is classified/added");
    const index = readInsightsIndex();
    assert.ok(index.insights.some((i) => i.title === VALID_INSIGHT.title));
    assert.ok(!index.insights.some((i) => i.title === "fixed bug"));
    assert.equal(listPendingCorrections(project).length, 1);
  });

  it("a fully valid batch behaves exactly as before (no pending, counts intact)", async () => {
    const project = "l2-valid";
    const result = await sessionEnd({
      summary: "Clean session with one well-formed insight",
      insights: [VALID_INSIGHT],
      project,
    });
    assert.equal(result.insights_pending ?? 0, 0);
    assert.equal(result.insights_added, 1);
    assert.equal(result.awareness_updated, true);
    assert.equal(listPendingCorrections(project).length, 0);
  });
});

describe("validateInsightCompleteness — unit", () => {
  it("accepts the existing corpus shapes (declarative full-sentence titles, single real token)", () => {
    for (const fixture of [
      VALID_INSIGHT,
      { title: "JWT refresh rotation prevents session fixation", evidence: "Implemented in auth module", applies_when: ["auth", "security", "jwt"] },
      { title: "Serialized budgets beat raw char caps", evidence: "JSON overhead counted", applies_when: ["budget"] },
      { title: "P0 completeness beats byte budget in section trims", evidence: "overflow branch documented", applies_when: ["corrections"] },
    ]) {
      assert.equal(validateInsightCompleteness(fixture).ok, true, `should accept: ${fixture.title}`);
    }
  });

  it("rejects fragment titles, empty evidence, fragment applies_when", () => {
    assert.equal(validateInsightCompleteness({ title: "fixed bug", evidence: "e", applies_when: ["x"] }).ok, false);
    assert.equal(validateInsightCompleteness({ ...VALID_INSIGHT, evidence: "  " }).ok, false);
    assert.equal(validateInsightCompleteness({ ...VALID_INSIGHT, applies_when: ["good,", "then", "don't"] }).ok, false);
    assert.equal(validateInsightCompleteness({ ...VALID_INSIGHT, applies_when: [] }).ok, false);
  });

  it("carries an agent_instruction on failure", () => {
    const r = validateInsightCompleteness({ title: "x", evidence: "", applies_when: [] });
    assert.equal(r.ok, false);
    assert.ok(r.agent_instruction && r.agent_instruction.length > 20);
  });
});
