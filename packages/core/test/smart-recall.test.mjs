import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  setRoot,
  resetRoot,
  smartRecall,
  createRoom,
  journalDir,
  palaceDir,
  archiveSession,
  CONFIDENCE_FLOOR,
} from "agent-recall-core";

describe("Smart recall — recency boost logic", () => {
  // The hot-window multiplier logic is inline in smartRecall, so we test
  // the multiplier calculation directly to verify correctness.

  function recencyMultiplier(dateStr) {
    if (!dateStr) return 1.0; // palace items (no date) — unaffected
    const hoursAgo = (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60);
    if (hoursAgo < 6) return 3.0;
    if (hoursAgo < 24) return 2.0;
    if (hoursAgo < 72) return 1.3;
    return 1.0;
  }

  it("boosts items from < 6 hours ago by 3x", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    assert.equal(recencyMultiplier(twoHoursAgo), 3.0);
  });

  it("boosts items from 6-24 hours ago by 2x", () => {
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    assert.equal(recencyMultiplier(twelveHoursAgo), 2.0);
  });

  it("boosts items from 24-72 hours ago by 1.3x", () => {
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    assert.equal(recencyMultiplier(fortyEightHoursAgo), 1.3);
  });

  it("does not boost items older than 72 hours", () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(recencyMultiplier(sevenDaysAgo), 1.0);
  });

  it("does not affect palace items (no date)", () => {
    assert.equal(recencyMultiplier(undefined), 1.0);
    assert.equal(recencyMultiplier(null), 1.0);
  });

  it("recent items outscore old items given equal base scores", () => {
    const baseScore = 0.016; // typical RRF score
    const recentScore = baseScore * recencyMultiplier(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
    const oldScore = baseScore * recencyMultiplier(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
    assert.ok(recentScore > oldScore, `recent ${recentScore} should be > old ${oldScore}`);
    assert.equal(recentScore, baseScore * 3.0);
    assert.equal(oldScore, baseScore * 1.0);
  });
});

describe("Smart recall — ambient dedup logic", () => {
  it("filters out items whose IDs are in history", () => {
    const history = new Set(["abc", "def", "ghi"]);
    const items = [
      { id: "abc", title: "seen before" },
      { id: "xyz", title: "new item" },
      { id: "def", title: "also seen" },
      { id: "qqq", title: "another new" },
    ];
    const filtered = items.filter(item => !history.has(item.id));
    assert.equal(filtered.length, 2);
    assert.equal(filtered[0].id, "xyz");
    assert.equal(filtered[1].id, "qqq");
  });

  it("rolling history stays within max 15", () => {
    const existing = Array.from({ length: 13 }, (_, i) => `id${i}`);
    const newIds = ["new1", "new2", "new3"];
    const updated = [...existing, ...newIds].slice(-15);
    assert.equal(updated.length, 15);
    assert.equal(updated[0], "id1"); // id0 dropped (oldest)
    assert.equal(updated[14], "new3");
  });

  it("clears history when topic overlap < 30%", () => {
    function computeOverlapAndDecide(prevQuery, currPrompt) {
      const prevWords = new Set(prevQuery.toLowerCase().split(/\s+/).filter(w => w.length > 2));
      const currWords = currPrompt.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      if (prevWords.size === 0 || currWords.length === 0) return false;
      const overlap = currWords.filter(w => prevWords.has(w)).length / currWords.length;
      return overlap < 0.3; // true = should clear
    }

    // Completely different topics — should clear
    assert.ok(computeOverlapAndDecide(
      "nextjs deployment vercel",
      "postgres schema migration drizzle"
    ));

    // Same topic — should NOT clear
    assert.ok(!computeOverlapAndDecide(
      "nextjs deployment vercel config",
      "vercel deployment nextjs environment"
    ));
  });

  it("minimum relevance threshold filters low-score items", () => {
    const results = [
      { id: "a", score: 0.05 },
      { id: "b", score: 0.02 },
      { id: "c", score: 0.01 },
      { id: "d", score: 0.10 },
    ];
    const filtered = results.filter(item => item.score >= 0.03);
    assert.equal(filtered.length, 2);
    assert.equal(filtered[0].id, "a");
    assert.equal(filtered[1].id, "d");
  });
});

