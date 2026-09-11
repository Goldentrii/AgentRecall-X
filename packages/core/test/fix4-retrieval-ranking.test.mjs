// packages/core/test/fix4-retrieval-ranking.test.mjs
//
// fix4-retrieval tranche (2026-09-11) — plan #4 "ranking repair + IDF" of the
// converged v2 plan (reports/agentrecall-evaluation-standard-2026-09-11.md).
// One describe-block per step, in tranche order:
//
//   S1 — corrections tier wired into the DEFAULT smart_recall path
//        (active-only, severity/proof_count-aware, non-time-decaying)
//   S2 — graph-link stubs become alsoLinked metadata (stop burning slots)
//   S3 — journal tier scores ALL candidates, then truncates (no recency
//        pre-truncation at perTierLimit)
//   S4 — palace tier: relevance dominates, salience is tiebreaker-scale
//   S5 — IDF (BM25-lite, pure local): rare discriminative tokens outweigh
//        ubiquitous ones; CJK tokens weighted identically
//
// Every test here pins a MECHANISM from the design, never a fixture query —
// the golden-query fixture is hash-locked and never referenced here.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  setRoot,
  resetRoot,
  resetRecallBackend,
  smartRecall,
  queryMemory,
  writeCorrection,
  retractCorrection,
  readCorrections,
  journalDir,
  palaceDir,
} from "../dist/index.js";
import { localRecallSearch } from "../dist/tools-logic/smart-recall.js";
import { addEdge } from "../dist/palace/graph.js";
import { ensurePalaceInitialized } from "../dist/palace/rooms.js";

