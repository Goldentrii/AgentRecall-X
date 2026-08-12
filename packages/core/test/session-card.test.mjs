// packages/core/test/session-card.test.mjs
//
// Continuity wave (2026-07-31), Worker W1 — F3: mechanical session-card
// distillation (packages/core/src/storage/session-card.ts).
//
// The acceptance fixture below is a SYNTHETIC, portable reproduction of the
// real 2026-07-31 "novada mcp 页面设计" incident (see
// reports/2026-07-31-continuity-fixture.md §3, session 8a02c8b2), not a
// literal read of the real archived .md file. Two reasons:
//   1. That file lives outside the repo, under the operator's real
//      ~/.agent-recall store — not something a portable CI-safe test suite
//      should depend on.
//   2. It was captured under the OLD (pre-F1b) buggy truncation, so its own
//      final record is cut off mid-JSON — it cannot even exercise the FIXED
//      tail-preserving read path this wave adds; a fresh, complete fixture
//      is required to prove buildSessionCard() actually surfaces the target
//      content once given un-truncated input (which F1b now provides).
// The synthetic fixture reproduces the same essential shape: hook-injected
// boilerplate mentioning the artifact path as a FALSE LEAD (must not leak
// into `artifacts`), a real Edit tool_use, and a final assistant message
// containing the Linear epic ID and the real artifact-path mention.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { setRoot, resetRoot } from "agent-recall-core";

function line(rec) {
  return JSON.stringify(rec);
}

// Hook-injected boilerplate (folder-lint style) mentioning the artifact path
// as a FALSE LEAD — must never be mistaken for a real artifact/title source.
const BOILERPLATE_HEAD = [
  line({
    type: "attachment",
    attachment: {
      type: "hook_success",
      hookName: "SessionStart:startup",
      content: "[folder-lint] NEW naming violations:\nC1: /Users/tongwu/交付物2_MCP原型_V14.html — loose file in ~ root",
    },
  }),
  line({ type: "ai-title", aiTitle: "MCP page design review and improvements" }),
  line({ type: "user", message: { content: "how much can you recall on our mcp page design?" } }),
].join("\n");

// The real tail: an Edit tool_use (mechanical artifact source) + the final
// assistant message carrying the Linear epic, the artifact-path mention
// (prose, not a tool_use — mirrors the real incident where the path was only
// referenced, never written this session), a decision line, and a next-step
// line.
const FINAL_ASSISTANT_TEXT = [
  "## 我现在完整掌握的(= 已 locked 的 spec,不是重造)",
  "",
  "- `~/交付物2_MCP原型_V14.html` = 早期独立原型(我一开始读的那个),仅参考",
  "",
  "**Epic TOW2-357 + 9 子 issue(今天 10:15 建,label Wutong):**",
  "",
  "3. **待办**(11:44):API key 变更请求已提交、OAuth 仍 pending,你去问团队。",
  "",
  "**一个决定就能往前走:** (a) 到此为止,还是 (b) 继续实现?",
].join("\n");

const REAL_TAIL = [
  line({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Edit",
          input: { file_path: "/Users/tongwu/.claude/projects/-Users-tongwu/memory/MEMORY.md" },
        },
      ],
    },
  }),
  line({ type: "user", message: { content: "sounds good, go ahead" } }),
  line({ type: "assistant", message: { content: [{ type: "text", text: FINAL_ASSISTANT_TEXT }] } }),
].join("\n");

