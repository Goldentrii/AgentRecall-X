// packages/cli/test/transcript-reader.test.mjs
//
// Continuity wave (2026-07-31), Worker W1 — F1 (unified claim-not-generate
// namer) + F1b (RAW_TAIL_CAP tail-bias fix), both in transcript-reader.ts.
//
// F1b regression context: reports/2026-07-31-continuity-fixture.md §1
// documented, against the real 8a02c8b2 incident file, that the OLD
// head(60K)+tail(25K) concat then `.slice(0, 80000)` truncation cut the
// TAIL of the transcript (decisions/next-steps) while preserving stale
// head-side hook boilerplate — the worst possible policy for a session
// card. These tests use synthetic (portable, deterministic) fixtures rather
// than the real machine-specific incident file, which (a) is outside the
// repo and not safe to depend on in CI, and (b) is itself a snapshot
// produced by the OLD buggy code, so its own final record is truncated
// mid-JSON and cannot exercise the FIXED tail-preservation path.
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-transcript-reader-test-" + Date.now());
const FAKE_HOME = path.join(os.tmpdir(), "ar-transcript-reader-home-" + Date.now());

describe("transcript-reader (F1 + F1b, continuity wave 2026-07-31)", () => {
  let reader;
  let core;

  before(async () => {
    fs.mkdirSync(FAKE_HOME, { recursive: true });
    reader = await import("../dist/utils/transcript-reader.js");
    core = await import("agent-recall-core");
  });

  after(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.rmSync(FAKE_HOME, { recursive: true, force: true });
  });

  describe("F1b — RAW_TAIL_CAP must preserve the TAIL, not the head", () => {
    let tDir;

    beforeEach(() => {
      tDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-f1b-"));
    });

    afterEach(() => {
      fs.rmSync(tDir, { recursive: true, force: true });
    });

    it("a marker at the TRUE end of a >80K-char transcript survives in rawTail", () => {
      const sid = "f1b00001-0000-0000-0000-000000000001";
      const transcriptPath = path.join(tDir, sid + ".jsonl");

      // A big head-side filler (boilerplate-shaped, but content doesn't matter
      // for this test) followed by a marker planted in the MIDDLE (should be
      // sampled OUT under the new small-head-sample policy) and a final
      // record whose text sits at the absolute end of the file. Sized with a
      // large safety margin on both sides of the new 20K-head/60K-tail split:
      // headFiller (100K) puts the middle marker way past the 20K head
      // sample, and midFiller (100K) puts it way before the last-60K tail
      // window (total size ~200K, so the tail window starts at ~140K —
      // the middle marker at ~100K sits safely in the dropped gap).
      const headFiller = "X".repeat(100_000);
      const middleMarker = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "MIDDLE_ZONE_MARKER_SHOULD_BE_DROPPED" }] },
      });
      const midFiller = "Y".repeat(100_000);
      const finalRecord = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "TRUE_END_MARKER_DECISION_TOW2-999" }] },
      });

      const body = [headFiller, middleMarker, midFiller, finalRecord].join("\n");
      fs.writeFileSync(transcriptPath, body);
      assert.ok(fs.statSync(transcriptPath).size > 80_000, "fixture must exceed the 80K cap to exercise truncation");

      const result = reader.readTranscriptByPath(transcriptPath);
      assert.ok(result, "readTranscriptByPath must parse the fixture");
      assert.ok(
        result.rawTail.includes("TRUE_END_MARKER_DECISION_TOW2-999"),
        "the true end-of-file content (where decisions/next-steps live) must survive the cap",
      );
      assert.ok(
        !result.rawTail.includes("MIDDLE_ZONE_MARKER_SHOULD_BE_DROPPED"),
        "middle-of-file content outside both the (smaller) head sample and the (larger) tail preserve window should be dropped, not the true end",
      );
      assert.ok(result.rawTail.length <= 80_000, "rawTail must still respect the ~80K overall cap");
    });

    it("a whole file smaller than the head sample is returned verbatim, no dedup artifacts", () => {
      const sid = "f1b00002-0000-0000-0000-000000000002";
      const transcriptPath = path.join(tDir, sid + ".jsonl");
      const body = JSON.stringify({ type: "user", message: { content: "tiny session" } });
      fs.writeFileSync(transcriptPath, body);

      const result = reader.readTranscriptByPath(transcriptPath);
      assert.ok(result);
      assert.equal(result.rawTail, body, "small files must round-trip verbatim");
    });

    it("returns null for a missing path (never throws)", () => {
      assert.equal(reader.readTranscriptByPath(path.join(tDir, "does-not-exist.jsonl")), null);
    });

    it("H3: a CJK-heavy transcript whose BYTE size fits the head sample is not duplicated in rawTail", () => {
      // The old check compared `stat.size` (BYTES) against `archiveHead.length`
      // (a JS string's length — UTF-16 CODE UNITS). For CJK content (3 bytes
      // per char in UTF-8, 1 UTF-16 code unit per char for BMP ideographs),
      // the string length is roughly 1/3 the byte size — so a file that fits
      // ENTIRELY inside the head sample still failed `stat.size <=
      // archiveHead.length` and fell through to the `else` branch, which
      // re-reads a full tail sample and concatenates it onto the SAME
      // already-complete head, duplicating the whole file's content.
      const sid = "h3-cjk-0001";
      const marker = "决定完成会话摘要审查任务并记录后续步骤"; // 19 CJK chars, 3 bytes each = 57 bytes
      const bigText = marker.repeat(260); // ~4940 chars, ~14820 bytes — comfortably under RAW_TAIL_HEAD_SAMPLE (20_000)
      const record = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: bigText }] } });
      const transcriptPath = path.join(tDir, sid + ".jsonl");
      fs.writeFileSync(transcriptPath, record, "utf-8");

      const byteSize = fs.statSync(transcriptPath).size;
      assert.ok(
        byteSize > 0 && byteSize < 20_000,
        `fixture must be under RAW_TAIL_HEAD_SAMPLE to exercise the whole-file-fits branch; got ${byteSize} bytes`,
      );

      const result = reader.readTranscriptByPath(transcriptPath);
      assert.ok(result);
      const count = result.rawTail.split(bigText).length - 1;
      assert.equal(count, 1, `rawTail must contain the CJK content exactly once, got ${count} occurrences`);
    });

    it("M8: readHeadTail's head window never emits a U+FFFD when it cuts mid-CJK-character", () => {
      const sid = "m8-boundary-0001";
      const transcriptPath = path.join(tDir, sid + ".jsonl");

      // Place a 3-byte CJK char ("中" = E4 B8 AD) straddling the DEFAULT head
      // window boundary (60_000 bytes): bytes at indices 59998,59999,60000 —
      // so the [0,60000) head window captures only the first TWO bytes of
      // the sequence (E4 B8), landing mid-character.
      const filler = Buffer.alloc(59998, "A"); // ASCII filler, indices 0..59997
      const cjkBytes = Buffer.from("中", "utf-8");
      assert.equal(cjkBytes.length, 3, "sanity: 中 must be a 3-byte UTF-8 sequence");
      const trailer = Buffer.from("\nTAIL_MARKER_AFTER_BOUNDARY\n" + "B".repeat(30_000), "utf-8");
      const body = Buffer.concat([filler, cjkBytes, trailer]);
      fs.writeFileSync(transcriptPath, body);

      const result = reader.readTranscriptByPath(transcriptPath);
      assert.ok(result, "must parse the fixture");
      assert.ok(
        !result.headText.includes("�"),
        `headText must not contain a U+FFFD replacement char from a mid-character cut; tail of headText: ${JSON.stringify(result.headText.slice(-20))}`,
      );
    });
  });

  describe("F1 — resolveSessionProject (claim-not-generate)", () => {
    beforeEach(() => {
      fs.rmSync(TEST_ROOT, { recursive: true, force: true });
      fs.mkdirSync(TEST_ROOT, { recursive: true });
      core.setRoot(TEST_ROOT);
    });

    afterEach(() => {
      core.resetRoot();
    });

    function line(rec) {
      return JSON.stringify(rec);
    }

    it("EXCLUDES hook-injected boilerplate (attachment records) from the content signal", () => {
      // A folder-lint-style attachment mentions a project path 5x — must NOT
      // be countable, matching the exact false-lead mechanism from the
      // fixture report (e577afbf/4c113109 false leads).
      const boilerplate = line({
        type: "attachment",
        attachment: { type: "hook_success", hookName: "SessionStart:startup" },
        content:
          "/Users/tongwu/Projects/false-lead/a /Users/tongwu/Projects/false-lead/b /Users/tongwu/Projects/false-lead/c",
      });
      const head = boilerplate;
      const tail = line({ type: "user", message: { content: "just chatting, nothing project-specific here really" } });

      const result = reader.resolveSessionProject(head, tail);
      assert.ok(
        !result.candidates.some((c) => c.slug === "false-lead"),
        `boilerplate-only mentions must not produce a candidate; got ${JSON.stringify(result.candidates)}`,
      );
      assert.equal(result.slug, "auto");
      assert.equal(result.confidence, 0);
    });

    it("Signal 1 (cwd) + claim-not-generate: prefers an EXISTING on-disk slug over a noisier non-existing one", () => {
      fs.mkdirSync(path.join(TEST_ROOT, "projects", "real-project"), { recursive: true });

      const tailLines = [
        // cwd signal: 3 records under ~/Projects/real-project
        line({ type: "assistant", cwd: "/Users/tongwu/Projects/real-project/sub", message: { content: [{ type: "text", text: "ok" }] } }),
        line({ type: "assistant", cwd: "/Users/tongwu/Projects/real-project/sub", message: { content: [{ type: "text", text: "ok" }] } }),
        // A higher-count CONTENT mention of a slug that has no on-disk project dir.
        line({ type: "user", message: { content: "let's talk about /Users/tongwu/Projects/noisy-nonexistent-project some more, /Users/tongwu/Projects/noisy-nonexistent-project is great, /Users/tongwu/Projects/noisy-nonexistent-project again" } }),
      ].join("\n");

      const result = reader.resolveSessionProject("", tailLines);
      assert.equal(result.slug, "real-project", `must claim the existing slug; got ${JSON.stringify(result)}`);
      assert.ok(result.confidence > 0);
    });

    it("new-slug gate: mints a brand-new slug only when content count >= 3 AND ~/Projects/<name> exists", () => {
      const projectsHome = path.join(FAKE_HOME, "Projects", "brand-new-real");
      fs.mkdirSync(projectsHome, { recursive: true });
      const originalHome = process.env.HOME;
      process.env.HOME = FAKE_HOME;
      try {
        const tailLines = [
          line({ type: "user", message: { content: "working in /Users/tongwu/Projects/brand-new-real today" } }),
          line({ type: "assistant", message: { content: [{ type: "text", text: "sure, /Users/tongwu/Projects/brand-new-real looks good" }] } }),
          line({ type: "user", message: { content: "ship it, /Users/tongwu/Projects/brand-new-real is done" } }),
        ].join("\n");

        const result = reader.resolveSessionProject("", tailLines);
        assert.equal(result.slug, "brand-new-real", `must mint the corroborated new slug; got ${JSON.stringify(result)}`);
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("new-slug gate REJECTS a candidate with only 1-2 mentions (no ~/Projects dir either)", () => {
      const originalHome = process.env.HOME;
      process.env.HOME = FAKE_HOME; // brand-new-real dir from the previous test may or may not exist; use a fresh name
      try {
        const tailLines = [
          line({ type: "user", message: { content: "quick one-off mention of /Users/tongwu/Projects/weak-signal-project" } }),
        ].join("\n");
        const result = reader.resolveSessionProject("", tailLines);
        assert.equal(result.slug, "auto", `a single weak hit must never mint a new project; got ${JSON.stringify(result)}`);
        assert.equal(result.confidence, 0);
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("never selects a deny-listed/invalid slug even when it exists on disk", () => {
      // "mcp" is on isValidProjectSlug's deny-list (packages/core/src/storage/project.ts).
      fs.mkdirSync(path.join(TEST_ROOT, "projects", "mcp"), { recursive: true });
      const tailLines = [
        line({ type: "assistant", cwd: "/Users/tongwu/Projects/mcp/sub", message: { content: [{ type: "text", text: "ok" }] } }),
      ].join("\n");
      const result = reader.resolveSessionProject("", tailLines);
      assert.notEqual(result.slug, "mcp", "a deny-listed slug must never be selected, even if it exists on disk");
    });
  });
});
