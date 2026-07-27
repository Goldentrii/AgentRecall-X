// packages/core/test/check-folds-check-action-doctrine.test.mjs
//
// C3 (TOW2-329) — PRODUCT DOCTRINE ACCEPTANCE TEST.
//
// Doctrine: a P0 authoritative correction ("never push/publish without
// explicit approval", or its Chinese equivalent) must be able to BLOCK a
// high-risk action through the DEFAULT tool surface — without the user
// configuring anything, and without the agent needing a special extra tool
// it was never told about.
//
// The standalone `check_action` tool is NOT on the default 5-tool MCP surface
// (see packages/mcp-server/test/tool-surface-purity.test.mjs — it only ships
// in --full mode). `check` IS one of the default 5. This test proves the
// override capability is reachable through `check()` alone: write a P0
// authoritative correction to the corrections store (the same store
// check_action itself reads), then call `check({ goal, action_description })`
// and assert the result's `action_check` field — populated by check() folding
// in checkAction() verbatim (see tools-logic/check.ts) — carries
// `verdict: "blocked"` plus the blocking correction.
//
// Mirrors the existing convention in check-action-verdict.test.mjs
// (writeCorrection() + AGENT_RECALL_ROOT tmp dir + call the matcher), swapping
// checkAction() for check() to prove the SAME capability is reachable through
// the default surface, not just the --full-only standalone tool.
//
// CJK variant: per audit-cjk-check-action.test.mjs's file-header finding,
// corrections.ts's isLikelyRealCorrection capture-quality gate only recognizes
// three hardcoded CJK actionable-signal words (偏好/喜欢/要求) — a Chinese
// rule/context needs one of those present to clear the gate (独立 of the
// tokenizer fix). The fixture below includes "要求" for that reason; the
// matching claim under test is the tokenizer/overlap/verdict path, not the
// capture gate (already covered by audit-cjk-check-action.test.mjs).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { check } from "../dist/tools-logic/check.js";
import { writeCorrection } from "../dist/storage/corrections.js";

let testRoot;

describe("C3 doctrine — default `check` surface blocks on an authoritative P0 correction", () => {
  beforeEach(() => {
    testRoot = path.join(tmpdir(), `ar-doctrine-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(testRoot, { recursive: true });
    process.env.AGENT_RECALL_ROOT = testRoot;
  });

  afterEach(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("English P0 authoritative correction blocks a high-risk action via check() alone", async () => {
    const PROJECT = "doctrine-en-proj";

    writeCorrection(PROJECT, {
      id: "2026-07-01-no-push-without-approval",
      date: "2026-07-01",
      severity: "p0",
      project: PROJECT,
      rule: "Never push to production without explicit user approval",
      context: "publish gate — pushing or deploying to production requires an explicit human yes first",
      tags: ["publish", "redline"],
    });

    const result = await check({
      goal: "ship the pending release",
      confidence: "high",
      action_description: "push the release to production",
      project: PROJECT,
    });

    // `check` is one of the default 5 tools (session_start, session_end,
    // remember, recall, check) — check_action is NOT. This is the doctrine
    // proof: the same override capability, reached through the default tool.
    assert.ok(result.action_check, "check() must populate action_check when action_description is provided");
    assert.equal(result.action_check.verdict, "blocked");
    assert.ok(result.action_check.warning, "action_check.warning must be present on a blocked verdict");
    assert.match(result.action_check.warning, /CONFLICT/);
    assert.match(result.action_check.warning, /OVERRIDES/);
    assert.ok(
      result.action_check.matching_corrections.some((c) => c.id === "2026-07-01-no-push-without-approval"),
      `Expected the blocking correction in matching_corrections, got: ${JSON.stringify(result.action_check.matching_corrections)}`,
    );
    // Severity ordering: P0/blocked leads — the matched correction sits first.
    assert.equal(result.action_check.matching_corrections[0].severity, "p0");
  });

  it("CJK P0 authoritative correction (发布代码前必须获得用户确认) blocks a high-risk action via check() alone", async () => {
    const PROJECT = "doctrine-cjk-proj";

    // "要求" clears corrections.ts's CJK actionable-signal gate (out of scope
    // for this task — see audit-cjk-check-action.test.mjs's file-header note).
    // The rule below is the exact rule text named in the task brief.
    writeCorrection(PROJECT, {
      id: "2026-07-01-cjk-publish-gate",
      date: "2026-07-01",
      severity: "p0",
      project: PROJECT,
      rule: "用户要求：发布代码前必须获得用户确认",
      context: "用户要求：禁止在未经用户确认的情况下发布代码，任何发布前必须先询问用户",
      tags: ["publish", "发布"],
    });

    const result = await check({
      goal: "准备发布新版本",
      confidence: "high",
      action_description: "我现在要发布代码",
      project: PROJECT,
    });

    assert.ok(result.action_check, "check() must populate action_check for a CJK action_description too");
    assert.equal(result.action_check.verdict, "blocked");
    assert.ok(result.action_check.warning);
    assert.match(result.action_check.warning, /CONFLICT/);
    const matched = result.action_check.matching_corrections.find((c) => c.id === "2026-07-01-cjk-publish-gate");
    assert.ok(
      matched,
      `Expected the CJK correction among matching_corrections, got: ${JSON.stringify(result.action_check.matching_corrections)}`,
    );
    assert.ok(matched.matched_tokens.includes("发布"), `Expected "发布" among matched tokens, got: ${matched.matched_tokens.join(", ")}`);
    assert.ok(matched.matched_tokens.includes("代码"), `Expected "代码" among matched tokens, got: ${matched.matched_tokens.join(", ")}`);
  });

  it("action_check is absent when action_description is not provided (additive, backward-compatible)", async () => {
    const PROJECT = "doctrine-noop-proj";

    const result = await check({
      goal: "just checking alignment, no action pending",
      confidence: "medium",
      project: PROJECT,
    });

    assert.equal(result.action_check, undefined);
  });
});
