import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { sanitizeName, byteCap } = await import("../dist/storage/sanitize.js");

describe("sanitizeName (naming-v2 shared sanitizer)", () => {
  it("lowercases input", () => {
    assert.equal(sanitizeName("MySlug"), "myslug");
    assert.equal(sanitizeName("AgentRecall"), "agentrecall");
  });

  it("NFC-normalizes so composed and decomposed accents converge", () => {
    const composed = "café"; // é = U+00E9 (single composed codepoint)
    const decomposed = "café"; // e + combining acute (U+0301)
    assert.equal(sanitizeName(composed), sanitizeName(decomposed));
  });

  it("collapses runs of disallowed characters to a single dash", () => {
    assert.equal(sanitizeName("hello   world"), "hello-world");
    assert.equal(sanitizeName("hello___world"), "hello-world");
    assert.equal(sanitizeName("hello.world!!!"), "hello-world");
  });

  it("never produces a double-dash, even when the input already has one", () => {
    assert.ok(!sanitizeName("already--dashed").includes("--"));
    assert.equal(sanitizeName("already--dashed"), "already-dashed");
    assert.ok(!sanitizeName("a---b----c").includes("--"));
  });

  it("trims leading/trailing dashes", () => {
    assert.equal(sanitizeName("-leading-and-trailing-"), "leading-and-trailing");
    assert.equal(sanitizeName("!!!wrapped!!!"), "wrapped");
  });

  it("falls back to bare 'unnamed' only for EMPTY input", () => {
    assert.equal(sanitizeName(""), "unnamed");
  });

  it("fully-stripped input gets a content-hashed 'unnamed-<hash8>' — distinct inputs never collide", () => {
    // Pre-fix, every fully-stripped input returned bare "unnamed": two distinct
    // same-day CJK-only correction rules computed the SAME filename and the
    // second silently overwrote the first (see cjk-slug-collision.test.mjs).
    const bang = sanitizeName("!!!");
    const dash = sanitizeName("---");
    assert.match(bang, /^unnamed-[0-9a-f]{8}$/);
    assert.match(dash, /^unnamed-[0-9a-f]{8}$/);
    assert.notEqual(bang, dash);
    // Deterministic: the same input always re-slugs to the same name.
    assert.equal(bang, sanitizeName("!!!"));
  });

  it("byte-caps a long ASCII slug at a word boundary when possible", () => {
    const long = "this-is-a-very-long-slug-that-exceeds-the-cap";
    const capped = sanitizeName(long, 20);
    assert.ok(Buffer.byteLength(capped, "utf-8") <= 20);
    assert.ok(!capped.endsWith("-"));
  });
});

describe("byteCap (raw byte-safe truncation helper)", () => {
  it("returns input unchanged when already within budget", () => {
    assert.equal(byteCap("short", 100), "short");
  });

  it("never splits a multi-byte codepoint (CJK)", () => {
    // Each CJK char below is 3 bytes in UTF-8.
    const cjk = "修复灰色页脚问题跨项目命名系统";
    const capped = byteCap(cjk, 10);
    assert.ok(Buffer.byteLength(capped, "utf-8") <= 10, `expected <=10 bytes, got ${Buffer.byteLength(capped, "utf-8")}`);
    // Round-tripping through Buffer must not produce the U+FFFD replacement
    // character — that would indicate a codepoint was cut mid-byte-sequence.
    assert.ok(!capped.includes("�"), `mojibake detected in: ${JSON.stringify(capped)}`);
    // Every character in the result must be one of the original characters
    // (i.e. we truncated at a whole-character boundary).
    for (const ch of capped) {
      assert.ok(cjk.includes(ch), `unexpected character in capped output: ${ch}`);
    }
  });

  it("caps at exactly the requested byte budget or less", () => {
    const cjk = "修复灰色页脚问题跨项目命名系统这是一个更长的字符串";
    for (const cap of [1, 3, 4, 9, 15, 30]) {
      const capped = byteCap(cjk, cap);
      assert.ok(Buffer.byteLength(capped, "utf-8") <= cap, `cap=${cap} got ${Buffer.byteLength(capped, "utf-8")} bytes`);
    }
  });

  it("prefers a dash word-boundary within 8 bytes of the cap for ASCII", () => {
    const input = "abcdefgh-ijklmnop";
    // Cap lands a couple bytes into "ijklmnop" — should prefer cutting at the dash.
    const capped = byteCap(input, 11);
    assert.equal(capped, "abcdefgh");
  });

  it("returns empty string for a non-positive budget", () => {
    assert.equal(byteCap("anything", 0), "");
  });
});
