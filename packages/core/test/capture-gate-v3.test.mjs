/**
 * capture-gate-v3.test.mjs — Loop 8.
 *
 * Locks the v3 capture-gate root-cause fix: the actionable-signal scan now runs
 * over the FULL text + each decimal-safe sentence fragment, so a directive in
 * sentence 2+ is seen — WITHOUT re-admitting the Loop-7 true-noise items.
 *
 * Two invariant classes are asserted here:
 *   1. RECALL (new behavior): soft corrections v2 wrongly rejected are accepted.
 *   2. PRECISION FLOOR (must NOT regress): every Loop-7 true-noise / system
 *      fragment is STILL rejected.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import {
  isLikelyRealCorrection,
  splitSentences,
  writeCorrection,
  readCorrections,
  GATE_VERSION,
} from "../dist/storage/corrections.js";

describe("capture gate v3 — GATE_VERSION stamp", () => {
  it("GATE_VERSION is bumped to v4-2026-06-22 (Loop 14 precision fix)", async () => {
    assert.equal(GATE_VERSION, "v4-2026-06-22");
  });
});

describe("capture gate v4 — PRECISION: hedged filler rejected, recall preserved", () => {
  // Loop 14 round-table found a MEDIUM false-accept: bare weak verbs
  // (use/should/avoid/stop/prefer) accepted tentative first-person filler.
  it("rejects tentative first-person filler whose only signal is a weak verb", async () => {
    const filler = [
      "I think we should use it",
      "the team wants to use the new API endpoint",
      "sounds good, I will use that approach",
      "maybe we could prefer the other one",
    ];
    for (const f of filler) {
      assert.equal(isLikelyRealCorrection(f).ok, false, `hedged filler must be rejected: ${f}`);
    }
  });

  it("STILL accepts a hedged opener when a STRONG directive marker is present (recall-safe)", async () => {
    // The hedge frame must NOT swallow a real rule that carries a strong marker.
    assert.equal(isLikelyRealCorrection("I think we should always deploy to staging first").ok, true);
    assert.equal(isLikelyRealCorrection("maybe, but never put secrets in the KV store").ok, true);
  });

  it("STILL accepts a directive sentence that FOLLOWS a hedged opener (per-fragment, not whole-text)", async () => {
    // A hedged first sentence must not poison a later directive sentence.
    assert.equal(isLikelyRealCorrection("I think that part is fine. Use inline, not full width.").ok, true);
  });

  it("STILL accepts a direct weak-verb correction with no hedge frame (no recall loss)", async () => {
    assert.equal(isLikelyRealCorrection("stop making the button full width, it should be inline").ok, true);
    assert.equal(isLikelyRealCorrection("avoid the floating docker tag, prefer a pinned digest").ok, true);
  });
});

describe("splitSentences — decimal-safe sentence splitter", () => {
  it("does NOT split on a decimal inside a version/model token", async () => {
    // "Opus 4.7" and "v3.4.32" must stay intact — the Loop-7 mis-split bug.
    assert.deepEqual(
      splitSentences("Show BOTH Opus 4.7 and 4.8 — keep the full Opus lineup"),
      ["Show BOTH Opus 4.7 and 4.8 — keep the full Opus lineup"],
    );
    assert.deepEqual(
      splitSentences("Pin to v3.4.32 not v3.4.30"),
      ["Pin to v3.4.32 not v3.4.30"],
    );
  });

  it("DOES split on sentence punctuation followed by whitespace/end", async () => {
    assert.deepEqual(
      splitSentences("No, that's wrong. Don't use dark backgrounds."),
      ["No, that's wrong.", "Don't use dark backgrounds."],
    );
  });

  it("splits on newlines and drops empty fragments", async () => {
    assert.deepEqual(
      splitSentences("first line\n\nsecond line"),
      ["first line", "second line"],
    );
  });

  it("does not split a bare decimal mid-number (e.g. file.md, e.g.)", async () => {
    // "readme.md" must not become two fragments.
    assert.deepEqual(
      splitSentences("change the readme.md for github"),
      ["change the readme.md for github"],
    );
  });
});

describe("capture gate v3 — RECALL: directive in sentence 2 is now ACCEPTED", () => {
  it("accepts a multi-sentence soft correction whose directive lives in sentence 2", async () => {
    // v2 saw only "No, that's wrong" (first-sentence slice) → rejected as ack.
    // v3 scans the full text → "Don't use …" in sentence 2 is a real directive.
    const r = isLikelyRealCorrection("No, that's wrong. Don't use dark backgrounds for new products.");
    assert.equal(r.ok, true, "directive in sentence 2 must rescue the leading acknowledgment");
  });

  it("accepts a soft correction whose directive follows a decimal-containing first clause", async () => {
    // v2 chopped "Show BOTH Opus 4" off the decimal and lost the imperative.
    const r = isLikelyRealCorrection("Show BOTH Opus 4.7 and 4.8 — keep the full Opus lineup even when prices match");
    assert.equal(r.ok, true, "imperative must survive the decimal; not mis-split into 'Show BOTH Opus 4'");
  });

  it("accepts the verbatim Loop-7 leaked soft corrections", async () => {
    const cases = [
      "no that is wrong, stop making the button full width, it should be inline",
      "again you made it full width, i told you it needs to be inline",
      "we can do 1 & 2 but not 3, we need those mcp tools because it is good for humans",
      "No dark backgrounds for new products. Always use light mode default.",
    ];
    for (const c of cases) {
      assert.equal(isLikelyRealCorrection(c).ok, true, `should accept: ${c}`);
    }
  });

  it("REGRESSION PIN: the truncated first sentence alone is rejected — full-text scan is what rescues", async () => {
    // If a future change re-introduces the v2 first-sentence slice, "No, that's
    // wrong" on its own rejects (ack) — proving the 2-sentence accept above is
    // owed to the full-text scan, not to the opener.
    assert.equal(isLikelyRealCorrection("No, that's wrong").ok, false, "the opener alone must reject");
  });

  it("accepts a corrective-fact 'X (not Y)' statement with no imperative verb", () => {
    const r = isLikelyRealCorrection(
      "Product names are novada-search (not novada-mcp) and novada-proxy (not proxy4agent).",
    );
    assert.equal(r.ok, true, "the (not Y) corrective-fact shape carries real intent");
  });
});

describe("capture gate v3 — PRECISION FLOOR: Loop-7 true-noise STILL rejected", () => {
  it("rejects system <task-notification> fragments (starts with '<')", () => {
    const r = isLikelyRealCorrection(
      "<task-notification>\n<task-id>acad5bc60a23ac5ff</task-id>\n<tool-use-id>toolu_0195cmz7w4SuRHt47fiS88SV</tool-use-id>",
    );
    assert.equal(r.ok, false);
    assert.match(r.reason, /system\/tool fragment/);
  });

  it("rejects bare acknowledgments the actionable scan does NOT rescue", async () => {
    for (const ack of ["confirmed and done now", "ok sure thing", "no that's not what I meant", "yeah right"]) {
      assert.equal(isLikelyRealCorrection(ack).ok, false, `ack must stay rejected: ${ack}`);
    }
  });

  it("rejects doc / report / mission / transcript headers (pasted artifacts)", async () => {
    const noise = [
      "AgentRecall Local Test Report — 2026-04-22",
      "# AgentRecall Dreaming Agent\n\nDate: 2026-06-20  Time: 11:01\nYou are the nightly agent.",
      "# Mission: Genome OS — Comprehensive Review + Improvement Plan\n\n## For: Fresh Agent",
      "file:///Users/tongwu/Projects/novada-kr-progress-report-2026-05-08.html#dimensions",
      "⏺ Fair point. The human memory framing was just a useful way to spot the gaps — the actual goal is a memory system that stays clean.",
    ];
    for (const n of noise) {
      assert.equal(isLikelyRealCorrection(n).ok, false, `doc/report header must stay rejected: ${n.slice(0, 40)}`);
    }
  });

  it("does NOT re-admit a long noise blob just because it contains 'always' somewhere", () => {
    // A pasted transcript header that happens to contain a modal word in its
    // body must still be rejected by the hard doc-header gate (runs first).
    const blob =
      "# Status Report — nightly run\n\nThe agent always logs to stdout and the build always passes; this is just a status dump with no behavioral rule for anyone to follow.";
    assert.equal(isLikelyRealCorrection(blob).ok, false, "doc header gate must pre-empt the 'always' marker");
  });
});

describe("capture gate v3 — writeCorrection end-to-end via the full-text gate", () => {
  let testRoot;
  beforeEach(async () => {
    testRoot = path.join(tmpdir(), `ar-gate-v3-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(testRoot, { recursive: true });
    process.env.AGENT_RECALL_ROOT = testRoot;
  });
  afterEach(async () => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("persists a correction whose directive is in the CONTEXT (rule is a truncated title)", async () => {
    // Mirrors the production check.ts path: rule = first-sentence title slice,
    // context = the full correction with the directive in sentence 2.
    const res = await writeCorrection("gate-v3-proj", {
      id: "2026-06-21-ctx-directive",
      date: "2026-06-21",
      severity: "p1",
      project: "gate-v3-proj",
      rule: "No, that's wrong", // truncated title — no directive on its own
      context: "No, that's wrong. Don't use dark backgrounds for new products.",
      tags: [],
    });
    assert.equal(res.written, true, "directive in the full context must be captured");
    assert.equal(readCorrections("gate-v3-proj").length, 1);
  });

  it("still rejects when BOTH rule and context are pure noise", async () => {
    const res = await writeCorrection("gate-v3-proj", {
      id: "2026-06-21-noise",
      date: "2026-06-21",
      severity: "p1",
      project: "gate-v3-proj",
      rule: "ok sure",
      context: "ok sure thing, sounds good to me",
      tags: [],
    });
    assert.equal(res.written, false);
    assert.equal(readCorrections("gate-v3-proj").length, 0);
  });
});
