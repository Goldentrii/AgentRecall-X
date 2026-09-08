// packages/core/test/recall-backend.test.mjs
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("RecallBackend interface", () => {
  it("LocalRecallBackend is always available", async () => {
    const { LocalRecallBackend } = await import("agent-recall-core");
    const backend = new LocalRecallBackend();
    assert.equal(backend.available(), true);
  });

  it("getRecallBackend returns a local backend when no Supabase config", async () => {
    const { setRoot, resetRoot } = await import("agent-recall-core");
    const { getRecallBackend, LocalRecallBackend, LocalVectorRecallBackend, resetRecallBackend } = await import("agent-recall-core");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-backend-"));
    setRoot(tmpDir);
    resetRecallBackend();
    const backend = await getRecallBackend();
    // keyword backend (no OPENAI_API_KEY) or vector backend (OPENAI_API_KEY set) — both are local
    assert.ok(
      backend instanceof LocalRecallBackend || backend instanceof LocalVectorRecallBackend,
      `Expected local backend, got ${backend?.constructor?.name}`
    );
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetRoot();
    resetRecallBackend();
  });
});

// ── P0 independent-review FIX 2 (2026-08-30) ────────────────────────────────
// `SupabaseRecallBackend.search()` itself requires a live Supabase client +
// embedding provider — this repo has no dependency-injection seam for
// either, so constructing a live backend here is out of scope (the
// P0-trust-class-closure report already flagged this gap honestly). Instead,
// this exercises `mapSemanticRows`/`mapFtsRows` — the pure row->
// RecallResultItem mappers `search()` itself delegates to (extracted
// specifically for this test, see recall-backend.ts's own header comment) —
// with a HAND-CONSTRUCTED row matching the REAL on-wire shape: `metadata` is
// where `doSync()`'s `parseMemoryFile()` preserves a file's frontmatter
// (`source: working-memory-rescue`) after SPLITTING it out of `body` before
// upload — `body` itself never carries the tag, so a row's rescue-ness is
// only ever visible via `metadata.source`.
describe("P0 review-fix (FIX 2) — mapSemanticRows/mapFtsRows drop a rescue-tagged Supabase row, keep a genuine one", () => {
  function rescueRow(id) {
    return {
      id,
      store: "journal",
      slug: "rescue-slug",
      title: "HIJACKED_SUPABASE_ROW_TITLE",
      body: "HIJACKED_SUPABASE_ROW_BODY — body never carries the source: tag (parseMemoryFile strips it)",
      similarity: 0.99, // deliberately the HIGHEST score — would rank #1 if not dropped
      metadata: { source: "working-memory-rescue" },
    };
  }

  function genuineRow(id) {
    return {
      id,
      store: "journal",
      slug: "genuine-slug",
      title: "GENUINE_SUPABASE_ROW_TITLE",
      body: "GENUINE_SUPABASE_ROW_BODY",
      similarity: 0.5,
      metadata: { source: "hook-end" },
    };
  }

  it("mapSemanticRows: drops a metadata.source:working-memory-rescue row (even at the top similarity score); keeps a genuine row", async () => {
    const { mapSemanticRows } = await import("agent-recall-core");
    const rows = [rescueRow("rescue-1"), genuineRow("genuine-1")];
    const items = mapSemanticRows(rows);
    assert.ok(!items.some((i) => i.id === "rescue-1"), `a rescue-tagged row must never appear in mapSemanticRows' output, at any rank; got ${JSON.stringify(items)}`);
    assert.ok(items.some((i) => i.id === "genuine-1"), "a genuine (non-rescue) row must still pass through");
    const genuine = items.find((i) => i.id === "genuine-1");
    assert.equal(genuine.title, "GENUINE_SUPABASE_ROW_TITLE");
  });

  it("mapFtsRows: drops a metadata.source:working-memory-rescue row; keeps a genuine row", async () => {
    const { mapFtsRows } = await import("agent-recall-core");
    const rows = [rescueRow("rescue-2"), genuineRow("genuine-2")];
    const items = mapFtsRows(rows);
    assert.ok(!items.some((i) => i.id === "rescue-2"), `a rescue-tagged row must never appear in mapFtsRows' output; got ${JSON.stringify(items)}`);
    assert.ok(items.some((i) => i.id === "genuine-2"), "a genuine (non-rescue) row must still pass through");
  });

  it("a row with NO metadata.source at all (legacy pre-rescue-mechanism content) is treated as genuine, not dropped", async () => {
    const { mapSemanticRows } = await import("agent-recall-core");
    const legacyRow = { id: "legacy-1", store: "journal", slug: "legacy-slug", title: "LEGACY_ROW", body: "no metadata.source field", similarity: 0.7, metadata: {} };
    const items = mapSemanticRows([legacyRow]);
    assert.ok(items.some((i) => i.id === "legacy-1"), "a row with no source tag at all must not be dropped — 'absent tag => trusted' is the shipped, intentional default");
  });
});

