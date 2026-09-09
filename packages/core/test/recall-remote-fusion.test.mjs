// packages/core/test/recall-remote-fusion.test.mjs
//
// remote-fusion wave #24 (2026-09-09) — rank-based RRF fusion of remote
// (Supabase) + local smart_recall results behind AGENT_RECALL_RECALL_FUSION,
// plus the client-side slug-derived enrichment (date/file/identity) that
// feeds its dedup identity.
//
// Section A — fuseRemoteWithLocal() as a pure function (fixture
// SmartRecallResultItem[] arrays only, no backend machinery).
// Section B — mapSemanticRows/mapFtsRows slug enrichment (hand-built rows,
// same style as recall-backend.test.mjs's existing P0-review-fix suite).
// Section C — smartRecall() end-to-end, with a REAL SupabaseRecallBackend
// instance (fake-but-syntactically-valid config so construction never
// touches the network) whose own `.search()` method is monkey-patched to
// return fixture data — no live Supabase call is ever made, but the actual
// isRemote-gated routing logic inside smartRecall() is exercised for real.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  setRoot,
  resetRoot,
  smartRecall,
  fuseRemoteWithLocal,
  mapSemanticRows,
  mapFtsRows,
  deriveSlug,
  createRoom,
  journalDir,
  palaceDir,
  getRecallBackend,
  resetRecallBackend,
  resetSupabaseClient,
} from "agent-recall-core";

// ---------------------------------------------------------------------------
// Section A — fuseRemoteWithLocal() pure-function tests
// ---------------------------------------------------------------------------

describe("fuseRemoteWithLocal — (b) local-only hit survives fusion", () => {
  it("a local-only item (no identity overlap with remote) is NOT discarded", () => {
    const localOnly = {
      id: "local-1", source: "journal", title: "LOCAL_ONLY_TITLE",
      excerpt: "local only excerpt, never seen by remote", score: 0.09,
      confidence: "medium", calibrated: 0.5, date: "2026-09-01",
    };
    const remoteOnly = {
      id: "remote-1", source: "palace", title: "REMOTE_ONLY_TITLE",
      excerpt: "remote only excerpt, never seen by local", score: 0.03,
      confidence: "medium", calibrated: 0.45, room: "decisions",
    };
    const fused = fuseRemoteWithLocal([localOnly], [remoteOnly]);
    assert.equal(fused.length, 2, "today's bug: remote-wins-outright would have DISCARDED localOnly entirely");
    assert.ok(fused.some((r) => r.id === "local-1"), "local-only item must survive fusion");
    assert.ok(fused.some((r) => r.id === "remote-1"), "remote-only item must also survive");
    const survivedLocal = fused.find((r) => r.id === "local-1");
    assert.equal(survivedLocal.title, "LOCAL_ONLY_TITLE", "local item's own fields must be untouched");
    assert.equal(survivedLocal.foundInRemote, undefined, "a local-only item was never matched in remote — must not be marked dual-origin");
  });
});

