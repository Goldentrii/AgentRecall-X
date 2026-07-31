// packages/core/test/resurrect.test.mjs
//
// Continuity wave F6 — `ar resurrect` core: read-only cross-slug dead-session
// finder. Builds a SYNTHETIC temp store (per worker precondition — real-store
// acceptance is a later verifier's job, never this suite's) with:
//  - 2+ projects, raw archive files with dated filenames
//  - one session card (journal/<date>--card--<sid>.md)
//  - a recent-sessions.jsonl (F2's documented format only — no W2 import)
// and asserts: cross-slug keyword ranking, card-overrides-raw title/goal,
// artifact/linearRef precision extraction, boilerplate-title exclusion, the
// days-window filter, a future-timestamp clamp (date logic vs TODAY), and
// the empty-store error path (never crash).
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { setRoot, resetRoot } from "agent-recall-core";

function isoDateNDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function isoDateNDaysAhead(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function writeFile(root, relPath, content) {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
  return full;
}

describe("resurrect (F6)", () => {
  let tmpDir;
  const dateA = isoDateNDaysAgo(5); // recent, inside default 14d window
  const dateOld = isoDateNDaysAgo(20); // outside default 14d window
  const dateToday = isoDateNDaysAgo(0);
  const dateFarFuture = isoDateNDaysAhead(100);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-resurrect-"));
    setRoot(tmpDir);

    // ---- Fixture 1: novada-mcp — raw + card, the "real" incident session ----
    writeFile(
      tmpDir,
      `projects/novada-mcp/journal/archive/raw/${dateA}--8a02c8b2-d37b-4681-8bf2-bcf0b6b9d37d.md`,
      [
        "---",
        "project: novada-mcp",
        "sessionId: 8a02c8b2-d37b-4681-8bf2-bcf0b6b9d37d",
        `savedAt: ${dateA}T10:44:34.940Z`,
        "source: hook-archive",
        "---",
        "",
        '{"type":"attachment","text":"SessionStart:startup hook success: folder-lint found 3 stray files in ~ including 交付物2_MCP原型_V13.html — please clean up your home directory before continuing with unrelated work."}',
        '{"type":"user","message":{"content":[{"type":"text","text":"Resume the novada MCP config page review — 页面设计 feedback needs organizing into Linear, focus on the AI setup flow."}]}}',
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/Users/tongwu/mcp_log_create_接口文档.md","content":"placeholder"}}]}}',
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__linear__save_issue","input":{"team":"TongWu","identifier":"TOW2-360"}}]}}',
      ].join("\n")
    );
    writeFile(
      tmpDir,
      `projects/novada-mcp/journal/${dateA}--card--8a02c8b2-d37b-4681-8bf2-bcf0b6b9d37d.md`,
      [
        "---",
        "sid: 8a02c8b2-d37b-4681-8bf2-bcf0b6b9d37d",
        `date: ${dateA}`,
        "slug: novada-mcp",
        "slug_confidence: 0.42",
        "source: hook-end",
        "---",
        "",
        "# Novada MCP config page 页面设计 — feedback organized into TOW2-357",
        "",
        "Owner reviewed prototype V14 (交付物2_MCP原型_V14.html) and dictated 8 feedback",
        "items; assistant organized them into epic TOW2-357 with 9 child issues.",
        "",
        "## Artifacts",
        "- /Users/tongwu/交付物2_MCP原型_V14.html",
        "",
        "## Next",
        "- Next: read novada-web's app/mcp/page.tsx and implement P1 (TOW2-358/359) + P2 (TOW2-360).",
      ].join("\n")
    );

    // ---- Fixture 2: agent-recall-demo — raw only, today, unrelated ----
    writeFile(
      tmpDir,
      `projects/agent-recall-demo/journal/archive/raw/${dateToday}--11111111-1111-1111-1111-111111111111.md`,
      [
        "---",
        "project: agent-recall-demo",
        "sessionId: 11111111-1111-1111-1111-111111111111",
        `savedAt: ${dateToday}T09:00:00.000Z`,
        "source: hook-archive",
        "---",
        "",
        '{"type":"attachment","text":"SessionStart:startup hook success: folder-lint found 3 stray files in ~ — this line must never become a session title even though it is long enough to pass the length filter on its own."}',
        '{"type":"user","message":{"content":[{"type":"text","text":"Let\'s clean up the AgentRecall demo README and ship the v2 release notes."}]}}',
      ].join("\n")
    );

    // ---- Fixture 3: old-project — raw only, outside the default window ----
    writeFile(
      tmpDir,
      `projects/old-project/journal/archive/raw/${dateOld}--22222222-2222-2222-2222-222222222222.md`,
      [
        "---",
        "project: old-project",
        "sessionId: 22222222-2222-2222-2222-222222222222",
        `savedAt: ${dateOld}T09:00:00.000Z`,
        "source: hook-archive",
        "---",
        "",
        '{"type":"user","message":{"content":[{"type":"text","text":"Old unrelated conversation about widget styling from three weeks ago."}]}}',
      ].join("\n")
    );

    // ---- Fixture 4: recent-sessions.jsonl only — a "dead" session with no raw/card ----
    writeFile(
      tmpDir,
      "recent-sessions.jsonl",
      JSON.stringify({
        ts: new Date().toISOString(),
        sid: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        slug: "quick-fix",
        title: "Quick hotfix landed",
        next_step: "Verify the patch in prod tomorrow",
      }) + "\n"
    );

    // ---- Fixture 5: stale-project — card-only, declares a corrected slug ----
    writeFile(
      tmpDir,
      `projects/stale-project/journal/${dateA}--card--dddddddd-dddd-dddd-dddd-dddddddddddd.md`,
      [
        "---",
        "sid: dddddddd-dddd-dddd-dddd-dddddddddddd",
        `date: ${dateA}`,
        "slug: corrected-slug-name",
        "slug_confidence: 0.1",
        "source: hook-end",
        "---",
        "",
        "# Misfiled session, later re-labeled",
        "",
        "This card physically lives under stale-project but declares the corrected slug in its frontmatter.",
      ].join("\n")
    );

    // ---- Fixture 6: clock-skew-test — raw dated 100 days in the future ----
    writeFile(
      tmpDir,
      `projects/clock-skew-test/journal/archive/raw/${dateFarFuture}--cs-future.md`,
      [
        "---",
        "project: clock-skew-test",
        "sessionId: cs-future",
        `savedAt: ${dateFarFuture}T09:00:00.000Z`,
        "source: hook-archive",
        "---",
        "",
        '{"type":"user","message":{"content":[{"type":"text","text":"Clock skew test fixture body content for scoring only."}]}}',
      ].join("\n")
    );
  });

  afterEach(() => {
    resetRoot();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("empty store: resurrect() returns [] and never crashes", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ar-resurrect-empty-"));
    setRoot(empty);
    try {
      const { resurrect } = await import("agent-recall-core");
      let result;
      assert.doesNotThrow(() => {
        result = resurrect();
      });
      assert.deepEqual(result, []);
    } finally {
      resetRoot();
      setRoot(tmpDir);
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("no query: pure recency ordering, cross-slug", async () => {
    const { resurrect } = await import("agent-recall-core");
    const briefs = resurrect({ days: 30 }); // 30d so the old fixture is included too
    const sids = briefs.map((b) => b.sid);
    // The recent-sessions-only session (ts=now) must rank at/near the very top.
    assert.equal(sids[0], "cccccccc-cccc-cccc-cccc-cccccccccccc");
    // Every project must be represented — this is a CROSS-slug scan, not one project.
    const slugs = new Set(briefs.map((b) => b.slug));
    assert.ok(slugs.has("novada-mcp"));
    assert.ok(slugs.has("agent-recall-demo"));
    assert.ok(slugs.has("quick-fix"));
    assert.ok(slugs.has("old-project"), "days:30 must include the 20-day-old fixture");
  });

  it("days window: default (14d) excludes the 20-day-old fixture; days:30 includes it", async () => {
    const { resurrect } = await import("agent-recall-core");
    const defaultBriefs = resurrect();
    assert.ok(
      !defaultBriefs.some((b) => b.slug === "old-project"),
      "default days window must exclude a 20-day-old session"
    );
    const wideBriefs = resurrect({ days: 30 });
    assert.ok(
      wideBriefs.some((b) => b.slug === "old-project"),
      "days:30 must include the 20-day-old session"
    );
  });

  it("keyword query 'TOW2-357' ranks the matching cross-slug session #1", async () => {
    const { resurrect } = await import("agent-recall-core");
    const briefs = resurrect({ query: "TOW2-357", days: 30 });
    assert.ok(briefs.length > 0);
    assert.equal(briefs[0].slug, "novada-mcp");
    assert.equal(briefs[0].sid, "8a02c8b2-d37b-4681-8bf2-bcf0b6b9d37d");
    assert.ok(briefs[0].linearRefs.includes("TOW2-357"), JSON.stringify(briefs[0].linearRefs));
  });

  it("keyword query 'MCP原型 页面设计' (CJK) ranks the same session #1", async () => {
    const { resurrect } = await import("agent-recall-core");
    const briefs = resurrect({ query: "MCP原型 页面设计", days: 30 });
    assert.ok(briefs.length > 0);
    assert.equal(briefs[0].sid, "8a02c8b2-d37b-4681-8bf2-bcf0b6b9d37d");
  });

  it("card overrides raw for title/goal, but artifacts+linearRefs are unioned across both sources", async () => {
    const { resurrect } = await import("agent-recall-core");
    const briefs = resurrect({ query: "TOW2-357", days: 30 });
    const brief = briefs[0];

    // Title must come from the CARD's clean heading, never the raw hook-boilerplate line.
    assert.ok(brief.title.includes("Novada MCP config page"), brief.title);
    assert.ok(!brief.title.toLowerCase().includes("folder-lint"), brief.title);

    // Artifacts: the card's V14 path AND the raw file's 接口文档 path must both be present.
    assert.ok(brief.artifacts.some((a) => a.includes("V14.html")), JSON.stringify(brief.artifacts));
    assert.ok(brief.artifacts.some((a) => a.includes("接口文档.md")), JSON.stringify(brief.artifacts));

    // Linear refs: TOW2-357/358 (from the card) and TOW2-360 (from raw only) all present.
    assert.ok(brief.linearRefs.includes("TOW2-357"));
    assert.ok(brief.linearRefs.includes("TOW2-358"));
    assert.ok(brief.linearRefs.includes("TOW2-360"));

    // Next steps mechanically pulled from the card.
    assert.ok(brief.nextSteps.some((s) => /next/i.test(s)), JSON.stringify(brief.nextSteps));

    // Provenance must cite BOTH the raw file and the card file.
    assert.ok(brief.provenance.some((p) => p.includes(path.join("archive", "raw"))), JSON.stringify(brief.provenance));
    assert.ok(brief.provenance.some((p) => p.includes("--card--")), JSON.stringify(brief.provenance));
  });

  it("raw-only session (no card) still excludes hook boilerplate from its title", async () => {
    const { resurrect } = await import("agent-recall-core");
    const briefs = resurrect({ days: 30 });
    const demo = briefs.find((b) => b.slug === "agent-recall-demo");
    assert.ok(demo, "agent-recall-demo session must be present");
    assert.ok(!demo.title.toLowerCase().includes("folder-lint"), demo.title);
    assert.ok(demo.title.includes("AgentRecall demo README"), demo.title);
  });

  it("recent-sessions-only entry (no raw/card at all) still produces a valid brief", async () => {
    const { resurrect } = await import("agent-recall-core");
    const briefs = resurrect({ days: 30 });
    const quickFix = briefs.find((b) => b.sid === "cccccccc-cccc-cccc-cccc-cccccccccccc");
    assert.ok(quickFix, "a recent-sessions-only session must still appear");
    assert.equal(quickFix.slug, "quick-fix");
    assert.equal(quickFix.title, "Quick hotfix landed");
    assert.ok(quickFix.nextSteps.includes("Verify the patch in prod tomorrow"));
    assert.ok(quickFix.provenance.some((p) => p.endsWith("recent-sessions.jsonl")));
  });

  it("a card's frontmatter `slug` overrides the directory it physically lives under", async () => {
    const { resurrect } = await import("agent-recall-core");
    const briefs = resurrect({ days: 30 });
    const relabeled = briefs.find((b) => b.sid === "dddddddd-dddd-dddd-dddd-dddddddddddd");
    assert.ok(relabeled, "the re-labeled card session must appear");
    assert.equal(relabeled.slug, "corrected-slug-name", "must use the card's declared slug, not the on-disk directory");
  });

  it("date logic vs TODAY: a far-future timestamp is clamped, never outranking a genuinely current session", async () => {
    const { resurrect } = await import("agent-recall-core");
    const briefs = resurrect({ days: 30 });
    const farFuture = briefs.find((b) => b.sid === "cs-future");
    const quickFix = briefs.find((b) => b.sid === "cccccccc-cccc-cccc-cccc-cccccccccccc");
    assert.ok(farFuture, "the far-future fixture must still appear (never dropped/crashed)");
    assert.ok(quickFix);
    assert.ok(farFuture.score <= 1 + 1e-6, `far-future score must be clamped to <=1, got ${farFuture.score}`);
    assert.ok(
      farFuture.score <= quickFix.score + 1e-6,
      `a future timestamp (${farFuture.score}) must not outrank a genuinely current session (${quickFix.score})`
    );
  });

  it("renderResurrectMarkdown renders a non-empty brief list and a 'nothing found' message for []", async () => {
    const { resurrect, renderResurrectMarkdown } = await import("agent-recall-core");
    const briefs = resurrect({ query: "TOW2-357", days: 30 });
    const md = renderResurrectMarkdown(briefs);
    assert.ok(md.includes("TOW2-357") || md.includes("Novada MCP"));
    assert.ok(md.includes("provenance"));

    const emptyMd = renderResurrectMarkdown([]);
    assert.ok(emptyMd.toLowerCase().includes("no dead sessions"));
  });
});
