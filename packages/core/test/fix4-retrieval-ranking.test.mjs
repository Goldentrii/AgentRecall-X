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