describe("fuseRemoteWithLocal — (c) slug-dup collapses to the LOCAL item, dual-origin marked", () => {
  it("a palace item shared by both origins (same slug-equivalent identity) keeps the LOCAL item's fields, not remote's", () => {
    const localPalace = {
      id: "local-palace-1", source: "palace", title: "LOCAL_RICH_TITLE",
      excerpt: "LOCAL richer excerpt, trust-filtered, match-anchored", score: 0.08,
      confidence: "high", calibrated: 0.75,
      verbatimKey: { kind: "palace", room: "decisions", file: "note" },
      room: "decisions",
    };
    const remoteDup = {
      id: "remote-palace-1", source: "palace", title: "REMOTE_DIFFERENT_TITLE",
      excerpt: "REMOTE completely different excerpt text", score: 0.4,
      confidence: "low", calibrated: 0.2,
      slug: "palace--decisions--note", // deriveSlug()'s own format for the SAME file
      room: "decisions", file: "note",
    };
    const fused = fuseRemoteWithLocal([localPalace], [remoteDup]);
    assert.equal(fused.length, 1, "a genuine slug-identity match must collapse to ONE canonical entry, not two");
    assert.equal(fused[0].id, "local-palace-1", "the LOCAL item must be the survivor");
    assert.equal(fused[0].title, "LOCAL_RICH_TITLE", "survivor keeps the LOCAL title, not remote's");
    assert.equal(fused[0].excerpt, "LOCAL richer excerpt, trust-filtered, match-anchored", "survivor keeps the LOCAL excerpt, not remote's — proves identity was SLUG-based, not excerpt-based (the excerpts deliberately differ)");
    assert.equal(fused[0].calibrated, 0.75, "calibrated must stay the LOCAL item's own (rrf-local-scale) value — never blended with remote's cosine-scale value");
    assert.equal(fused[0].foundInRemote, true, "must be marked dual-origin");
  });

  it("insight items collapse by TITLE (DB-unique on both origins), not by their low-entropy excerpt", () => {
    // Both origins' insight excerpts are deliberately identical-SHAPED but
    // this is the SAME insight (matching title) — must still collapse to
    // the local item via title identity, exactly like the palace case.
    const localInsight = {
      id: "local-insight-1", source: "insight", title: "Class-not-instance: shared parser",
      excerpt: "[important] wave_a, wave_b", score: 0.07, confidence: "high", calibrated: 0.7,
      severity: "important",
    };
    const remoteInsight = {
      id: "remote-insight-1", source: "insight", title: "Class-not-instance: shared parser",
      excerpt: "[important] confirmed 3x", score: 0.02, confidence: "medium", calibrated: 0.3,
      severity: "important",
    };
    const fused = fuseRemoteWithLocal([localInsight], [remoteInsight]);
    assert.equal(fused.length, 1, "same-title insight items across origins must collapse to one");
    assert.equal(fused[0].id, "local-insight-1", "local insight item must survive");
    assert.equal(fused[0].calibrated, 0.7, "must keep the local item's own calibrated value");
    assert.equal(fused[0].foundInRemote, true);
  });

  it("two DIFFERENT insights sharing the SAME low-entropy excerpt shape (severity+count) must NOT falsely collapse", () => {
    const localInsight = {
      id: "local-insight-2", source: "insight", title: "Insight A — completely unrelated topic",
      excerpt: "[important] some_tag, other_tag", score: 0.05, confidence: "medium", calibrated: 0.5,
      severity: "important",
    };
    const remoteInsight = {
      id: "remote-insight-2", source: "insight", title: "Insight B — a totally different unrelated topic",
      // Same excerpt SHAPE (severity="important") as localInsight above —
      // if identity fell back to the raw excerpt/severity, these two
      // UNRELATED insights could false-positive collapse.
      excerpt: "[important] confirmed 1x", score: 0.05, confidence: "medium", calibrated: 0.5,
      severity: "important",
    };
    const fused = fuseRemoteWithLocal([localInsight], [remoteInsight]);
    assert.equal(fused.length, 2, "different-titled insights must never be conflated just because their excerpt/severity shape coincides");
  });

  it("two palace items with DIFFERENT rooms/files never collapse (no false-positive dedup)", () => {
    const localPalace = {
      id: "local-2", source: "palace", title: "A", excerpt: "a excerpt", score: 0.05,
      confidence: "medium", calibrated: 0.5,
      verbatimKey: { kind: "palace", room: "decisions", file: "note" },
    };
    const remoteDifferent = {
      id: "remote-2", source: "palace", title: "B", excerpt: "b excerpt", score: 0.05,
      confidence: "medium", calibrated: 0.5,
      slug: "palace--architecture--other-note",
    };
    const fused = fuseRemoteWithLocal([localPalace], [remoteDifferent]);
    assert.equal(fused.length, 2, "different room/file identities must never be merged");
  });
});

