// packages/core/test/safety-consolidation.test.mjs
//
// L2 — runSafetyConsolidation is the LOGIN-FREE / LLM-FREE background safety
// pass. It wires three previously-dead-or-rarely-run steps together:
//   (a) decay   — stale skills/rooms flagged archived (via consolidateJournalToPalace)
//   (b) prune   — aged + distilled raw segments gzipped (pruneRawArchive, was dead)
//   (c) graduate — above-threshold crystallization candidates re-titled CRYSTALLIZED:
//
// Invariants under test (per the L2 brief):
//   1. with NO OPENAI_API_KEY and NO Claude login (env unset) the pass succeeds
//      and FIRES the steps (old+consumed segment pruned, stale skill decays,
//      above-threshold candidate graduates).
//   2. idempotency — a 2nd run is a no-op (no double-prune, no duplicate graduation).
//   3. one step throwing does NOT abort the others.
//   4. dryRun writes NOTHING.
//
// Tests import from the COMPILED package (../dist) and drive a temp root via
// setRoot/resetRoot, mirroring archive-prune.test.mjs.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  setRoot,
  resetRoot,
  archiveRawDir,
  writeAwarenessState,
  readAwarenessState,
  findCrystallizationCandidates,
  runSafetyConsolidation,
  DEFAULT_GRADUATION_MIN_CONFIRMATIONS,
} from "agent-recall-core";
import * as skills from "../dist/palace/skills.js";
import * as rooms from "../dist/palace/rooms.js";

const PROJECT = "safety-demo"; // clean slug → sanitizeSlug is identity
const DAY_MS = 86_400_000;

