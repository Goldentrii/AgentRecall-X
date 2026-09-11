/**
 * corrections-naming-v2.test.mjs
 *
 * Naming System v2 (Wave 1) — corrections/ store:
 *   - new writes: {date}--{rule-slug}.json (double-dash), rule-slug derived
 *     by stripping a leading interjection/ack phrase before sanitizing.
 *   - REWRITE SAFETY: retractCorrection / recordOutcome must reuse the
 *     EXISTING on-disk filename (whatever delimiter it was written with)
 *     rather than recomputing one via the (now-changed) slugify — otherwise
 *     a v1 (single-dash) record would get silently duplicated into a new
 *     v2-named file on its first retract/outcome event.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import {
  writeCorrection,
  readCorrections,
  retractCorrection,
  recordOutcome,
  stripInterjections,
} from "../dist/storage/corrections.js";

let testRoot;

function correctionsDir(project) {
  return path.join(testRoot, "projects", project, "corrections");
}

function writeRawCorrection(project, filename, record) {
  const dir = correctionsDir(project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(record, null, 2), "utf-8");
}

describe("corrections naming v2", () => {
  beforeEach(async () => {
    testRoot = path.join(tmpdir(), `ar-corrections-naming-v2-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(testRoot, { recursive: true });
    process.env.AGENT_RECALL_ROOT = testRoot;
  });

  afterEach(async () => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("new writes use the v2 double-dash delimiter", async () => {
    await writeCorrection("v2-proj", {
      id: "2026-07-20-never-publish-without-approval",
      date: "2026-07-20",
      severity: "p0",
      project: "v2-proj",
      rule: "Never publish without explicit approval",
      context: "Never publish without explicit approval.",
      tags: [],
    });
    // .json-only: writeCorrection also regenerates _index.md (W2-1, naming-v2
    // spec §4) as an intentional sibling file — not a correction record.
    const files = fs.readdirSync(correctionsDir("v2-proj")).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1);
    assert.ok(files[0].includes("--"), `expected v2 double-dash filename, got ${files[0]}`);
    assert.ok(files[0].startsWith("2026-07-20--"));
  });

  it("strips a leading interjection before slugging the rule", async () => {
    await writeCorrection("v2-proj", {
      id: "x",
      date: "2026-07-20",
      severity: "p0",
      project: "v2-proj",
      rule: "No, that's wrong. Never publish without approval",
      context: "No, that's wrong. Never publish without approval.",
      tags: [],
    });
    // .json-only — see the sibling _index.md note above.
    const files = fs.readdirSync(correctionsDir("v2-proj")).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1);
    // "No, " is stripped by the interjection regex; "that's wrong." is not a
    // listed interjection so it may remain — the spec explicitly allows
    // "or close" for this exact example. What must hold: the leading "no"
    // ack is gone, and the real rule text is present.
    assert.ok(!/^2026-07-20--no-/.test(files[0]), `interjection "no" should be stripped: ${files[0]}`);
    assert.ok(files[0].includes("never-publish-without-approval"), `expected rule text in filename: ${files[0]}`);
  });

  it("readCorrections still reads legacy single-dash fixture files", async () => {
    writeRawCorrection("legacy-proj", "2026-06-01-legacy-rule.json", {
      id: "2026-06-01-legacy-rule",
      date: "2026-06-01",
      severity: "p1",
      project: "legacy-proj",
      rule: "Some legacy rule",
      context: "Some legacy rule.",
      tags: [],
    });
    const all = readCorrections("legacy-proj");
    assert.equal(all.length, 1);
    assert.equal(all[0].id, "2026-06-01-legacy-rule");
  });

  it("retractCorrection REUSES the existing legacy filename (no orphan duplicate)", async () => {
    writeRawCorrection("legacy-proj", "2026-06-01-legacy-rule.json", {
      id: "2026-06-01-legacy-rule",
      date: "2026-06-01",
      severity: "p1",
      project: "legacy-proj",
      rule: "Some legacy rule",
      context: "Some legacy rule.",
      tags: [],
      active: true,
    });

    const result = await retractCorrection("legacy-proj", "2026-06-01-legacy-rule", "test retract");
    assert.equal(result.success, true);

    // .json-only: retractCorrection also regenerates the _index.md sibling
    // (W2-1) — not a correction record, must not be counted here.
    const files = fs.readdirSync(correctionsDir("legacy-proj")).filter((f) => f.endsWith(".json"));
    // Must still be exactly ONE file — the original legacy filename, rewritten
    // in place — not two (original + a freshly-slugified v2 duplicate).
    assert.equal(files.length, 1, `expected 1 file after retract, got ${files.length}: ${files.join(", ")}`);
    assert.equal(files[0], "2026-06-01-legacy-rule.json");

    const raw = JSON.parse(fs.readFileSync(path.join(correctionsDir("legacy-proj"), files[0]), "utf-8"));
    assert.equal(raw.active, false);
  });

  // ── F4 (independent review, 2026-07-20): CJK interjection stripping ───────
  // Tests stripInterjections() DIRECTLY rather than through writeCorrection():
  // the capture-quality gate (isLikelyRealCorrection) requires an English
  // actionable-signal marker and would reject pure-CJK fixtures for reasons
  // unrelated to F4, obscuring the thing under test.
  describe("stripInterjections — full-width CJK punctuation (F4)", () => {
    it("strips a CJK interjection followed by a full-width comma （，）", async () => {
      assert.equal(stripInterjections("你错了，应该用novada-search"), "应该用novada-search");
    });

    it("strips a CJK interjection followed by a full-width period （。）", async () => {
      assert.equal(stripInterjections("不对。用 proxy 版本"), "用 proxy 版本");
    });

    it("does NOT strip English content that merely starts with the interjection word 'no' (no separator follows)", () => {
      // "no" is only an interjection when followed by a separator —
      // "notification" continues with a letter ('t'), so nothing should be
      // stripped: unchanged ASCII behavior (F4's fix only widened the
      // SEPARATOR class, not the interjection-word matching itself).
      const text = "notification emails should always include an unsubscribe link";
      assert.equal(stripInterjections(text), text);
    });

    it("still strips ASCII interjections followed by ASCII punctuation (regression guard)", async () => {
      assert.equal(
        stripInterjections("No, that's wrong. Never publish without approval"),
        "that's wrong. Never publish without approval",
      );
    });

    it("end-to-end: writeCorrection slugs a mixed CJK+actionable correction with the interjection stripped", async () => {
      // Include an English STRONG_IMPERATIVE marker ("always") so the text
      // clears the capture-quality gate, while still exercising the CJK
      // interjection-stripping path end-to-end through the real write path.
      await writeCorrection("v2-cjk-proj", {
        id: "cjk-1",
        date: "2026-07-20",
        severity: "p0",
        project: "v2-cjk-proj",
        rule: "你错了，always use novada-search instead of novada-mcp",
        context: "你错了，always use novada-search instead of novada-mcp.",
        tags: [],
      });
      // .json-only — see the sibling _index.md note above.
      const files = fs.readdirSync(correctionsDir("v2-cjk-proj")).filter((f) => f.endsWith(".json"));
      assert.equal(files.length, 1);
      assert.ok(!files[0].includes("你错了"), `CJK interjection should be stripped from the slug: ${files[0]}`);
      assert.ok(files[0].includes("novada-search"), `rule content should survive: ${files[0]}`);
    });
  });

  it("recordOutcome REUSES the existing legacy filename (no orphan duplicate)", async () => {
    writeRawCorrection("legacy-proj2", "2026-06-01-legacy-rule.json", {
      id: "2026-06-01-legacy-rule",
      date: "2026-06-01",
      severity: "p1",
      project: "legacy-proj2",
      rule: "Some legacy rule",
      context: "Some legacy rule.",
      tags: [],
      active: true,
    });

    await recordOutcome({
      correction_id: "2026-06-01-legacy-rule",
      project: "legacy-proj2",
      kind: "heeded",
      at: new Date().toISOString(),
    });

    const files = fs.readdirSync(correctionsDir("legacy-proj2")).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1, `expected 1 file after recordOutcome, got ${files.length}: ${files.join(", ")}`);
    assert.equal(files[0], "2026-06-01-legacy-rule.json");
  });
});