// ── W4b FIX 1 (2026-09-08) — buildFtsQuery: CJK-aware FTS query segmentation
// on the SupabaseRecallBackend remote path (the owner's REAL smart_recall
// traffic — remote replaces local output when non-empty within 2500ms). See
// recall-backend.ts's own `buildFtsQuery` doc comment for the full bug/fix
// mechanism. The old code was `query.split(/\s+/).join(" & ")` — reproduced
// inline below (never re-imported; it no longer exists in the source) so
// each CJK assertion carries its own RED (old, buggy) vs GREEN (new, fixed)
// proof in one place, without needing a separate git checkout.
describe("W4b FIX 1 — buildFtsQuery (CJK-aware Postgres FTS query segmentation)", () => {
  const oldBuggySplit = (query) => query.split(/\s+/).join(" & ");

  it("RED->GREEN: unspaced CJK query collapses to ONE token under the old split, but segments into multiple &-joined lexemes under the fix", async () => {
    const { buildFtsQuery } = await import("agent-recall-core");
    const query = "分析报告"; // "analysis report" — normal, space-free Chinese phrasing

    // RED: the old `query.split(/\s+/).join(" & ")` finds ZERO whitespace in
    // an unspaced CJK query, so it never segments at all — one opaque
    // 4-character blob token that can only ever match an identical blob in
    // the indexed content (the "hit@5 = 0%" bug class).
    const redResult = oldBuggySplit(query);
    assert.equal(redResult, "分析报告", "old split produces ONE unsegmented token — the bug this fix closes");
    assert.ok(!redResult.includes("&"), "old split never introduces a boolean AND boundary for unspaced CJK");

    // GREEN: the fix routes through the shared CJK-aware tokenizer first,
    // which segments the Han run into word-level tokens BEFORE joining.
    const greenResult = buildFtsQuery(query);
    assert.equal(greenResult, "分析 & 报告", "fixed query-builder segments unspaced CJK into multiple &-joined lexemes");
    assert.ok(greenResult.includes("&"), "fixed output introduces AND boundaries between CJK words");
  });

  it("segments a CJK run that is directly adjacent to ASCII (no whitespace boundary at all) into separate lexemes, Han-first", async () => {
    const { buildFtsQuery } = await import("agent-recall-core");
    // Old split also fails this case: zero whitespace anywhere in the string
    // means `"CJK修复bug".split(/\s+/)` never breaks it up either.
    assert.equal(oldBuggySplit("CJK修复bug"), "CJK修复bug", "old split leaves CJK-adjacent-to-ASCII as one blob too");
    assert.equal(buildFtsQuery("CJK修复bug"), "修复 & cjk & bug", "fix isolates the Han run from the ASCII runs even with zero surrounding whitespace");
  });

  it("ASCII query: produces the same &-joined tsquery as the old split.join for ordinary (>=3 char) words", async () => {
    const { buildFtsQuery } = await import("agent-recall-core");
    const query = "hello world testing";
    assert.equal(buildFtsQuery(query), oldBuggySplit(query), "ASCII queries with only >=3-char words are byte-identical to the old behavior");
    assert.equal(buildFtsQuery(query), "hello & world & testing");
  });

  it("ASCII query of short (<3 char) words: CHARACTERIZED DIFFERENCE from old behavior — documented, not a regression", async () => {
    const { buildFtsQuery } = await import("agent-recall-core");
    const query = "a to be";
    // Old code had NO length floor at all, so it would have produced
    // "a & to & be" (searching on near-meaningless 1-2 char stopword-like
    // tokens). The shared `tokenizeWords` helper's default `minLength: 3` —
    // the SAME floor every other recall/search site in this codebase already
    // uses (journal-search.ts's `queryKeywords` doc comment: "reproduces the
    // original `length > 2` floor exactly for ASCII input") — filters these
    // out. This is the one accepted, documented minor ASCII difference the
    // task brief permits ("minor differences like stemming/minLength are
    // acceptable ONLY if characterized in the report"): short low-signal
    // words no longer force a (mostly useless) FTS AND-clause, and the
    // codebase-wide minLength convention now applies uniformly to this leg.
    assert.equal(oldBuggySplit(query), "a & to & be", "documents what the OLD code would have produced (near-noise tokens)");
    assert.equal(buildFtsQuery(query), null, "new code returns null — all tokens below the shared minLength floor, so the FTS leg is skipped rather than searching on noise");
  });

  it("empty-token guard: punctuation-only query returns null (safe fallback — search() must skip the FTS leg, never hand Postgres a malformed/empty tsquery)", async () => {
    const { buildFtsQuery } = await import("agent-recall-core");
    assert.equal(buildFtsQuery("!! ?? --"), null, "punctuation-only tokens all fall below minLength, so no tokens survive");
  });

  it("empty-token guard: empty-string query returns null", async () => {
    const { buildFtsQuery } = await import("agent-recall-core");
    assert.equal(buildFtsQuery(""), null);
  });

  it("empty-token guard: whitespace-only query returns null", async () => {
    const { buildFtsQuery } = await import("agent-recall-core");
    assert.equal(buildFtsQuery("   "), null);
  });
});
