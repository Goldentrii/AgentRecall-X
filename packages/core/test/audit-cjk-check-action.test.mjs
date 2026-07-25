// packages/core/test/audit-cjk-check-action.test.mjs
//
// AUDIT REGRESSION (Codex audit, v3.4.38 / commit 1f36bde) — Phase 0 / PR A1.
//
// Claim under test: check_action's Chinese text-matching should surface a
// stored Chinese correction when the current action text overlaps with that
// correction's rule/context in Chinese, but the tokenizer used by checkAction
// is English-only and drops CJK content, so it never matches.
//
// Ownership: the real text-matching/tokenization logic lives in
// packages/core/src/tools-logic/check-action.ts (exported `checkAction`,
// `tokenize`, `overlap`). packages/mcp-server/src/tools/check-action.ts is
// only a thin Zod/MCP wrapper that calls `checkAction` from
// `agent-recall-core` — it contains no matching logic of its own. This test
// therefore lives in packages/core (following the existing convention in
// packages/core/test/check-action-verdict.test.mjs: writeCorrection() +
// AGENT_RECALL_ROOT tmp dir + checkAction()).
//
// This is a REGRESSION FIXTURE ONLY (PR A1) — no production code is touched
// here (not check-action.ts in core or mcp-server). The positive-case
// assertion is expected to FAIL against the current tokenize() in
// check-action.ts, which is:
//
//   s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s\-]+/g, " ")...
//
// The `[^a-z0-9\s\-]+` replacement strips every CJK character (they are not
// a-z0-9), so any pure-Chinese rule/context/action tokenizes to an EMPTY
// token set — overlap() against another empty set is always 0, regardless
// of whether the two Chinese strings are about the same topic.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { checkAction, tokenize } from "../dist/tools-logic/check-action.js";
import { writeCorrection } from "../dist/storage/corrections.js";

let testRoot;
const PROJECT = "audit-cjk-proj";

describe("audit regression — CJK check_action text matching", () => {
  beforeEach(() => {
    testRoot = path.join(tmpdir(), `ar-audit-cjk-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(testRoot, { recursive: true });
    process.env.AGENT_RECALL_ROOT = testRoot;
  });

  afterEach(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("diagnostic: tokenize() on pure-Chinese text returns an EMPTY set (tokenizer is English-only)", () => {
    // Direct evidence for the root cause, independent of storage/matching:
    // the a-z0-9-only character-class strips CJK before the split/filter
    // step ever runs, so there is nothing left to overlap on.
    const tokens = tokenize("发布代码前必须获得用户确认");
    assert.equal(
      tokens.size,
      0,
      `Expected tokenize() to drop all CJK characters (English-only regex), got tokens: ${[...tokens].join(", ")}`,
    );
  });

  it("[EXPECTED TO CURRENTLY FAIL] Chinese action should match a Chinese correction with clearly overlapping topic", async () => {
    writeCorrection(PROJECT, {
      id: "2026-07-01-cjk-publish-gate",
      date: "2026-07-01",
      severity: "p1",
      project: PROJECT,
      rule: "发布代码前必须获得用户确认",
      context: "禁止在未经用户确认的情况下发布代码，任何发布前必须先询问用户",
      tags: ["publish", "发布"],
    });

    const result = await checkAction({
      action_description: "我现在要发布代码",
      project: PROJECT,
      // Lowest possible floor — isolates the question to "does ANY overlap
      // register at all", not "does it clear the default relevance floor".
      min_overlap: 1,
    });

    assert.ok(
      result.matching_corrections.length > 0,
      `Audit claim reproduced: check_action found NO matching corrections for a Chinese action ` +
        `against a topically-identical Chinese correction (rule="发布代码前必须获得用户确认", ` +
        `action="我现在要发布代码"). matching_corrections=${JSON.stringify(result.matching_corrections)}`,
    );
  });
});