describe("buildSessionCard (F3, continuity wave 2026-07-31)", () => {
  let core;

  beforeEach(async () => {
    core = await import("agent-recall-core");
  });

  it("acceptance: card built from the fixture contains BOTH TOW2-357 and the 交付物2_MCP原型_V14.html artifact mention", () => {
    const card = core.buildSessionCard({
      rawHead: BOILERPLATE_HEAD,
      rawTail: REAL_TAIL,
      meta: {
        sid: "8a02c8b2-d37b-4681-8bf2-bcf0b6b9d37d",
        slug: "novada-mcp",
        slugConfidence: 0.6,
        slugCandidates: [{ slug: "novada-mcp", count: 3 }],
      },
    });

    assert.ok(card.markdown.includes("TOW2-357"), `card must contain TOW2-357:\n${card.markdown}`);
    assert.ok(
      card.markdown.includes("交付物2_MCP原型_V14.html"),
      `card must contain the artifact path:\n${card.markdown}`,
    );
    assert.ok(
      Buffer.byteLength(card.markdown, "utf-8") <= 2000,
      `card must respect the ~2KB byte cap; got ${Buffer.byteLength(card.markdown, "utf-8")} bytes`,
    );
  });

  it("title prefers the transcript's own ai-title summary entry over the first user prompt", () => {
    const card = core.buildSessionCard({
      rawHead: BOILERPLATE_HEAD,
      rawTail: REAL_TAIL,
      meta: { sid: "s1", slug: "novada-mcp", slugConfidence: 0.6, slugCandidates: [] },
    });
    assert.equal(card.title, "MCP page design review and improvements");
  });

  it("falls back to the first real user prompt when no ai-title record exists", () => {
    const headNoTitle = line({ type: "user", message: { content: "let's refactor the checkout flow please" } });
    const card = core.buildSessionCard({
      rawHead: headNoTitle,
      rawTail: "",
      meta: { sid: "s2", slug: "auto", slugConfidence: 0, slugCandidates: [] },
    });
    assert.equal(card.title, "let's refactor the checkout flow please");
  });

  it("artifacts come ONLY from Write/Edit tool_use inputs — the boilerplate-mentioned path never leaks in", () => {
    const card = core.buildSessionCard({
      rawHead: BOILERPLATE_HEAD,
      rawTail: REAL_TAIL,
      meta: { sid: "s3", slug: "novada-mcp", slugConfidence: 0.6, slugCandidates: [] },
    });
    assert.deepEqual(card.artifacts, ["/Users/tongwu/.claude/projects/-Users-tongwu/memory/MEMORY.md"]);
    assert.ok(
      !card.artifacts.includes("/Users/tongwu/交付物2_MCP原型_V14.html"),
      "a path mentioned only in hook boilerplate/prose must never appear in the mechanical artifacts list",
    );
  });

  it("decisions and nextStep are extracted from the final assistant text, each capped", () => {
    const card = core.buildSessionCard({
      rawHead: BOILERPLATE_HEAD,
      rawTail: REAL_TAIL,
      meta: { sid: "s4", slug: "novada-mcp", slugConfidence: 0.6, slugCandidates: [] },
    });
    assert.ok(card.decisions.length >= 1 && card.decisions.length <= 5);
    assert.ok(card.nextStep.length >= 1 && card.nextStep.length <= 3);
    assert.ok(card.decisions.some((d) => /locked|决定/.test(d)));
    assert.ok(card.nextStep.some((n) => /待办/.test(n)));
  });

  it("M9: linearRefs exclude tool_result payloads (cross-project leak vector) but still capture tool_use inputs and prose", () => {
    const tail = [
      line({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "abc",
              content: [{ type: "text", text: "Found unrelated issue ZZZ9-123 in another project" }],
            },
          ],
        },
      }),
      line({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "mcp__linear__save_issue", input: { team: "TongWu", identifier: "TOW2-999" } },
          ],
        },
      }),
      line({ type: "assistant", message: { content: [{ type: "text", text: "Decided on TOW2-500 for this session." }] } }),
    ].join("\n");

    const card = core.buildSessionCard({
      rawHead: "",
      rawTail: tail,
      meta: { sid: "m9-test", slug: "auto", slugConfidence: 0, slugCandidates: [] },
    });

    assert.ok(
      !card.linearRefs.includes("ZZZ9-123"),
      `tool_result content must never leak into linearRefs; got ${JSON.stringify(card.linearRefs)}`,
    );
    assert.ok(card.linearRefs.includes("TOW2-999"), "a real tool_use call's own input must still be captured");
    assert.ok(card.linearRefs.includes("TOW2-500"), "prose mentions in assistant text must still be captured");
  });

  it("linearRefs are deduped", () => {
    const tail = [
      line({ type: "assistant", message: { content: [{ type: "text", text: "TOW2-358 and TOW2-358 again, plus TOW2-359" }] } }),
    ].join("\n");
    const card = core.buildSessionCard({
      rawHead: "",
      rawTail: tail,
      meta: { sid: "s5", slug: "auto", slugConfidence: 0, slugCandidates: [] },
    });
    assert.deepEqual(card.linearRefs, ["TOW2-358", "TOW2-359"]);
  });

  it("frontmatter carries sid/date/slug/slug_confidence/slug_candidates/source", () => {
    const card = core.buildSessionCard({
      rawHead: "",
      rawTail: "",
      meta: {
        sid: "front-1",
        slug: "demo-project",
        slugConfidence: 0.42,
        slugCandidates: [{ slug: "demo-project", count: 4 }],
        date: "2026-07-31",
      },
    });
    assert.match(card.markdown, /^---\n/);
    assert.ok(card.markdown.includes("sid: front-1"));
    assert.ok(card.markdown.includes("date: 2026-07-31"));
    assert.ok(card.markdown.includes("slug: demo-project"));
    assert.ok(card.markdown.includes("slug_confidence: 0.42"));
    assert.ok(card.markdown.includes("source: hook-end"));
  });

  it("M8: byte-truncating a CJK-heavy body never emits a U+FFFD replacement character", () => {
    // Force the body truncation path: pad the final assistant text with a
    // long CJK string so the whole markdown exceeds CARD_BYTE_CAP (2000
    // bytes) and truncateBytes must cut somewhere inside it. A 3-byte-per-
    // char CJK string of ~3000 bytes guarantees the byte cut lands mid-
    // character for MOST cut points (only 1-in-3 byte offsets align to a
    // char boundary).
    const cjkPad = "决".repeat(1000); // 1000 chars, 3000 bytes
    const tail = [
      line({
        type: "assistant",
        message: { content: [{ type: "text", text: `Final notes: ${cjkPad}` }] },
      }),
    ].join("\n");
    const card = core.buildSessionCard({
      rawHead: "",
      rawTail: tail,
      meta: { sid: "m8-card-test", slug: "auto", slugConfidence: 0, slugCandidates: [] },
    });
    assert.ok(Buffer.byteLength(card.markdown, "utf-8") <= 2000, "card must still respect the byte cap");
    assert.ok(!card.markdown.includes("�"), `truncated markdown must not contain a U+FFFD replacement char:\n${card.markdown}`);
  });

  it("H4: 200 synthetic slugCandidates never truncate the frontmatter mid-YAML — body sections still present", () => {
    const manyCandidates = Array.from({ length: 200 }, (_, i) => ({ slug: `candidate-project-name-${i}`, count: 200 - i }));
    const card = core.buildSessionCard({
      rawHead: BOILERPLATE_HEAD,
      rawTail: REAL_TAIL,
      meta: {
        sid: "h4-candidates-test",
        slug: "novada-mcp",
        slugConfidence: 0.1,
        slugCandidates: manyCandidates,
      },
    });

    // Frontmatter must close properly: exactly two "---" delimiter lines.
    const delimiterCount = (card.markdown.match(/^---$/gm) || []).length;
    assert.equal(delimiterCount, 2, `frontmatter must have a closing '---'; markdown:\n${card.markdown}`);
    // Body content must survive the truncation, not just the frontmatter.
    assert.ok(card.markdown.includes(`# ${card.title}`), "title heading must survive");
    assert.ok(card.markdown.includes("TOW2-357"), "Linear ref from the real tail must survive");
    assert.ok(card.markdown.includes("交付物2_MCP原型_V14.html"), "artifact-adjacent content must survive");
  });

  it("never throws on malformed/garbage input — degrades to a minimal valid card", () => {
    assert.doesNotThrow(() => {
      const card = core.buildSessionCard({
        rawHead: undefined,
        rawTail: "{not even json\nnor is this",
        meta: { sid: "bad-1", slug: "auto", slugConfidence: 0, slugCandidates: [] },
      });
      assert.ok(typeof card.markdown === "string" && card.markdown.length > 0);
    });
  });

  it("a session with no real content (all boilerplate) produces an empty-but-valid card, no false artifacts/linearRefs", () => {
    const card = core.buildSessionCard({
      rawHead: BOILERPLATE_HEAD,
      rawTail: "",
      meta: { sid: "s6", slug: "auto", slugConfidence: 0, slugCandidates: [] },
    });
    assert.deepEqual(card.artifacts, []);
    assert.deepEqual(card.linearRefs, []);
  });
});