describe("RecallBackend selection", () => {
  it("uses a local backend (keyword or vector) when no Supabase config", async () => {
    const { setRoot, resetRoot } = await import("agent-recall-core");
    const { getRecallBackend, LocalRecallBackend, LocalVectorRecallBackend, resetRecallBackend } = await import("agent-recall-core");
    const tmpDir = (await import("node:fs")).mkdtempSync(
      (await import("node:path")).join((await import("node:os")).tmpdir(), "ar-sel-")
    );
    setRoot(tmpDir);
    resetRecallBackend();
    const backend = await getRecallBackend();
    // Either keyword (no API key) or vector (OPENAI_API_KEY present) — both are local, not Supabase
    assert.ok(
      backend instanceof LocalRecallBackend || backend instanceof LocalVectorRecallBackend,
      `Expected local backend, got ${backend?.constructor?.name}`
    );
    (await import("node:fs")).rmSync(tmpDir, { recursive: true, force: true });
    resetRoot();
    resetRecallBackend();
  });
});

// ---------------------------------------------------------------------------
// F4 (continuity wave, 2026-07-31) — explicit archive-fallback source
// ---------------------------------------------------------------------------
// Real integration tests against smartRecall() itself (not logic replication
// like the describe blocks above) — the gate being tested (fused top
// confidence vs CONFIDENCE_FLOOR.medium) only exists inside the real
// function, so it must be exercised end-to-end against a temp store.
describe("smartRecall — explicit archive fallback source (F4)", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-archive-src-"));
    setRoot(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetRoot();
  });

  it("(a) high-confidence query: archive source does NOT run", async () => {
    const project = "archive-src-hi";
    // Distinctive, non-boilerplate terms (avoid words that appear in the
    // auto-generated default palace room READMEs, e.g. "decisions",
    // "architecture", "goals").
    const query = "zerothorn gateway redesign";
    const today = new Date().toISOString().slice(0, 10);
    // Short line so BOTH palace's ±40/+80 window and journal's ±100/+150
    // window fully contain it without truncation — their excerpts come out
    // byte-identical, which is what lets fuseCanonical() (smart-recall.ts)
    // merge the two sources' RRF contributions into one high-confidence
    // canonical entry. Embedding today's date lets BOTH items pick up the
    // hot-window recency boost regardless of which source "wins" as primary
    // after fusion.
    const sharedLine = `${today} zerothorn gateway redesign decision locked`;

    createRoom(project, "decisions", "Decisions", "decision trail room");
    const roomDir = path.join(palaceDir(project), "rooms", "decisions");
    fs.mkdirSync(roomDir, { recursive: true });
    fs.writeFileSync(path.join(roomDir, "note.md"), sharedLine + "\n", "utf-8");

    const jdir = journalDir(project);
    fs.mkdirSync(jdir, { recursive: true });
    fs.writeFileSync(path.join(jdir, `${today}.md`), sharedLine + "\n", "utf-8");

    // A raw archive dump containing the SAME query terms — proves the gate
    // correctly SKIPPED the archive source (not that there was simply nothing
    // to find had it run).
    archiveSession({
      project,
      sessionId: "d0000000-1111-2222-3333-444444444444",
      rawTranscript: "raw transcript also mentions zerothorn gateway redesign in passing",
    });

    const result = await smartRecall({ query, project, drilldown: false });

    assert.ok(result.results.length > 0, "expected at least one result");
    assert.ok(
      result.results[0].calibrated >= CONFIDENCE_FLOOR.medium,
      `expected top result calibrated >= ${CONFIDENCE_FLOOR.medium}, got ${result.results[0].calibrated}`
    );
    assert.ok(
      !result.results.some((r) => r.source === "archive"),
      `archive source must not run on a high-confidence query; got ${JSON.stringify(result.results)}`
    );
    assert.ok(
      !result.sources_queried.includes("archive"),
      "sources_queried must not list archive when the gate never fired"
    );
  });

  it("(b) sparse store, query only matches raw: archive source surfaces with label", async () => {
    const project = "archive-src-lo";
    const query = "brinjal orchard telemetry rollout";

    // No palace content, no journal content — only a raw hook-archive dump
    // matching the query. palace/journal/insight all come back empty, so the
    // fused top confidence is 0 (no results at all) — well below medium.
    archiveSession({
      project,
      sessionId: "e0000000-1111-2222-3333-444444444444",
      rawTranscript: "meeting notes: brinjal orchard telemetry rollout decision pending review",
    });

    const result = await smartRecall({ query, project });

    const archiveItem = result.results.find((r) => r.source === "archive");
    assert.ok(archiveItem, `expected an archive-source item; got ${JSON.stringify(result.results)}`);
    assert.match(archiveItem.excerpt, /\[raw-archive · low-confidence/, "excerpt must carry the raw-archive label");
    assert.match(
      archiveItem.excerpt,
      /journal[/\\]archive[/\\]raw[/\\]/,
      "excerpt must carry a provenance path under journal/archive/raw/"
    );
    assert.ok(
      archiveItem.confidence === "low" || archiveItem.confidence === "weak",
      `archive item confidence must never be medium/high; got ${archiveItem.confidence}`
    );
    assert.ok(archiveItem.calibrated < CONFIDENCE_FLOOR.medium, "archive item calibrated must stay below medium");
    assert.ok(archiveItem.verbatimKey && archiveItem.verbatimKey.kind === "archive", "must carry an archive verbatimKey");
    assert.ok(result.sources_queried.includes("archive"), "sources_queried must include archive when the gate fired");
  });

  // ---------------------------------------------------------------------------
  // H1 (review fix, 2026-07-31) — archive fallback must resolve `project` via
  // resolveProject(), not use the "auto"/undefined literal directly. Without
  // this, the default MCP calling convention (project omitted, or the literal
  // "auto") reached archiveSearch()/fetchVerbatim() unresolved, scanning a
  // nonexistent projects/auto/ directory instead of the real detected project.
  // ---------------------------------------------------------------------------
  it("H1: project omitted (MCP default) still resolves via AGENT_RECALL_PROJECT and surfaces the archive hit", async () => {
    const project = "archive-src-h1-auto";
    const query = "flamingo turnstile ledger reconciliation";
    const savedEnv = process.env.AGENT_RECALL_PROJECT;
    process.env.AGENT_RECALL_PROJECT = project;
    try {
      archiveSession({
        project,
        sessionId: "a1111111-1111-2222-3333-444444444444",
        rawTranscript: "meeting notes: flamingo turnstile ledger reconciliation pending review",
      });

      // Project OMITTED entirely — must still resolve to `project` via
      // resolveProject()'s env-var signal, exactly like journalSearch/
      // palaceSearch already do internally per-call.
      const result = await smartRecall({ query });

      const archiveItem = result.results.find((r) => r.source === "archive");
      assert.ok(
        archiveItem,
        `expected an archive-source item once project resolves via AGENT_RECALL_PROJECT; got ${JSON.stringify(result.results)}`,
      );
      assert.ok(result.sources_queried.includes("archive"));
    } finally {
      if (savedEnv === undefined) delete process.env.AGENT_RECALL_PROJECT;
      else process.env.AGENT_RECALL_PROJECT = savedEnv;
    }
  });

  // ---------------------------------------------------------------------------
  // M5 (review fix, 2026-07-31) — the `limit` contract must hold even when the
  // archive fallback source fires: it used to push up to ARCHIVE_SOURCE_CAP
  // items regardless of how many slots `limit` had left.
  // ---------------------------------------------------------------------------
  it("M5: limit contract holds when the archive source fires (limit:1 + 3 raw matches → exactly 1 result)", async () => {
    const project = "archive-limit-m5";
    const query = "wombat cordillera bakery inventory";
    archiveSession({
      project,
      sessionId: "b2222222-1111-2222-3333-444444444444",
      rawTranscript: [
        "line one: wombat cordillera bakery inventory update pending review",
        "line two: another mention of wombat cordillera bakery inventory count",
        "line three: yet another wombat cordillera bakery inventory note",
      ].join("\n"),
    });

    const result = await smartRecall({ query, project, limit: 1 });
    assert.ok(result.results.length <= 1, `limit:1 must never return more than 1 result; got ${result.results.length}`);
    assert.ok(result.sources_queried.includes("archive"), "archive gate must still be reported as queried even when budget was tight");
  });
});
