// packages/core/test/unclaimed-staging.test.mjs
//
// fix5 (2026-09-11) — _unclaimed staging + the projects/ CREATION INVARIANT.
//
// Class under test (eval-standard S5, reports/agentrecall-evaluation-standard-
// 2026-09-11.md plan #5): a FAILED or ZERO-CONFIDENCE project resolution must
// NEVER materialize a directory under projects/. The junk exemplars pinned
// here are the real ones from the live store audit: a literal `auto/` dir
// holding 422+ journals (~168 one-line rescue cards), a `default/` dir,
// mega-slug concatenation dirs, and case-variant twins (AgentRecall/
// agentrecall). Failed resolutions stage into the global `_unclaimed/`
// namespace (per-session subdirs with provenance) instead; a claim op moves
// staged cards into a real project explicitly.
//
// The `_` prefix is the same BY-NAME reserved-namespace exclusion mechanism
// fix4 applied to `_pending/`/`_index.md`-class infra files (class-not-
// instance: one leading-underscore rule, not one branch per known dir).
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { setRoot, resetRoot } from "agent-recall-core";

/** readdir that returns [] for a missing dir. */
function ls(p) {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

/** All entries under <root>/projects — the set the creation invariant protects. */
function projectDirs(root) {
  return ls(path.join(root, "projects")).sort();
}

/** Find the single staged session dir (non-underscore entry) under _unclaimed. */
function stagedSessionDirs(root) {
  return ls(path.join(root, "_unclaimed")).filter((e) => !e.startsWith("_") && !e.startsWith("."));
}

describe("fix5 — _unclaimed staging & projects/ creation invariant", () => {
  let tmpDir;
  let savedCwd;
  let savedEnvProject;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-unclaimed-"));
    setRoot(tmpDir);
    savedCwd = process.cwd();
    savedEnvProject = process.env.AGENT_RECALL_PROJECT;
    delete process.env.AGENT_RECALL_PROJECT;
  });

  afterEach(() => {
    process.chdir(savedCwd);
    if (savedEnvProject !== undefined) process.env.AGENT_RECALL_PROJECT = savedEnvProject;
    resetRoot();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // A. resolveProject — staging sentinel instead of throw / junk-dir resolution
  // -------------------------------------------------------------------------
  describe("A. resolveProject returns the staging sentinel on failure", () => {
    it("A1: detection failure (blocked cwd basename) returns the sentinel, creates NOTHING under projects/, and records provenance", async () => {
      const { resolveProject, UNCLAIMED_PROJECT } = await import("agent-recall-core");
      const cwd = path.join(tmpDir, "cwd", "Downloads"); // BLOCKED_SLUGS member as basename
      fs.mkdirSync(cwd, { recursive: true });
      process.chdir(cwd);

      const slug = await resolveProject(undefined);
      assert.equal(slug, UNCLAIMED_PROJECT, "failed detection must return the staging sentinel, not throw");
      assert.deepEqual(projectDirs(tmpDir), [], "a failed resolution must NEVER materialize a projects/ dir");

      const sessions = stagedSessionDirs(tmpDir);
      assert.equal(sessions.length, 1, "staging must be per-session: exactly one session subdir");
      const provPath = path.join(tmpDir, "_unclaimed", sessions[0], "provenance.json");
      assert.ok(fs.existsSync(provPath), "provenance.json must be recorded for a staged resolution");
      const prov = JSON.parse(fs.readFileSync(provPath, "utf-8"));
      assert.ok(typeof prov.cwd === "string" && prov.cwd.length > 0, "provenance must carry the cwd");
      assert.ok(typeof prov.sid === "string" && prov.sid.length > 0, "provenance must carry the session id");
      assert.ok("slug_confidence" in prov, "provenance must carry slug_confidence");
      assert.ok(Array.isArray(prov.slug_candidates), "provenance must carry slug_candidates");
    });

    it('A2: project "auto" (the API-compat default) means RESOLVE; on failure it stages — it never creates a dir named auto', async () => {
      const { resolveProject, UNCLAIMED_PROJECT } = await import("agent-recall-core");
      const cwd = path.join(tmpDir, "cwd", "Downloads");
      fs.mkdirSync(cwd, { recursive: true });
      process.chdir(cwd);

      const slug = await resolveProject("auto");
      assert.equal(slug, UNCLAIMED_PROJECT);
      assert.ok(!fs.existsSync(path.join(tmpDir, "projects", "auto")), 'no projects/auto — "auto" is a resolve trigger, never a dir name');
    });

    it("A3: an invalid auto-detected slug stages EVEN WHEN a legacy junk dir already exists (new writes stop landing in default/-class dirs)", async () => {
      const { resolveProject, UNCLAIMED_PROJECT } = await import("agent-recall-core");
      // Legacy junk dir on disk — the pre-fix escape hatch resolved to it.
      fs.mkdirSync(path.join(tmpDir, "projects", "build"), { recursive: true });
      const cwd = path.join(tmpDir, "cwd", "build"); // deny-listed basename
      fs.mkdirSync(cwd, { recursive: true });
      process.chdir(cwd);

      const slug = await resolveProject(undefined);
      assert.equal(slug, UNCLAIMED_PROJECT, "auto-detection landing on a deny-listed name must stage, not resolve to the legacy junk dir");
    });

    it("A4: explicit valid slug resolution is unchanged", async () => {
      const { resolveProject } = await import("agent-recall-core");
      assert.equal(await resolveProject("real-project"), "real-project");
    });

    it("A5: explicit invalid slug with an EXISTING dir still resolves — ghost project dirs stay recallable when explicitly scoped (gq20 class)", async () => {
      const { resolveProject } = await import("agent-recall-core");
      fs.mkdirSync(path.join(tmpDir, "projects", "build"), { recursive: true });
      assert.equal(await resolveProject("build"), "build");
    });

    it("A6: explicit invalid slug with NO existing dir still throws (unchanged agent-first error)", async () => {
      const { resolveProject } = await import("agent-recall-core");
      await assert.rejects(() => resolveProject("phase-1"), /Invalid project slug/);
    });

    it("A7: the sentinel itself round-trips through resolveProject (writers that already hold it must not throw)", async () => {
      const { resolveProject, UNCLAIMED_PROJECT } = await import("agent-recall-core");
      assert.equal(await resolveProject(UNCLAIMED_PROJECT), UNCLAIMED_PROJECT);
    });

    it('A8: the literal "auto" is deny-listed as a project slug (class member alongside "default")', async () => {
      const { isValidProjectSlug } = await import("agent-recall-core");
      assert.equal(isValidProjectSlug("auto"), false);
      assert.equal(isValidProjectSlug("default"), false);
    });
  });

  // -------------------------------------------------------------------------
  // B. Sentinel path routing — ONE choke point (projectSubPath), all writers
  // -------------------------------------------------------------------------
  describe("B. sentinel writes route to _unclaimed/<sid>/, never projects/", () => {
    it("B1: journalDir(sentinel) resolves under _unclaimed/<sid>/journal, outside projects/", async () => {
      const { journalDir, UNCLAIMED_PROJECT } = await import("agent-recall-core");
      const dir = journalDir(UNCLAIMED_PROJECT);
      assert.ok(dir.startsWith(path.join(tmpDir, "_unclaimed") + path.sep), `journalDir(sentinel) must live under _unclaimed/: ${dir}`);
      assert.ok(!dir.includes(path.sep + "projects" + path.sep), `journalDir(sentinel) must NOT touch projects/: ${dir}`);
    });

    it("B2: a real journal write through the sentinel lands in staging and creates nothing under projects/", async () => {
      const { journalWrite, UNCLAIMED_PROJECT } = await import("agent-recall-core");
      await journalWrite({
        project: UNCLAIMED_PROJECT,
        content: "## Brief\nstaged write for the UNCLAIMED_B2_MARKER fixture\n",
      });
      assert.deepEqual(projectDirs(tmpDir), [], "sentinel journal writes must never materialize projects/ dirs");
      const sessions = stagedSessionDirs(tmpDir);
      assert.equal(sessions.length, 1);
      const journal = path.join(tmpDir, "_unclaimed", sessions[0], "journal");
      const files = ls(journal).filter((f) => f.endsWith(".md"));
      assert.ok(files.length >= 1, "the staged journal file must exist under _unclaimed/<sid>/journal");
    });
  });

  // -------------------------------------------------------------------------
  // C. writeSessionCard — junk exemplars stage, legitimate writes unchanged
  // -------------------------------------------------------------------------
  describe("C. writeSessionCard staging gate", () => {
    function minimalCard(slug, sid, extra = {}) {
      return {
        markdown: `---\nsid: ${sid}\nslug: ${slug}\n---\n# card fixture for ${sid}\n`,
        title: `card fixture for ${sid}`,
        artifacts: [],
        linearRefs: [],
        decisions: [],
        nextStep: [],
        sid,
        slug,
        date: "2026-09-11",
        ...extra,
      };
    }

    it('C1 (junk exemplar: literal "auto"): a card with slug "auto" stages into _unclaimed/<card-sid>/ — projects/auto is never created', async () => {
      const { writeSessionCard, UNCLAIMED_PROJECT } = await import("agent-recall-core");
      const res = writeSessionCard(minimalCard("auto", "sid-c1"));
      assert.equal(res.slug, UNCLAIMED_PROJECT, "the returned slug must be the staging sentinel");
      assert.ok(res.path.includes(path.join("_unclaimed", "sid-c1")), `card must land in _unclaimed/sid-c1/: ${res.path}`);
      assert.ok(!fs.existsSync(path.join(tmpDir, "projects", "auto")), "projects/auto must NEVER be created");
      assert.deepEqual(projectDirs(tmpDir), []);
    });

    it("C2 (junk exemplar: mega-slug concatenation, confidence 0): stages, never mints the mega dir", async () => {
      const { writeSessionCard, UNCLAIMED_PROJECT } = await import("agent-recall-core");
      const mega = "novada-gtm-bowtie-agentrecall-fix-tranche-planning-notes-2026";
      const res = writeSessionCard(minimalCard(mega, "sid-c2", { slug_confidence: 0 }));
      assert.equal(res.slug, UNCLAIMED_PROJECT);
      assert.deepEqual(projectDirs(tmpDir), [], "a zero-confidence card must never mkdir a new projects/<mega-slug>/");
    });

    it("C3: confidence 0 stages even when the guessed project dir already exists (rescue landing zone is _unclaimed by design)", async () => {
      const { writeSessionCard, UNCLAIMED_PROJECT } = await import("agent-recall-core");
      fs.mkdirSync(path.join(tmpDir, "projects", "agentrecall", "journal"), { recursive: true });
      const res = writeSessionCard(minimalCard("agentrecall", "sid-c3", { slug_confidence: 0 }));
      assert.equal(res.slug, UNCLAIMED_PROJECT);
      assert.equal(
        ls(path.join(tmpDir, "projects", "agentrecall", "journal")).length,
        0,
        "no new write may land inside the existing project from a zero-confidence card",
      );
    });

    it("C4: a valid slug with no confidence field (legacy caller) writes normally — existing behavior pinned", async () => {
      const { writeSessionCard } = await import("agent-recall-core");
      const res = writeSessionCard(minimalCard("real-project", "sid-c4"));
      assert.equal(res.slug, "real-project");
      assert.ok(res.path.includes(path.join("projects", "real-project", "journal")), res.path);
    });

    it("C5 (junk exemplar: case-variant twin): a case-variant of an existing dir resolves to the existing dir — never a twin", async () => {
      const { writeSessionCard, pickProjectDirEntry } = await import("agent-recall-core");
      fs.mkdirSync(path.join(tmpDir, "projects", "AgentRecall", "journal"), { recursive: true });
      const res = writeSessionCard(minimalCard("agentrecall", "sid-c5", { slug_confidence: 0.9 }));
      assert.equal(res.slug, "AgentRecall", "the existing on-disk casing must be reused");
      const entries = projectDirs(tmpDir).filter((e) => e.toLowerCase() === "agentrecall");
      assert.equal(entries.length, 1, `exactly one case-variant dir may exist, got: ${JSON.stringify(entries)}`);
      // Pure-logic pin (fs on APFS silently collides case variants, masking regressions):
      assert.equal(pickProjectDirEntry("agentrecall", ["AgentRecall"]).picked, "AgentRecall");
    });

    it("C6: staging is idempotent on the session UUID (second call is a no-op, one file)", async () => {
      const { writeSessionCard } = await import("agent-recall-core");
      const first = writeSessionCard(minimalCard("auto", "sid-c6"));
      const second = writeSessionCard(minimalCard("auto", "sid-c6"));
      assert.ok(first.bytes > 0);
      assert.equal(second.bytes, 0, "second write for the same sid must be an idempotent no-op");
      const dir = path.dirname(first.path);
      assert.equal(ls(dir).filter((f) => f.includes("--card--")).length, 1);
    });

    it("C8 (staged sid traversal): an untrusted traversal-shaped sid is sanitized before the staged path.join — twin of session-card.test.mjs's normal-path pin", async () => {
      const { writeSessionCard } = await import("agent-recall-core");
      const res = writeSessionCard(minimalCard("auto", "../../etc/passwd"));
      assert.ok(res.path, "staged write must succeed");
      assert.ok(!res.path.includes(".."), `staged path must never contain traversal segments: ${res.path}`);
      assert.ok(res.path.startsWith(path.join(tmpDir, "_unclaimed") + path.sep), `staged path must stay inside _unclaimed/: ${res.path}`);
      assert.ok(!fs.existsSync(path.join(tmpDir, "etc", "passwd")));
    });

    it("C7: staging records provenance (sid, cwd, slug candidates + confidence)", async () => {
      const { writeSessionCard } = await import("agent-recall-core");
      writeSessionCard(
        minimalCard("auto", "sid-c7", {
          slug_confidence: 0,
          slug_candidates: [{ slug: "some-guess", count: 2 }],
        }),
      );
      const provPath = path.join(tmpDir, "_unclaimed", "sid-c7", "provenance.json");
      assert.ok(fs.existsSync(provPath), "provenance.json must exist next to the staged card");
      const prov = JSON.parse(fs.readFileSync(provPath, "utf-8"));
      assert.equal(prov.sid, "sid-c7");
      assert.ok(typeof prov.cwd === "string");
      assert.equal(prov.slug_confidence, 0);
      assert.deepEqual(prov.slug_candidates, [{ slug: "some-guess", count: 2 }]);
    });
  });

  // -------------------------------------------------------------------------
  // D. kill-9 rescue — feature KEPT, landing zone moved to _unclaimed
  // -------------------------------------------------------------------------
  describe("D. working-memory orphan rescue stages into _unclaimed", () => {
    function plantOrphan(sid, lines) {
      const wmDir = path.join(tmpDir, "working-memory");
      fs.mkdirSync(wmDir, { recursive: true });
      const p = path.join(wmDir, `${sid}.jsonl`);
      fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
      const past = (Date.now() - 2 * 60 * 60 * 1000) / 1000; // 2h — past the 1h orphan window
      fs.utimesSync(p, past, past);
      return p;
    }

    it('D1 (junk exemplar: guess-failed rescue → the old projects/auto class): card stages, ledger slug is "_unclaimed", WM deleted, projects/ untouched', async () => {
      const { rescueOrphanedWorkingMemory, readRecentSessions, UNCLAIMED_PROJECT } = await import("agent-recall-core");
      const sid = "sid-d1-crash";
      const wmPath = plantOrphan(sid, [
        { ts: "2026-09-11T01:00:00.000Z", prompt: "investigating the D1 crash fixture", cwd: "/Users/x/Downloads/nowhere" },
        { ts: "2026-09-11T01:05:00.000Z", prompt: "still working when kill -9 hit", cwd: "/Users/x/Downloads/nowhere" },
      ]);

      rescueOrphanedWorkingMemory();

      assert.ok(!fs.existsSync(wmPath), "rescue must still complete (crash-safety is KEPT) — WM deleted after rescue");
      assert.ok(!fs.existsSync(path.join(tmpDir, "projects", "auto")), "the projects/auto rescue-card class must be dead");
      assert.deepEqual(projectDirs(tmpDir), [], "rescue must not materialize any projects/ dir");

      const cardDir = path.join(tmpDir, "_unclaimed", sid);
      const cards = ls(cardDir).filter((f) => f.includes(`--card--${sid}`));
      assert.equal(cards.length, 1, "the rescue card must exist under _unclaimed/<sid>/");

      const entry = readRecentSessions(50).find((e) => e.sid === sid);
      assert.ok(entry, "the rescue must still be visible to continuity (recency ledger)");
      assert.equal(entry.slug, UNCLAIMED_PROJECT, "ledger slug must point at where the card actually lives");
      assert.equal(entry.source, "working-memory-rescue", "rescue provenance tag unchanged");
    });

    it("D2: a valid cwd guess with NO existing project dir stages too (creation invariant) and preserves the guess in provenance", async () => {
      const { rescueOrphanedWorkingMemory } = await import("agent-recall-core");
      const sid = "sid-d2-newdir";
      plantOrphan(sid, [
        { ts: "2026-09-11T02:00:00.000Z", prompt: "work in a project AR has never seen", cwd: "/Users/x/Projects/never-seen-before-proj" },
      ]);

      rescueOrphanedWorkingMemory();

      assert.ok(!fs.existsSync(path.join(tmpDir, "projects", "never-seen-before-proj")), "an unauthenticated cwd guess must never mint a new projects/ dir");
      const prov = JSON.parse(fs.readFileSync(path.join(tmpDir, "_unclaimed", sid, "provenance.json"), "utf-8"));
      assert.ok(
        JSON.stringify(prov.slug_candidates).includes("never-seen-before-proj"),
        `the guess must be preserved in provenance for later claim: ${JSON.stringify(prov.slug_candidates)}`,
      );
    });

    it("D3: rescue idempotency against staged cards — a second sweep never duplicates the card", async () => {
      const { rescueOrphanedWorkingMemory } = await import("agent-recall-core");
      const sid = "sid-d3-idem";
      plantOrphan(sid, [{ ts: "2026-09-11T03:00:00.000Z", prompt: "idempotency fixture", cwd: "/Users/x/Downloads/nowhere" }]);
      rescueOrphanedWorkingMemory();
      // Re-plant the WM file as if a race left it behind after the card was staged.
      plantOrphan(sid, [{ ts: "2026-09-11T03:00:00.000Z", prompt: "idempotency fixture", cwd: "/Users/x/Downloads/nowhere" }]);
      rescueOrphanedWorkingMemory();
      const cards = ls(path.join(tmpDir, "_unclaimed", sid)).filter((f) => f.includes("--card--"));
      assert.equal(cards.length, 1, "the staged card must not be duplicated by a second sweep");
    });

    it("D4: staged records pass the same scrub-on-write — a secret captured pre-crash never reaches the staged card verbatim", async () => {
      const { wmAppend, rescueOrphanedWorkingMemory } = await import("agent-recall-core");
      const sid = "sid-d4-secret";
      const SECRET = "sk-" + "b".repeat(30);
      wmAppend(sid, { ts: new Date().toISOString(), prompt: `deploy key is ${SECRET} do not lose it`, cwd: "/Users/x/Downloads/nowhere" });
      const wmPath = path.join(tmpDir, "working-memory", `${sid}.jsonl`);
      const past = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
      fs.utimesSync(wmPath, past, past);

      rescueOrphanedWorkingMemory();

      const cardDir = path.join(tmpDir, "_unclaimed", sid);
      const card = ls(cardDir).find((f) => f.includes("--card--"));
      assert.ok(card, "staged card must exist");
      const body = fs.readFileSync(path.join(cardDir, card), "utf-8");
      assert.ok(!body.includes(SECRET), "the raw secret must never appear in a staged card (same scrub-on-write as every persist path)");
    });
  });

  // -------------------------------------------------------------------------
  // E. 14-day TTL — move to _unclaimed/_archive/, never delete
  // -------------------------------------------------------------------------
  describe("E. TTL archival", () => {
    it("E1: a staged session dir older than 14 days moves to _unclaimed/_archive/ with content intact; fresh dirs stay", async () => {
      const { archiveExpiredUnclaimed } = await import("agent-recall-core");
      const oldDir = path.join(tmpDir, "_unclaimed", "sid-old");
      const freshDir = path.join(tmpDir, "_unclaimed", "sid-fresh");
      fs.mkdirSync(oldDir, { recursive: true });
      fs.mkdirSync(freshDir, { recursive: true });
      fs.writeFileSync(path.join(oldDir, "2026-08-01--card--sid-old.md"), "# old staged card\n", "utf-8");
      fs.writeFileSync(path.join(freshDir, "2026-09-11--card--sid-fresh.md"), "# fresh staged card\n", "utf-8");
      const past = (Date.now() - 15 * 24 * 60 * 60 * 1000) / 1000;
      fs.utimesSync(oldDir, past, past);

      const moved = archiveExpiredUnclaimed();

      assert.equal(moved, 1, "exactly the expired dir moves");
      assert.ok(!fs.existsSync(oldDir), "expired dir must no longer sit in the active staging area");
      const archived = path.join(tmpDir, "_unclaimed", "_archive", "sid-old");
      assert.ok(fs.existsSync(path.join(archived, "2026-08-01--card--sid-old.md")), "content must be MOVED (never deleted)");
      assert.ok(fs.existsSync(freshDir), "fresh staged dirs are untouched");
    });

    it("E2: _archive itself (underscore namespace) is never swept or recursed", async () => {
      const { archiveExpiredUnclaimed } = await import("agent-recall-core");
      const archived = path.join(tmpDir, "_unclaimed", "_archive", "sid-done");
      fs.mkdirSync(archived, { recursive: true });
      const past = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
      fs.utimesSync(path.join(tmpDir, "_unclaimed", "_archive"), past, past);
      const moved = archiveExpiredUnclaimed();
      assert.equal(moved, 0);
      assert.ok(fs.existsSync(archived), "_archive content stays put");
    });
  });

  // -------------------------------------------------------------------------
  // F. claim — the ONE legal way a staged card enters a real project
  // -------------------------------------------------------------------------
  describe("F. claim op (manifest-logged, reversible)", () => {
    function stageCardFixture(sid) {
      const dir = path.join(tmpDir, "_unclaimed", sid);
      fs.mkdirSync(dir, { recursive: true });
      const file = `2026-09-11--card--${sid}.md`;
      fs.writeFileSync(path.join(dir, file), `---\nsid: ${sid}\n---\n# staged fixture ${sid}\n`, "utf-8");
      return { dir, file };
    }

    it("F1: claim moves the card into projects/<slug>/journal/ and appends a manifest log line", async () => {
      const { claimUnclaimedSession } = await import("agent-recall-core");
      const { file } = stageCardFixture("sid-f1");

      const result = claimUnclaimedSession("sid-f1", "real-project");

      const dest = path.join(tmpDir, "projects", "real-project", "journal", file);
      assert.ok(fs.existsSync(dest), "claimed card must live in the real project's journal");
      assert.ok(result.moved.length >= 1, "claim result must report moved files");

      const logPath = path.join(tmpDir, "_unclaimed", "_claims.jsonl");
      assert.ok(fs.existsSync(logPath), "claims manifest log must exist");
      const entries = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const entry = entries.find((e) => e.sid === "sid-f1");
      assert.ok(entry, "manifest must log the claim");
      assert.equal(entry.project, "real-project");
      assert.ok(entry.moved.every((m) => m.from && m.to), "manifest entries must record from→to for reversibility");
    });

    it("F2: claim into an invalid project slug is refused with an agent-first error", async () => {
      const { claimUnclaimedSession } = await import("agent-recall-core");
      stageCardFixture("sid-f2");
      assert.throws(() => claimUnclaimedSession("sid-f2", "auto"), /[Ii]nvalid/);
    });

    it("F3: undo reverses a claim from the manifest log", async () => {
      const { claimUnclaimedSession, undoClaimUnclaimedSession } = await import("agent-recall-core");
      const { dir, file } = stageCardFixture("sid-f3");
      claimUnclaimedSession("sid-f3", "real-project");
      assert.ok(!fs.existsSync(path.join(dir, file)));

      const undone = undoClaimUnclaimedSession("sid-f3");

      assert.ok(undone.moved.length >= 1, "undo must report restored files");
      assert.ok(fs.existsSync(path.join(dir, file)), "the card must be back in staging after undo");
      assert.ok(!fs.existsSync(path.join(tmpDir, "projects", "real-project", "journal", file)), "the claimed copy must be gone after undo");
    });

    it("F4: claim never overwrites an existing destination file (skip + report)", async () => {
      const { claimUnclaimedSession } = await import("agent-recall-core");
      const { file } = stageCardFixture("sid-f4");
      const destDir = path.join(tmpDir, "projects", "real-project", "journal");
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(path.join(destDir, file), "# pre-existing — must survive\n", "utf-8");

      const result = claimUnclaimedSession("sid-f4", "real-project");

      assert.equal(fs.readFileSync(path.join(destDir, file), "utf-8"), "# pre-existing — must survive\n", "existing dest must never be overwritten");
      assert.ok(result.skipped.length >= 1, "the collision must be reported as skipped");
    });
  });

  // -------------------------------------------------------------------------
  // G. session_start surface — ≤1 line, absent when zero
  // -------------------------------------------------------------------------
  describe("G. session_start unclaimed surface", () => {
    it("G1: staged cards are counted once in the payload (unclaimed_cards)", async () => {
      const { sessionStart } = await import("agent-recall-core");
      for (const sid of ["sid-g1-a", "sid-g1-b"]) {
        const dir = path.join(tmpDir, "_unclaimed", sid);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `2026-09-11--card--${sid}.md`), `# staged ${sid}\n`, "utf-8");
      }
      const result = await sessionStart({ project: "g1-project" });
      assert.equal(result.unclaimed_cards, 2);
    });

    it("G2: absent-when-empty — zero staged cards means the field is omitted", async () => {
      const { sessionStart } = await import("agent-recall-core");
      const result = await sessionStart({ project: "g2-project" });
      assert.equal(result.unclaimed_cards, undefined);
    });

    it("G3: session_start from an unresolvable cwd works end-to-end on the sentinel — no throw, no projects/ dir, no palace scaffold in staging", async () => {
      const { sessionStart, UNCLAIMED_PROJECT } = await import("agent-recall-core");
      const cwd = path.join(tmpDir, "cwd", "Downloads");
      fs.mkdirSync(cwd, { recursive: true });
      process.chdir(cwd);

      const result = await sessionStart({});

      assert.equal(result.project, UNCLAIMED_PROJECT);
      assert.deepEqual(projectDirs(tmpDir), [], "session_start on the sentinel must not materialize projects/ dirs");
      const sessions = stagedSessionDirs(tmpDir);
      for (const s of sessions) {
        assert.ok(!fs.existsSync(path.join(tmpDir, "_unclaimed", s, "palace")), "no palace scaffold may be created for staged sessions");
      }
    });
  });

  // -------------------------------------------------------------------------
  // H. BY-NAME exclusion — _unclaimed never enters project enumeration/corpus
  // -------------------------------------------------------------------------
  describe("H. underscore-namespace exclusion (fix4 mechanism, BY NAME)", () => {
    it("H1: listAllProjects never lists an underscore-namespaced dir, even if one appears under projects/", async () => {
      const { listAllProjects } = await import("agent-recall-core");
      // Defensive fixture: someone (an external script) drops _unclaimed INSIDE projects/.
      const j = path.join(tmpDir, "projects", "_unclaimed", "journal");
      fs.mkdirSync(j, { recursive: true });
      fs.writeFileSync(path.join(j, "2026-09-11-note.md"), "# smuggled\n", "utf-8");
      const slugs = listAllProjects().map((p) => p.slug);
      assert.ok(!slugs.some((s) => s.startsWith("_")), `underscore namespace must be excluded BY NAME from project enumeration: ${JSON.stringify(slugs)}`);
    });

    it("H2: staged content is invisible to another project's journal search (recall corpus exclusion)", async () => {
      const { journalWrite, journalSearch, UNCLAIMED_PROJECT } = await import("agent-recall-core");
      await journalWrite({ project: UNCLAIMED_PROJECT, content: "## Brief\nUNCLAIMED_H2_MARKER staged secret note\n" });
      // A real project with its own journal, so the search has a corpus to scan.
      await journalWrite({ project: "real-project", content: "## Brief\nordinary note\n" });
      const res = await journalSearch({ query: "UNCLAIMED_H2_MARKER", project: "real-project" });
      const serialized = JSON.stringify(res);
      assert.ok(!serialized.includes("UNCLAIMED_H2_MARKER"), "staged content must never surface in another project's recall corpus");
    });
  });

  // -------------------------------------------------------------------------
  // I. Creation-invariant sweep pin
  // -------------------------------------------------------------------------
  it("I1: after every junk-exemplar operation above run back-to-back, projects/ holds ZERO unexpected entries", async () => {
    const { resolveProject, writeSessionCard, rescueOrphanedWorkingMemory } = await import("agent-recall-core");
    const cwd = path.join(tmpDir, "cwd", "Downloads");
    fs.mkdirSync(cwd, { recursive: true });
    process.chdir(cwd);
    await resolveProject(undefined).catch(() => {});
    await resolveProject("auto").catch(() => {});
    writeSessionCard({
      markdown: "# x\n", title: "x", artifacts: [], linearRefs: [], decisions: [], nextStep: [],
      sid: "sid-i1", slug: "auto", date: "2026-09-11",
    });
    const wmDir = path.join(tmpDir, "working-memory");
    fs.mkdirSync(wmDir, { recursive: true });
    const wmPath = path.join(wmDir, "sid-i1-wm.jsonl");
    fs.writeFileSync(wmPath, JSON.stringify({ ts: "t", prompt: "invariant fixture", cwd: "/Users/x/Downloads/z" }) + "\n", "utf-8");
    const past = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(wmPath, past, past);
    rescueOrphanedWorkingMemory();

    assert.deepEqual(projectDirs(tmpDir), [], "the creation invariant: no failed/zero-confidence path may materialize a projects/ dir");
  });
});