describe("writeSessionCard (F3)", () => {
  let core;
  let tmpDir;

  beforeEach(async () => {
    core = await import("agent-recall-core");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-session-card-"));
    setRoot(tmpDir);
  });

  afterEach(() => {
    resetRoot();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a normal journal file at projects/<slug>/journal/<date>--card--<sid>.md", () => {
    const card = core.buildSessionCard({
      rawHead: "",
      rawTail: REAL_TAIL,
      meta: { sid: "write-test-1", slug: "demo-app", slugConfidence: 0.5, slugCandidates: [], date: "2026-07-31" },
    });
    const res = core.writeSessionCard(card);
    assert.ok(res.path, "writeSessionCard must return a path");
    assert.ok(res.bytes > 0);
    const expected = path.join(tmpDir, "projects", "demo-app", "journal", "2026-07-31--card--write-test-1.md");
    assert.equal(res.path, expected);
    assert.ok(fs.existsSync(expected));
    assert.equal(fs.readFileSync(expected, "utf-8"), card.markdown);
  });

  it("is idempotent on the session id — a second write is a no-op and never overwrites", () => {
    const card = core.buildSessionCard({
      rawHead: "",
      rawTail: "",
      meta: { sid: "write-test-2", slug: "demo-app", slugConfidence: 0, slugCandidates: [], date: "2026-07-31" },
    });
    const first = core.writeSessionCard(card);
    const firstContent = fs.readFileSync(first.path, "utf-8");

    const differentCard = { ...card, markdown: "DIFFERENT CONTENT" };
    const second = core.writeSessionCard(differentCard);
    assert.equal(second.path, first.path);
    assert.equal(second.bytes, 0);
    assert.equal(fs.readFileSync(second.path, "utf-8"), firstContent);
  });

  it("sanitizes an untrusted sid before path.join (no traversal)", () => {
    const card = core.buildSessionCard({
      rawHead: "",
      rawTail: "",
      meta: { sid: "../../etc/passwd", slug: "demo-app", slugConfidence: 0, slugCandidates: [], date: "2026-07-31" },
    });
    const res = core.writeSessionCard(card);
    if (res.path) {
      const journalDirPath = path.join(tmpDir, "projects", "demo-app", "journal");
      assert.ok(res.path.startsWith(journalDirPath + path.sep));
      assert.ok(!res.path.includes(".."));
    }
    assert.ok(!fs.existsSync(path.join(tmpDir, "etc", "passwd")));
  });

  // -------------------------------------------------------------------
  // F5 depth (2026-08-12, followups wave): both buildSessionCard's and
  // writeSessionCard's catches must record to hook-health.jsonl. These
  // force REAL throws (a malformed field, a directory blocking a file
  // write) rather than mocking.
  // -------------------------------------------------------------------
  it("F5: records 'session-card-build' when a meta field is malformed (slugConfidence not a number) and still returns a valid stub card", () => {
    const card = core.buildSessionCard({
      rawHead: "",
      rawTail: "",
      // slugConfidence.toFixed(3) throws TypeError since it's a string, not a number.
      meta: { sid: "build-fail-1", slug: "demo-app", slugConfidence: "boom", slugCandidates: [], date: "2026-07-31" },
    });
    assert.equal(card.title, "(session card build failed)");
    assert.ok(card.markdown.includes("session card build failed"));

    const jsonlPath = path.join(tmpDir, "hook-health.jsonl");
    assert.ok(fs.existsSync(jsonlPath), "hook-health.jsonl should exist");
    const rows = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => r.hook === "session-card-build"), "expected a session-card-build row");
  });

  it("F5: records 'session-card-write' when the journal dir cannot be created (blocked by a file)", () => {
    const card = core.buildSessionCard({
      rawHead: "",
      rawTail: "",
      meta: { sid: "write-fail-1", slug: "demo-blocked", slugConfidence: 0, slugCandidates: [], date: "2026-07-31" },
    });

    // Block projects/demo-blocked with a plain FILE so ensureDir(journalDir)
    // throws ENOTDIR when it tries to mkdir underneath it.
    fs.mkdirSync(path.join(tmpDir, "projects"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "projects", "demo-blocked"), "blocker");

    const res = core.writeSessionCard(card);
    assert.equal(res.path, "", "writeSessionCard must degrade to {path:'',bytes:0}, never throw");
    assert.equal(res.bytes, 0);

    const jsonlPath = path.join(tmpDir, "hook-health.jsonl");
    assert.ok(fs.existsSync(jsonlPath), "hook-health.jsonl should exist");
    const rows = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => r.hook === "session-card-write"), "expected a session-card-write row");
  });
});
