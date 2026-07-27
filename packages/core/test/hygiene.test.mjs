import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "node:module";

// See store-doctor.test.mjs for the rationale: the ESM `node:fs` namespace is
// frozen, but the CJS `fs` object shares the same underlying bindings and its
// properties ARE writable — the surface to stub for the read-only proof below.
const cjsFs = createRequire(import.meta.url)("fs");

/**
 * hygiene.test.mjs — behavior-specific tests for the DETECTION-ONLY store
 * trash audit ("ar hygiene").
 *
 * `runHygieneScan(root)` is pure w.r.t. global state (unlike store-doctor,
 * which reads the process-global getRoot()) — every test builds a plain temp
 * directory and passes it straight in. No AGENT_RECALL_ROOT / setRoot dance
 * needed.
 */

let hygiene;

let TEST_ROOT;

function mkProjectDir(root, name) {
  const dir = path.join(root, "projects", name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeRootFile(root, name, content) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, name), content, "utf-8");
}

describe("hygiene (detection-only store trash audit)", () => {
  before(async () => {
    hygiene = await import("../dist/storage/hygiene.js");
  });

  beforeEach(() => {
    TEST_ROOT = path.join(
      os.tmpdir(),
      "ar-hygiene-test-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2),
    );
    fs.mkdirSync(TEST_ROOT, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("clean store -> grade 'clean', zero findings, all counts zero", () => {
    mkProjectDir(TEST_ROOT, "a-real-project");
    const result = hygiene.runHygieneScan(TEST_ROOT);
    assert.equal(result.grade, "clean");
    assert.deepEqual(result.findings, []);
    for (const n of Object.values(result.counts)) assert.equal(n, 0);
  });

  it("missing root / missing projects dir never throws", () => {
    const ghost = path.join(TEST_ROOT, "does-not-exist");
    const result = hygiene.runHygieneScan(ghost);
    assert.equal(result.grade, "clean");
    assert.deepEqual(result.findings, []);
  });

  // ── (a) junk-project-dirs ─────────────────────────────────────────────────

  it("(a) uuid-shaped project dir -> RED", () => {
    mkProjectDir(TEST_ROOT, "550e8400-e29b-41d4-a716-446655440000");
    const result = hygiene.runHygieneScan(TEST_ROOT);
    const f = result.findings.find((x) => x.check === "junk-project-dirs");
    assert.ok(f, "expected a junk-project-dirs finding");
    assert.equal(f.severity, "red");
    assert.equal(result.grade, "red");
  });

  it("(a) path-traversal-shaped ('..') project dir -> RED", () => {
    mkProjectDir(TEST_ROOT, "evil..name");
    const result = hygiene.runHygieneScan(TEST_ROOT);
    const f = result.findings.find((x) => x.check === "junk-project-dirs");
    assert.ok(f);
    assert.equal(f.severity, "red");
  });

  it("(a) literal test/placeholder slug -> YELLOW", () => {
    mkProjectDir(TEST_ROOT, "this-project-does-not-exist");
    const result = hygiene.runHygieneScan(TEST_ROOT);
    const f = result.findings.find((x) => x.check === "junk-project-dirs");
    assert.ok(f);
    assert.equal(f.severity, "yellow");
    assert.equal(result.grade, "yellow");
  });

  it("(a) epoch-timestamp-suffixed slug -> YELLOW", () => {
    mkProjectDir(TEST_ROOT, "project-1721000000000");
    const result = hygiene.runHygieneScan(TEST_ROOT);
    const f = result.findings.find((x) => x.check === "junk-project-dirs");
    assert.ok(f);
    assert.equal(f.severity, "yellow");
  });

  it("(a) a normal project slug is never flagged", () => {
    mkProjectDir(TEST_ROOT, "prismma-web");
    const result = hygiene.runHygieneScan(TEST_ROOT);
    assert.equal(result.findings.filter((x) => x.check === "junk-project-dirs").length, 0);
  });

  // ── (b) counter-accumulation — AGGREGATE, never per-file ──────────────────

  it("(b) 101 counter files -> exactly ONE aggregate YELLOW finding (not 101)", () => {
    for (let i = 0; i < 101; i++) {
      writeRootFile(TEST_ROOT, `.ambient-counter-sess${i}`, "1");
    }
    const result = hygiene.runHygieneScan(TEST_ROOT);
    const counterFindings = result.findings.filter((x) => x.check === "counter-accumulation");
    assert.equal(counterFindings.length, 1, "must be ONE aggregate finding, not one per file");
    assert.equal(counterFindings[0].severity, "yellow");
    assert.equal(result.counts["counter-accumulation"], 1);
  });

  it("(b) 501 counter files -> RED (still one aggregate finding)", () => {
    for (let i = 0; i < 501; i++) {
      writeRootFile(TEST_ROOT, `.ambient-counter-sess${i}`, "1");
    }
    const result = hygiene.runHygieneScan(TEST_ROOT);
    const counterFindings = result.findings.filter((x) => x.check === "counter-accumulation");
    assert.equal(counterFindings.length, 1);
    assert.equal(counterFindings[0].severity, "red");
    assert.equal(result.grade, "red");
  });

  it("(b) 100 counter files (at threshold) -> no finding", () => {
    for (let i = 0; i < 100; i++) {
      writeRootFile(TEST_ROOT, `.ambient-counter-sess${i}`, "1");
    }
    const result = hygiene.runHygieneScan(TEST_ROOT);
    assert.equal(result.findings.filter((x) => x.check === "counter-accumulation").length, 0);
  });

  // ── (c) theme-epidemic ──────────────────────────────────────────────────

  it("(c) one theme dominating >50% of >=10 parseable journal filenames -> YELLOW", () => {
    const jDir = path.join(mkProjectDir(TEST_ROOT, "themed-proj"), "journal");
    fs.mkdirSync(jDir, { recursive: true });
    // 7/12 share "naming-drift" (v2 4-part form: date--type--theme--slug).
    for (let i = 0; i < 7; i++) {
      fs.writeFileSync(path.join(jDir, `2026-07-0${(i % 9) + 1}--arsave--naming-drift--sess${i}.md`), "x");
    }
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(jDir, `2026-06-0${(i % 9) + 1}--arsave--test-gap--sess${i}.md`), "x");
    }
    const result = hygiene.runHygieneScan(TEST_ROOT);
    const f = result.findings.find((x) => x.check === "theme-epidemic");
    assert.ok(f, "expected a theme-epidemic finding");
    assert.equal(f.severity, "yellow");
    assert.match(f.evidence, /naming-drift/);
  });

  it("(c) fewer than 10 parseable files never triggers, even at 100% one theme", () => {
    const jDir = path.join(mkProjectDir(TEST_ROOT, "small-proj"), "journal");
    fs.mkdirSync(jDir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(jDir, `2026-07-0${i + 1}--arsave--naming-drift--sess${i}.md`), "x");
    }
    const result = hygiene.runHygieneScan(TEST_ROOT);
    assert.equal(result.findings.filter((x) => x.check === "theme-epidemic").length, 0);
  });

  it("(c) an even split across themes never triggers", () => {
    const jDir = path.join(mkProjectDir(TEST_ROOT, "balanced-proj"), "journal");
    fs.mkdirSync(jDir, { recursive: true });
    const themes = ["naming-drift", "test-gap", "silent-failure", "multi-loop"];
    for (let i = 0; i < 12; i++) {
      const theme = themes[i % themes.length];
      fs.writeFileSync(path.join(jDir, `2026-07-${String((i % 27) + 1).padStart(2, "0")}--arsave--${theme}--sess${i}.md`), "x");
    }
    const result = hygiene.runHygieneScan(TEST_ROOT);
    assert.equal(result.findings.filter((x) => x.check === "theme-epidemic").length, 0);
  });

  // ── (d) case-fold-forks ─────────────────────────────────────────────────

  it("(d) two case-variant project dirs -> RED", () => {
    // Real case-variant sibling directories cannot be fabricated on this
    // machine's default filesystem (macOS APFS is case-insensitive-but-
    // case-preserving: a second mkdirSync("agentrecall") silently collides
    // with an existing "AgentRecall") — the exact caveat documented on
    // `pickProjectDirEntry` in storage/paths.ts, and the reason
    // paths-naming-v2.test.mjs itself only unit-tests the pure
    // `groupCaseVariantForks` for the actual fork-grouping logic rather than
    // fabricating real fs forks. hygiene.ts follows the same pattern: the
    // fs-facing `checkCaseFoldForks` is a thin wrapper around the exported
    // pure `caseFoldForksToFindings`, tested directly here.
    const findings = hygiene.caseFoldForksToFindings([
      { project: "agentrecall", variants: ["AgentRecall", "agentrecall"] },
    ]);
    assert.equal(findings.length, 1);
    const f = findings[0];
    assert.equal(f.check, "case-fold-forks");
    assert.equal(f.severity, "red");
    assert.equal(f.path, "projects/agentrecall");
    assert.match(f.evidence, /AgentRecall/);
    assert.match(f.evidence, /agentrecall/);
  });

  it("(d) checkCaseFoldForks integrates with the real (fork-free) filesystem", () => {
    mkProjectDir(TEST_ROOT, "solo-project");
    const result = hygiene.runHygieneScan(TEST_ROOT);
    assert.equal(result.findings.filter((x) => x.check === "case-fold-forks").length, 0);
  });

  // ── (e) stale-derived-caches ────────────────────────────────────────────

  it("(e) a 40-day-old *-cache.json -> YELLOW", () => {
    writeRootFile(TEST_ROOT, "board-cache.json", "{}");
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
    fs.utimesSync(path.join(TEST_ROOT, "board-cache.json"), new Date(old), new Date(old));
    const result = hygiene.runHygieneScan(TEST_ROOT);
    const f = result.findings.find((x) => x.check === "stale-derived-caches");
    assert.ok(f);
    assert.equal(f.severity, "yellow");
    assert.equal(f.path, "board-cache.json");
  });

  it("(e) dashboard.json / scoreboard.json are recognized by exact name", () => {
    writeRootFile(TEST_ROOT, "dashboard.json", "{}");
    writeRootFile(TEST_ROOT, "scoreboard.json", "{}");
    const old = Date.now() - 45 * 24 * 60 * 60 * 1000;
    fs.utimesSync(path.join(TEST_ROOT, "dashboard.json"), new Date(old), new Date(old));
    fs.utimesSync(path.join(TEST_ROOT, "scoreboard.json"), new Date(old), new Date(old));
    const result = hygiene.runHygieneScan(TEST_ROOT);
    const names = result.findings.filter((x) => x.check === "stale-derived-caches").map((f) => f.path);
    assert.ok(names.includes("dashboard.json"));
    assert.ok(names.includes("scoreboard.json"));
  });

  it("(e) a FRESH cache file (< 30d) never triggers", () => {
    writeRootFile(TEST_ROOT, "recent-cache.json", "{}");
    const result = hygiene.runHygieneScan(TEST_ROOT);
    assert.equal(result.findings.filter((x) => x.check === "stale-derived-caches").length, 0);
  });

  // ── (f) root-secret-patterns ────────────────────────────────────────────

  it("(f) a secret-shaped string in a root JSON file -> RED, evidence NEVER contains the secret", () => {
    const secret = "sk-test1234567890123456789012345";
    writeRootFile(TEST_ROOT, "leaked.json", `{\n  "key": "${secret}"\n}\n`);
    const result = hygiene.runHygieneScan(TEST_ROOT);
    const f = result.findings.find((x) => x.check === "root-secret-patterns");
    assert.ok(f, "expected a root-secret-patterns finding");
    assert.equal(f.severity, "red");
    assert.equal(result.grade, "red");
    // The evidence, path, and agent_instruction must NEVER contain the raw secret.
    const serialized = JSON.stringify(f);
    assert.ok(!serialized.includes(secret), "finding must never echo the matched secret text");
    assert.match(f.evidence, /line=2/);
    assert.match(f.evidence, /pattern=/);
  });

  it("(f) recognizes every documented pattern class by name, never the raw match", () => {
    const cases = [
      ["AKIA1234567890123456", "aws-access-key-id"],
      ["ghp_" + "a".repeat(36), "github-pat"],
      ["xoxb-1234", "slack-token"],
      ["sbp_" + "0".repeat(40), "supabase-service-role-key"],
      ["sb_secret_abcdef", "supabase-secret-key"],
    ];
    for (const [secret, expectedPattern] of cases) {
      fs.rmSync(TEST_ROOT, { recursive: true, force: true });
      fs.mkdirSync(TEST_ROOT, { recursive: true });
      writeRootFile(TEST_ROOT, "creds.json", `{"v":"${secret}"}`);
      const result = hygiene.runHygieneScan(TEST_ROOT);
      const f = result.findings.find((x) => x.check === "root-secret-patterns");
      assert.ok(f, `expected a finding for ${expectedPattern}`);
      assert.match(f.evidence, new RegExp(`pattern=${expectedPattern}\\b`));
      assert.ok(!JSON.stringify(f).includes(secret));
    }
  });

  it("(f) never scans files under projects/ — only root-level *.json", () => {
    const projDir = mkProjectDir(TEST_ROOT, "some-proj");
    fs.writeFileSync(path.join(projDir, "config.json"), '{"key":"sk-abcdefghijklmnopqrstuvwx"}');
    const result = hygiene.runHygieneScan(TEST_ROOT);
    assert.equal(result.findings.filter((x) => x.check === "root-secret-patterns").length, 0);
  });

  it("(f) never scans its own baseline file", () => {
    writeRootFile(TEST_ROOT, "hygiene-baseline.json", JSON.stringify({ created_at: "x", stable_ids: ["sk-abcdefghijklmnopqrstuvwx"] }));
    const result = hygiene.runHygieneScan(TEST_ROOT);
    assert.equal(result.findings.filter((x) => x.check === "root-secret-patterns").length, 0);
  });

  // ── (g) missing-corrections-index ──────────────────────────────────────

  it("(g) corrections/*.json with no _index.md -> YELLOW", () => {
    const corrDir = path.join(mkProjectDir(TEST_ROOT, "no-index-proj"), "corrections");
    fs.mkdirSync(corrDir, { recursive: true });
    fs.writeFileSync(path.join(corrDir, "2026-07-01--some-rule.json"), "{}");
    const result = hygiene.runHygieneScan(TEST_ROOT);
    const f = result.findings.find((x) => x.check === "missing-corrections-index");
    assert.ok(f);
    assert.equal(f.severity, "yellow");
  });

  it("(g) corrections/*.json WITH _index.md never triggers", () => {
    const corrDir = path.join(mkProjectDir(TEST_ROOT, "has-index-proj"), "corrections");
    fs.mkdirSync(corrDir, { recursive: true });
    fs.writeFileSync(path.join(corrDir, "2026-07-01--some-rule.json"), "{}");
    fs.writeFileSync(path.join(corrDir, "_index.md"), "# Corrections Index");
    const result = hygiene.runHygieneScan(TEST_ROOT);
    assert.equal(result.findings.filter((x) => x.check === "missing-corrections-index").length, 0);
  });

  it("(g) an empty corrections dir never triggers", () => {
    const corrDir = path.join(mkProjectDir(TEST_ROOT, "empty-corr-proj"), "corrections");
    fs.mkdirSync(corrDir, { recursive: true });
    const result = hygiene.runHygieneScan(TEST_ROOT);
    assert.equal(result.findings.filter((x) => x.check === "missing-corrections-index").length, 0);
  });

  // ── (h) reserved-word-slugs ─────────────────────────────────────────────

  it("(h) a project dir literally named 'tmp' -> RED", () => {
    mkProjectDir(TEST_ROOT, "tmp");
    const result = hygiene.runHygieneScan(TEST_ROOT);
    const f = result.findings.find((x) => x.check === "reserved-word-slugs");
    assert.ok(f);
    assert.equal(f.severity, "red");
    assert.equal(result.grade, "red");
  });

  it("(h) every reserved word is caught, case-insensitively", () => {
    for (const word of ["palace", "Journal", "CORRECTIONS", "insights", "rooms", "skills"]) {
      mkProjectDir(TEST_ROOT, word);
    }
    const result = hygiene.runHygieneScan(TEST_ROOT);
    assert.equal(result.findings.filter((x) => x.check === "reserved-word-slugs").length, 6);
  });

  // ── Baseline round-trip ─────────────────────────────────────────────────

  it("baseline round-trip: first run all fresh -> update -> second run zero fresh -> new junk dir -> exactly one fresh", () => {
    mkProjectDir(TEST_ROOT, "this-project-does-not-exist"); // one yellow junk finding
    for (let i = 0; i < 150; i++) writeRootFile(TEST_ROOT, `.ambient-counter-sess${i}`, "1"); // one aggregate finding

    const baselinePath = hygiene.hygieneBaselinePath(TEST_ROOT);
    assert.equal(baselinePath, path.join(TEST_ROOT, "hygiene-baseline.json"));

    // First run, no baseline yet: everything is fresh.
    let scan = hygiene.runHygieneScan(TEST_ROOT);
    let { fresh, known } = hygiene.applyBaseline(scan.findings, baselinePath);
    assert.equal(fresh.length, scan.findings.length);
    assert.equal(known.length, 0);
    assert.ok(!fs.existsSync(baselinePath), "applyBaseline must never write the baseline file");

    // Seed the baseline against everything currently found.
    const baseline = hygiene.updateBaseline(scan.findings, baselinePath);
    assert.ok(fs.existsSync(baselinePath));
    assert.equal(baseline.stable_ids.length, scan.findings.length);

    // Second run, unchanged store: zero fresh, everything known.
    scan = hygiene.runHygieneScan(TEST_ROOT);
    ({ fresh, known } = hygiene.applyBaseline(scan.findings, baselinePath));
    assert.equal(fresh.length, 0, JSON.stringify(fresh));
    assert.equal(known.length, scan.findings.length);

    // A brand-new junk dir appears: exactly one fresh finding, rest still known.
    mkProjectDir(TEST_ROOT, "550e8400-e29b-41d4-a716-446655440099");
    scan = hygiene.runHygieneScan(TEST_ROOT);
    ({ fresh, known } = hygiene.applyBaseline(scan.findings, baselinePath));
    assert.equal(fresh.length, 1, JSON.stringify(fresh));
    assert.equal(fresh[0].check, "junk-project-dirs");
    assert.equal(known.length, scan.findings.length - 1);
  });

  it("applyBaseline degrades to all-fresh on a malformed baseline file", () => {
    mkProjectDir(TEST_ROOT, "this-project-does-not-exist");
    const baselinePath = hygiene.hygieneBaselinePath(TEST_ROOT);
    fs.writeFileSync(baselinePath, "{ not json", "utf-8");
    const scan = hygiene.runHygieneScan(TEST_ROOT);
    const { fresh, known } = hygiene.applyBaseline(scan.findings, baselinePath);
    assert.equal(fresh.length, scan.findings.length);
    assert.equal(known.length, 0);
  });

  // ── READ-ONLY invariant ─────────────────────────────────────────────────

  it("runHygieneScan and applyBaseline perform ZERO writes (fs mutators stubbed to throw)", () => {
    mkProjectDir(TEST_ROOT, "this-project-does-not-exist");
    mkProjectDir(TEST_ROOT, "AgentRecall");
    mkProjectDir(TEST_ROOT, "agentrecall");
    for (let i = 0; i < 150; i++) writeRootFile(TEST_ROOT, `.ambient-counter-sess${i}`, "1");
    writeRootFile(TEST_ROOT, "leaked.json", '{"k":"sk-abcdefghijklmnopqrstuvwx"}');

    const before = snapshotTree(TEST_ROOT);

    const MUTATORS = [
      "writeFileSync", "mkdirSync", "renameSync", "rmdirSync", "rmSync",
      "unlinkSync", "appendFileSync", "writeSync", "copyFileSync", "truncateSync",
    ];
    const saved = {};
    for (const m of MUTATORS) {
      saved[m] = cjsFs[m];
      cjsFs[m] = () => { throw new Error("READONLY VIOLATION: " + m); };
    }

    let result;
    try {
      result = hygiene.runHygieneScan(TEST_ROOT);
      hygiene.applyBaseline(result.findings, hygiene.hygieneBaselinePath(TEST_ROOT));
    } finally {
      for (const m of MUTATORS) cjsFs[m] = saved[m];
    }

    assert.ok(result && typeof result.grade === "string");
    assert.ok(result.findings.length > 0);

    const after = snapshotTree(TEST_ROOT);
    assert.deepEqual(after, before, "the store tree must be byte-identical after a scan with no --baseline-update");
  });

  it("updateBaseline is the ONLY function that writes — before/after tree hash proves it", () => {
    mkProjectDir(TEST_ROOT, "this-project-does-not-exist");
    const before = snapshotTree(TEST_ROOT);
    const scan = hygiene.runHygieneScan(TEST_ROOT);
    assert.deepEqual(snapshotTree(TEST_ROOT), before, "scan alone must not touch disk");

    hygiene.updateBaseline(scan.findings, hygiene.hygieneBaselinePath(TEST_ROOT));
    const after = snapshotTree(TEST_ROOT);
    assert.notDeepEqual(after, before, "updateBaseline must be the one write this module performs");
    assert.ok(fs.existsSync(hygiene.hygieneBaselinePath(TEST_ROOT)));
  });
});

/** Deterministic snapshot of every file's relative path + content, for a before/after diff. */
function snapshotTree(root) {
  const out = {};
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        out[path.relative(root, full)] = fs.readFileSync(full, "utf-8");
      }
    }
  }
  walk(root);
  return out;
}