/** Force the deterministic local keyword backend regardless of ambient env. */
function stashBackendEnv(saved) {
  for (const k of ["OPENAI_API_KEY", "AGENT_RECALL_SUPABASE_URL", "AGENT_RECALL_SUPABASE_KEY"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
}
function restoreBackendEnv(saved) {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function correctionsDirFor(project) {
  // Same base resolution as query-memory-pipeline.test.mjs PART G:
  // corrections.ts's private correctionsDir(project) is
  // projectSubPath(project, "corrections") — journalDir's dirname +
  // "corrections" reaches the identical directory.
  return path.join(path.dirname(journalDir(project)), "corrections");
}

/** Date string N days before today (local time), YYYY-MM-DD. */
function daysAgo(n) {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// S1 — corrections tier on the DEFAULT smart_recall path
// ---------------------------------------------------------------------------

describe("fix4 S1 — corrections tier wired into default smart_recall", () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ar-fix4-s1-"));
  const SAVED_ENV = {};

  before(() => {
    stashBackendEnv(SAVED_ENV);
    setRoot(TMP);
    resetRecallBackend();
  });
  after(() => {
    resetRoot();
    resetRecallBackend();
    restoreBackendEnv(SAVED_ENV);
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("S1a: a matching ACTIVE correction surfaces on the default smartRecall path with source 'corrections' and is counted in the accounting fields", async () => {
    const PROJECT = "fix4-s1a-default-path";
    const TERM = "zzfixfouralpha3301";
    const write = writeCorrection(PROJECT, {
      id: `${daysAgo(10)}-s1a-rule`,
      date: daysAgo(10),
      severity: "p0",
      project: PROJECT,
      rule: `Never ${TERM} without explicit owner approval`,
      context: `Hard rule about ${TERM} discovered in review.`,
      tags: ["fix4"],
    });
    assert.ok(write.written, `precondition: correction must write; got ${JSON.stringify(write)}`);

    const result = await smartRecall({ query: `${TERM} approval rule`, project: PROJECT });
    const hit = result.results.find((r) => r.source === "corrections");
    assert.ok(
      hit,
      `default smart_recall must surface the correction (THE S2-standard gap: 9/10 correction-homed ` +
      `golden facts unreachable); got sources ${JSON.stringify(result.results.map((r) => r.source))}`,
    );
    assert.ok(hit.excerpt.includes(TERM), `correction excerpt must carry the rule text; got "${hit.excerpt}"`);
    assert.equal(hit.id, `${daysAgo(10)}-s1a-rule`, "id must be the correction's real record id");
    assert.equal(hit.severity, "p0", "severity must thread through to the external item");
    assert.ok(result.sources_queried.includes("corrections"), "sources_queried must include corrections");
    assert.equal(
      result.candidates_by_source.corrections,
      1,
      `candidates_by_source must count the corrections tier; got ${JSON.stringify(result.candidates_by_source)}`,
    );
    assert.ok(
      result.total_searched >= 1,
      `total_searched must include corrections candidates; got ${result.total_searched}`,
    );
  });

  it("S1b: the reserved-name class (_pending/, _quarantine/, _rejected.jsonl, _outcomes.jsonl, _index.md, _*.json) and inactive/retracted records NEVER surface", async () => {
    const PROJECT = "fix4-s1b-exclusions";
    const TERM = "zzfixfourbravo4402";
    const dir = correctionsDirFor(PROJECT);

    // One genuine active record so the tier itself provably ran. Written
    // directly (like every disk-seeded record below) — writeCorrection's own
    // capture noise gate (isLikelyRealCorrection) is not under test here.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${daysAgo(9)}-s1b-real.json`),
      JSON.stringify({
        id: `${daysAgo(9)}-s1b-real`, date: daysAgo(9), severity: "p1", project: PROJECT,
        rule: `Real active rule mentioning ${TERM}`, context: `${TERM} context`, tags: [],
      }),
    );

    // Class member 1: fix2-style staging subtree corrections/_pending/ —
    // excluded BY NAME (forward-compat with the fix2 staging store).
    const pendingDir = path.join(dir, "_pending");
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(
      path.join(pendingDir, `${daysAgo(1)}-staged.json`),
      JSON.stringify({
        id: `${daysAgo(1)}-staged`, date: daysAgo(1), severity: "p0", project: PROJECT,
        rule: `PENDING_MARKER_A staged raw rule ${TERM}`, context: "", tags: [],
      }),
    );
    // Class member 2: quarantine subtree.
    const quarantineDir = path.join(dir, "_quarantine");
    fs.mkdirSync(quarantineDir, { recursive: true });
    fs.writeFileSync(
      path.join(quarantineDir, "noise.json"),
      JSON.stringify({
        id: "2026-01-01-quarantined", date: "2026-01-01", severity: "p0", project: PROJECT,
        rule: `QUARANTINE_MARKER_B ${TERM}`, context: "", tags: [],
      }),
    );
    // Class members 3-5: infra ledgers/index at the corrections root.
    fs.writeFileSync(path.join(dir, "_rejected.jsonl"), JSON.stringify({ rule: `REJECTED_MARKER_C ${TERM}` }) + "\n");
    fs.writeFileSync(path.join(dir, "_outcomes.jsonl"), JSON.stringify({ note: `OUTCOME_MARKER_D ${TERM}` }) + "\n");
    fs.writeFileSync(path.join(dir, "_index.md"), `| p0 | ${TERM} INDEX_MARKER_E |\n`);
    // Class member 6: a reserved-name .json FILE at the corrections root —
    // this is the case a bare ".json"-extension filter would wrongly parse;
    // the exclusion must be BY NAME (leading underscore = infrastructure
    // namespace), not by extension accident.
    fs.writeFileSync(
      path.join(dir, "_staged-flat.json"),
      JSON.stringify({
        id: "2026-01-02-underscore-file", date: "2026-01-02", severity: "p0", project: PROJECT,
        rule: `UNDERSCORE_FILE_MARKER_F ${TERM}`, context: "", tags: [],
      }),
    );
    // Inactive record (active:false on disk).
    fs.writeFileSync(
      path.join(dir, "2026-01-03-inactive.json"),
      JSON.stringify({
        id: "2026-01-03-inactive", date: "2026-01-03", severity: "p0", project: PROJECT,
        rule: `INACTIVE_MARKER_G ${TERM}`, context: "", tags: [], active: false,
      }),
    );
    // Retracted record (retractCorrection soft-delete of a disk record).
    fs.writeFileSync(
      path.join(dir, `${daysAgo(8)}-s1b-retracted.json`),
      JSON.stringify({
        id: `${daysAgo(8)}-s1b-retracted`, date: daysAgo(8), severity: "p1", project: PROJECT,
        rule: `RETRACTED_MARKER_H ${TERM} old superseded rule`, context: "", tags: [],
      }),
    );
    const retract = retractCorrection(PROJECT, `${daysAgo(8)}-s1b-retracted`, "fix4 test retraction");
    assert.ok(retract.success, `precondition: retraction must succeed; got ${JSON.stringify(retract)}`);

    // The storage primitive itself must already exclude the reserved-name
    // class (choke-point fix, not a per-caller filter).
    const records = readCorrections(PROJECT);
    const markers = ["PENDING_MARKER_A", "QUARANTINE_MARKER_B", "UNDERSCORE_FILE_MARKER_F"];
    for (const m of markers) {
      assert.ok(
        !records.some((r) => (r.rule ?? "").includes(m)),
        `readCorrections must never parse reserved-name (_-prefixed) entries; leaked: ${m}`,
      );
    }

    const result = await smartRecall({ query: `${TERM} rule`, project: PROJECT, limit: 10 });
    const corrections = result.results.filter((r) => r.source === "corrections");
    assert.ok(
      corrections.some((r) => r.excerpt.includes("Real active rule")),
      `the genuine active correction must surface (tier provably ran); got ${JSON.stringify(result.results.map((r) => r.title))}`,
    );
    const allText = JSON.stringify(result);
    for (const m of ["PENDING_MARKER_A", "QUARANTINE_MARKER_B", "REJECTED_MARKER_C", "OUTCOME_MARKER_D", "INDEX_MARKER_E", "UNDERSCORE_FILE_MARKER_F", "INACTIVE_MARKER_G", "RETRACTED_MARKER_H"]) {
      assert.ok(
        !allText.includes(m),
        `excluded-class content must never surface anywhere in smart_recall output; leaked marker: ${m}`,
      );
    }
  });

  it("S1c: severity-aware — at equal keyword relevance, a p0 correction outranks a p1 correction", async () => {
    const PROJECT = "fix4-s1c-severity";
    const TERM = "zzfixfourcharlie5503";
    // Same rule shape, both >72h old (outside the hot-window boost), equal
    // proof_count — only severity differs. Disk-seeded (writeCorrection's
    // capture noise gate is not under test). Newer date on the p1 record, so
    // date-desc candidate order favors it on a scoring tie — making this a
    // real severity test, not an insertion-order accident.
    const dir = correctionsDirFor(PROJECT);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${daysAgo(4)}-s1c-p1.json`),
      JSON.stringify({
        id: `${daysAgo(4)}-s1c-p1`, date: daysAgo(4), severity: "p1", project: PROJECT,
        rule: `Handle ${TERM} deployments with a checklist`, context: "", tags: [],
      }),
    );
    fs.writeFileSync(
      path.join(dir, `${daysAgo(6)}-s1c-p0.json`),
      JSON.stringify({
        id: `${daysAgo(6)}-s1c-p0`, date: daysAgo(6), severity: "p0", project: PROJECT,
        rule: `Handle ${TERM} rollbacks with a checklist`, context: "", tags: [],
      }),
    );

    const result = await queryMemory({ query: `${TERM} checklist`, project: PROJECT, tiers: ["corrections"] });
    assert.equal(result.items.length, 2, `both corrections must match; got ${JSON.stringify(result.items)}`);
    assert.equal(
      result.items[0].severity,
      "p0",
      `at equal relevance the p0 record must rank first (severity-aware scoring); got order ` +
      `${JSON.stringify(result.items.map((i) => [i.id, i.severity, i.score]))}`,
    );
  });

  it("S1d: proof_count-aware — at equal relevance and severity, higher proof_count outranks", async () => {
    const PROJECT = "fix4-s1d-proof";
    const TERM = "zzfixfourdelta6604";
    const dir = correctionsDirFor(PROJECT);
    fs.mkdirSync(dir, { recursive: true });
    // Written directly (writeCorrection's consolidation would merge same-kind
    // rules); proof_count 5 vs 1, singleton is NEWER so date-order favors it
    // on a tie — proof weighting must overcome that.
    fs.writeFileSync(
      path.join(dir, `${daysAgo(4)}-s1d-single.json`),
      JSON.stringify({
        id: `${daysAgo(4)}-s1d-single`, date: daysAgo(4), severity: "p1", project: PROJECT,
        rule: `Verify ${TERM} exports before publishing`, context: "", tags: [], proof_count: 1,
      }),
    );
    fs.writeFileSync(
      path.join(dir, `${daysAgo(6)}-s1d-proven.json`),
      JSON.stringify({
        id: `${daysAgo(6)}-s1d-proven`, date: daysAgo(6), severity: "p1", project: PROJECT,
        rule: `Verify ${TERM} imports before publishing`, context: "", tags: [], proof_count: 5,
      }),
    );

    const result = await queryMemory({ query: `${TERM} publishing`, project: PROJECT, tiers: ["corrections"] });
    assert.equal(result.items.length, 2, `both corrections must match; got ${JSON.stringify(result.items)}`);
    assert.equal(
      result.items[0].id,
      `${daysAgo(6)}-s1d-proven`,
      `the proof_count=5 record must rank first (proof-aware scoring, like insight confirmation); got order ` +
      `${JSON.stringify(result.items.map((i) => [i.id, i.score]))}`,
    );
  });

  it("S1e: non-time-decaying — an 8-month-old correction scores identically to a 5-day-old one at equal relevance/severity/proof", async () => {
    const PROJECT = "fix4-s1e-nodecay";
    const TERM = "zzfixfourecho7705";
    const dir = correctionsDirFor(PROJECT);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "2026-01-05-s1e-old.json"),
      JSON.stringify({
        id: "2026-01-05-s1e-old", date: "2026-01-05", severity: "p1", project: PROJECT,
        rule: `Escalate ${TERM} conflicts to the owner first`, context: "", tags: [],
      }),
    );
    fs.writeFileSync(
      path.join(dir, `${daysAgo(5)}-s1e-new.json`),
      JSON.stringify({
        id: `${daysAgo(5)}-s1e-new`, date: daysAgo(5), severity: "p1", project: PROJECT,
        rule: `Escalate ${TERM} disputes to the owner first`, context: "", tags: [],
      }),
    );

    const result = await queryMemory({ query: `${TERM} owner`, project: PROJECT, tiers: ["corrections"] });
    assert.equal(result.items.length, 2, `both corrections must match; got ${JSON.stringify(result.items)}`);
    // Compare the PRE-fusion tier scores via a corrections-only queryMemory
    // call: with a single tier, RRF assigns 1/(60+rank) by position, so equal
    // tier-internal scores are proven by the underlying per-tier scorer
    // producing a tie — assert the two fused scores differ ONLY by the rank-1
    // vs rank-2 RRF positions, i.e. no decay multiplier separated them.
    const s1 = result.items[0].score;
    const s2 = result.items[1].score;
    assert.ok(
      Math.abs(s1 - 1 / 61) < 1e-9 && Math.abs(s2 - 1 / 62) < 1e-9,
      `corrections must not time-decay: expected pure positional RRF scores (1/61, 1/62) for two ` +
      `equal-relevance records regardless of an 8-month age gap; got ${s1}, ${s2}`,
    );
  });
});

// ---------------------------------------------------------------------------
// S2 — graph-link stubs become alsoLinked metadata
// ---------------------------------------------------------------------------

describe("fix4 S2 — graph-link stubs move out of result slots into alsoLinked", () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ar-fix4-s2-"));
  const SAVED_ENV = {};
  const PROJECT = "fix4-s2-graph-meta";
  const TERM = "zzfixfourfoxtrot8806";
  const TERM2 = "zzfixfourhotel1108";

  before(() => {
    stashBackendEnv(SAVED_ENV);
    setRoot(TMP);
    resetRecallBackend();

    // A palace room with a matching file, graph-connected to two other rooms.
    // Initialize the palace FIRST: ensurePalaceInitialized (invoked by the
    // palace tier on every search) full-inits any palace missing
    // palace-index.json — including unconditionally rewriting graph.json to
    // {edges: []} — so edges added to a hand-planted, index-less palace
    // would be silently wiped by the first query (pre-existing init
    // behavior, observed while writing this test).
    ensurePalaceInitialized(PROJECT);
    const roomDirPath = path.join(palaceDir(PROJECT), "rooms", "architecture");
    fs.mkdirSync(roomDirPath, { recursive: true });
    fs.writeFileSync(
      path.join(roomDirPath, "graph-meta-probe.md"),
      `---\ntopic: graph-meta-probe\n---\n\n${TERM} ${TERM2} decision recorded here\n`,
    );
    const pd = palaceDir(PROJECT);
    addEdge(pd, "architecture", "knowledge", "semantic_similar", 0.5);
    addEdge(pd, "architecture", "decisions", "semantic_similar", 0.5);
  });
  after(() => {
    resetRoot();
    resetRecallBackend();
    restoreBackendEnv(SAVED_ENV);
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("S2a: no '↳ linked:' stub items occupy result slots; the parent (top) result carries alsoLinked instead", async () => {
    const results = await localRecallSearch(TERM, PROJECT, 10);
    assert.ok(results.length >= 1, `expected the substantive palace hit; got ${JSON.stringify(results)}`);

    const stubs = results.filter(
      (r) => r.title.startsWith("↳ linked:") || (r.excerpt ?? "").includes("via memory graph"),
    );
    assert.equal(
      stubs.length,
      0,
      `graph-link stubs must no longer burn result slots (24/100 top-5 slots at baseline); got ` +
      `${JSON.stringify(stubs.map((s) => s.title))}`,
    );

    const top = results[0];
    assert.ok(Array.isArray(top.alsoLinked), `top result must carry the graph signal as alsoLinked metadata; got ${JSON.stringify(top)}`);
    assert.deepEqual(
      [...top.alsoLinked].sort(),
      ["decisions", "knowledge"],
      `alsoLinked must name the 1-hop connected rooms; got ${JSON.stringify(top.alsoLinked)}`,
    );
  });

  it("S2b: alsoLinked is absent when the top result's room has no graph edges", async () => {
    const LONE_PROJECT = "fix4-s2-lone";
    const LONE_TERM = "zzfixfourgolf9907";
    const roomDirPath = path.join(palaceDir(LONE_PROJECT), "rooms", "architecture");
    fs.mkdirSync(roomDirPath, { recursive: true });
    fs.writeFileSync(
      path.join(roomDirPath, "lone-probe.md"),
      `---\ntopic: lone-probe\n---\n\n${LONE_TERM} standalone fact\n`,
    );
    const results = await localRecallSearch(LONE_TERM, LONE_PROJECT, 10);
    assert.ok(results.length >= 1, "expected the substantive palace hit");
    assert.equal(results[0].alsoLinked, undefined, "no edges -> no alsoLinked field at all (additive-absent, not empty)");
  });

  it("S2c: a linked room already visible among the results is not re-advertised in alsoLinked", async () => {
    // Second matching file lives in "knowledge" (one of the linked rooms) —
    // knowledge already surfaces as a result, so alsoLinked must only carry
    // the room NOT already visible.
    const roomDirPath = path.join(palaceDir(PROJECT), "rooms", "knowledge");
    fs.mkdirSync(roomDirPath, { recursive: true });
    fs.writeFileSync(
      path.join(roomDirPath, "kn-probe.md"),
      `---\ntopic: kn-probe\n---\n\n${TERM} knowledge runbook entry\n`,
    );
    // Two-token query: the architecture probe matches both tokens
    // (exactness 1.0), the knowledge probe only one (0.5) — pins
    // architecture as the deterministic top result.
    const results = await localRecallSearch(`${TERM} ${TERM2}`, PROJECT, 10);
    const top = results[0];
    assert.equal(top.room, "architecture", `precondition: architecture must be the top result; got ${JSON.stringify(results.map((r) => [r.title, r.score]))}`);
    assert.ok(results.some((r) => r.room === "knowledge"), "precondition: knowledge must surface as a substantive result");
    assert.ok(top.alsoLinked, "top result must still carry alsoLinked for the remaining unlinked room");
    assert.ok(
      !top.alsoLinked.includes("knowledge"),
      `alsoLinked must not re-advertise a room already visible in the results; got ${JSON.stringify(top.alsoLinked)}`,
    );
    assert.deepEqual(top.alsoLinked, ["decisions"], `only the not-yet-visible room remains; got ${JSON.stringify(top.alsoLinked)}`);
  });
});

// ---------------------------------------------------------------------------
// S3 — journal tier: score ALL candidates, then truncate
// ---------------------------------------------------------------------------

describe("fix4 S3 — journal score-then-truncate (no recency pre-truncation)", () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ar-fix4-s3-"));
  const SAVED_ENV = {};
  const PROJECT = "fix4-s3-journal";
  const T1 = "zzfixfourindia2209";
  const T2 = "zzfixfourjuliet3310";
  const T3 = "zzfixfourkilo4411";

  before(() => {
    stashBackendEnv(SAVED_ENV);
    setRoot(TMP);
    resetRecallBackend();

    const jdir = journalDir(PROJECT);
    fs.mkdirSync(jdir, { recursive: true });
    // 26 NEWER entries, each matching exactly ONE of the three query
    // keywords — enough hits to exhaust perTierLimit=25 during a
    // date-descending pre-truncation scan before any older file is reached.
    // Dated 4-6 days back: newer than the golden entry (so pre-truncation
    // still consumes the limit before reaching it) but OUTSIDE the <72h
    // hot-window boost, which is a separate, pre-existing RANK/FUSE
    // mechanism deliberately not under test here.
    for (let i = 0; i < 26; i++) {
      const d = daysAgo(4 + Math.floor(i / 9)); // spread over a few near days
      fs.writeFileSync(
        path.join(jdir, `${d}--card--recent-${String(i).padStart(2, "0")}.md`),
        `# recent filler ${i}\n\nnote ${i} mentions ${T1} only, in passing\n`,
      );
    }
    // ONE 60-day-old entry matching ALL THREE keywords — the golden fact.
    fs.writeFileSync(
      path.join(jdir, `${daysAgo(60)}--card--golden-old.md`),
      `# old golden entry\n\ndecision: ${T1} ${T2} ${T3} full rule lives here\n`,
    );
  });
  after(() => {
    resetRoot();
    resetRecallBackend();
    restoreBackendEnv(SAVED_ENV);
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("S3a: an old, strongly-matching journal entry survives perTierLimit — all candidates are scored BEFORE truncation", async () => {
    const result = await queryMemory({
      query: `${T1} ${T2} ${T3}`,
      project: PROJECT,
      tiers: ["journal"],
      journal: { perTierLimit: 25 },
    });
    const golden = result.items.find((i) => i.excerpt.includes(T3));
    assert.ok(
      golden,
      `the 60-day-old entry matching ALL query keywords must be scored and surface — recency ` +
      `pre-truncation at perTierLimit must not drop it unscored; got ${JSON.stringify(result.items.map((i) => i.title))}`,
    );
    assert.equal(
      result.items[0].excerpt.includes(T3),
      true,
      `the full-match entry must outrank single-keyword recent filler (exactness 1.0 vs ~0.33); got top ` +
      `${JSON.stringify(result.items[0])}`,
    );
  });

  it("S3b: perTierLimit still caps the RETURNED item count (truncation happens, after scoring)", async () => {
    const result = await queryMemory({
      query: `${T1} ${T2} ${T3}`,
      project: PROJECT,
      tiers: ["journal"],
      journal: { perTierLimit: 25 },
    });
    assert.ok(
      result.candidatesBySource.journal <= 25,
      `perTierLimit must still bound the tier's candidate count; got ${result.candidatesBySource.journal}`,
    );
  });
});

// ---------------------------------------------------------------------------
// S4 — palace tier: relevance dominates, salience is tiebreaker-scale
// ---------------------------------------------------------------------------

describe("fix4 S4 — palace relevance-over-salience", () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ar-fix4-s4-"));
  const SAVED_ENV = {};
  const PROJECT = "fix4-s4-palace";
  const Q = ["zzfixfourlima5512", "zzfixfourmike6613", "zzfixfournovember7714", "zzfixfouroscar8815"];

  function setSalience(project, room, value) {
    const metaPath = path.join(palaceDir(project), "rooms", room, "_room.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    meta.salience = value;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }

  before(() => {
    stashBackendEnv(SAVED_ENV);
    setRoot(TMP);
    resetRecallBackend();
    ensurePalaceInitialized(PROJECT);

    // "knowledge" plays the mega-room: MAX salience, but its line matches
    // only 3 of the 4 query tokens (a realistic mega-room partial match).
    fs.writeFileSync(
      path.join(palaceDir(PROJECT), "rooms", "knowledge", "mega-note.md"),
      `---\ntopic: mega-note\n---\n\n${Q[0]} ${Q[1]} ${Q[2]} broad catch-all note\n`,
    );
    setSalience(PROJECT, "knowledge", 1.0);

    // "decisions" plays the topical room: MIN salience, full 4/4 match.
    fs.writeFileSync(
      path.join(palaceDir(PROJECT), "rooms", "decisions", "exact-note.md"),
      `---\ntopic: exact-note\n---\n\n${Q[0]} ${Q[1]} ${Q[2]} ${Q[3]} the actual answer\n`,
    );
    setSalience(PROJECT, "decisions", 0.35); // floored to 0.4 by the scorer
  });
  after(() => {
    resetRoot();
    resetRecallBackend();
    restoreBackendEnv(SAVED_ENV);
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("S4a: a stronger keyword match in a low-salience room outranks a weaker match in a max-salience room", async () => {
    const result = await queryMemory({ query: Q.join(" "), project: PROJECT, tiers: ["palace"] });
    const first = result.items[0];
    assert.ok(first, "expected palace results");
    assert.equal(
      first.room,
      "decisions",
      `the 4/4-match room must outrank the 3/4-match mega-room regardless of the salience gap ` +
      `(relevance dominates; salience is tiebreaker-scale); got order ` +
      `${JSON.stringify(result.items.map((i) => [i.room, i.title, i.keywordScore, i.score]))}`,
    );
  });

  it("S4b: at EQUAL keyword relevance, higher salience still breaks the tie", async () => {
    const P2 = "fix4-s4b-tie";
    const T = "zzfixfourpapa9916";
    ensurePalaceInitialized(P2);
    fs.writeFileSync(
      path.join(palaceDir(P2), "rooms", "knowledge", "tie-a.md"),
      `---\ntopic: tie-a\n---\n\n${T} candidate approach alpha\n`,
    );
    fs.writeFileSync(
      path.join(palaceDir(P2), "rooms", "decisions", "tie-b.md"),
      `---\ntopic: tie-b\n---\n\n${T} candidate approach beta\n`,
    );
    setSalience(P2, "knowledge", 1.0);
    setSalience(P2, "decisions", 0.4);

    const result = await queryMemory({ query: T, project: P2, tiers: ["palace"] });
    const rooms = result.items.map((i) => i.room);
    const knowledgeIdx = rooms.indexOf("knowledge");
    const decisionsIdx = rooms.indexOf("decisions");
    assert.ok(knowledgeIdx !== -1 && decisionsIdx !== -1, `both rooms must surface; got ${JSON.stringify(rooms)}`);
    assert.ok(
      knowledgeIdx < decisionsIdx,
      `at equal keyword relevance the higher-salience room must rank first (salience keeps its ` +
      `tiebreaker role); got ${JSON.stringify(result.items.map((i) => [i.room, i.score]))}`,
    );
  });
});

// ---------------------------------------------------------------------------
// S5 — IDF (BM25-lite, pure local, in-pass over the scanned corpus)
// ---------------------------------------------------------------------------

describe("fix4 S5 — BM25-lite IDF: rare discriminative tokens outweigh ubiquitous ones", () => {
  const SAVED_ENV = {};
  let TMP;

  before(() => {
    stashBackendEnv(SAVED_ENV);
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ar-fix4-s5-"));
    setRoot(TMP);
    resetRecallBackend();
  });
  after(() => {
    resetRoot();
    resetRecallBackend();
    restoreBackendEnv(SAVED_ENV);
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("S5a (journal, en): a doc matching only the RARE query token outranks newer docs matching only the ubiquitous one", async () => {
    const PROJECT = "fix4-s5a-journal-en";
    const RARE = "zzraretok7501";
    const COMMON = "zzcommontok7502";
    const jdir = journalDir(PROJECT);
    fs.mkdirSync(jdir, { recursive: true });
    // Old doc: rare token only.
    fs.writeFileSync(path.join(jdir, `${daysAgo(30)}--card--rare.md`), `# rare doc\n\n${RARE} deep dive lives here\n`);
    // Newer docs: ubiquitous token only (5 of 6 corpus docs carry it).
    fs.writeFileSync(path.join(jdir, `${daysAgo(10)}--card--common.md`), `# common doc\n\n${COMMON} status line\n`);
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(path.join(jdir, `${daysAgo(5 + i)}--card--filler-${i}.md`), `# filler ${i}\n\n${COMMON} routine note ${i}\n`);
    }

    const result = await queryMemory({ query: `${RARE} ${COMMON}`, project: PROJECT, tiers: ["journal"] });
    assert.ok(result.items.length >= 2, `expected multiple matches; got ${JSON.stringify(result.items)}`);
    assert.ok(
      result.items[0].excerpt.includes(RARE),
      `the rare-token doc must rank first: at equal match-count the rare token carries nearly all the ` +
      `query's IDF mass (df 1/6 vs 5/6), which must outweigh the fillers' recency edge; got top ` +
      `${JSON.stringify(result.items.slice(0, 3).map((i) => [i.title, i.excerpt, i.score]))}`,
    );
  });

  it("S5b (journal, zh): CJK tokens get identical IDF treatment — the rare Han token wins over the ubiquitous one", async () => {
    const PROJECT = "fix4-s5b-journal-zh";
    const RARE = "熔断";   // rare: 1/6 docs
    const COMMON = "版本"; // ubiquitous: 5/6 docs
    const jdir = journalDir(PROJECT);
    fs.mkdirSync(jdir, { recursive: true });
    fs.writeFileSync(path.join(jdir, `${daysAgo(30)}--card--rare.md`), `# 深挖\n\n${RARE}机制的完整设计在这里\n`);
    fs.writeFileSync(path.join(jdir, `${daysAgo(10)}--card--common.md`), `# 常规\n\n${COMMON}更新说明\n`);
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(path.join(jdir, `${daysAgo(5 + i)}--card--filler-${i}.md`), `# 填充 ${i}\n\n${COMMON}日常记录 ${i}\n`);
    }

    const result = await queryMemory({ query: `${RARE} ${COMMON}`, project: PROJECT, tiers: ["journal"] });
    assert.ok(result.items.length >= 2, `expected multiple matches; got ${JSON.stringify(result.items)}`);
    assert.ok(
      result.items[0].excerpt.includes(RARE),
      `the rare Han token must dominate exactly like its English mirror (tokenizeCJK segments Han; DF is ` +
      `substring-based and script-agnostic); got top ` +
      `${JSON.stringify(result.items.slice(0, 3).map((i) => [i.title, i.excerpt, i.score]))}`,
    );
  });

  it("S5c (corrections): rare-token record outranks a NEWER common-token record at equal severity/proof", async () => {
    const PROJECT = "fix4-s5c-corrections";
    const RARE = "zzraretok8601";
    const COMMON = "zzcommontok8602";
    const dir = correctionsDirFor(PROJECT);
    fs.mkdirSync(dir, { recursive: true });
    // Rare-token record — OLDER (date-desc candidate order favors the other on a tie).
    fs.writeFileSync(path.join(dir, "2026-03-01-rare.json"), JSON.stringify({
      id: "2026-03-01-rare", date: "2026-03-01", severity: "p1", project: PROJECT,
      rule: `Guard the ${RARE} pathway explicitly`, context: "", tags: [],
    }));
    // Common-token record — newer.
    fs.writeFileSync(path.join(dir, `${daysAgo(5)}-common.json`), JSON.stringify({
      id: `${daysAgo(5)}-common`, date: daysAgo(5), severity: "p1", project: PROJECT,
      rule: `Track the ${COMMON} pathway explicitly`, context: "", tags: [],
    }));
    // Corpus: 4 more records carrying the common token (df 5/6 vs 1/6).
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(path.join(dir, `2026-04-0${i + 1}-filler-${i}.json`), JSON.stringify({
        id: `2026-04-0${i + 1}-filler-${i}`, date: `2026-04-0${i + 1}`, severity: "p1", project: PROJECT,
        rule: `Routine ${COMMON} note number ${i}`, context: "", tags: [],
      }));
    }

    const result = await queryMemory({ query: `${RARE} ${COMMON} pathway`, project: PROJECT, tiers: ["corrections"] });
    assert.ok(result.items.length >= 2, `expected both pathway records to match; got ${JSON.stringify(result.items)}`);
    assert.equal(
      result.items[0].id,
      "2026-03-01-rare",
      `the rare-token record must rank first (IDF over the scanned corrections corpus); got ` +
      `${JSON.stringify(result.items.map((i) => [i.id, i.score]))}`,
    );
  });

  it("S5d (palace): DF comes from the SCANNED CORPUS, not just the hit set — heading-only occurrences still count toward df", async () => {
    const PROJECT = "fix4-s5d-palace";
    const RARE = "zzpalacerare9701";
    const COMMON = "zzpalacecommon9702";
    ensurePalaceInitialized(PROJECT);
    const roomsRoot = path.join(palaceDir(PROJECT), "rooms");
    // docA (knowledge): rare token in body. Low salience.
    fs.writeFileSync(path.join(roomsRoot, "knowledge", "rare-note.md"), `---\ntopic: rare-note\n---\n\n${RARE} incident analysis body\n`);
    // docB (decisions): common token in body. High salience (wins a pre-IDF tie).
    fs.writeFileSync(path.join(roomsRoot, "decisions", "common-note.md"), `---\ntopic: common-note\n---\n\n${COMMON} weekly sync body\n`);
    // 8 corpus files where the common token appears ONLY in a heading line —
    // structural headings are skipped by the palace line scanner (no hits),
    // but the files ARE part of the scanned corpus, so corpus-DF must see
    // them (hits-only DF cannot).
    for (let i = 0; i < 8; i++) {
      fs.writeFileSync(
        path.join(roomsRoot, "architecture", `corpus-${i}.md`),
        `---\ntopic: corpus-${i}\n---\n\n## ${COMMON} section ${i}\n\nunrelated body text ${i}\n`,
      );
    }
    const setSal = (room, v) => {
      const mp = path.join(roomsRoot, room, "_room.json");
      const m = JSON.parse(fs.readFileSync(mp, "utf-8"));
      m.salience = v;
      fs.writeFileSync(mp, JSON.stringify(m, null, 2));
    };
    setSal("knowledge", 0.4);
    setSal("decisions", 1.0);

    const result = await queryMemory({ query: `${RARE} ${COMMON}`, project: PROJECT, tiers: ["palace"] });
    const bodies = result.items.filter((i) => i.excerpt.includes("body"));
    assert.ok(bodies.length >= 2, `both body docs must hit; got ${JSON.stringify(result.items)}`);
    assert.ok(
      bodies[0].excerpt.includes(RARE),
      `corpus-wide DF (rare 1/10+, common 9/10+) must let the rare-token doc beat the high-salience ` +
      `common-token doc — a hits-only DF sees df(common)=df(rare)=1 and ties them; got ` +
      `${JSON.stringify(result.items.map((i) => [i.room, i.excerpt, i.keywordScore, i.score]))}`,
    );
  });
});

// ---------------------------------------------------------------------------
// S4-completion — one document, one RRF vote (palace mega-file accumulation)
//
// Diagnosed IN this tranche (fix4 probe, 2026-09-11): S4's design premise
// named salience as the mega-room mechanism, but the dominant leg in live
// data is the W3b-documented palace id-collision — every matching LINE of a
// room file shares stableId("palace", room/file), so applyRRF ACCUMULATES
// one contribution per line into a single entry (goals/evolution reached
// fused scores of 0.44-0.71 ≈ 30-40 summed ranks vs 0.0164 for a rank-1
// single hit). That measures file LENGTH, not relevance — the exact signal
// class BM25's TF-saturation exists to cap. Completion mechanism: the
// palace tier returns ONE item per document (its best-scoring line as the
// excerpt/evidence), so RRF sees one vote per document.
// ---------------------------------------------------------------------------

describe("fix4 S4-completion — palace one-doc-one-vote (TF saturation)", () => {
  const SAVED_ENV = {};
  let TMP;

  before(() => {
    stashBackendEnv(SAVED_ENV);
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ar-fix4-s4c-"));
    setRoot(TMP);
    resetRecallBackend();
  });
  after(() => {
    resetRoot();
    resetRecallBackend();
    restoreBackendEnv(SAVED_ENV);
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("S4c: a mega-file with 30 weak-matching lines must NOT outrank a small file whose one line matches the full query", async () => {
    const PROJECT = "fix4-s4c-megafile";
    const A = "zzfixfourquebec1117";
    const B = "zzfixfourromeo2218";
    ensurePalaceInitialized(PROJECT);
    const roomsRoot = path.join(palaceDir(PROJECT), "rooms");
    // Mega-file: 30 lines each matching ONE of the two query words.
    const megaLines = [];
    for (let i = 0; i < 30; i++) megaLines.push(`entry ${i}: routine ${A} bookkeeping note`);
    fs.writeFileSync(
      path.join(roomsRoot, "goals", "evolution.md"),
      `---\ntopic: evolution\n---\n\n${megaLines.join("\n")}\n`,
    );
    // Small file: ONE line matching BOTH query words.
    fs.writeFileSync(
      path.join(roomsRoot, "decisions", "the-answer.md"),
      `---\ntopic: the-answer\n---\n\n${A} ${B} — the actual decision\n`,
    );

    const result = await queryMemory({ query: `${A} ${B}`, project: PROJECT, tiers: ["palace"] });
    assert.ok(result.items.length >= 2, `both docs must surface; got ${JSON.stringify(result.items)}`);
    assert.equal(
      result.items[0].room,
      "decisions",
      `the full-match small file must outrank the 30-weak-line mega-file — line COUNT is length, not ` +
      `relevance (one doc, one RRF vote); got ${JSON.stringify(result.items.slice(0, 3).map((i) => [i.room, i.title, i.score]))}`,
    );
    const megaItems = result.items.filter((i) => i.title === "goals/evolution");
    assert.equal(megaItems.length, 1, "the mega-file must appear exactly once");
    assert.ok(
      megaItems[0].score < result.items[0].score,
      `the mega-file's single vote (${megaItems[0].score}) must stay below the full match (${result.items[0].score}) — no per-line accumulation`,
    );
  });

  it("S4d: a multi-line doc's surfaced excerpt is its BEST-matching line, not its first-matching line", async () => {
    const PROJECT = "fix4-s4d-bestline";
    const A = "zzfixfoursierra3319";
    const B = "zzfixfourtango4420";
    ensurePalaceInitialized(PROJECT);
    fs.writeFileSync(
      path.join(palaceDir(PROJECT), "rooms", "knowledge", "layered.md"),
      `---\ntopic: layered\n---\n\nweak mention of ${A} first\nlater line: ${A} ${B} the full answer\n`,
    );
    const result = await queryMemory({ query: `${A} ${B}`, project: PROJECT, tiers: ["palace"] });
    const doc = result.items.find((i) => i.title === "knowledge/layered");
    assert.ok(doc, `expected the doc; got ${JSON.stringify(result.items)}`);
    assert.ok(
      doc.excerpt.includes("the full answer"),
      `the excerpt must come from the best-scoring line (pre-fix applyRRF kept the FIRST line's excerpt ` +
      `and discarded the stronger one); got "${doc.excerpt}"`,
    );
  });
});

// ---------------------------------------------------------------------------
// S4-completion (journal side) — competitive-surface flooding controls
// ---------------------------------------------------------------------------

describe("fix4 S4-completion — journal index exclusion + per-section dedupe on the fusion surface", () => {
  const SAVED_ENV = {};
  let TMP;

  before(() => {
    stashBackendEnv(SAVED_ENV);
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ar-fix4-jflood-"));
    setRoot(TMP);
    resetRecallBackend();
  });
  after(() => {
    resetRoot();
    resetRecallBackend();
    restoreBackendEnv(SAVED_ENV);
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("JF-a: generated index files (index.md, _*.md) in journal/ and journal/archive/ never become retrieval candidates", async () => {
    const PROJECT = "fix4-jf-index";
    const TERM = "zzfixfouruniform5521";
    const jdir = journalDir(PROJECT);
    const adir = path.join(jdir, "archive");
    fs.mkdirSync(adir, { recursive: true });
    // Real entries — live and archived — plus generated index/infra files
    // carrying the same term (an index is a TOC over everything, so it
    // matches every query and floods the competitive surface).
    fs.writeFileSync(path.join(jdir, `${daysAgo(10)}--card--real.md`), `# real\n\n${TERM} live entry INDEXFREE_L\n`);
    fs.writeFileSync(path.join(adir, `${daysAgo(20)}--card--old.md`), `# old\n\n${TERM} archived entry INDEXFREE_A\n`);
    fs.writeFileSync(path.join(jdir, "index.md"), `- ${TERM} INDEX_NOISE_LIVE\n`);
    fs.writeFileSync(path.join(jdir, "_index.md"), `- ${TERM} INDEX_NOISE_LIVE_U\n`);
    fs.writeFileSync(path.join(adir, "index.md"), `- ${TERM} INDEX_NOISE_ARCH\n`);
    fs.writeFileSync(path.join(adir, "_rollup-state.md"), `- ${TERM} INDEX_NOISE_ARCH_U\n`);

    const result = await queryMemory({ query: TERM, project: PROJECT, tiers: ["journal"] });
    const text = JSON.stringify(result.items);
    assert.ok(text.includes("INDEXFREE_L"), `live entry must surface; got ${text}`);
    assert.ok(text.includes("INDEXFREE_A"), `archived entry must surface; got ${text}`);
    for (const marker of ["INDEX_NOISE_LIVE", "INDEX_NOISE_LIVE_U", "INDEX_NOISE_ARCH", "INDEX_NOISE_ARCH_U"]) {
      assert.ok(!text.includes(marker), `generated index/infra file content must never surface as a journal candidate; leaked: ${marker}`);
    }
  });

  it("JF-b: on the smart_recall fusion surface, one journal (date, section) contributes at most ONE result slot; journalSearch keeps per-line results", async () => {
    const PROJECT = "fix4-jf-dedupe";
    const TERM = "zzfixfourvictor6622";
    const jdir = journalDir(PROJECT);
    fs.mkdirSync(jdir, { recursive: true });
    fs.writeFileSync(
      path.join(jdir, `${daysAgo(10)}--card--multi.md`),
      `# entry\n\n## Notes\n\n${TERM} first mention here\n${TERM} second mention here\n${TERM} third mention here\n`,
    );

    // Fusion surface: the three same-section lines must occupy ONE slot.
    const fused = await localRecallSearch(TERM, PROJECT, 10);
    const journalItems = fused.filter((r) => r.source === "journal");
    assert.equal(
      journalItems.length,
      1,
      `three matching lines of the same (date, section) must collapse to one competitive slot; got ` +
      `${JSON.stringify(journalItems.map((i) => [i.title, i.excerpt]))}`,
    );

    // journalSearch contract (per-line grep surface) is unchanged.
    const { journalSearch } = await import("../dist/tools-logic/journal-search.js");
    const grep = await journalSearch({ query: TERM, project: PROJECT });
    assert.equal(
      grep.results.length,
      3,
      `journalSearch's own per-line contract must be preserved (W3b decision); got ` +
      `${JSON.stringify(grep.results.map((r) => r.excerpt))}`,
    );
  });
});

// ---------------------------------------------------------------------------
// S1-refinement — authority tie-break: corrections win exact fused-score ties
// ---------------------------------------------------------------------------

describe("fix4 S1-refinement — corrections win exact RRF ties (authority order)", () => {
  const SAVED_ENV = {};
  let TMP;

  before(() => {
    stashBackendEnv(SAVED_ENV);
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ar-fix4-tiebreak-"));
    setRoot(TMP);
    resetRecallBackend();
  });
  after(() => {
    resetRoot();
    resetRecallBackend();
    restoreBackendEnv(SAVED_ENV);
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("TB-a: at identical rank evidence (both tier-rank-1, fused 1/61, no boosts), the authoritative correction displays above the palace mention", async () => {
    const PROJECT = "fix4-tb-authority";
    const TERM = "zzfixfourwhiskey7723";
    // Palace mention (no date pattern in content -> no hot-window boost).
    ensurePalaceInitialized(PROJECT);
    fs.writeFileSync(
      path.join(palaceDir(PROJECT), "rooms", "knowledge", "mention.md"),
      `---\ntopic: mention\n---\n\nsomeone mentioned ${TERM} in passing\n`,
    );
    // The authoritative rule (>72h old -> no hot-window boost).
    const dir = correctionsDirFor(PROJECT);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${daysAgo(10)}-tb-rule.json`),
      JSON.stringify({
        id: `${daysAgo(10)}-tb-rule`, date: daysAgo(10), severity: "p0", project: PROJECT,
        rule: `Never bypass the ${TERM} gate`, context: "", tags: [],
      }),
    );

    const results = await localRecallSearch(TERM, PROJECT, 10);
    const corrIdx = results.findIndex((r) => r.source === "corrections");
    const palIdx = results.findIndex((r) => r.source === "palace");
    assert.ok(corrIdx !== -1 && palIdx !== -1, `both must surface; got ${JSON.stringify(results.map((r) => [r.source, r.score]))}`);
    assert.ok(
      Math.abs(results[corrIdx].score - results[palIdx].score) < 1e-9,
      `precondition: the two must genuinely TIE on fused score (both tier-rank-1 = 1/61); got ` +
      `${results[corrIdx].score} vs ${results[palIdx].score}`,
    );
    assert.ok(
      corrIdx < palIdx,
      `at an exact fused-score tie the AUTHORITATIVE record (the owner's own captured rule) must win ` +
      `over a derivative mention — ties were previously broken by tier insertion order, which put ` +
      `corrections dead last; got ${JSON.stringify(results.map((r) => [r.source, r.score]))}`,
    );
  });
});