describe("fuseRemoteWithLocal — (d) rank-based merge order (RRF by position, never raw .score)", () => {
  it("an item ranked #1 in its own list outranks an item with a MUCH higher raw .score ranked lower in ITS list", () => {
    // itemA: local rank #1 (contribution 1/61), but a tiny raw .score (0.001)
    // — if raw scores were ever consulted, this item would rank LAST.
    const itemA = {
      id: "item-a", source: "journal", title: "A", excerpt: "rank-1 local, low raw score",
      score: 0.001, confidence: "weak", calibrated: 0.05, date: "2026-01-01",
    };
    // itemB: remote rank #2 (contribution 1/62 — slightly LESS than itemA's
    // 1/61), but a huge raw .score (0.95) — if raw scores were ever
    // consulted, this item would rank FIRST.
    const itemFiller = { id: "filler", source: "palace", title: "filler", excerpt: "filler excerpt, remote rank 1", score: 0.99, confidence: "high", calibrated: 0.9 };
    const itemB = {
      id: "item-b", source: "palace", title: "B", excerpt: "rank-2 remote, huge raw score",
      score: 0.95, confidence: "high", calibrated: 0.95,
    };

    // Sanity precondition: a NAIVE raw-.score sort of {itemA, itemB} alone
    // would rank itemB FIRST (0.95 > 0.001) — the opposite of what
    // rank-based RRF must produce. If this assertion itself ever failed the
    // fixture would no longer be discriminating.
    assert.ok(itemB.score > itemA.score, "fixture precondition: raw-score order would favor itemB");

    const fused = fuseRemoteWithLocal([itemA], [itemFiller, itemB]);
    const rankOfA = fused.findIndex((r) => r.id === "item-a");
    const rankOfB = fused.findIndex((r) => r.id === "item-b");
    assert.ok(rankOfA >= 0 && rankOfB >= 0, "both items must survive fusion");
    assert.ok(
      rankOfA < rankOfB,
      `rank-based RRF must place itemA (local rank #1: 1/61 ≈ ${(1 / 61).toFixed(5)}) ahead of itemB ` +
      `(remote rank #2: 1/62 ≈ ${(1 / 62).toFixed(5)}) despite itemB's much higher raw .score — ` +
      `got order ${JSON.stringify(fused.map((r) => r.id))}`,
    );
    // Exact contribution check — proves the formula, not just the ordering.
    const RRF_K = 60;
    const expectedA = 1 / (RRF_K + 1);
    const expectedB = 1 / (RRF_K + 2);
    assert.ok(Math.abs(fused[rankOfA].score - expectedA) < 1e-9, `itemA's fused score must be the RANK contribution 1/(60+1), got ${fused[rankOfA].score}`);
    assert.ok(Math.abs(fused[rankOfB].score - expectedB) < 1e-9, `itemB's fused score must be the RANK contribution 1/(60+2), got ${fused[rankOfB].score}`);
  });
});

// ---------------------------------------------------------------------------
// Section B — mapSemanticRows/mapFtsRows slug enrichment (INC1)
// ---------------------------------------------------------------------------

