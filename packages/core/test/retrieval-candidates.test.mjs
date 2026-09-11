/**
 * retrieval-candidates.test.mjs — Wave 1 (2026-08-29, plywood SOP 58053587).
 *
 * Proves `readTierCandidates()` (packages/core/src/retrieval/candidates.ts)
 * is BEHAVIORALLY EQUIVALENT (content-hash superset, per the kickoff plan's
 * exit criterion #2) to >=2 existing independent scanners for EACH tier —
 * before anything migrates to call it — plus that identity-trust tagging
 * (isRescueSourcedContent) is correctly baked into both tiers.
 *
 * "Superset" (not exact-equal) is the deliberately chosen bar: MemoryCandidate
 * carries strictly more fields than any single existing scanner returns, and
 * a couple of existing scanners apply their OWN narrower filters (e.g.
 * palace-lint.ts excludes README.md for lint-specific reasons) — so this
 * suite hashes raw file CONTENT per candidate and asserts the new reader's
 * content-hash set is a superset of each comparison scanner's own set,
 * reproducing each scanner's read logic inline (not importing its internal,
 * unexported helpers) so the comparison is genuinely independent.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

const TEST_ROOT = path.join(os.tmpdir(), "ar-retrieval-candidates-" + Date.now());

function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf-8").digest("hex");
}

describe("retrieval/candidates.ts — readTierCandidates", () => {
  let core;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core = await import("../dist/index.js");
    core.setRoot(TEST_ROOT);
  });

  after(() => {
    core.resetRoot?.();
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(TEST_ROOT, "projects"), { recursive: true, force: true });
  });

  // ── journal tier ─────────────────────────────────────────────────────────
  describe("journal tier", () => {
    const PROJECT = "candidates-journal-demo";

    function seedJournalFixture() {
      const jdir = core.journalDir(PROJECT);
      fs.mkdirSync(jdir, { recursive: true });
      fs.writeFileSync(path.join(jdir, "2026-08-27--card--live1.md"), "# live entry one\nUNIQUE_LIVE_ONE\n", "utf-8");
      fs.writeFileSync(path.join(jdir, "2026-08-28--card--live2.md"), "# live entry two\nUNIQUE_LIVE_TWO\n", "utf-8");

      const archiveDir = path.join(jdir, "archive");
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(path.join(archiveDir, "2026-W01.md"), "## rollup\nUNIQUE_ROLLUP_ENTRY\n", "utf-8");

      core.archiveSession({
        project: PROJECT,
        sessionId: "raw-session-0001",
        rawTranscript: "UNIQUE_RAW_ARCHIVE_TRANSCRIPT",
      });
    }

    it("default call (no opts) is a content-hash superset of listJournalFiles(project, false)'s own reads — live files only, no rollup/raw", () => {
      seedJournalFixture();

      // Independent comparison scanner #1: helpers/journal-files.ts's
      // listJournalFiles() — the existing partial shared reader.
      const listed = core.listJournalFiles(PROJECT, false);
      const expected = new Set(
        listed.map((e) => sha256(fs.readFileSync(path.join(e.dir, e.file), "utf-8"))),
      );
      assert.ok(expected.size > 0, "sanity: fixture must produce at least one live journal file");

      const candidates = core.readTierCandidates("journal", PROJECT);
      const got = new Set(candidates.map((c) => sha256(c.content)));
      for (const hash of expected) {
        assert.ok(got.has(hash), `readTierCandidates("journal") missing a hash listJournalFiles(false) returned`);
      }
      // No rollup/raw leaked in by default.
      assert.ok(!candidates.some((c) => c.content.includes("UNIQUE_ROLLUP_ENTRY")), "default call must NOT include rollup archive");
      assert.ok(!candidates.some((c) => c.content.includes("UNIQUE_RAW_ARCHIVE_TRANSCRIPT")), "default call must NOT include raw archive");
      assert.ok(candidates.every((c) => c.sourceKind === "journal-live"), "every default candidate must be sourceKind journal-live");
    });

    it("{includeRollupArchive:true} is a content-hash superset of listJournalFiles(project, true) AND of journal-search.ts's own independent journalDirs(slug,true) scan", () => {
      seedJournalFixture();

      // Comparison scanner #1: listJournalFiles(project, true).
      const listedWithArchive = core.listJournalFiles(PROJECT, true);
      const expected1 = new Set(
        listedWithArchive.map((e) => sha256(fs.readFileSync(path.join(e.dir, e.file), "utf-8"))),
      );

      // Comparison scanner #2: journal-search.ts's OWN independent scan —
      // reproduced inline (journalDirs(slug, true) + readdirSync + .md
      // filter), since journal-search.ts's real function does its own
      // keyword-matching, not a raw file dump.
      // RETARGETED (fix4, 2026-09-11): the reproduction now applies the SAME
      // generated-index / reserved-namespace exclusion (`index.md`, `_*`)
      // the reader gained — an INTENDED divergence from the historical raw
      // scan: `journal/archive/index.md` is a generated TOC (appended by
      // archiveSession), not a journal entry, and matching it floods the
      // competitive surface. The superset guarantee this test protects
      // (no real ENTRY the old scanners saw is lost) is unchanged.
      const dirs = core.journalDirs(PROJECT, true);
      const expected2 = new Set();
      for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "index.md" && !f.startsWith("_"))) {
          expected2.add(sha256(fs.readFileSync(path.join(dir, f), "utf-8")));
        }
      }
      assert.ok(expected1.size > 0 && expected2.size > 0, "sanity: fixture must produce entries in both comparisons");

      const candidates = core.readTierCandidates("journal", PROJECT, { includeRollupArchive: true });
      const got = new Set(candidates.map((c) => sha256(c.content)));
      for (const hash of expected1) assert.ok(got.has(hash), "missing a hash from listJournalFiles(true)");
      for (const hash of expected2) assert.ok(got.has(hash), "missing a hash from journal-search.ts's own journalDirs(true) scan");
      assert.ok(!candidates.some((c) => c.content.includes("UNIQUE_RAW_ARCHIVE_TRANSCRIPT")), "includeRollupArchive must still NOT include raw archive");
    });

    it("{includeRawArchive:true} is a content-hash superset of resurrect.ts's Source-2 scan AND smart-recall.ts's archiveSearch scan (both read archiveRawDir directly)", () => {
      seedJournalFixture();

      const rawDir = core.archiveRawDir(PROJECT);
      // Both resurrect.ts's Source 2 and smart-recall.ts's archiveSearch use
      // the identical filter: readdirSync + f.endsWith(".md"), raw content.
      const expected = new Set();
      for (const f of fs.readdirSync(rawDir).filter((f) => f.endsWith(".md"))) {
        expected.add(sha256(fs.readFileSync(path.join(rawDir, f), "utf-8")));
      }
      assert.ok(expected.size > 0, "sanity: archiveSession must have produced a raw-archive file");

      const candidates = core.readTierCandidates("journal", PROJECT, { includeRawArchive: true });
      const rawCandidates = candidates.filter((c) => c.sourceKind === "journal-archive-raw");
      const got = new Set(rawCandidates.map((c) => sha256(c.content)));
      for (const hash of expected) assert.ok(got.has(hash), "missing a hash both resurrect.ts and smart-recall.ts's raw-archive scanners would have returned");
      assert.ok(rawCandidates.some((c) => c.content.includes("UNIQUE_RAW_ARCHIVE_TRANSCRIPT")), "raw archive content must be reachable when opted in");
    });

    it("trust-tags a rescue-sourced journal entry as untrusted:true, leaves a genuine entry untrusted:false", () => {
      const jdir = core.journalDir(PROJECT);
      fs.mkdirSync(jdir, { recursive: true });
      fs.writeFileSync(
        path.join(jdir, "2026-08-29--card--genuine.md"),
        ["---", "source: hook-end", "---", "", "# genuine card", "GENUINE_UNIQUE_TERM"].join("\n"),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(jdir, "2026-08-29--card--rescued.md"),
        ["---", "source: working-memory-rescue", "---", "", "# rescued card", "RESCUED_UNIQUE_TERM"].join("\n"),
        "utf-8",
      );

      // includeUntrusted:true — this test inspects the `untrusted` FLAG
      // itself on a rescue-tagged candidate, which the W2 safe-by-default
      // fix now drops entirely under the plain default call (see the
      // "safe by default" describe block below for that behavior).
      const candidates = core.readTierCandidates("journal", PROJECT, { includeUntrusted: true });
      const genuine = candidates.find((c) => c.content.includes("GENUINE_UNIQUE_TERM"));
      const rescued = candidates.find((c) => c.content.includes("RESCUED_UNIQUE_TERM"));
      assert.ok(genuine && rescued, "both fixture files must be discoverable as candidates");
      assert.equal(genuine.untrusted, false, "a hook-end-sourced card must not be tagged untrusted");
      assert.equal(rescued.untrusted, true, "a working-memory-rescue-sourced card must be tagged untrusted");
    });

    // Independent review fix (2026-08-29, plywood SOP 58053587): sourceTag
    // must carry the RAW frontmatter source value alongside (not instead of)
    // the untrusted boolean — a rescue candidate must be BOTH sourceTag
    // "working-memory-rescue" AND untrusted:true; a hook-end candidate must
    // be BOTH sourceTag "hook-end" AND untrusted:false.
    it("preserves the raw frontmatter source value on sourceTag, alongside (not instead of) the untrusted boolean", () => {
      const jdir = core.journalDir(PROJECT);
      fs.mkdirSync(jdir, { recursive: true });
      fs.writeFileSync(
        path.join(jdir, "2026-08-29--card--sourcetag-genuine.md"),
        ["---", "source: hook-end", "---", "", "# genuine card", "SOURCETAG_GENUINE_TERM"].join("\n"),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(jdir, "2026-08-29--card--sourcetag-rescued.md"),
        ["---", "source: working-memory-rescue", "---", "", "# rescued card", "SOURCETAG_RESCUED_TERM"].join("\n"),
        "utf-8",
      );

      // includeUntrusted:true — see the previous test's comment.
      const candidates = core.readTierCandidates("journal", PROJECT, { includeUntrusted: true });
      const genuine = candidates.find((c) => c.content.includes("SOURCETAG_GENUINE_TERM"));
      const rescued = candidates.find((c) => c.content.includes("SOURCETAG_RESCUED_TERM"));
      assert.ok(genuine && rescued, "both fixture files must be discoverable as candidates");

      assert.equal(genuine.sourceTag, "hook-end", "a hook-end-sourced card's sourceTag must carry the raw value");
      assert.equal(genuine.untrusted, false, "the same hook-end candidate must still be untrusted:false");

      assert.equal(rescued.sourceTag, "working-memory-rescue", "a rescue-sourced card's sourceTag must carry the raw value");
      assert.equal(rescued.untrusted, true, "the same rescue candidate must still be untrusted:true");
    });

    // Independent review fix (2026-08-29, plywood SOP 58053587): meta is a
    // forward-compatible placeholder Wave 1 does not populate (the reader
    // parses nothing beyond source+date from frontmatter this wave) — it
    // must be present in the type (no consumer needs a cast to reference
    // it) but left undefined, a documented "possibly-empty-now" contract,
    // not a silently-broken promise of populated scoring inputs.
    it("carries an optional, currently-unpopulated meta field (forward-compatible placeholder, not pre-computed scores)", () => {
      const jdir = core.journalDir(PROJECT);
      fs.mkdirSync(jdir, { recursive: true });
      fs.writeFileSync(
        path.join(jdir, "2026-08-29--card--meta-demo.md"),
        ["---", "source: hook-end", "---", "", "# meta demo", "META_DEMO_UNIQUE_TERM"].join("\n"),
        "utf-8",
      );

      const candidates = core.readTierCandidates("journal", PROJECT);
      const demo = candidates.find((c) => c.content.includes("META_DEMO_UNIQUE_TERM"));
      assert.ok(demo, "fixture file must be discoverable as a candidate");
      assert.equal(demo.meta, undefined, "Wave 1 must not populate meta — it is a Wave 2+ forward-compatible placeholder only");
    });
  });

  // ── palace-room tier ─────────────────────────────────────────────────────
  describe("palace-room tier", () => {
    const PROJECT = "candidates-palace-demo";

    it("is a content-hash superset of palace-search.ts's own room-content enumeration AND palace-walk.ts's readRoomContent per-file reads", () => {
      core.ensurePalaceInitialized(PROJECT);
      core.createRoom(PROJECT, "candidates-room", "Candidates Room", "fixture room", []);
      const pd = core.palaceDir(PROJECT);
      const roomPath = path.join(pd, "rooms", "candidates-room");
      // README.md already exists (createRoom scaffolds it) — add one more topic file.
      fs.writeFileSync(path.join(roomPath, "extra-topic.md"), "### 2026-08-29 — high\nUNIQUE_TOPIC_ENTRY\n", "utf-8");
      // Also append a distinguishing marker into README.md so its content is non-trivial.
      fs.appendFileSync(path.join(roomPath, "README.md"), "\n### 2026-08-29 — medium\nUNIQUE_README_ENTRY\n", "utf-8");

      // Comparison scanner #1: palace-search.ts's own enumeration —
      // listRooms(slug) -> per-room readdirSync().filter(f.endsWith(".md")) -> readFileSync.
      // Reproduced inline since palaceSearch() itself does keyword scoring,
      // not a raw dump.
      const rooms = core.listRooms(PROJECT);
      const expected1 = new Set();
      for (const room of rooms) {
        const rp = path.join(pd, "rooms", room.slug);
        if (!fs.existsSync(rp)) continue;
        for (const f of fs.readdirSync(rp).filter((f) => f.endsWith(".md"))) {
          expected1.add(sha256(fs.readFileSync(path.join(rp, f), "utf-8")));
        }
      }

      // Comparison scanner #2: palace-walk.ts's readRoomContent — same file
      // enumeration (readdirSync().filter(f.endsWith(".md")).sort()), full
      // per-file raw content BEFORE readRoomContent's own 2000-char
      // per-file truncation/concatenation (which is a rendering-stage
      // transform, not part of "what content exists").
      const expected2 = new Set();
      for (const f of fs.readdirSync(roomPath).filter((f) => f.endsWith(".md")).sort()) {
        expected2.add(sha256(fs.readFileSync(path.join(roomPath, f), "utf-8")));
      }

      assert.ok(expected1.size >= 2 && expected2.size >= 2, "sanity: fixture must produce >=2 files (README.md + extra-topic.md)");

      const candidates = core.readTierCandidates("palace-room", PROJECT);
      const got = new Set(candidates.map((c) => sha256(c.content)));
      for (const hash of expected1) assert.ok(got.has(hash), "missing a hash palace-search.ts's own enumeration would have returned");
      for (const hash of expected2) assert.ok(got.has(hash), "missing a hash palace-walk.ts's readRoomContent would have returned");
      assert.ok(candidates.some((c) => c.content.includes("UNIQUE_README_ENTRY")), "README.md content must be included (matches the majority-scanner INCLUSIVE behavior)");
      assert.ok(candidates.some((c) => c.content.includes("UNIQUE_TOPIC_ENTRY")), "a non-README topic file must be included");
      // ensurePalaceInitialized also scaffolds the 5 default rooms, so a
      // room-unfiltered call legitimately returns candidates from those too
      // — every candidate must still carry tier:"palace-room" and SOME room,
      // but only the fixture's own two candidates must carry THIS room.
      assert.ok(candidates.every((c) => c.tier === "palace-room" && typeof c.room === "string"), "every candidate must carry tier:palace-room and a room slug");
      const thisRoomCandidates = candidates.filter((c) => c.room === "candidates-room");
      assert.equal(thisRoomCandidates.length, 2, "candidates-room must contribute exactly its own 2 files (README.md + extra-topic.md)");
    });

    it("{room: <slug>} restricts to that single room only", () => {
      core.ensurePalaceInitialized(PROJECT);
      core.createRoom(PROJECT, "room-a", "Room A", "fixture", []);
      core.createRoom(PROJECT, "room-b", "Room B", "fixture", []);
      const pd = core.palaceDir(PROJECT);
      fs.writeFileSync(path.join(pd, "rooms", "room-a", "topic.md"), "UNIQUE_ROOM_A_MARKER\n", "utf-8");
      fs.writeFileSync(path.join(pd, "rooms", "room-b", "topic.md"), "UNIQUE_ROOM_B_MARKER\n", "utf-8");

      const candidates = core.readTierCandidates("palace-room", PROJECT, { room: "room-a" });
      assert.ok(candidates.every((c) => c.room === "room-a"), "must only return room-a candidates");
      assert.ok(candidates.some((c) => c.content.includes("UNIQUE_ROOM_A_MARKER")));
      assert.ok(!candidates.some((c) => c.content.includes("UNIQUE_ROOM_B_MARKER")));
    });

    it("trust-tags a rescue-sourced room file as untrusted:true, leaves a genuine room file untrusted:false", () => {
      core.ensurePalaceInitialized(PROJECT);
      core.createRoom(PROJECT, "trust-room", "Trust Room", "fixture", []);
      const pd = core.palaceDir(PROJECT);
      const roomPath = path.join(pd, "rooms", "trust-room");
      fs.writeFileSync(
        path.join(roomPath, "genuine-topic.md"),
        ["---", "source: hook-end", "---", "", "GENUINE_ROOM_TERM"].join("\n"),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(roomPath, "rescued-topic.md"),
        ["---", "source: working-memory-rescue", "---", "", "RESCUED_ROOM_TERM"].join("\n"),
        "utf-8",
      );

      // includeUntrusted:true — see the journal-tier trust-tagging test's
      // comment above for why (W2 safe-by-default fix).
      const candidates = core.readTierCandidates("palace-room", PROJECT, { room: "trust-room", includeUntrusted: true });
      const genuine = candidates.find((c) => c.content.includes("GENUINE_ROOM_TERM"));
      const rescued = candidates.find((c) => c.content.includes("RESCUED_ROOM_TERM"));
      assert.ok(genuine && rescued, "both fixture topic files must be discoverable as candidates");
      assert.equal(genuine.untrusted, false, "a hook-end-sourced room file must not be tagged untrusted");
      assert.equal(rescued.untrusted, true, "a working-memory-rescue-sourced room file must be tagged untrusted (defense-in-depth — see harness allowlist reasoning for why this shouldn't occur via the live write path today, but the READER must not assume that forever)");
      // Independent review fix (2026-08-29, plywood SOP 58053587): sourceTag
      // must be populated identically for the palace-room tier (same
      // extractFrontmatterSource call as the journal tier).
      assert.equal(genuine.sourceTag, "hook-end", "a hook-end-sourced room file's sourceTag must carry the raw value");
      assert.equal(rescued.sourceTag, "working-memory-rescue", "a rescue-sourced room file's sourceTag must carry the raw value");
    });
  });

  // ── corrections tier (v4 W3, 2026-09-08) ────────────────────────────────
  describe("corrections tier", () => {
    const PROJECT = "candidates-corrections-demo";

    it("returns a MemoryCandidate per active correction, content=rule, meta carries context/confidence/decay_class/severity/correction_id/authoritative", () => {
      core.writeCorrection(PROJECT, {
        id: "2026-09-01-cand-basic",
        date: "2026-09-01",
        severity: "p0",
        project: PROJECT,
        rule: "Never CANDIDATES_UNIQUE_RULE_TERM without approval",
        context: "Never CANDIDATES_UNIQUE_RULE_TERM without approval — full context text CANDIDATES_UNIQUE_CONTEXT_TERM.",
        tags: ["cand"],
        confidence: "high",
        authoritative: true,
      });

      const candidates = core.readTierCandidates("corrections", PROJECT);
      const c = candidates.find((c) => c.content.includes("CANDIDATES_UNIQUE_RULE_TERM"));
      assert.ok(c, "fixture correction must be discoverable as a candidate");
      assert.equal(c.tier, "corrections");
      assert.equal(c.sourceKind, "corrections");
      assert.equal(c.date, "2026-09-01");
      assert.equal(c.untrusted, false, "corrections are untrusted:false by construction");
      assert.equal(c.sourceTag, undefined, "corrections are JSON, not frontmatter-tagged markdown — no source: tag to extract");
      assert.equal(c.content, "Never CANDIDATES_UNIQUE_RULE_TERM without approval", "content must be the rule text");
      assert.ok(c.meta, "meta bag must be populated for corrections (unlike journal/palace-room, which leave it undefined this wave)");
      assert.equal(c.meta.correction_id, "2026-09-01-cand-basic");
      assert.ok(c.meta.context.includes("CANDIDATES_UNIQUE_CONTEXT_TERM"), "meta.context must carry the fuller context text, separate from content");
      assert.equal(c.meta.confidence, "high");
      assert.equal(c.meta.decay_class, "slow");
      assert.equal(c.meta.severity, "p0");
      assert.equal(c.meta.authoritative, "true");
    });

    it("a retracted correction (active:false) is never returned — filtered at the FETCH stage via readActiveCorrections()", () => {
      core.writeCorrection(PROJECT, {
        id: "2026-09-01-cand-retract",
        date: "2026-09-01",
        severity: "p1",
        project: PROJECT,
        rule: "Always CANDIDATES_RETRACT_UNIQUE_TERM before merging",
        context: "Always CANDIDATES_RETRACT_UNIQUE_TERM before merging.",
        tags: [],
      });
      const before = core.readTierCandidates("corrections", PROJECT);
      assert.ok(before.some((c) => c.content.includes("CANDIDATES_RETRACT_UNIQUE_TERM")), "precondition: must surface before retraction");

      core.retractCorrection(PROJECT, "2026-09-01-cand-retract", "test");
      const after = core.readTierCandidates("corrections", PROJECT);
      assert.ok(!after.some((c) => c.content.includes("CANDIDATES_RETRACT_UNIQUE_TERM")), "a retracted correction must never be returned as a candidate");
    });

    it("a legacy no-fields record (no confidence/decay_class_override on disk) surfaces with DERIVED defaults, never undefined", () => {
      core.writeCorrection(PROJECT, {
        id: "2026-09-01-cand-legacy",
        date: "2026-09-01",
        severity: "p1",
        project: PROJECT,
        rule: "Never skip CANDIDATES_LEGACY_UNIQUE_TERM in a legacy record with no confidence field",
        context: "Never skip CANDIDATES_LEGACY_UNIQUE_TERM in a legacy record with no confidence field.",
        tags: [],
        // confidence / decay_class_override / authoritative deliberately omitted
      });
      const candidates = core.readTierCandidates("corrections", PROJECT);
      const c = candidates.find((c) => c.content.includes("CANDIDATES_LEGACY_UNIQUE_TERM"));
      assert.ok(c);
      assert.equal(c.meta.confidence, "medium", "p1 severity -> weight 0.7 -> derived confidence 'medium', never left blank");
      assert.equal(c.meta.decay_class, "slow", "no override present -> derived default 'slow'");
    });

    // Code-review LOW-2 (2026-09-08): a project with no corrections/
    // directory yet at all — must return an empty array, never throw. This
    // is already handled by readCorrections()'s own `!fs.existsSync(dir)`
    // guard (storage/corrections.ts), same pattern journal/palace-room rely
    // on for a never-touched tier; this test makes that reliance explicit
    // for the corrections tier specifically, rather than leaving it implicit.
    it("a project with no corrections/ directory at all returns an empty array, never throws", () => {
      const untouchedProject = "candidates-corrections-untouched-demo";
      const candidates = core.readTierCandidates("corrections", untouchedProject);
      assert.deepEqual(candidates, []);
    });

    // ── v4 PRE-SHIP GATE FIX (2026-09-08, security must-fix #2) ─────────────
    // CHARACTERIZATION test, not a correctness guarantee: machine-records
    // TODAY's documented residual (see readCorrectionCandidates's own doc
    // comment, "v4 PRE-SHIP GATE FIX ... security must-fix #1") by actually
    // planting a raw .json file into a project's corrections/ directory,
    // bypassing writeCorrection() entirely — mirroring the palace-room
    // tier's own "trust-tags a rescue-sourced room file" test above, which
    // plants a raw .md file directly rather than going through whatever a
    // room's normal write path is. Unlike that palace-room case (which HAS a
    // trust check — isRescueSourcedContent — and correctly flags the planted
    // file untrusted:true), this asserts the corrections tier's ACTUAL
    // current behavior: the planted record surfaces exactly like a genuine
    // one, untrusted:false, because readCorrections() has no equivalent
    // check to run — it JSON.parses any *.json file it finds, full stop.
    // This is the machine-recorded proof of a documented gap, NOT an
    // assertion that this is correct — a future provenance-stamping wave
    // should intentionally FLIP this test (assert the planted record is
    // rejected or flagged untrusted) when it closes the gap, rather than
    // discover it silently green for the wrong reason.
    it("CHARACTERIZATION (documented residual): a raw .json planted directly into corrections/, bypassing writeCorrection(), surfaces exactly like a genuine record — untrusted:false", () => {
      const plantedProject = "candidates-corrections-planted-demo";
      const dir = path.join(TEST_ROOT, "projects", plantedProject, "corrections");
      fs.mkdirSync(dir, { recursive: true });
      // Deliberately NOT core.writeCorrection() — a hand-written record, the
      // same shape a raw file-glob injection (attacker, or a buggy script)
      // dropping a file straight into this directory would produce.
      fs.writeFileSync(
        path.join(dir, "2026-09-08--planted.json"),
        JSON.stringify(
          {
            id: "2026-09-08-planted-cand",
            date: "2026-09-08",
            severity: "p0",
            project: plantedProject,
            rule: "PLANTED_CANDIDATES_UNIQUE_TERM never went through writeCorrection",
            context: "PLANTED_CANDIDATES_UNIQUE_TERM never went through writeCorrection.",
            tags: [],
            active: true,
          },
          null,
          2,
        ),
        "utf-8",
      );

      const candidates = core.readTierCandidates("corrections", plantedProject);
      const planted = candidates.find((c) => c.content.includes("PLANTED_CANDIDATES_UNIQUE_TERM"));
      assert.ok(planted, "the planted record must be discoverable — readCorrections() has no gate that would exclude it");
      assert.equal(
        planted.untrusted,
        false,
        "DOCUMENTED RESIDUAL: a planted file bypassing writeCorrection() is indistinguishable from a genuine record and surfaces untrusted:false — see readCorrectionCandidates's own doc comment",
      );
    });
  });

  // ── W2 independent-review fix (T1, HIGH) — readTierCandidates() is safe by
  // default ────────────────────────────────────────────────────────────────
  // Before this fix, `readTierCandidates()` was a PUBLIC, exported escape
  // hatch: a direct caller (which this file's own header literally instructs
  // a future retrieval surface to become) got raw, unfiltered candidates
  // back — `untrusted` was a mere FIELD, never enforced — reopening the
  // CRITICAL-2 rescue-quarantine injection gap this whole retrieval-pipeline
  // effort exists to close, one function further down than `queryMemory()`.
  describe("W2 independent-review fix — readTierCandidates() default call drops untrusted candidates (HIGH)", () => {
    const JOURNAL_PROJECT = "candidates-safe-default-journal-demo";
    const PALACE_PROJECT = "candidates-safe-default-palace-demo";

    it("journal tier: default call drops a rescue-tagged candidate; includeUntrusted:true still returns it (flagged); a non-rescue sourceTag candidate is KEPT under the default", () => {
      const jdir = core.journalDir(JOURNAL_PROJECT);
      fs.mkdirSync(jdir, { recursive: true });
      fs.writeFileSync(
        path.join(jdir, "2026-08-30--card--safe-default-rescued.md"),
        ["---", "source: working-memory-rescue", "---", "", "SAFE_DEFAULT_RESCUED_TERM"].join("\n"),
        "utf-8",
      );
      // Non-rescue sourceTag ("hook-end") — must be KEPT under the default:
      // sourceTag is a down-tier/attribution axis, never a drop axis;
      // dropping it too would lose genuine, merely-attributed content.
      fs.writeFileSync(
        path.join(jdir, "2026-08-30--card--safe-default-tagged.md"),
        ["---", "source: hook-end", "---", "", "SAFE_DEFAULT_TAGGED_TERM"].join("\n"),
        "utf-8",
      );

      const defaultCandidates = core.readTierCandidates("journal", JOURNAL_PROJECT);
      assert.ok(
        !defaultCandidates.some((c) => c.content.includes("SAFE_DEFAULT_RESCUED_TERM")),
        "default call (no opts) must NOT return a rescue-tagged candidate at all — this is the whole point of the HIGH fix",
      );
      const taggedDefault = defaultCandidates.find((c) => c.content.includes("SAFE_DEFAULT_TAGGED_TERM"));
      assert.ok(taggedDefault, "a non-rescue sourceTag candidate must still be returned under the default");
      assert.equal(taggedDefault.sourceTag, "hook-end");
      assert.equal(taggedDefault.untrusted, false);

      const withUntrusted = core.readTierCandidates("journal", JOURNAL_PROJECT, { includeUntrusted: true });
      const rescuedFlagged = withUntrusted.find((c) => c.content.includes("SAFE_DEFAULT_RESCUED_TERM"));
      assert.ok(rescuedFlagged, "includeUntrusted:true must still return the rescue-tagged candidate");
      assert.equal(rescuedFlagged.untrusted, true, "...correctly flagged untrusted:true, not silently trusted");
    });

    it("palace-room tier: default call drops a rescue-tagged room file; includeUntrusted:true still returns it (flagged)", () => {
      core.ensurePalaceInitialized(PALACE_PROJECT);
      core.createRoom(PALACE_PROJECT, "safe-default-room", "Safe Default Room", "fixture", []);
      const pd = core.palaceDir(PALACE_PROJECT);
      const roomPath = path.join(pd, "rooms", "safe-default-room");
      fs.writeFileSync(
        path.join(roomPath, "rescued.md"),
        ["---", "source: working-memory-rescue", "---", "", "SAFE_DEFAULT_PALACE_RESCUED_TERM"].join("\n"),
        "utf-8",
      );

      const defaultCandidates = core.readTierCandidates("palace-room", PALACE_PROJECT, { room: "safe-default-room" });
      assert.ok(
        !defaultCandidates.some((c) => c.content.includes("SAFE_DEFAULT_PALACE_RESCUED_TERM")),
        "default call must NOT return a rescue-tagged room-file candidate",
      );

      const withUntrusted = core.readTierCandidates("palace-room", PALACE_PROJECT, {
        room: "safe-default-room",
        includeUntrusted: true,
      });
      const rescuedFlagged = withUntrusted.find((c) => c.content.includes("SAFE_DEFAULT_PALACE_RESCUED_TERM"));
      assert.ok(rescuedFlagged, "includeUntrusted:true must still return it");
      assert.equal(rescuedFlagged.untrusted, true);
    });
  });

  // ── T3 — filterTrusted() is a real, publicly exported, discriminating
  // predicate (not a private implementation detail duplicated per surface) ──
  describe("filterTrusted() — the canonical, publicly exported trust predicate", () => {
    it("is exported from the built package; drops untrusted:true; keeps untrusted:false AND untrusted:undefined", () => {
      assert.equal(typeof core.filterTrusted, "function", "filterTrusted must be exported from the package");
      const candidates = [
        { untrusted: true, tag: "drop-explicit-true" },
        { untrusted: false, tag: "keep-explicit-false" },
        { tag: "keep-undefined" }, // untrusted omitted entirely — must be treated as trusted
      ];
      const kept = core.filterTrusted(candidates);
      const keptTags = kept.map((c) => c.tag);
      assert.ok(!keptTags.includes("drop-explicit-true"), "must drop untrusted:true");
      assert.ok(keptTags.includes("keep-explicit-false"), "must keep untrusted:false");
      assert.ok(keptTags.includes("keep-undefined"), "must keep a candidate with no untrusted field at all — undefined is not === true");
    });
  });
});
