// packages/core/test/working-memory.test.mjs
//
// v3.4.42 working-memory wave — minutes-level, crash-proof capture tier.
// Covers the fixture-class rules from the design doc §Tests:
//  - CJK prompts (byte caps, no U+FFFD)
//  - two sids appending concurrently → different files, no cross-talk
//  - line-cap boundary (exactly at WM_LINE_CAP)
//  - boilerplate-only prompt → no line appended
//  - unwritable root → wmAppend never throws (hook output unaffected)
//  - wmDelete idempotency, wmList/wmRead round-trip, guessSlugFromWmLines
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { setRoot, resetRoot } from "agent-recall-core";

describe("working-memory (v3.4.42)", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-working-memory-"));
    setRoot(tmpDir);
  });

  afterEach(() => {
    resetRoot();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("wmAppend writes a JSONL line under <AR_ROOT>/working-memory/<sid>.jsonl", async () => {
    const { wmAppend, wmRead } = await import("agent-recall-core");
    wmAppend("sid-basic", { ts: "2026-08-04T10:00:00.000Z", prompt: "help me fix the login bug", cwd: "/Users/tongwu/Projects/demo" });

    const filePath = path.join(tmpDir, "working-memory", "sid-basic.jsonl");
    assert.ok(fs.existsSync(filePath), "working-memory/<sid>.jsonl should exist under AR_ROOT");

    const lines = wmRead("sid-basic");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].prompt, "help me fix the login bug");
    assert.equal(lines[0].cwd, "/Users/tongwu/Projects/demo");
    assert.equal(lines[0].ts, "2026-08-04T10:00:00.000Z");
  });

  it("CJK: a >300-byte CJK prompt is truncated to the byte cap with no U+FFFD replacement char", async () => {
    const { wmAppend, wmRead } = await import("agent-recall-core");
    const cjk = "决".repeat(200); // 200 chars, 600 bytes — well over the 300-byte cap
    wmAppend("sid-cjk", { ts: new Date().toISOString(), prompt: cjk });

    const lines = wmRead("sid-cjk");
    assert.equal(lines.length, 1);
    assert.ok(Buffer.byteLength(lines[0].prompt, "utf-8") <= 300, `prompt must be capped at 300 bytes, got ${Buffer.byteLength(lines[0].prompt, "utf-8")}`);
    assert.ok(!lines[0].prompt.includes("�"), "truncated CJK prompt must not contain a U+FFFD replacement character");
  });

  it("two sids appending concurrently land in different files with no cross-talk", async () => {
    const { wmAppend, wmRead } = await import("agent-recall-core");
    for (let i = 0; i < 5; i++) {
      wmAppend("sid-alpha", { ts: new Date().toISOString(), prompt: `alpha prompt number ${i} about the billing service` });
      wmAppend("sid-beta", { ts: new Date().toISOString(), prompt: `beta prompt number ${i} about the search index` });
    }

    const alphaLines = wmRead("sid-alpha");
    const betaLines = wmRead("sid-beta");
    assert.equal(alphaLines.length, 5);
    assert.equal(betaLines.length, 5);
    assert.ok(alphaLines.every((l) => l.prompt.includes("billing")), "sid-alpha's file must contain ONLY sid-alpha's prompts");
    assert.ok(betaLines.every((l) => l.prompt.includes("search")), "sid-beta's file must contain ONLY sid-beta's prompts");

    const files = fs.readdirSync(path.join(tmpDir, "working-memory")).filter((f) => f.endsWith(".jsonl"));
    assert.deepEqual(files.sort(), ["sid-alpha.jsonl", "sid-beta.jsonl"]);
  });

  it("line-cap boundary: an append at count===WM_LINE_CAP is skipped; the one before it succeeds", async () => {
    const { wmAppend, wmRead, WM_LINE_CAP } = await import("agent-recall-core");
    const dir = path.join(tmpDir, "working-memory");
    fs.mkdirSync(dir, { recursive: true });
    // Pre-seed the sidecar counter at WM_LINE_CAP - 1, with one real existing
    // line, so we don't need WM_LINE_CAP real appends to exercise the boundary.
    fs.writeFileSync(path.join(dir, "sid-cap.jsonl"), JSON.stringify({ ts: "t0", prompt: "seed" }) + "\n", "utf-8");
    fs.writeFileSync(path.join(dir, "sid-cap.jsonl.count"), String(WM_LINE_CAP - 1), "utf-8");

    wmAppend("sid-cap", { ts: "t1", prompt: "the append that reaches the cap" });
    let lines = wmRead("sid-cap");
    assert.equal(lines.length, 2, "append at count===CAP-1 (< CAP) must succeed");
    assert.equal(fs.readFileSync(path.join(dir, "sid-cap.jsonl.count"), "utf-8").trim(), String(WM_LINE_CAP));

    wmAppend("sid-cap", { ts: "t2", prompt: "the append that must be skipped" });
    lines = wmRead("sid-cap");
    assert.equal(lines.length, 2, "append at count===CAP must be skipped — file must not grow past the cap");
    assert.equal(fs.readFileSync(path.join(dir, "sid-cap.jsonl.count"), "utf-8").trim(), String(WM_LINE_CAP), "counter must not increment past the cap");
  });

  it("boilerplate-only prompt → no line appended, no file created", async () => {
    const { wmAppend, wmRead } = await import("agent-recall-core");
    wmAppend("sid-boiler", { ts: new Date().toISOString(), prompt: "<system-reminder>\nsome injected startup text\n</system-reminder>" });

    const filePath = path.join(tmpDir, "working-memory", "sid-boiler.jsonl");
    assert.ok(!fs.existsSync(filePath), "a purely boilerplate prompt must not create a working-memory file at all");
    assert.equal(wmRead("sid-boiler").length, 0);
  });

  it("an empty/whitespace-only prompt is also skipped (not boilerplate, but not real content either)", async () => {
    const { wmAppend, wmRead } = await import("agent-recall-core");
    wmAppend("sid-empty", { ts: new Date().toISOString(), prompt: "   \n  " });
    assert.equal(wmRead("sid-empty").length, 0);
  });

  it("unwritable root: wmAppend never throws even when the root cannot be created", async () => {
    const { wmAppend } = await import("agent-recall-core");
    // Mirror hook-health.test.mjs's trick: point AR_ROOT at a path whose
    // parent is a FILE (not a directory) — mkdirSync for such a path fails.
    const blockerFile = path.join(tmpDir, "blocker");
    fs.writeFileSync(blockerFile, "not a directory", "utf-8");
    setRoot(path.join(blockerFile, "nested", "root"));

    assert.doesNotThrow(() => {
      wmAppend("sid-unwritable", { ts: new Date().toISOString(), prompt: "this should be silently dropped, not crash the hook" });
    });
  });

  it("wmDelete is idempotent — deleting twice, or a sid with no file, never throws", async () => {
    const { wmAppend, wmDelete, wmRead } = await import("agent-recall-core");
    wmAppend("sid-del", { ts: new Date().toISOString(), prompt: "a prompt to be deleted" });
    assert.equal(wmRead("sid-del").length, 1);

    assert.doesNotThrow(() => wmDelete("sid-del"));
    assert.equal(wmRead("sid-del").length, 0, "file should be gone after delete");
    assert.doesNotThrow(() => wmDelete("sid-del")); // second delete — no-op, must not throw
    assert.doesNotThrow(() => wmDelete("sid-never-existed"));
  });

  it("wmList reports sid/mtime/lines for every WM file, and reflects post-delete state", async () => {
    const { wmAppend, wmList, wmDelete } = await import("agent-recall-core");
    wmAppend("sid-list-1", { ts: new Date().toISOString(), prompt: "first session prompt" });
    wmAppend("sid-list-2", { ts: new Date().toISOString(), prompt: "second session prompt" });
    wmAppend("sid-list-2", { ts: new Date().toISOString(), prompt: "second session prompt, turn two" });

    const before = wmList();
    const bySid = new Map(before.map((f) => [f.sid, f]));
    assert.ok(bySid.has("sid-list-1"));
    assert.ok(bySid.has("sid-list-2"));
    assert.equal(bySid.get("sid-list-1").lines, 1);
    assert.equal(bySid.get("sid-list-2").lines, 2);
    assert.ok(bySid.get("sid-list-1").mtimeMs > 0);

    wmDelete("sid-list-1");
    const after = wmList();
    assert.ok(!after.some((f) => f.sid === "sid-list-1"), "deleted sid must not appear in wmList anymore");
    assert.ok(after.some((f) => f.sid === "sid-list-2"));
  });

  it("wmList returns [] when the working-memory directory does not exist yet", async () => {
    const { wmList } = await import("agent-recall-core");
    assert.deepEqual(wmList(), []);
  });

  it("guessSlugFromWmLines picks the majority ~/Projects/<name> cwd across lines", async () => {
    const { guessSlugFromWmLines } = await import("agent-recall-core");
    const lines = [
      { ts: "t0", prompt: "a", cwd: "/Users/tongwu/Projects/novada-mcp" },
      { ts: "t1", prompt: "b", cwd: "/Users/tongwu/Projects/novada-mcp/packages/core" },
      { ts: "t2", prompt: "c", cwd: "/Users/tongwu/Projects/some-other-project" },
    ];
    assert.equal(guessSlugFromWmLines(lines), "novada-mcp");
  });

  it("guessSlugFromWmLines returns null when no line's cwd matches the ~/Projects/<name> pattern", async () => {
    const { guessSlugFromWmLines } = await import("agent-recall-core");
    assert.equal(guessSlugFromWmLines([{ ts: "t0", prompt: "a", cwd: "/tmp/somewhere" }]), null);
    assert.equal(guessSlugFromWmLines([{ ts: "t0", prompt: "a" }]), null);
    assert.equal(guessSlugFromWmLines([]), null);
  });
});