describe("mapSemanticRows/mapFtsRows — slug-derived date/file/identity enrichment", () => {
  it("journal row: date is parsed from the REAL deriveSlug() output's embedded YYYY-MM-DD prefix", () => {
    const filePath = path.join("/fake-root", "journal", "2026-09-08-remote-fusion-report.md");
    const slug = deriveSlug(filePath);
    assert.equal(slug, "journal--2026-09-08-remote-fusion-report");
    const row = { id: "j1", store: "journal", slug, title: "T", body: "B", similarity: 0.5, metadata: {} };

    const semantic = mapSemanticRows([row]);
    assert.equal(semantic[0].date, "2026-09-08", "date must be parsed from the slug's embedded filename prefix");
    assert.equal(semantic[0].slug, slug, "raw slug must be exposed verbatim (the fusion identity key)");
    assert.equal(semantic[0].file, undefined, "journal rows must not get a palace `file` field");

    const fts = mapFtsRows([row]);
    assert.equal(fts[0].date, "2026-09-08", "mapFtsRows must get the same enrichment as mapSemanticRows");
    assert.equal(fts[0].slug, slug);
  });

  it("journal row with a CJK filename: date still parses correctly despite the CJK suffix", () => {
    const filePath = path.join("/fake-root", "journal", "2026-09-08-远程融合报告.md");
    const slug = deriveSlug(filePath);
    assert.equal(slug, "journal--2026-09-08-远程融合报告");
    const row = { id: "j2", store: "journal", slug, title: "T", body: "B", similarity: 0.5, metadata: {} };
    const semantic = mapSemanticRows([row]);
    assert.equal(semantic[0].date, "2026-09-08", "the date prefix must parse correctly even with a trailing CJK filename segment");
  });

  it("palace row: file basename is derived by stripping THIS row's own `palace--${room}--` prefix", () => {
    const filePath = path.join("/fake-root", "palace", "rooms", "decisions", "note.md");
    const slug = deriveSlug(filePath);
    assert.equal(slug, "palace--decisions--note");
    const row = { id: "p1", store: "palace", room: "decisions", slug, title: "T", body: "B", similarity: 0.5, metadata: {} };

    const semantic = mapSemanticRows([row]);
    assert.equal(semantic[0].file, "note", "file must be the basename with the room prefix stripped");
    assert.equal(semantic[0].slug, slug);
    assert.equal(semantic[0].date, undefined, "palace rows must not get a journal `date` field");

    const fts = mapFtsRows([row]);
    assert.equal(fts[0].file, "note");
  });

  it("palace row with a CJK room AND CJK file: file basename still derives correctly (no ambiguous generic `--`-split)", () => {
    const filePath = path.join("/fake-root", "palace", "rooms", "决策室", "笔记.md");
    const slug = deriveSlug(filePath);
    assert.equal(slug, "palace--决策室--笔记");
    const row = { id: "p2", store: "palace", room: "决策室", slug, title: "T", body: "B", similarity: 0.5, metadata: {} };
    const semantic = mapSemanticRows([row]);
    assert.equal(semantic[0].file, "笔记", "CJK room/file basenames must derive via the row's own room column, not a fragile generic split");
  });

  it("insight rows are untouched (no slug column exists) — mapSemanticRows/mapFtsRows never see insight rows at all", () => {
    // Insight items are constructed by SupabaseRecallBackend.search() inline
    // from ar_insight_search's own RETURNS TABLE (no body/slug/metadata) —
    // they never flow through mapSemanticRows/mapFtsRows, so there is
    // nothing for this enrichment to touch. Documented here, not exercised,
    // since exercising it would require constructing a live backend.
  });
});

// ---------------------------------------------------------------------------
// Section C — smartRecall() end-to-end, real routing logic, fixture-only
// remote responses (a REAL SupabaseRecallBackend instance, fake-but-valid
// config so construction never touches the network, `.search()` monkey-
// patched so no network call is EVER made).
// ---------------------------------------------------------------------------

let tmpDir;
let savedEnv;

function saveEnv(keys) {
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  return saved;
}
function restoreEnv(saved) {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const ENV_KEYS = [
  "AGENT_RECALL_SUPABASE_URL",
  "AGENT_RECALL_SUPABASE_KEY",
  "AGENT_RECALL_EMBEDDING_KEY",
  "AGENT_RECALL_RECALL_FUSION",
  "AGENT_RECALL_RECALL_BUDGET_MS",
];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-fusion-e2e-"));
  setRoot(tmpDir);
  savedEnv = saveEnv(ENV_KEYS);
});

afterEach(() => {
  resetRecallBackend();
  resetSupabaseClient();
  restoreEnv(savedEnv);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  resetRoot();
});

/**
 * Materialize a REAL SupabaseRecallBackend (fake-but-syntactically-valid
 * config — @supabase/supabase-js's createClient() does not make any network
 * call at construction time, and OpenAIEmbedding's constructor only stores
 * the key) and monkey-patch its OWN `.search()` instance method so
 * smartRecall()'s real isRemote-gated routing runs for real, with ZERO
 * network I/O — `search` is never called through the patched instance.
 */
async function installMockedRemoteBackend(searchImpl) {
  process.env.AGENT_RECALL_SUPABASE_URL = "https://fixture.invalid.supabase.co";
  process.env.AGENT_RECALL_SUPABASE_KEY = "fixture-anon-key";
  process.env.AGENT_RECALL_EMBEDDING_KEY = "fixture-embed-key";
  resetRecallBackend();
  resetSupabaseClient();
  const backend = await getRecallBackend();
  assert.equal(backend.constructor.name, "SupabaseRecallBackend", "test setup must materialize a real SupabaseRecallBackend instance (fake config) for isRemote===true routing");
  backend.search = searchImpl;
  return backend;
}

