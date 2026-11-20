// 3.5.4 PR-B — every stored rule is shown whole wherever an agent sees it.
//
// Found by the 2026-11-19 black-box test of 3.5.3 (round 2, g4): rules were cut
// twice — to the first sentence and 100 characters when stored, and to 120
// characters again when rendered (session-start.ts, session-start-render.ts).
// 16 of the owner's 18 printed P0 lines were cut with no marker; 0 of 12 rules
// over 120 characters printed whole; a cut clause was followed 0/5 and a cut
// fragment steered the wrong way 5/5.
//
// Rules already cut on disk keep their whole text in `context` (rule + "\n\nWhy: "
// + why), so fullRuleOf() derives the whole rule at read time. Nothing on disk is
// rewritten.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import * as core from "../dist/index.js";

const PROJECT = "rules-whole-proj";
let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), "ar-rules-whole-"));
  process.env.AGENT_RECALL_ROOT = root;
});
afterEach(() => {
  delete process.env.AGENT_RECALL_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

const FULL =
  "Never use translucent or glass card backgrounds on the landing page; always use opaque cards with the site gold border and a solid dark fill.";
const CUT = FULL.slice(0, 100); // what 3.5.3 stored as `rule`
const WHY = "The owner rejected the glass look twice.";

/** Write a record the way 3.5.3 left it on disk: rule cut at 100, context whole. */
function seedCut({ rule = CUT, context = `${FULL}\n\nWhy: ${WHY}`, id = "2026-11-01-never-use-translucent-or-glas", date = "2026-11-01" } = {}) {
  const dir = path.join(root, "projects", PROJECT, "corrections");
  fs.mkdirSync(dir, { recursive: true });
  const rec = {
    id, date, severity: "p0", project: PROJECT, rule, context,
    tags: ["design", "landing"], applies_when: ["design", "landing"], kind: "correction",
    weight: 1, active: true, authoritative: true, proof_count: 1, proof_confidence: 1, confidence: "high",
  };
  const file = path.join(dir, `${date}--${id.slice(11)}.json`);
  fs.writeFileSync(file, JSON.stringify(rec, null, 2));
  return file;
}
const startText = async (mode) => core.renderSessionStart(await core.sessionStart({ project: PROJECT, ...(mode ? { mode } : {}) }));

describe("fullRuleOf", () => {
  it("derives the whole rule from context when the stored rule is its prefix", () => {
    assert.equal(core.fullRuleOf({ rule: CUT, context: `${FULL}\n\nWhy: ${WHY}` }), FULL);
  });
  it("keeps the stored rule when context has no Why separator", () => {
    assert.equal(core.fullRuleOf({ rule: CUT, context: `${FULL} because ${WHY}` }), CUT);
  });
  it("keeps the stored rule when the context head does not start with it (hand-edited)", () => {
    assert.equal(core.fullRuleOf({ rule: CUT, context: `Something else entirely.\n\nWhy: ${WHY}` }), CUT);
  });
  it("keeps the stored rule when it is already whole", () => {
    assert.equal(core.fullRuleOf({ rule: FULL, context: `${FULL}\n\nWhy: ${WHY}` }), FULL);
  });
  it("handles a missing context", () => {
    assert.equal(core.fullRuleOf({ rule: CUT }), CUT);
  });
});

describe("session start shows rules whole", () => {
  for (const mode of [undefined, "full"]) {
    it(`a rule cut at 100 on disk prints whole (${mode ?? "cards"})`, async () => {
      seedCut();
      const res = await core.sessionStart({ project: PROJECT, ...(mode ? { mode } : {}) });
      assert.equal(res.corrections[0].rule, FULL);
      const line = core.renderSessionStart(res).split("\n").find((l) => l.includes("[P0]"));
      assert.ok(line.includes(FULL), `line: ${line}`);
    });
  }

  it("a 180-character rule recorded through check() prints whole on one line", async () => {
    const R = "Always run the full test suite on Windows and on Linux before you open a pull request, and paste both result summaries into the pull request description.";
    assert.ok(R.length > 120);
    await core.check({ goal: "g", confidence: "high", project: PROJECT, human_correction: { rule: R, why: WHY, applies_when: ["tests", "pr"] } });
    const text = await startText();
    assert.ok(text.split("\n").some((l) => l.includes("[P0]") && l.includes(R)), text);
  });

  it(`a rule over RULE_RENDER_MAX is bounded with a visible ellipsis`, async () => {
    const LONG = "Never " + "change the shared deployment configuration without a review ".repeat(20).trim() + ".";
    assert.ok(LONG.length > core.RULE_RENDER_MAX);
    seedCut({ rule: LONG });
    const line = (await startText()).split("\n").find((l) => l.includes("[P0]"));
    assert.ok(line.includes("…"), line);
    assert.ok(line.length < core.RULE_RENDER_MAX + 40, `line length ${line.length}`);
  });

  it("rule and context on disk are unchanged by session start (read-time only)", async () => {
    const file = seedCut();
    await core.sessionStart({ project: PROJECT });
    await core.flushAllBookkeeping?.();
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(rec.rule, CUT);
    assert.equal(rec.context, `${FULL}\n\nWhy: ${WHY}`);
  });
});

describe("other surfaces show the derived rule", () => {
  it("check(action) returns the whole rule in matching_corrections and the warning", async () => {
    seedCut();
    const res = await core.checkAction({ project: PROJECT, action_description: "make the landing page cards translucent glass" });
    const m = res.matching_corrections.find((c) => c.rule.startsWith("Never use translucent"));
    assert.ok(m, "matched");
    assert.equal(m.rule, FULL);
    assert.ok((res.warning ?? "").includes(FULL));
  });

  it("recording the whole text of an old cut rule merges into it", async () => {
    seedCut();
    await core.check({ goal: "g", confidence: "high", project: PROJECT, human_correction: { rule: FULL, why: WHY, applies_when: ["design"] } });
    const active = core.readCorrections(PROJECT).filter((c) => c.active !== false);
    assert.equal(active.length, 1, "one active rule, not a duplicate");
    assert.equal(active[0].proof_count, 2);
  });

  it("ar cold-start returns every active P0, whole", async () => {
    for (let i = 0; i < 7; i++) {
      seedCut({ id: `2026-11-0${i + 1}-rule-${i}`, date: `2026-11-0${i + 1}`, rule: i === 0 ? CUT : `Never skip review step number ${i} before merging.`, context: i === 0 ? `${FULL}\n\nWhy: ${WHY}` : `Never skip review step number ${i} before merging.\n\nWhy: ${WHY}` });
    }
    const res = await core.journalColdStart({ project: PROJECT });
    assert.equal(res.p0_corrections.length, 7);
    assert.ok(res.p0_corrections.some((c) => c.rule === FULL));
  });

  it("the handoff and the per-prompt instinct warning print the whole rule", async () => {
    seedCut();
    assert.ok(core.generateHandoff(PROJECT).includes(FULL), "handoff");
    const rec = core.readCorrections(PROJECT)[0];
    const lines = core.buildPriors("make the landing page cards translucent glass with a blur", [rec], []);
    assert.ok(lines.some((l) => l.includes(FULL)), JSON.stringify(lines));
  });
});

describe("review follow-ups (M3, M4, L1)", () => {
  it("M4: session_start context does not repeat the whole rule", async () => {
    seedCut();
    const res = await core.sessionStart({ project: PROJECT });
    const ctx = res.corrections[0].context ?? "";
    assert.ok(!ctx.startsWith(FULL), `context repeats the rule: ${ctx.slice(0, 60)}`);
  });

  it("M3: cold-start caps the rule count and bounds context", async () => {
    for (let i = 0; i < 55; i++) {
      const d = `2026-10-${String((i % 28) + 1).padStart(2, "0")}`;
      const r = `Never skip review step number ${i} before merging the branch.`;
      seedCut({ id: `${d}-step-${i}`, date: d, rule: r, context: `${r}\n\nWhy: ${"x ".repeat(400)}` });
    }
    const res = await core.journalColdStart({ project: PROJECT });
    assert.equal(res.p0_corrections.length, 50);
    assert.ok(res.p0_corrections.every((c) => c.context.length <= 301));
  });

  it("L1: boundRule never leaves a lone surrogate", () => {
    const out = core.boundRule("a".repeat(399) + "\u{1F600}" + " tail", 400);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), "no lone high surrogate");
  });
});
