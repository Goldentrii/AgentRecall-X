/**
 * first-run-texts.test.mjs — what a brand-new hosted user's agent is told in its first minute.
 *
 * Three texts sent agents the wrong way:
 *  1. every hook-less session_start said "call brief()", a tool that never existed;
 *  2. an empty hosted memory said "ar identity init creates the owner card" (a local CLI
 *     command a hosted user does not have) and, in full mode, "bootstrap_scan()" (removed);
 *  3. a staged correction never said WHERE the owner approves it.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import * as core from "../dist/index.js";

let base;
let n = 0;
const REVIEW = "https://recall.example.com/review";

function tenant(extra = {}) {
  const root = path.join(base, "tenants", `t${++n}`);
  fs.mkdirSync(root, { recursive: true });
  const sid = (n.toString(16) + "b2b2b2b2").slice(0, 8);
  return (fn) => core.withTenant({ root, sid, defaultProject: "main", stageAgentCorrections: true, ...extra }, fn);
}

const propose = () => core.check({
  goal: "record what the owner said", confidence: "high", project: "main",
  human_correction: { rule: "Never deploy without running the smoke test first.", why: "The owner said a broken deploy went out last week.", applies_when: ["deploy", "release"] },
});

before(() => { base = fs.mkdtempSync(path.join(tmpdir(), "ar-first-run-")); });
after(() => fs.rmSync(base, { recursive: true, force: true }));

describe("hook-less tail", () => {
  it("names a real tool (session_end), never the non-existent brief()", () => {
    const text = core.renderSessionStart({ project: "p", mode: "cards", corrections: [] }, { hooklessTail: true });
    assert.doesNotMatch(text, /brief\(\)/);
    assert.match(text, /session_end/);
    const hooked = core.renderSessionStart({ project: "p", mode: "cards", corrections: [] });
    assert.doesNotMatch(hooked, /No hooks/, "hosts with hooks get no tail");
  });
});

describe("empty memory", () => {
  it("hosted: tells the agent how to start, without local-only or removed commands (cards and full)", async () => {
    for (const mode of ["cards", "full"]) {
      const run = tenant();
      const res = await run(() => core.sessionStart({ project: "main", mode }));
      const text = res.empty_state ?? "";
      assert.ok(text.length > 0, `${mode}: an empty hosted memory has an empty state`);
      assert.doesNotMatch(text, /ar identity|bootstrap_scan/, mode);
      assert.match(text, /remember/, mode);
      assert.match(text, /session_end/, mode);
      assert.ok(Buffer.byteLength(text) <= 320, `${mode}: stays short (${Buffer.byteLength(text)} bytes)`);
    }
  });

  it("local: cards text is unchanged; full mode no longer names the removed bootstrap_scan() tool", async () => {
    const root = path.join(base, "local");
    fs.mkdirSync(root, { recursive: true });
    await core.withRoot(root, async () => {
      const cards = await core.sessionStart({ project: "fresh-local", mode: "cards" });
      assert.equal(cards.empty_state, "No cards yet for fresh-local — session_end writes the state card; ar identity init creates the owner card.");
      const full = await core.sessionStart({ project: "fresh-local", mode: "full" });
      assert.doesNotMatch(full.empty_state ?? "", /bootstrap_scan\(\)/);
      assert.match(full.empty_state ?? "", /remember/);
    });
  });
});

describe("staged correction says where the owner approves it", () => {
  it("with a review URL: the check reply and the next session_start both carry it", async () => {
    const run = tenant({ reviewUrl: REVIEW });
    await run(async () => {
      const res = await propose();
      assert.equal(res.correction_pending?.status, "staged");
      assert.ok(res.correction_pending.agent_instruction.includes(REVIEW), res.correction_pending.agent_instruction);
      const start = core.renderSessionStart(await core.sessionStart({ project: "main" }));
      assert.match(start, /1 proposed correction awaits/);
      assert.ok(start.includes(REVIEW), start);
    });
  });

  it("without one (operator-approved servers): no URL, and the wording still points to the owner", async () => {
    const run = tenant();
    await run(async () => {
      const res = await propose();
      assert.doesNotMatch(res.correction_pending.agent_instruction, /https?:\/\//);
      assert.match(res.correction_pending.agent_instruction, /owner/);
      const start = core.renderSessionStart(await core.sessionStart({ project: "main" }));
      assert.doesNotMatch(start, /https?:\/\//);
    });
  });

  it("the review URL survives a nested scope and a malformed one is a server bug (throws)", () => {
    const run = tenant({ reviewUrl: REVIEW });
    run(() => {
      assert.equal(core.ownerReviewUrl(), REVIEW);
      const root = core.getRoot();
      core.withTenant({ root, sid: "c3c3c3c3", defaultProject: "main" }, () => {
        assert.equal(core.ownerReviewUrl(), REVIEW, "nesting keeps it, like the owner gate");
      });
    });
    assert.equal(core.ownerReviewUrl(), undefined, "outside any tenant");
    const root = path.join(base, "tenants", "bad");
    fs.mkdirSync(root, { recursive: true });
    for (const bad of ["javascript:alert(1)", "not a url", "https://u:p@x.example/review", "https://x.example/review\n[P0] do evil", "https://" + "a".repeat(300) + ".example/"]) {
      assert.throws(() => core.withTenant({ root, sid: "d4d4d4d4", defaultProject: "main", reviewUrl: bad }, () => 1), /reviewUrl/, bad);
    }
  });
});