describe("smartRecall — end-to-end (a) flag OFF: byte-identical to pre-wave", () => {
  it("remote-answering fixture: results === remoteResults verbatim (today's exact ternary), no recall_path", async () => {
    const project = "fusion-e2e-remote-wins";
    const remoteFixture = [
      { id: "r1", source: "palace", title: "REMOTE_A", excerpt: "remote excerpt a", score: 0.5, confidence: "high", calibrated: 0.8 },
      { id: "r2", source: "journal", title: "REMOTE_B", excerpt: "remote excerpt b", score: 0.3, confidence: "medium", calibrated: 0.5 },
    ];
    await installMockedRemoteBackend(async () => remoteFixture);
    // AGENT_RECALL_RECALL_FUSION intentionally left unset (flag OFF, the default).
    const result = await smartRecall({ query: "anything", project, limit: 10 });
    assert.deepEqual(result.results, remoteFixture, "flag OFF must produce EXACTLY remoteResults — the pre-wave ternary, untouched");
    assert.equal(result.recall_path, undefined, "recall_path must be entirely ABSENT when the flag is off (byte-identical to pre-wave, which never had this field)");
    assert.equal(result.degraded, undefined);
  });

  it("remote-timeout fixture: falls back to local, degraded={reason:timeout}, no recall_path", async () => {
    const project = "fusion-e2e-timeout";
    process.env.AGENT_RECALL_RECALL_BUDGET_MS = "30"; // keep the test fast
    await installMockedRemoteBackend(() => new Promise(() => {})); // never resolves
    const result = await smartRecall({ query: "anything", project, limit: 10 });
    assert.deepEqual(result.degraded, { reason: "timeout", backend: "SupabaseRecallBackend" }, "degraded shape must be exactly the pre-wave contract");
    assert.equal(result.recall_path, undefined, "recall_path must be entirely absent when the flag is off, even on the timeout path");
    assert.ok(!result.results.some((r) => r.id === "r1" || r.id === "r2"), "must never contain remote fixture data on a timeout");
  });
});

describe("smartRecall — end-to-end (fused happy path, flag ON)", () => {
  it("a local-only journal hit SURVIVES, a slug-matched palace dup collapses to the local item, a remote-only item is appended — recall_path='fused'", async () => {
    const project = "fusion-e2e-fused";
    const trigger = "gizmoflex teleport array";

    createRoom(project, "decisions", "Decisions", "decision trail room");
    const roomDir = path.join(palaceDir(project), "rooms", "decisions");
    fs.mkdirSync(roomDir, { recursive: true });
    fs.writeFileSync(path.join(roomDir, "note.md"), `local palace line about ${trigger} decision\n`, "utf-8");

    const jdir = journalDir(project);
    fs.mkdirSync(jdir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(jdir, `${today}.md`), `## notes\njournal-only mention of ${trigger} and zzzuniquejournalonly\n`, "utf-8");

    const paletteSlug = deriveSlug(path.join(palaceDir(project), "rooms", "decisions", "note.md"));
    const remoteFixture = [
      // Same canonical file as the local palace hit — must collapse to LOCAL.
      { id: "remote-dup", source: "palace", title: "REMOTE_DUP_TITLE", excerpt: "totally different remote excerpt text", score: 0.9, confidence: "high", calibrated: 0.9, slug: paletteSlug },
      // Genuinely remote-only — no local counterpart at all.
      { id: "remote-only", source: "journal", title: "REMOTE_ONLY", excerpt: `remote-only hit for ${trigger}`, score: 0.6, confidence: "medium", calibrated: 0.5 },
    ];
    await installMockedRemoteBackend(async () => remoteFixture);
    process.env.AGENT_RECALL_RECALL_FUSION = "1";

    const result = await smartRecall({ query: trigger, project, limit: 10, drilldown: false });
    assert.equal(result.recall_path, "fused", "both sides answered non-empty with the flag on — fusion must have run");

    const journalOnly = result.results.find((r) => r.excerpt.includes("zzzuniquejournalonly"));
    assert.ok(journalOnly, `local-only journal hit must survive fusion (the #24 bug fix) — got ${JSON.stringify(result.results)}`);

    const collapsedPalace = result.results.find((r) => r.id !== "remote-only" && r.source === "palace");
    assert.ok(collapsedPalace, "the palace hit must survive");
    assert.notEqual(collapsedPalace.id, "remote-dup", "the surviving palace item must be the LOCAL one, not the remote dup");
    assert.ok(!collapsedPalace.excerpt.includes("totally different remote excerpt"), "must keep the LOCAL excerpt, not remote's");
    assert.equal(collapsedPalace.foundInRemote, true, "the collapsed item must be marked dual-origin");

    const remoteOnly = result.results.find((r) => r.id === "remote-only");
    assert.ok(remoteOnly, "the genuinely remote-only item must also be appended");
  });

  it("flag ON but local side is empty (no palace/journal content) — fusion preconditions unmet, falls through to today's ternary, recall_path='remote'", async () => {
    const project = "fusion-e2e-empty-local";
    const remoteFixture = [{ id: "r1", source: "palace", title: "R", excerpt: "r excerpt", score: 0.5, confidence: "high", calibrated: 0.8 }];
    await installMockedRemoteBackend(async () => remoteFixture);
    process.env.AGENT_RECALL_RECALL_FUSION = "1";
    const result = await smartRecall({ query: "nonexistent-term-xyz", project, limit: 10 });
    assert.equal(result.recall_path, "remote", "fusion must NOT run when one side is empty, even with the flag on");
    assert.deepEqual(result.results, remoteFixture, "must fall through to the pre-existing ternary exactly");
  });

  it("flag ON, remote times out — degraded+recall_path='local-timeout' (same case `degraded` already covers)", async () => {
    const project = "fusion-e2e-flagged-timeout";
    process.env.AGENT_RECALL_RECALL_BUDGET_MS = "30";
    await installMockedRemoteBackend(() => new Promise(() => {}));
    process.env.AGENT_RECALL_RECALL_FUSION = "1";
    const result = await smartRecall({ query: "anything", project, limit: 10 });
    assert.deepEqual(result.degraded, { reason: "timeout", backend: "SupabaseRecallBackend" });
    assert.equal(result.recall_path, "local-timeout");
  });
});

