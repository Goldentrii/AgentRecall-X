/**
 * v4 W5 (design memo Wave 5, 2026-09-08) — `ar corrections conflicts` /
 * `ar corrections retract` CLI e2e tests.
 *
 * ASSERT_INVARIANT under test: NEVER auto-retract. `conflicts` only lists
 * suspected supersession pairs (read-only); `retract` requires an explicit,
 * human-typed <id> AND --superseded-by <newer-id> — no --all/--yes/bulk mode.
 *
 * Coverage:
 *   (a) planted conflicting pair → `conflicts` lists it with correct ids/values
 *   (b) non-conflicting store → `conflicts` returns an empty listing, exit 0
 *   (c) `retract <id> --superseded-by <newer-id>` retracts EXACTLY the named
 *       id (active:false, superseded_by set on disk); the pair then
 *       disappears from `conflicts`; the retracted rule stops surfacing via
 *       queryMemory's corrections tier (destination-proof, RED-by-revert —
 *       shown present BEFORE retract so the absence after isn't vacuous);
 *       sibling corrections are left untouched
 *   (d) no bulk/auto path: `retract` with no id, or with an id but no
 *       --superseded-by, or with "--all" in the id slot, all reject
 *       (non-zero exit) and retract nothing
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "dist", "index.js");

const TEST_ROOT = path.join(os.tmpdir(), `ar-corr-conflicts-test-${Date.now()}`);
const PROJECT = "corr-conflicts-test";

// v4 PRE-SHIP GATE FIX (2026-09-08): was a key-value fact
// ("env = production" -> "env = staging"). tools-logic/supersession.ts's
// compareForConflicts no longer detects key-value conflicts at all (see that
// file's own header — status/kv detection removed; version-only, via the
// shared high-precision extractor), so these fixtures were rewritten to an
// explicit-marker VERSION fact, the one grammar that still fires. Matches
// packages/core/test/corrections-supersede.test.mjs's own OLD/NEW rewrite.
const OLD_RULE = "AgentRecall version 3.4.41 is deployed to prod";
const NEW_RULE = "AgentRecall version 3.5.0 is deployed to prod";

// Same fence-strip convention as cli.test.mjs / outcomes-audit.test.mjs.
function parseFenced(stdout) {
  if (stdout.startsWith("⟦agentrecall:memory⟧")) {
    const firstNL = stdout.indexOf("\n");
    const lastNL = stdout.lastIndexOf("\n");
    if (firstNL !== -1 && lastNL > firstNL) {
      return JSON.parse(stdout.slice(firstNL + 1, lastNL));
    }
  }
  return JSON.parse(stdout);
}

/** Spawn the built CLI against an arbitrary project, normalizing to {stdout, stderr, exitCode}. */
async function runCliFor(proj, ...args) {
  try {
    const { stdout, stderr } = await execFileAsync(
      "node",
      [CLI, "--root", TEST_ROOT, "--project", proj, ...args],
      { timeout: 15000 },
    );
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (e) {
    return {
      stdout: (e.stdout ?? "").trim(),
      stderr: (e.stderr ?? "").trim(),
      exitCode: e.code ?? 1,
    };
  }
}

function runCli(...args) {
  return runCliFor(PROJECT, ...args);
}

function corrDirFor(proj) {
  return path.join(TEST_ROOT, "projects", proj, "corrections");
}

function corrDir() {
  return corrDirFor(PROJECT);
}

/** Write a minimal correction JSON file straight into a project's seeded store. */
function seedCorrectionIn(proj, opts) {
  const { id, rule, date, severity = "p0" } = opts;
  const dir = corrDirFor(proj);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${date}--${id}.json`;
  const record = {
    id,
    date,
    severity,
    project: proj,
    rule,
    context: rule,
    tags: [],
    active: true,
    kind: "correction",
    weight: 0.7,
  };
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(record, null, 2), "utf-8");
  return id;
}

function seedCorrection(opts) {
  return seedCorrectionIn(PROJECT, opts);
}

function readCorrectionFile(proj, filename) {
  return JSON.parse(fs.readFileSync(path.join(corrDirFor(proj), filename), "utf-8"));
}

describe("ar corrections conflicts / retract (v4 W5)", () => {
  after(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  // ── (a) planted conflicting pair is listed ────────────────────────────────
  it("(a) conflicts lists a planted conflicting pair with correct ids/values", async () => {
    seedCorrection({ id: "old-env", rule: OLD_RULE, date: "2026-06-01" });
    seedCorrection({ id: "new-env", rule: NEW_RULE, date: "2026-06-02" });

    const { stdout, exitCode } = await runCli("corrections", "conflicts");
    assert.equal(exitCode, 0, "conflicts should exit 0");
    const list = parseFenced(stdout);
    assert.ok(Array.isArray(list), "conflicts output should be a JSON array");
    assert.equal(list.length, 1, `expected exactly one suspected pair, got ${JSON.stringify(list)}`);
    const c = list[0];
    assert.equal(c.existingId, "old-env");
    assert.equal(c.newerId, "new-env");
    assert.equal(c.existingRule, OLD_RULE);
    assert.equal(c.newerRule, NEW_RULE);
    assert.ok(
      c.conflictingValues.some((v) => v.existing.includes("3.4.41") && v.incoming.includes("3.5.0")),
      `conflictingValues should carry the version conflict; got ${JSON.stringify(c.conflictingValues)}`,
    );
  });

  // ── (b) non-conflicting store → empty listing ─────────────────────────────
  it("(b) conflicts returns an empty listing (exit 0) for a non-conflicting store", async () => {
    const project2 = `${PROJECT}-nonconflict`;
    seedCorrectionIn(project2, { id: "a", rule: "Never commit secrets to git", date: "2026-06-01" });
    seedCorrectionIn(project2, { id: "b", rule: "Prefer functional React components", date: "2026-06-02", severity: "p1" });

    const { stdout, stderr, exitCode } = await runCliFor(project2, "corrections", "conflicts");
    assert.equal(exitCode, 0, `should exit 0, stderr: ${stderr}`);
    const list = parseFenced(stdout);
    assert.deepEqual(list, [], "non-conflicting store must produce an empty listing");
  });

  // ── (c) retract: exact-id retraction + destination-proof ─────────────────
  it("(c) retract retracts exactly the named id, clears the pair from conflicts, and the retracted rule stops surfacing via queryMemory's corrections tier", async () => {
    // Fresh project so this test doesn't interact with (a)'s already-mutated store.
    const project3 = `${PROJECT}-retract`;
    seedCorrectionIn(project3, { id: "r-old", rule: OLD_RULE, date: "2026-06-01" });
    seedCorrectionIn(project3, { id: "r-new", rule: NEW_RULE, date: "2026-06-02" });
    // A third, unrelated correction — must survive the retract untouched.
    seedCorrectionIn(project3, { id: "r-sibling", rule: "Never commit secrets to git", date: "2026-06-01" });

    // Precondition (non-vacuous): the pair is listed before retraction.
    const before = await runCliFor(project3, "corrections", "conflicts");
    assert.equal(before.exitCode, 0);
    const beforeList = parseFenced(before.stdout);
    assert.equal(beforeList.length, 1, "precondition: the pair must be listed before retraction");

    // Precondition (RED-by-revert, destination-proof): the older rule is
    // actually reachable via queryMemory's corrections tier BEFORE retraction
    // — otherwise its absence afterward would be vacuous.
    const core = await import("agent-recall-core");
    core.setRoot(TEST_ROOT);
    const beforeQuery = await core.queryMemory({ query: "AgentRecall version deployed prod", project: project3, tiers: ["corrections"] });
    assert.ok(
      beforeQuery.items.some((i) => i.id === "r-old"),
      `precondition: r-old must surface via queryMemory(tiers:['corrections']) before retraction; got ${JSON.stringify(beforeQuery.items)}`,
    );

    // Act: human-confirmed retract of the OLDER side, superseded by the newer.
    const acted = await runCliFor(project3, "corrections", "retract", "r-old", "--superseded-by", "r-new");
    assert.equal(acted.exitCode, 0, `retract should exit 0, stderr: ${acted.stderr}`);
    const result = JSON.parse(acted.stdout);
    assert.equal(result.success, true);
    assert.equal(result.id, "r-old");
    assert.equal(result.active, false);
    assert.equal(result.superseded_by, "r-new");
    assert.ok(result.retracted_at, "retracted_at should be stamped");

    // On-disk verification: exactly the named record changed.
    const dir3 = corrDirFor(project3);
    const all = fs.readdirSync(dir3).filter((f) => f.endsWith(".json")).map((f) => readCorrectionFile(project3, f));
    const oldRec = all.find((r) => r.id === "r-old");
    const newRec = all.find((r) => r.id === "r-new");
    const siblingRec = all.find((r) => r.id === "r-sibling");
    assert.equal(oldRec.active, false, "r-old must be retracted (active:false)");
    assert.equal(oldRec.superseded_by, "r-new");
    assert.equal(newRec.active, true, "r-new must remain untouched/active");
    assert.equal(siblingRec.active, true, "unrelated sibling correction must be untouched");
    assert.equal(siblingRec.superseded_by, undefined, "unrelated sibling must not gain a superseded_by pointer");

    // The pair must no longer be listed.
    const after = await runCliFor(project3, "corrections", "conflicts");
    assert.equal(after.exitCode, 0);
    const afterList = parseFenced(after.stdout);
    assert.deepEqual(afterList, [], "the pair must disappear from conflicts after the older side is retracted");

    // Destination-proof: the retracted rule must NEVER surface via
    // queryMemory's corrections tier anymore (W3's retracted-never-surfaces
    // guarantee holds through this new write path too).
    const afterQuery = await core.queryMemory({ query: "AgentRecall version deployed prod", project: project3, tiers: ["corrections"] });
    assert.ok(
      !afterQuery.items.some((i) => i.id === "r-old"),
      `retracted r-old must never surface via queryMemory(tiers:['corrections']) after retraction; got ${JSON.stringify(afterQuery.items)}`,
    );
  });

  // ── (d) no bulk/auto path ──────────────────────────────────────────────────
  it("(d) retract with no id rejects (non-zero exit), retracts nothing", async () => {
    const project4 = `${PROJECT}-noid`;
    seedCorrectionIn(project4, { id: "x", rule: "keep me", date: "2026-06-01" });

    const { stderr, exitCode } = await runCliFor(project4, "corrections", "retract");
    assert.notEqual(exitCode, 0, "retract with no id must exit non-zero");
    assert.ok(/superseded-by|Usage/.test(stderr), `stderr should explain the required arguments, got: ${stderr}`);

    const rec = readCorrectionFile(project4, "2026-06-01--x.json");
    assert.equal(rec.active, true, "nothing should be retracted when id is missing");
  });

  it("(d) retract with an id but no --superseded-by rejects (non-zero exit), retracts nothing", async () => {
    const project5 = `${PROJECT}-nosuper`;
    seedCorrectionIn(project5, { id: "y", rule: "keep me too", date: "2026-06-01" });

    const { stderr, exitCode } = await runCliFor(project5, "corrections", "retract", "y");
    assert.notEqual(exitCode, 0, "retract without --superseded-by must exit non-zero");
    assert.ok(stderr.includes("--superseded-by"), `stderr should mention --superseded-by, got: ${stderr}`);

    const rec = readCorrectionFile(project5, "2026-06-01--y.json");
    assert.equal(rec.active, true, "nothing should be retracted when --superseded-by is missing");
  });

  it("(d) retract \"--all\" in the id slot is rejected as an invalid id, never treated as a bulk flag", async () => {
    const project6 = `${PROJECT}-noall`;
    seedCorrectionIn(project6, { id: "z", rule: "keep me three", date: "2026-06-01" });

    const { stderr, exitCode } = await runCliFor(project6, "corrections", "retract", "--all");
    assert.notEqual(exitCode, 0, "\"--all\" must not be accepted as a bulk-retract flag");
    assert.ok(stderr.includes("Usage"), `stderr should show usage, got: ${stderr}`);

    const rec = readCorrectionFile(project6, "2026-06-01--z.json");
    assert.equal(rec.active, true, "no record should be retracted by \"--all\"");
  });

  it("conflicts on an empty/non-existent project store returns an empty listing without throwing", async () => {
    const project7 = `${PROJECT}-empty`;
    const { stdout, exitCode } = await runCliFor(project7, "corrections", "conflicts");
    assert.equal(exitCode, 0);
    assert.deepEqual(parseFenced(stdout), []);
  });
});
