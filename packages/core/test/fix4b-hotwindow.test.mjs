// packages/core/test/fix4b-hotwindow.test.mjs
//
// fix4b — hot-window redesign (2026-09-12,
// reports/agentrecall-fix4b-hotwindow-2026-09-12.md; diagnosed in
// reports/agentrecall-fix4-retrieval-2026-09-11.md Escalation §1).
//
// SHIPPED DESIGN (the brief's fallback clause, after its primary D1
// "banded tie-break" measured 65.0% — below the 70% exit gate — on the
// twin-clone golden eval): FULL NEUTRALIZATION. The multiplicative
// hot-window boost (fused RRF scores ×3.0/×2.0/×1.3 for items dated
// <6h/<24h/<72h) is removed from every default surface; freshness plays NO
// role in default ranking; exact fused-score ties resolve by the fix4
// authority/insertion order (corrections first). The legacy boost survives
// verbatim SOLELY behind the explicit `freshnessBias` opt-in, for the one
// audited caller whose downstream score floor was calibrated against
// boosted magnitudes (the CLI ambient-injection hook's `score >= 0.03`).
//
// Pins (the fix4b exit-gate classes, mapped onto the shipped design):
//   (a) an off-topic FRESH item cannot outrank an on-topic OLDER item —
//       the exact failure mode the ×3/×2/×1.3 multipliers caused
//   (b) the freshness feature's disposition, pinned BOTH ways: default →
//       ties resolve by authority, freshness contributes nothing;
//       freshnessBias:true → the fresh item outranks (feature preserved
//       behind the opt-in, "what did we just do" for the ambient surface)
//   (c) palace items' regex-scraped excerpt dates earn nothing on the
//       default path (fix4 Finding 2's mis-bucketing class, retired) —
//       and the legacy opt-in still trusts them (characterized, documented)
//   (d) exact-tie determinism: cross-tier ties at 1/(60+r) are the common
//       case post one-doc-one-vote; their resolution is the stable
//       authority/insertion order, byte-stable across runs
//
// Every test pins a MECHANISM, never a fixture query — the golden-query
// fixture is hash-locked and never referenced here. This file is NEW; no
// fence/trust test was modified (fix4b brief hard rule).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  setRoot,
  resetRoot,
  resetRecallBackend,
  journalDir,
  palaceDir,
  queryMemory,
} from "../dist/index.js";
import { localRecallSearch } from "../dist/tools-logic/smart-recall.js";
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
  // Same base resolution as fix4-retrieval-ranking.test.mjs: corrections.ts's
  // private correctionsDir(project) is projectSubPath(project, "corrections")
  // — journalDir's dirname + "corrections" reaches the identical directory.
  return path.join(path.dirname(journalDir(project)), "corrections");
}

/** Date string N days before now (UTC), YYYY-MM-DD. */
function daysAgo(n) {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Seed an old (>72h, outside every legacy hot window) correction whose rule
 *  carries `term` — corrections-tier rank-1 by construction (sole record). */
function seedOldCorrection(project, term) {
  const dir = correctionsDirFor(project);
  fs.mkdirSync(dir, { recursive: true });
  const id = `${daysAgo(10)}-fix4b-rule`;
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      date: daysAgo(10),
      severity: "p0",
      project,
      rule: `Never rotate the ${term} credentials without owner approval`,
      context: "",
      tags: [],
    }),
  );
  return id;
}

const RRF_RANK1 = 1 / 61;
const RRF_RANK2 = 1 / 62;

// ---------------------------------------------------------------------------
// (a) — fresh-but-off-topic never outranks on-topic-but-old
// ---------------------------------------------------------------------------