describe("smartRecall — (f) since-path and breaker-path stay untouched regardless of the fusion flag", () => {
  it("`since` filter bypasses the remote branch entirely — recall_path is never set, even with a remote backend configured and the flag on", async () => {
    const project = "fusion-e2e-since";
    const remoteFixture = [{ id: "r1", source: "palace", title: "R", excerpt: "r excerpt", score: 0.5, confidence: "high", calibrated: 0.8 }];
    await installMockedRemoteBackend(async () => remoteFixture);
    process.env.AGENT_RECALL_RECALL_FUSION = "1";
    const result = await smartRecall({ query: "anything", project, since: "7d", limit: 10 });
    assert.equal(result.recall_path, undefined, "the `since` branch (local-only) must never engage the remote/fusion machinery at all");
    assert.ok(!result.results.some((r) => r.id === "r1"), "must never contain remote fixture data on the since path");
  });

  it("once the circuit breaker trips, subsequent calls fall back to LocalRecallBackend and never engage fusion, even with the flag on", async () => {
    const project = "fusion-e2e-breaker";
    process.env.AGENT_RECALL_RECALL_BUDGET_MS = "30";
    await installMockedRemoteBackend(() => new Promise(() => {})); // always times out
    process.env.AGENT_RECALL_RECALL_FUSION = "1";

    // BREAKER_THRESHOLD = 2 consecutive failures trips the breaker.
    await smartRecall({ query: "one", project, limit: 10 });
    await smartRecall({ query: "two", project, limit: 10 });
    const third = await smartRecall({ query: "three", project, limit: 10 });

    // Once tripped, getRecallBackend() returns LocalRecallBackend immediately
    // — isRemote is false, so smartRecall()'s remote/fusion branch (and thus
    // `recall_path`) is structurally unreachable, regardless of the flag.
    assert.equal(third.recall_path, undefined, "fusion/recall_path must be unreachable once the breaker has tripped");
    assert.equal(third.degraded, undefined, "a pure-local backend call is not a 'timeout' — degraded must not be set either");
  });
});