describe("runSafetyConsolidation (L2 — login-free safety pass)", () => {
  let tmpDir;
  let rawDir;
  let savedOpenAiKey;

  /** Write a raw archive segment and backdate its mtime by `ageDays`. */
  function writeSegment(name, body, ageDays) {
    const full = path.join(rawDir, name);
    fs.writeFileSync(full, body);
    const tSec = (Date.now() - ageDays * DAY_MS) / 1000;
    fs.utimesSync(full, tSec, tSec);
    return full;
  }

  /** Seed a stale FSRS skill (retrievability below the archive threshold). */
  function writeStaleSkill(slug) {
    const old = new Date(Date.now() - 200 * DAY_MS).toISOString();
    return skills.writeSkill(
      PROJECT,
      {
        slug,
        name: slug,
        topic: "deploy",
        triggers: [slug],
        created: old,
        updated: old,
        source: "manual",
        fsrs: { stability: 5, last_confirmed: old, confirmations: 1 },
      },
      { when: "w", preconditions: [], steps: ["s"], postconditions: ["p"] },
    );
  }

  /** Seed an above-threshold crystallization cluster: ≥3 insights sharing ≥2
   *  appliesWhen keywords, total confirmations ≥ the graduation floor. */
  function seedCrystallizationCluster() {
    const now = new Date().toISOString();
    const shared = ["deploy", "rollback"]; // ≥2 shared keywords binds the cluster
    const mk = (n, confirmations) => ({
      id: `insight-${n}`,
      title: `Deploy rollback discipline pattern number ${n}`,
      evidence: `evidence body for insight ${n} that is long enough to pass gate`,
      confirmations,
      lastConfirmed: now,
      appliesWhen: shared,
      source: "test-seed",
      source_project: PROJECT,
      trend: "stable",
    });
    writeAwarenessState({
      identity: "test user",
      // 3 insights, total confirmations 4+4+4 = 12 ≥ floor (8)
      topInsights: [mk(1, 4), mk(2, 4), mk(3, 4)],
      compoundInsights: [],
      trajectory: "",
      blindSpots: [],
      lastUpdated: now,
    });
  }

  beforeEach(() => {
    // The pass MUST work with NO OpenAI key and NO Claude login. Unset the key
    // for the duration of each test so we prove the login-free contract.
    savedOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-safety-"));
    setRoot(tmpDir);
    rawDir = archiveRawDir(PROJECT);
    fs.mkdirSync(rawDir, { recursive: true });
    rooms.ensurePalaceInitialized(PROJECT);
  });

  afterEach(() => {
    if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAiKey;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetRoot();
  });

  it("1) login-free: fires all three steps (prune, decay, graduate) with no OPENAI_API_KEY", async () => {
    assert.equal(process.env.OPENAI_API_KEY, undefined, "OPENAI_API_KEY must be unset");

    // (b) an old raw segment, distilled because it predates the retention window.
    const seg = writeSegment("2020-01-01--old-session.md", "VERBATIM OLD SESSION", 200);
    // (a) a stale skill that decay should flag archived.
    const skillPath = writeStaleSkill("ancient-deploy-skill");
    // (c) an above-threshold crystallization cluster.
    seedCrystallizationCluster();

    const res = await runSafetyConsolidation(PROJECT, { dryRun: false });

    // No step errored.
    assert.equal(res.decay.error, undefined, "decay step must not error");
    assert.equal(res.pruned.error, undefined, "prune step must not error");
    assert.equal(res.graduated.error, undefined, "graduate step must not error");
    assert.ok(res.decay.ran && res.pruned.ran && res.graduated.ran, "all three steps ran");

    // (b) the aged segment was gzipped (the marker advanced, prune fired).
    assert.equal(res.pruned.gzipped, 1, "the old distilled segment is gzipped");
    assert.ok(!fs.existsSync(seg), "original .md removed");
    assert.ok(fs.existsSync(seg + ".gz"), ".md.gz written");
    assert.notEqual(res.pruned.consumedThrough, null, "consume marker advanced");

    // (a) the stale skill is flagged archived but NEVER deleted.
    assert.ok(res.decay.archived >= 1, "at least one object flagged archived");
    assert.ok(fs.existsSync(skillPath), "stale skill file is NOT deleted");
    const parsed = skills.parseSkillFile(skillPath);
    assert.equal(parsed.meta.archived, true, "stale skill flagged archived:true");

    // (c) the strongest member graduated to a CRYSTALLIZED: title.
    assert.ok(res.graduated.candidates >= 1, "a candidate was surfaced");
    assert.equal(res.graduated.graduated, 1, "exactly one cluster graduated");
    const state = readAwarenessState();
    const crystallized = state.topInsights.filter((i) => /^CRYSTALLIZED:/.test(i.title));
    assert.equal(crystallized.length, 1, "one insight re-titled CRYSTALLIZED:");
  });

  it("2) idempotency: a 2nd run is a no-op (no double-prune, no duplicate graduation)", async () => {
    const seg = writeSegment("2020-02-02--old-session.md", "DATA", 200);
    seedCrystallizationCluster();

    const first = await runSafetyConsolidation(PROJECT, { dryRun: false });
    assert.equal(first.pruned.gzipped, 1, "first run gzips the segment");
    assert.equal(first.graduated.graduated, 1, "first run graduates one cluster");

    const second = await runSafetyConsolidation(PROJECT, { dryRun: false });
    // Nothing new to prune (the .md is gone; only .md.gz remains).
    assert.equal(second.pruned.gzipped, 0, "2nd run gzips nothing");
    assert.equal(second.pruned.eligible, 0, "no eligible segments on re-run");
    assert.ok(!fs.existsSync(seg), "original still gone");
    // Already-CRYSTALLIZED insight is excluded from candidates ⇒ no re-graduation.
    assert.equal(second.graduated.graduated, 0, "2nd run graduates nothing");
    const state = readAwarenessState();
    const crystallized = state.topInsights.filter((i) => /^CRYSTALLIZED:/.test(i.title));
    assert.equal(crystallized.length, 1, "still exactly one CRYSTALLIZED: insight (no duplicate)");
  });

  it("3) one step throwing does NOT abort the others", async () => {
    // Force the GRADUATE step to throw by corrupting awareness-state.json so
    // readAwarenessState returns null AND findCrystallizationCandidates is asked
    // to operate on garbage. To make the THROW deterministic, monkey-patch is
    // overkill — instead corrupt the prune input dir while keeping decay + a
    // valid prunable segment intact, then assert the surviving steps still ran.
    //
    // Strategy: make the consume marker unreadable-as-JSON so advanceConsumeMarker
    // throws, then assert decay + graduate still ran (per-step try/catch isolation).
    writeSegment("2020-03-03--old-session.md", "DATA", 200);
    writeStaleSkill("ancient-skill-2");
    seedCrystallizationCluster();

    // Make the raw dir a FILE where pruneRawArchive/advanceConsumeMarker expect a
    // dir → forces the prune step to throw inside runSafetyConsolidation.
    // (We point archiveRawDir at a path we then clobber.)
    const markerPath = path.join(rawDir, ".consumed.json");
    // Write a directory in place of the marker file so writeJsonAtomic throws.
    fs.mkdirSync(markerPath, { recursive: true });

    const res = await runSafetyConsolidation(PROJECT, { dryRun: false });

    // The prune step is sabotaged...
    assert.ok(res.pruned.error !== undefined || res.pruned.gzipped === 0,
      "prune step degraded (errored or pruned nothing) due to the clobbered marker");
    // ...but decay and graduate STILL ran (per-step isolation).
    assert.equal(res.decay.error, undefined, "decay still succeeds");
    assert.ok(res.decay.ran, "decay step still ran");
    assert.equal(res.graduated.error, undefined, "graduate still succeeds");
    assert.ok(res.graduated.ran, "graduate step still ran");
    assert.equal(res.graduated.graduated, 1, "graduate still fired despite prune failing");
  });

  it("4) dryRun writes NOTHING (no prune, no decay flag, no graduation)", async () => {
    const seg = writeSegment("2020-04-04--old-session.md", "DATA", 200);
    const skillPath = writeStaleSkill("ancient-skill-3");
    seedCrystallizationCluster();

    // Seed the consume marker so we can prove dryRun does not advance it.
    fs.writeFileSync(
      path.join(rawDir, ".consumed.json"),
      JSON.stringify({ lastConsumedOffset: 0, lastConsumedAt: null }),
    );

    const res = await runSafetyConsolidation(PROJECT, { dryRun: true });

    assert.equal(res.dryRun, true);
    // (b) nothing gzipped, original untouched, no .gz written.
    assert.equal(res.pruned.gzipped, 0, "dryRun gzips nothing");
    assert.ok(fs.existsSync(seg), "original segment untouched");
    assert.ok(!fs.existsSync(seg + ".gz"), "no .gz written in dryRun");
    // The consume marker must NOT have been advanced on disk.
    const marker = JSON.parse(fs.readFileSync(path.join(rawDir, ".consumed.json"), "utf-8"));
    assert.equal(marker.lastConsumedAt ?? null, null, "consume marker not advanced in dryRun");

    // (a) decay reports candidates but the skill flag is NOT written.
    const parsed = skills.parseSkillFile(skillPath);
    assert.notEqual(parsed.meta.archived, true, "skill NOT flagged archived in dryRun");

    // (c) graduation is computed but NOT written.
    assert.ok(res.graduated.graduated >= 1, "dryRun still reports a would-graduate count");
    const state = readAwarenessState();
    const crystallized = state.topInsights.filter((i) => /^CRYSTALLIZED:/.test(i.title));
    assert.equal(crystallized.length, 0, "no insight re-titled CRYSTALLIZED: in dryRun");
  });
});
