// Regression tests for the CJK / degenerate-slug filename collision
// (found 2026-07-27 by the filesystem-performance round-table seat,
// reproduced live before fixing):
//
//   Two DISTINCT same-day corrections whose rules sanitize to the same slug
//   were written to the SAME file — the second atomic tmp+rename silently
//   overwrote the first, both callers saw { written: true }, and the first
//   record was permanently gone. Pure-CJK rules made this the COMMON case,
//   not an edge: sanitizeName strips every non-[a-z0-9-] character, so every
//   Chinese-only rule collapsed to the bare "unnamed" fallback.
//
// Two-layer fix under test:
//   1. sanitize.ts — the degenerate fallback is "unnamed-<hash8>" (content
//      hash of the NFC-lowercased input): distinct inputs diverge, identical
//      inputs stay deterministic.
//   2. corrections.ts — brand-new record writes check for an existing file at
//      the computed path and disambiguate with an id-hash suffix inside the
//      slug field (single "-" join: the "--" delimiter grammar is preserved).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ar-cjk-collision-"));
process.env.AGENT_RECALL_ROOT = TEST_ROOT;

const { sanitizeName } = await import("../dist/storage/sanitize.js");
const { writeCorrection, readCorrections, retractCorrection, recordOutcome } = await import("../dist/storage/corrections.js");