describe("fix4b (a) — an off-topic FRESH item cannot outrank an on-topic OLDER item", () => {
  const SAVED_ENV = {};
  let TMP;

  before(() => {
    stashBackendEnv(SAVED_ENV);
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ar-fix4b-a-"));
    setRoot(TMP);
    resetRecallBackend();
  });
  after(() => {
    resetRoot();
    resetRecallBackend();
    restoreBackendEnv(SAVED_ENV);
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("today-dated journal entries score their raw RRF sums and rank below the older on-topic correction", async () => {
    const PROJECT = "fix4b-a-bands";
    const TERM = "zzfbhotalpha4471";

    // The golden: an OLD correction matching BOTH query words (corrections
    // tier rank 1 → fused 1/61).
    seedOldCorrection(PROJECT, TERM);

    // Two FRESH (today-dated) journal entries matching only the generic
    // query word "credentials" — the off-topic-but-recent diary class that
    // the old boost vaulted to the top of every query. Different `## `
    // sections so smart_recall's perSectionDedupe keeps both competitive
    // slots; different wording so fusionIdentity doesn't collapse them.
    const jdir = journalDir(PROJECT);
    fs.mkdirSync(jdir, { recursive: true });
    fs.writeFileSync(
      path.join(jdir, `${daysAgo(0)}--card--fresh1.md`),
      `## alpha\n\nrotated the credentials for the staging cluster today\n`,
    );
    fs.writeFileSync(
      path.join(jdir, `${daysAgo(0)}--card--fresh2.md`),
      `## beta\n\nchecked the credentials dashboard for upcoming expiry\n`,
    );

    const results = await localRecallSearch(`${TERM} credentials`, PROJECT, 10);
    const corrIdx = results.findIndex((r) => r.source === "corrections");
    const journalItems = results.filter((r) => r.source === "journal");
    assert.ok(corrIdx !== -1, `correction must surface; got ${JSON.stringify(results.map((r) => [r.source, r.score]))}`);
    assert.equal(
      journalItems.length,
      2,
      `both fresh journal entries must surface as separate slots (different sections); got ` +
      `${JSON.stringify(results.map((r) => [r.source, r.title, r.score]))}`,
    );

    // The correction's fused score is the RAW rank-1 RRF sum, and every
    // fresh journal score is its raw sum too — nothing is multiplied.
    // Pre-fix4b the fresh entries scored 1/61×2|×3 and 1/62×2|×3
    // (0.0328–0.0492) and BOTH vaulted the un-boosted golden (0.0164) — the
    // measured cause of the golden eval's 55%→75% hit-rate gap.
    assert.ok(
      Math.abs(results[corrIdx].score - RRF_RANK1) < 1e-9,
      `correction must score the raw rank-1 RRF sum ${RRF_RANK1}; got ${results[corrIdx].score}`,
    );
    for (const j of journalItems) {
      assert.ok(
        Math.abs(j.score - RRF_RANK1) < 1e-9 || Math.abs(j.score - RRF_RANK2) < 1e-9,
        `journal scores must be raw RRF sums (1/61 or 1/62), never multiplied; got ${j.score}`,
      );
    }
    assert.equal(
      corrIdx,
      0,
      `the on-topic older correction must rank FIRST: it ties the journal-rank-1 fresh entry at 1/61 ` +
      `(authority order wins the tie) and strictly outscores the rank-2 one; got ` +
      `${JSON.stringify(results.map((r) => [r.source, r.score]))}`,
    );
  });
});

// ---------------------------------------------------------------------------
// (b) — the freshness feature's disposition: default OFF, alive behind opt-in
// ---------------------------------------------------------------------------

describe("fix4b (b) — freshness contributes nothing by default; freshnessBias preserves the 'what did we just do' behavior", () => {
  const SAVED_ENV = {};
  let TMP;

  before(() => {
    stashBackendEnv(SAVED_ENV);
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ar-fix4b-b-"));
    setRoot(TMP);
    resetRecallBackend();
  });
  after(() => {
    resetRoot();
    resetRecallBackend();
    restoreBackendEnv(SAVED_ENV);
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("DEFAULT: at an exact fused-score tie (both tier-rank-1, 1/61) the AUTHORITY order decides — the fresh journal entry does not pass the old correction", async () => {
    const PROJECT = "fix4b-b-default";
    const TERM = "zzfbhotbravo5582";
    seedOldCorrection(PROJECT, TERM);
    const jdir = journalDir(PROJECT);
    fs.mkdirSync(jdir, { recursive: true });
    fs.writeFileSync(
      path.join(jdir, `${daysAgo(0)}--card--now.md`),
      `## worklog\n\nwe just rotated the ${TERM} credentials with the owner watching\n`,
    );

    const results = await localRecallSearch(`${TERM} credentials`, PROJECT, 10);
    const corrIdx = results.findIndex((r) => r.source === "corrections");
    const jourIdx = results.findIndex((r) => r.source === "journal");
    assert.ok(corrIdx !== -1 && jourIdx !== -1, `both must surface; got ${JSON.stringify(results.map((r) => [r.source, r.score]))}`);
    assert.ok(
      Math.abs(results[corrIdx].score - results[jourIdx].score) < 1e-9,
      `precondition: both tier-rank-1 items must genuinely TIE on fused score (1/61); got ` +
      `${results[corrIdx].score} vs ${results[jourIdx].score}`,
    );
    assert.ok(
      corrIdx < jourIdx,
      `fix4b fallback: freshness plays NO role in default ranking — the tie resolves by the fix4 ` +
      `authority order (corrections first), today-dated or not. (The brief's primary D1 design let ` +
      `hotness win this band; it measured 65% vs the fallback's 75% and was not shipped.) got ` +
      `${JSON.stringify(results.map((r) => [r.source, r.date, r.score]))}`,
    );
  });

  it("freshnessBias:true — the SAME store, same query: the fresh journal entry now outranks the old correction (legacy ×2/×3 vaulting, preserved behind the opt-in)", async () => {
    const PROJECT = "fix4b-b-optin";
    const TERM = "zzfbhotcharlie6693";
    seedOldCorrection(PROJECT, TERM);
    const jdir = journalDir(PROJECT);
    fs.mkdirSync(jdir, { recursive: true });
    fs.writeFileSync(
      path.join(jdir, `${daysAgo(0)}--card--now.md`),
      `## worklog\n\nwe just rotated the ${TERM} credentials with the owner watching\n`,
    );

    const results = await localRecallSearch(`${TERM} credentials`, PROJECT, 10, undefined, true);
    const corrIdx = results.findIndex((r) => r.source === "corrections");
    const jourIdx = results.findIndex((r) => r.source === "journal");
    assert.ok(corrIdx !== -1 && jourIdx !== -1, `both must surface; got ${JSON.stringify(results.map((r) => [r.source, r.score]))}`);
    assert.ok(
      jourIdx < corrIdx,
      `under the legacy opt-in the today-dated entry (×2/×3) must outrank the >72h correction (×1) — ` +
      `this IS the preserved "what did we just do" behavior for the audited ambient caller; got ` +
      `${JSON.stringify(results.map((r) => [r.source, r.date, r.score]))}`,
    );
    assert.ok(
      results[jourIdx].score > RRF_RANK1 * 1.9,
      `the opt-in must reproduce the legacy multiplied magnitude (≥ ×2 for a today-dated item); ` +
      `got ${results[jourIdx].score}`,
    );
    assert.ok(
      Math.abs(results[corrIdx].score - RRF_RANK1) < 1e-9,
      `the >72h correction stays unmultiplied even under the opt-in (legacy semantics, verbatim); ` +
      `got ${results[corrIdx].score}`,
    );
  });
});

// ---------------------------------------------------------------------------
// (c) — palace regex-scraped dates earn nothing on the default path
// ---------------------------------------------------------------------------

describe("fix4b (c) — palace items' scraped excerpt dates earn no ranking advantage by default", () => {
  const SAVED_ENV = {};
  let TMP;

  before(() => {
    stashBackendEnv(SAVED_ENV);
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ar-fix4b-c-"));
    setRoot(TMP);
    resetRecallBackend();
  });
  after(() => {
    resetRoot();
    resetRecallBackend();
    restoreBackendEnv(SAVED_ENV);
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("DEFAULT: a palace line QUOTING today's date scores raw 1/61 and does not beat the tied old correction (pre-fix4b it collected ×2/×3 and vaulted — fix4 audit Finding 2)", async () => {
    const PROJECT = "fix4b-c-palace";
    const TERM = "zzfbhotdelta7714";
    seedOldCorrection(PROJECT, TERM);
    // Palace mention whose matching line CONTAINS today's date —
    // scorePalaceTier regex-scrapes it into item.date. The scraped date is
    // NOT a timestamp (the field's own doc comment); the old boost trusted
    // it anyway, so a years-old note merely quoting a recent date collected
    // the full multiplier.
    ensurePalaceInitialized(PROJECT);
    fs.writeFileSync(
      path.join(palaceDir(PROJECT), "rooms", "knowledge", "mention.md"),
      `---\ntopic: mention\n---\n\n${TERM} credentials probed on ${daysAgo(0)}\n`,
    );

    const results = await localRecallSearch(`${TERM} credentials`, PROJECT, 10);
    const corrIdx = results.findIndex((r) => r.source === "corrections");
    const palIdx = results.findIndex((r) => r.source === "palace");
    assert.ok(corrIdx !== -1 && palIdx !== -1, `both must surface; got ${JSON.stringify(results.map((r) => [r.source, r.score]))}`);
    // Precondition: the palace item really did scrape today's date (the
    // exact signal the old boost vaulted on).
    assert.equal(
      results[palIdx].date,
      daysAgo(0),
      `precondition: the palace item must carry the scraped fresh date; got ${results[palIdx].date}`,
    );
    assert.ok(
      Math.abs(results[palIdx].score - RRF_RANK1) < 1e-9,
      `palace score must be the RAW rank-1 RRF sum (${RRF_RANK1}) — pre-fix4b the scraped fresh date ` +
      `earned it ×2/×3; got ${results[palIdx].score}`,
    );
    assert.ok(
      corrIdx < palIdx,
      `at the exact tie the authority order (corrections first) must decide, exactly as if the ` +
      `palace item were undated; got ${JSON.stringify(results.map((r) => [r.source, r.date, r.score]))}`,
    );
  });

  it("CHARACTERIZATION: the freshnessBias legacy path still trusts scraped palace dates (defect preserved verbatim inside the opt-in, documented — not an endorsement)", async () => {
    const PROJECT = "fix4b-c2-legacy";
    const TERM = "zzfbhotecho8825";
    seedOldCorrection(PROJECT, TERM);
    ensurePalaceInitialized(PROJECT);
    fs.writeFileSync(
      path.join(palaceDir(PROJECT), "rooms", "knowledge", "mention.md"),
      `---\ntopic: mention\n---\n\n${TERM} credentials probed on ${daysAgo(0)}\n`,
    );

    const results = await localRecallSearch(`${TERM} credentials`, PROJECT, 10, undefined, true);
    const palIdx = results.findIndex((r) => r.source === "palace");
    assert.ok(palIdx !== -1, `palace item must surface; got ${JSON.stringify(results.map((r) => [r.source, r.score]))}`);
    assert.ok(
      results[palIdx].score > RRF_RANK1 * 1.9,
      `legacy opt-in semantics are the pre-fix4b code VERBATIM — including boosting a palace item on ` +
      `its regex-scraped excerpt date (≥ ×2 for a today-dated scrape). If this pin ever fails because ` +
      `palace was exempted inside the legacy path too, that is a deliberate contract change to the ` +
      `opt-in — update SmartRecallInput.freshnessBias's doc comment in the same change. got ` +
      `${results[palIdx].score}`,
    );
  });
});

// ---------------------------------------------------------------------------
// (d) — exact-tie determinism + opt-in magnitude contract
// ---------------------------------------------------------------------------

describe("fix4b (d) — exact cross-tier ties resolve deterministically; the opt-in reproduces the audited magnitude contract", () => {
  const SAVED_ENV = {};
  let TMP;

  before(() => {
    stashBackendEnv(SAVED_ENV);
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ar-fix4b-d-"));
    setRoot(TMP);
    resetRecallBackend();
  });
  after(() => {
    resetRoot();
    resetRecallBackend();
    restoreBackendEnv(SAVED_ENV);
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("a four-way exact tie (all four tiers rank-1 at 1/61) orders by tier insertion: corrections, palace, journal — byte-stable across repeated runs", async () => {
    const PROJECT = "fix4b-d-tie";
    const TERM = "zzfbhotfoxtrot9936";
    seedOldCorrection(PROJECT, TERM);
    ensurePalaceInitialized(PROJECT);
    fs.writeFileSync(
      path.join(palaceDir(PROJECT), "rooms", "knowledge", "mention.md"),
      `---\ntopic: mention\n---\n\nsomeone mentioned ${TERM} credentials in passing\n`,
    );
    const jdir = journalDir(PROJECT);
    fs.mkdirSync(jdir, { recursive: true });
    fs.writeFileSync(
      path.join(jdir, `${daysAgo(0)}--card--now.md`),
      `## worklog\n\ntouched the ${TERM} credentials rollout just now\n`,
    );

    const runs = [];
    for (let i = 0; i < 3; i++) {
      const results = await localRecallSearch(`${TERM} credentials`, PROJECT, 10);
      runs.push(results.map((r) => r.source).join(","));
      const tied = results.filter((r) => Math.abs(r.score - RRF_RANK1) < 1e-9);
      assert.ok(
        tied.length >= 3,
        `precondition: at least corrections+palace+journal must tie at 1/61; got ` +
        `${JSON.stringify(results.map((r) => [r.source, r.score]))}`,
      );
      const order = results.map((r) => r.source);
      assert.deepEqual(
        order.slice(0, 3),
        ["corrections", "palace", "journal"],
        `an exact tie must resolve by tier insertion order (the fix4 authority order) — post ` +
        `one-doc-one-vote this is the COMMON case, not an edge case; got ${JSON.stringify(order)}`,
      );
    }
    assert.equal(new Set(runs).size, 1, `tie resolution must be byte-stable across runs; got ${JSON.stringify(runs)}`);
  });

  it("queryMemory freshnessBias contract: default raw 1/61; opted-in ≥ ×2 for a today-dated item, clearing the CLI ambient 0.03 floor", async () => {
    const PROJECT = "fix4b-d-optin";
    const TERM = "zzfbhotgolf0047";
    const jdir = journalDir(PROJECT);
    fs.mkdirSync(jdir, { recursive: true });
    fs.writeFileSync(
      path.join(jdir, `${daysAgo(0)}--card--now.md`),
      `## worklog\n\ntouched the ${TERM} rollout just now\n`,
    );

    const raw = await queryMemory({ query: TERM, project: PROJECT, tiers: ["corrections", "palace", "journal", "insight"] });
    assert.equal(raw.items.length, 1, `expected exactly 1 result, got ${JSON.stringify(raw.items)}`);
    assert.ok(
      Math.abs(raw.items[0].score - RRF_RANK1) < 1e-9,
      `DEFAULT is the honest raw score (${RRF_RANK1}); got ${raw.items[0].score}`,
    );

    const biased = await queryMemory({
      query: TERM, project: PROJECT,
      tiers: ["corrections", "palace", "journal", "insight"],
      freshnessBias: true,
    });
    assert.equal(biased.items.length, 1);
    // A today-dated bare YYYY-MM-DD parses to 00:00 UTC → hoursAgo ∈ [0,24)
    // → the legacy boost is ×3 (before 06:00 UTC) or ×2 — either way ≥ ×2,
    // which is what lets the CLI ambient caller's `score >= 0.03` floor pass
    // (0.0328 or 0.0492 vs 0.0164 raw).
    assert.ok(
      biased.items[0].score > RRF_RANK1 * 1.9,
      `freshnessBias must reproduce the legacy multiplied magnitude (≥ ×2 for a today-dated item); ` +
      `got ${biased.items[0].score} vs raw ${RRF_RANK1}`,
    );
    assert.ok(
      biased.items[0].score >= 0.03,
      `the audited caller contract: a fresh single-source item must clear the CLI ambient 0.03 floor ` +
      `under the opt-in; got ${biased.items[0].score}`,
    );
  });
});
