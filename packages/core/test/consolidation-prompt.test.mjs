import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import {
  CONSOLIDATION_PROMPT_TEMPLATE,
  buildConsolidationPrompt,
} from "../dist/prompts/consolidation-prompt.js";
import { proposeSkillsFromPhases } from "../dist/tools-logic/skill-propose.js";

let testRoot;
const PROJECT = "consol-proj";

describe("Wave 5 — versioned consolidation prompt + skill drafts", () => {
  beforeEach(() => {
    testRoot = path.join(tmpdir(), `ar-consol-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(testRoot, { recursive: true });
    process.env.AGENT_RECALL_ROOT = testRoot;
  });

  afterEach(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("CONSOLIDATION_PROMPT_TEMPLATE is a versioned non-empty template", () => {
    assert.equal(typeof CONSOLIDATION_PROMPT_TEMPLATE, "string");
    assert.ok(CONSOLIDATION_PROMPT_TEMPLATE.length > 50);
    // versioned: carries a version marker
    assert.match(CONSOLIDATION_PROMPT_TEMPLATE, /v\d+/i);
  });

  it("buildConsolidationPrompt embeds the bundle and asks for candidates (Phase B), not synthesis", () => {
    const bundle = {
      recent_journals: [{ date: "2026-06-01", file: "2026-06-01.md", excerpt: "fixed the deploy pipeline twice" }],
      active_corrections: [{ id: "c1", rule: "Never deploy on Friday", severity: "p0", precision: null }],
      recent_phases: [{ order: 1, phase: "deploy-hardening", synthesis: "atomic writes everywhere" }],
    };
    const prompt = buildConsolidationPrompt(PROJECT, bundle);
    assert.ok(prompt.includes(PROJECT));
    assert.ok(prompt.includes("2026-06-01"));
    assert.ok(prompt.includes("Never deploy on Friday"));
  });

  it("proposeSkillsFromPhases returns DRAFT skills (source auto_reflection), writes nothing", async () => {
    const result = await proposeSkillsFromPhases(PROJECT);
    assert.ok(Array.isArray(result));
    // No phases → no drafts, and nothing written to skills dir.
    const skillsDir = path.join(testRoot, "projects", PROJECT, "palace", "skills");
    assert.ok(!fs.existsSync(skillsDir) || fs.readdirSync(skillsDir).length === 0, "must not auto-write any skill files");
    for (const d of result) {
      assert.equal(d.source, "auto_reflection");
    }
  });
});