after(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function correctionFiles(project) {
  const dir = path.join(TEST_ROOT, "projects", project, "corrections");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
}

describe("sanitizeName — degenerate (CJK-only) inputs no longer collide", () => {
  it("two distinct pure-CJK inputs get distinct names", () => {
    const a = sanitizeName("用户偏好深色主题而不是浅色主题", 48);
    const b = sanitizeName("用户偏好使用简体中文而不是繁体中文", 48);
    assert.notEqual(a, b, "distinct CJK inputs must not share a slug");
    assert.match(a, /^unnamed-[0-9a-f]{8}$/);
    assert.match(b, /^unnamed-[0-9a-f]{8}$/);
  });

  it("the same input is deterministic across calls (rewrite paths stay stable)", () => {
    assert.equal(
      sanitizeName("用户偏好深色主题而不是浅色主题", 48),
      sanitizeName("用户偏好深色主题而不是浅色主题", 48),
    );
  });

  it("hash input is NFC+lowercase normalized — visually-identical variants agree", () => {
    // NFD vs NFC of the same accented string must land on the same hash.
    const nfc = "café主题".normalize("NFC");
    const nfd = "café主题".normalize("NFD");
    assert.equal(sanitizeName(nfc, 48), sanitizeName(nfd, 48));
  });

  it("empty input still returns the bare 'unnamed' fallback", () => {
    assert.equal(sanitizeName(""), "unnamed");
  });

  it("Latin inputs are byte-identical to the pre-fix pipeline", () => {
    assert.equal(sanitizeName("Never push to Main!", 48), "never-push-to-main");
    assert.equal(sanitizeName("hello--world"), "hello-world");
  });

  it("output never contains the '--' field delimiter", () => {
    for (const input of ["中文", "…！？", "a", "--", "中a文"]) {
      assert.ok(!sanitizeName(input, 48).includes("--"), `"--" leaked for input ${input}`);
    }
  });
});

describe("writeCorrection — same-day slug collisions no longer destroy records", () => {
  it("two distinct pure-CJK rules both survive on disk (the original repro)", () => {
    const project = "cjk-two-rules";
    const r1 = writeCorrection(project, {
      id: "c-cjk-aaa",
      rule: "用户偏好深色主题而不是浅色主题",
      context: "你搞错了，用户偏好深色主题而不是浅色主题，永远默认深色",
      severity: "p1",
      date: "2026-07-27",
    });
    const r2 = writeCorrection(project, {
      id: "c-cjk-bbb",
      rule: "用户偏好使用简体中文而不是繁体中文",
      context: "你搞错了，用户偏好使用简体中文而不是繁体中文，永远用简体",
      severity: "p1",
      date: "2026-07-27",
    });
    assert.equal(r1.written, true);
    assert.equal(r2.written, true);
    assert.equal(r2.merged, false, "distinct rules must not merge");

    const files = correctionFiles(project);
    assert.equal(files.length, 2, `expected 2 files, got: ${files.join(", ")}`);
    const rules = readCorrections(project).map((r) => r.rule).sort();
    assert.deepEqual(rules, [
      "用户偏好使用简体中文而不是繁体中文",
      "用户偏好深色主题而不是浅色主题",
    ]);
  });

  it("distinct rules sharing one surviving Latin word both survive (id-hash suffix)", () => {
    const project = "latin-collision";
    // Both rules sanitize to the slug "push" — CJK stripped, one Latin word left.
    const r1 = writeCorrection(project, {
      id: "c-latin-aaa",
      rule: "用户偏好在push之前先运行完整的测试套件",
      context: "你搞错了，用户偏好在push之前先运行完整的测试套件",
      severity: "p1",
      date: "2026-07-27",
    });
    const r2 = writeCorrection(project, {
      id: "c-latin-bbb",
      rule: "用户偏好把push安排在工作日的早晨进行",
      context: "你搞错了，用户偏好把push安排在工作日的早晨进行",
      severity: "p1",
      date: "2026-07-27",
    });
    assert.equal(r1.written, true);
    assert.equal(r2.written, true);
    assert.equal(r2.merged, false);

    const files = correctionFiles(project).sort();
    assert.equal(files.length, 2, `expected 2 files, got: ${files.join(", ")}`);
    // One of the two carries the id-hash disambiguation suffix; grammar intact:
    // exactly one "--" (the date/slug delimiter) per name.
    assert.ok(
      files.some((f) => /-[0-9a-f]{8}\.json$/.test(f)),
      `expected an id-hash-suffixed file among: ${files.join(", ")}`,
    );
    for (const f of files) {
      assert.equal(f.split("--").length, 2, `v2 grammar violated: ${f}`);
    }
    assert.equal(readCorrections(project).length, 2);
  });

  it("a RETRACTED record with a colliding slug survives, and later mutations target the right file", () => {
    const project = "retracted-collision";
    // Record A: pure-CJK rule, gets written then retracted (leaves the file on
    // disk with status retracted — the active-only merge scan skips it).
    const rA = writeCorrection(project, {
      id: "c-retract-aaa",
      rule: "用户偏好深色主题而不是浅色主题",
      context: "你搞错了，用户偏好深色主题而不是浅色主题",
      severity: "p1",
      date: "2026-07-27",
    });
    assert.equal(rA.written, true);
    retractCorrection(project, "c-retract-aaa", "superseded in test");

    // Record B: SAME rule text as retracted A — merge loop skips retracted
    // records, so this lands in the brand-new branch and its computed filename
    // collides with A's file. Pre-fix, B would silently overwrite A's
    // retraction history.
    const rB = writeCorrection(project, {
      id: "c-retract-bbb",
      rule: "用户偏好深色主题而不是浅色主题",
      context: "你又搞错了，用户偏好深色主题而不是浅色主题",
      severity: "p1",
      date: "2026-07-27",
    });
    assert.equal(rB.written, true);
    assert.equal(rB.merged, false, "retracted records must not be merge targets");

    const files = correctionFiles(project);
    assert.equal(files.length, 2, `expected retracted A + new B on disk, got: ${files.join(", ")}`);

    const recs = readCorrections(project);
    const a = recs.find((r) => r.id === "c-retract-aaa");
    const b = recs.find((r) => r.id === "c-retract-bbb");
    assert.ok(a, "retracted record A must still exist");
    assert.equal(a.active, false, "A must still be marked retracted (active:false)");
    assert.ok(a.retracted_at, "A must keep its retraction timestamp");
    assert.ok(b, "new record B must exist");

    // Later mutation on B targets B's own (hash-suffixed) file, not A's.
    recordOutcome({
      correction_id: "c-retract-bbb",
      project,
      kind: "heeded",
      at: new Date().toISOString(),
      evidence: "collision regression test",
    });
    const after = readCorrections(project);
    const a2 = after.find((r) => r.id === "c-retract-aaa");
    const b2 = after.find((r) => r.id === "c-retract-bbb");
    assert.equal(a2.active, false, "outcome on B must not touch A");
    assert.ok((b2.heeded_count ?? 0) >= 1 || b2.last_outcome, "outcome must land on B");
  });

  it("writing the SAME rule twice still merges into one record (dedup preserved)", () => {
    const project = "same-rule-merge";
    const r1 = writeCorrection(project, {
      id: "c-merge-aaa",
      rule: "用户偏好深色主题而不是浅色主题",
      context: "你搞错了，用户偏好深色主题而不是浅色主题",
      severity: "p1",
      date: "2026-07-27",
    });
    const r2 = writeCorrection(project, {
      id: "c-merge-bbb",
      rule: "用户偏好深色主题而不是浅色主题",
      context: "你又搞错了，用户偏好深色主题而不是浅色主题",
      severity: "p1",
      date: "2026-07-27",
    });
    assert.equal(r1.written, true);
    assert.equal(r2.written, true);
    assert.equal(r2.merged, true, "identical rules must keep merging");
    assert.equal(correctionFiles(project).length, 1);
    const recs = readCorrections(project);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].proof_count, 2);
  });
});
