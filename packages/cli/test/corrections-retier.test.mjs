/**
 * Evolution p4 (2026-09-17) — `ar corrections retier` CLI e2e tests.
 *
 * Coverage:
 *   (a) --dry-run (default): full tier table + proposal lists, zero writes.
 *   (b) --write persists the tier field via the sanctioned record-write path;
 *       a second --write run changes zero records (idempotent).
 *   (c) --store overrides the storage root for the call (independent of the
 *       global --root flag).
 *   (d) --proposals-out writes the proposal lists to a plain (non-store) file.
 *   (e) archive/promote-to-gate proposal listings render fenced (rule prose);
 *       the structural tier table does not.
 *   (f) fence-completeness manifest classification (see fence-manifest.mjs)
 *       is proven correct in practice: --json output parses cleanly.
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

const TEST_ROOT = path.join(os.tmpdir(), `ar-retier-cli-test-${Date.now()}`);
const AS_OF = "2026-09-17";
const PROJECT_A = "retier-cli-a";
const PROJECT_B = "retier-cli-b";

async function runCli(...args) {
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI, ...args], { timeout: 15000 });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (e) {
    return { stdout: (e.stdout ?? "").trim(), stderr: (e.stderr ?? "").trim(), exitCode: e.code ?? 1 };
  }
}

function corrDirFor(proj) {
  return path.join(TEST_ROOT, "projects", proj, "corrections");
}

function seedCorrectionIn(proj, opts) {
  const { id, rule, date, severity = "p0", ...rest } = opts;
  const dir = corrDirFor(proj);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${date}--${id}.json`;
  const record = {
    id, date, severity, project: proj, rule, context: rule, tags: [],
    active: true, kind: "correction", weight: severity === "p0" ? 1.0 : 0.7,
    ...rest,
  };
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(record, null, 2), "utf-8");
  return id;
}

function readCorrectionFile(proj, id) {
  const dir = corrDirFor(proj);
  const file = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .find((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")).id === id);
  return JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
}

describe("ar corrections retier (evolution p4)", () => {
  after(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("(a) --dry-run (default) reports the full tier table + proposal counts, and writes NOTHING", async () => {
    seedCorrectionIn(PROJECT_A, {
      id: "gate-rule", date: "2026-09-01", severity: "p0",
      rule: "gate-qualifying rule for CLI dry-run test",
      proof_confidence: 0.9, last_retrieved: "2026-09-10T00:00:00.000Z",
    });
    seedCorrectionIn(PROJECT_B, {
      id: "watch-rule", date: "2026-03-01", severity: "p1",
      rule: "watch-tier rule for CLI dry-run test", proof_confidence: 0.4,
    });

    const before = readCorrectionFile(PROJECT_A, "gate-rule");
    assert.equal(before.tier, undefined, "precondition: no tier field yet");

    const { stdout, stderr, exitCode } = await runCli(
      "corrections", "retier", "--store", TEST_ROOT, "--as-of", AS_OF, "--json",
    );
    assert.equal(exitCode, 0, `should exit 0, stderr: ${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.dry_run, true);
    assert.equal(result.projects_scanned, 2);
    assert.equal(result.written, 0);
    const rowA = result.rows.find((r) => r.id === "gate-rule");
    assert.equal(rowA.computed_tier, "gate");
    assert.equal(rowA.stored_tier, null);

    const after = readCorrectionFile(PROJECT_A, "gate-rule");
    assert.deepEqual(after, before, "dry-run must leave the on-disk record byte-identical (no tier field written)");
  });

  it("(b) --write persists tier via the sanctioned path; a second --write run is idempotent (zero writes)", async () => {
    seedCorrectionIn(PROJECT_A, {
      id: "write-rule", date: "2026-09-01", severity: "p0",
      rule: "gate-qualifying rule for CLI write test",
      proof_confidence: 0.9, last_retrieved: "2026-09-10T00:00:00.000Z",
    });

    const first = await runCli("corrections", "retier", "--store", TEST_ROOT, "--as-of", AS_OF, "--write", "--json");
    assert.equal(first.exitCode, 0, first.stderr);
    const firstResult = JSON.parse(first.stdout);
    assert.equal(firstResult.dry_run, false);
    assert.ok(firstResult.written >= 1);

    const persisted = readCorrectionFile(PROJECT_A, "write-rule");
    assert.equal(persisted.tier, "gate");
    assert.equal(persisted.rule, "gate-qualifying rule for CLI write test", "every other field survives untouched");

    const mtimeBefore = fs.statSync(
      path.join(corrDirFor(PROJECT_A), fs.readdirSync(corrDirFor(PROJECT_A)).filter((f) => f.endsWith(".json")).find((f) => f.includes("write-rule"))),
    ).mtimeMs;

    const second = await runCli("corrections", "retier", "--store", TEST_ROOT, "--as-of", AS_OF, "--write", "--json");
    assert.equal(second.exitCode, 0, second.stderr);
    const secondResult = JSON.parse(second.stdout);
    const secondRowWriteRule = secondResult.rows.find((r) => r.id === "write-rule");
    assert.equal(secondRowWriteRule.changed, false, "second run must see no change for this record");

    const mtimeAfter = fs.statSync(
      path.join(corrDirFor(PROJECT_A), fs.readdirSync(corrDirFor(PROJECT_A)).filter((f) => f.endsWith(".json")).find((f) => f.includes("write-rule"))),
    ).mtimeMs;
    assert.equal(mtimeAfter, mtimeBefore, "idempotent --write must not even rewrite the file on the second run");
  });

  it("(c) archive/promote-to-gate proposal listings render inside the memory fence; the tier table does not", async () => {
    const projectC = `${PROJECT_A}-fence`;
    seedCorrectionIn(projectC, {
      id: "dormant-rule", date: "2026-03-01", severity: "p1",
      rule: "UNIQUE_MARKER_DORMANT_RULE_TEXT", proof_confidence: 0.4,
    });

    const { stdout, exitCode, stderr } = await runCli(
      "corrections", "retier", "--store", TEST_ROOT, "--as-of", AS_OF,
    );
    assert.equal(exitCode, 0, stderr);
    assert.ok(stdout.includes("tier distribution"), "structural table renders");
    assert.ok(!stdout.startsWith("⟦agentrecall:memory:"), "the structural table itself is not the fenced payload");
    assert.ok(stdout.includes("⟦agentrecall:memory:"), "the archive-candidate listing (rule prose) IS fenced");
    assert.ok(stdout.includes("UNIQUE_MARKER_DORMANT_RULE_TEXT"), "the rule text is present (inside the fence)");
  });

  it("(d) --proposals-out writes the proposal lists to a plain JSON file (not a corrections-store write)", async () => {
    const projectD = `${PROJECT_A}-proposals-out`;
    seedCorrectionIn(projectD, {
      id: "archivable", date: "2026-03-01", severity: "p1",
      rule: "a dormant rule for proposals-out test", proof_confidence: 0.4,
    });
    const outPath = path.join(TEST_ROOT, "retier-proposals.json");

    const { exitCode, stderr } = await runCli(
      "corrections", "retier", "--store", TEST_ROOT, "--as-of", AS_OF, "--proposals-out", outPath, "--json",
    );
    assert.equal(exitCode, 0, stderr);
    assert.ok(fs.existsSync(outPath), "proposals-out file must be created");
    const proposals = JSON.parse(fs.readFileSync(outPath, "utf-8"));
    assert.equal(proposals.as_of, AS_OF);
    assert.ok(proposals.archive_candidates.some((c) => c.id === "archivable"));
  });

  it("(e) demotion is automatic in --write; promote-to-gate/archive proposals are NEVER auto-applied", async () => {
    const projectE = `${PROJECT_A}-demotion`;
    seedCorrectionIn(projectE, {
      id: "demote-me", date: "2026-01-01", severity: "p0",
      rule: "p0 rule with a not_violated plateau",
      proof_confidence: 0.9, last_retrieved: "2026-09-10T00:00:00.000Z",
      not_violated_count: 5, heeded_count: 0, recurrence_count: 0,
    });
    seedCorrectionIn(projectE, {
      id: "archive-me", date: "2026-03-01", severity: "p1",
      rule: "long-dormant p1 rule", proof_confidence: 0.4,
    });

    const { stdout, exitCode, stderr } = await runCli(
      "corrections", "retier", "--store", TEST_ROOT, "--as-of", AS_OF, "--write", "--json",
    );
    assert.equal(exitCode, 0, stderr);
    const result = JSON.parse(stdout);

    const demoted = result.rows.find((r) => r.id === "demote-me");
    assert.deepEqual(demoted.triggers, ["not_violated_plateau"]);
    assert.equal(demoted.final_tier, "nudge", "automatically demoted one step from the raw gate formula");
    const persistedDemoted = readCorrectionFile(projectE, "demote-me");
    assert.equal(persistedDemoted.tier, "nudge");

    // archive-me is flagged but NEVER retracted/mutated beyond `tier`.
    assert.ok(result.archive_candidates.some((c) => c.id === "archive-me"));
    const persistedArchived = readCorrectionFile(projectE, "archive-me");
    assert.equal(persistedArchived.active, true, "archive candidate must never be auto-retracted by --write");
  });

  it("rejects a malformed --as-of", async () => {
    const { exitCode, stderr } = await runCli("corrections", "retier", "--store", TEST_ROOT, "--as-of", "09-17-2026");
    assert.notEqual(exitCode, 0);
    assert.ok(stderr.includes("YYYY-MM-DD"));
  });
});
