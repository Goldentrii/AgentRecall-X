/**
 * Fix #3 Part B — backfill script (scripts/backfill-cjk-insights.mjs).
 *
 * Re-clusters an existing insights-index.json under the FIXED CJK-aware
 * normalization: merges now-detectable duplicates (confirmed_count = SUM of
 * members, richest-metadata member kept, merged-away entries preserved
 * VERBATIM in a manifest with a restore path — never deleted), then re-runs
 * the STANDARD promotion path (promoteConfirmedInsights → awareness
 * confirm-first + 20-cap) for entries at >= 3 post-merge.
 *
 * Contract under test:
 *   - dry-run is the DEFAULT and makes ZERO writes
 *   - --apply merges + backs up + writes manifest + promotes
 *   - idempotent: a second --apply run is a byte-identical no-op
 *   - operates ONLY via AGENT_RECALL_ROOT (refuses to run without it)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../scripts/backfill-cjk-insights.mjs", import.meta.url));

const ZH_A  = "部署前必须运行测试";
const ZH_A2 = "部署之前必须要运行测试";
const ZH_A3 = "部署前一定要运行测试";
const ZH_B  = "永远不要跳过代码审查";
const ZH_B2 = "不要跳过代码审查";
const ZH_C  = "提交信息必须遵循约定格式";
const EN_F  = "Use golden eval parity before shipping retrieval changes";
const EN_G1 = "Always run zgprobe database migrations before deploying code";
const EN_G2 = "Always run the zgprobe database migrations before deploying new code";
const PUNCT = "！！！";

function makeFixture(root) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "awareness-state.json"), JSON.stringify({
    identity: "test-user",
    topInsights: [],
    compoundInsights: [],
    trajectory: "",
    blindSpots: [],
    lastUpdated: "2026-09-10T00:00:00.000Z",
  }, null, 2), "utf-8");

  const insights = [
    { id: "idx-100", title: ZH_A,  source: "session", applies_when: ["部署", "测试"], projects: ["proj-a"], severity: "important", confirmed_count: 1, last_confirmed: "2026-09-01T00:00:00.000Z" },
    { id: "idx-101", title: ZH_A2, source: "session", applies_when: ["deploy"], skill_tags: ["deployment"], file: "feedback/a2.md", projects: ["proj-b"], severity: "important", confirmed_count: 1, last_confirmed: "2026-09-05T00:00:00.000Z" },
    { id: "idx-102", title: ZH_A3, source: "session", applies_when: [], projects: [], severity: "minor", confirmed_count: 1, last_confirmed: "2026-09-03T00:00:00.000Z" },
    { id: "idx-103", title: ZH_B,  source: "session", applies_when: ["审查"], projects: [], severity: "minor", confirmed_count: 1, last_confirmed: "2026-09-02T00:00:00.000Z" },
    { id: "idx-104", title: ZH_B2, source: "session", applies_when: [], projects: [], severity: "minor", confirmed_count: 1, last_confirmed: "2026-09-04T00:00:00.000Z" },
    { id: "idx-105", title: ZH_C,  source: "session", applies_when: [], projects: [], severity: "minor", confirmed_count: 1, last_confirmed: "2026-09-01T00:00:00.000Z" },
    { id: "idx-106", title: "Never expose internal telemetry endpoints publicly", source: "session", applies_when: [], projects: [], severity: "minor", confirmed_count: 1, last_confirmed: "2026-09-01T00:00:00.000Z" },
    { id: "idx-107", title: "Always pin CI runner versions in workflows", source: "session", applies_when: [], projects: [], severity: "minor", confirmed_count: 1, last_confirmed: "2026-09-01T00:00:00.000Z" },
    { id: "idx-108", title: EN_F,  source: "session", applies_when: ["eval"], projects: ["AgentRecall"], severity: "important", confirmed_count: 5, last_confirmed: "2026-09-06T00:00:00.000Z" },
    { id: "idx-109", title: PUNCT, source: "session", applies_when: [], projects: [], severity: "minor", confirmed_count: 1, last_confirmed: "2026-09-01T00:00:00.000Z" },
    { id: "idx-110", title: EN_G1, source: "session", applies_when: ["migrations", "database"], projects: [], severity: "important", confirmed_count: 2, last_confirmed: "2026-09-01T00:00:00.000Z" },
    { id: "idx-111", title: EN_G2, source: "session", applies_when: [], projects: [], severity: "important", confirmed_count: 1, last_confirmed: "2026-09-07T00:00:00.000Z" },
  ];
  fs.writeFileSync(path.join(root, "insights-index.json"), JSON.stringify({
    version: "1.0.0",
    updated: "2026-09-10T00:00:00.000Z",
    insights,
  }, null, 2), "utf-8");
  return insights;
}

/** Recursive byte snapshot of every file under root. */
function snapshotTree(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.set(path.relative(root, p), fs.readFileSync(p, "utf-8"));
    }
  };
  walk(root);
  return out;
}

function runScript(root, args = []) {
  const env = { ...process.env };
  delete env.AGENT_RECALL_SUPABASE_URL;
  delete env.AGENT_RECALL_SUPABASE_KEY;
  if (root === null) delete env.AGENT_RECALL_ROOT;
  else env.AGENT_RECALL_ROOT = root;
  const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf-8" });
  return JSON.parse(stdout);
}

describe("backfill-cjk-insights: dry-run (default)", () => {
  const ROOT = path.join(os.tmpdir(), "ar-backfill-dry-" + Date.now());
  let originalInsights;

  before(() => { originalInsights = makeFixture(ROOT); });
  after(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

  it("computes the merge diff without writing anything", () => {
    const beforeTree = snapshotTree(ROOT);
    const diff = runScript(ROOT);
    const afterTree = snapshotTree(ROOT);

    assert.equal(diff.mode, "dry-run");
    assert.equal(diff.changed, true, "fixture has mergeable duplicates — diff must report changes");
    assert.deepEqual([...afterTree.keys()].sort(), [...beforeTree.keys()].sort(), "dry-run must create no files");
    for (const [rel, bytes] of beforeTree) {
      assert.equal(afterTree.get(rel), bytes, `dry-run must not modify ${rel}`);
    }
    assert.equal(diff.manifest_path, null, "dry-run writes no manifest");
    assert.equal(diff.backup_path, null, "dry-run writes no backup");
  });

  it("reports the expected clusters, sum semantics, and distributions", () => {
    const diff = runScript(ROOT);
    assert.equal(diff.total_before, 12);
    assert.equal(diff.total_after, 8);
    assert.equal(diff.merged_away_total, 4);
    assert.equal(diff.merge_clusters.length, 3, `expected 3 clusters, got ${JSON.stringify(diff.merge_clusters, null, 2)}`);

    const byKept = Object.fromEntries(diff.merge_clusters.map((c) => [c.kept_id, c]));

    // zh A-cluster: 3 members, SUM = 3, richest-metadata member (idx-101) kept
    const a = byKept["idx-101"];
    assert.ok(a, `zh cluster must keep the richest-metadata member idx-101, clusters: ${JSON.stringify(diff.merge_clusters)}`);
    assert.equal(a.confirmed_count_after, 3, "merged confirmed_count must be the SUM of members (1+1+1)");
    assert.deepEqual(a.merged_away.map((m) => m.id).sort(), ["idx-100", "idx-102"]);

    // zh B-cluster: 2 members, SUM = 2
    const b = byKept["idx-103"];
    assert.ok(b, "zh B cluster must be detected");
    assert.equal(b.confirmed_count_after, 2);
    assert.deepEqual(b.merged_away.map((m) => m.id), ["idx-104"]);

    // ASCII G-cluster: sum 2+1 = 3
    const g = byKept["idx-110"];
    assert.ok(g, "ASCII duplicate pair must also merge under the fixed normalization");
    assert.equal(g.confirmed_count_after, 3);

    // punctuation-only and singleton entries never merge
    const mergedIds = new Set(diff.merge_clusters.flatMap((c) => [c.kept_id, ...c.merged_away.map((m) => m.id)]));
    for (const id of ["idx-105", "idx-106", "idx-107", "idx-108", "idx-109"]) {
      assert.ok(!mergedIds.has(id), `${id} must not participate in any merge`);
    }

    assert.deepEqual(diff.distribution_before, { 1: 10, 2: 1, 5: 1 });
    assert.deepEqual(diff.distribution_after, { 1: 4, 2: 1, 3: 2, 5: 1 });

    // promotion candidates = entries CROSSING >= 3 via the merge
    const candidateIds = diff.promotion_candidates.map((c) => c.id).sort();
    assert.deepEqual(candidateIds, ["idx-101", "idx-110"]);
    assert.equal(diff.promotion, null, "dry-run must not run promotion");
  });

  it("refuses to run without AGENT_RECALL_ROOT", () => {
    try {
      runScript(null);
      assert.fail("script must exit non-zero without AGENT_RECALL_ROOT");
    } catch (e) {
      assert.notEqual(e.status, 0);
      assert.match(String(e.stderr), /AGENT_RECALL_ROOT/i, "refusal must name the missing env var");
    }
  });

  it("refuses a nonexistent root", () => {
    try {
      runScript(path.join(os.tmpdir(), "ar-does-not-exist-" + Date.now()));
      assert.fail("script must exit non-zero for a nonexistent root");
    } catch (e) {
      assert.notEqual(e.status, 0);
    }
  });
});

describe("backfill-cjk-insights: --apply", () => {
  const ROOT = path.join(os.tmpdir(), "ar-backfill-apply-" + Date.now());
  let originalInsights;
  let originalIndexBytes;
  let applyDiff;

  before(() => {
    originalInsights = makeFixture(ROOT);
    originalIndexBytes = fs.readFileSync(path.join(ROOT, "insights-index.json"), "utf-8");
    applyDiff = runScript(ROOT, ["--apply"]);
  });
  after(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

  it("merges clusters in place with SUM counts and richest-metadata representative", () => {
    const index = JSON.parse(fs.readFileSync(path.join(ROOT, "insights-index.json"), "utf-8"));
    assert.equal(index.insights.length, 8);

    const rep = index.insights.find((i) => i.id === "idx-101");
    assert.ok(rep, "richest-metadata member must survive as the representative");
    assert.equal(rep.title, ZH_A2);
    assert.equal(rep.confirmed_count, 3, "SUM of member counts");
    assert.equal(rep.last_confirmed, "2026-09-05T00:00:00.000Z", "last_confirmed = max over members");
    assert.deepEqual([...rep.applies_when].sort(), ["deploy", "测试", "部署"].sort(), "applies_when must union across members");
    assert.deepEqual([...rep.projects].sort(), ["proj-a", "proj-b"], "projects must union across members");
    assert.deepEqual(rep.skill_tags, ["deployment"]);
    assert.equal(rep.file, "feedback/a2.md");
    assert.equal(rep.severity, "important");

    // merged-away members are gone from the index (preserved in the manifest)
    assert.ok(!index.insights.some((i) => i.id === "idx-100" || i.id === "idx-102" || i.id === "idx-104" || i.id === "idx-111"));
    // untouched entries remain byte-equal
    const punct = index.insights.find((i) => i.id === "idx-109");
    assert.deepEqual(punct, originalInsights.find((i) => i.id === "idx-109"));
  });

  it("writes a manifest holding every merged-away entry VERBATIM plus a restore path", () => {
    assert.ok(applyDiff.manifest_path, "apply must report the manifest path");
    const manifest = JSON.parse(fs.readFileSync(applyDiff.manifest_path, "utf-8"));

    const mergedAway = manifest.clusters.flatMap((c) => c.merged_away);
    assert.equal(mergedAway.length, 4);
    for (const id of ["idx-100", "idx-102", "idx-104", "idx-111"]) {
      const entry = mergedAway.find((e) => e.id === id);
      assert.deepEqual(entry, originalInsights.find((i) => i.id === id), `manifest must hold ${id} verbatim`);
    }

    assert.ok(manifest.index_backup, "manifest must point at the pre-image backup");
    assert.equal(fs.readFileSync(manifest.index_backup, "utf-8"), originalIndexBytes, "backup must be byte-identical to the pre-merge index");
    assert.ok(manifest.restore && manifest.restore.includes(manifest.index_backup), "manifest must carry an explicit restore path");
  });

  it("re-runs the STANDARD promotion path for entries at >= 3 post-merge", () => {
    assert.ok(applyDiff.promotion, "apply mode must run promotion");
    assert.ok(applyDiff.promotion.promoted.includes(ZH_A2), `merged zh cluster (3) must promote, got ${JSON.stringify(applyDiff.promotion)}`);
    assert.ok(applyDiff.promotion.promoted.includes(EN_G1), "merged ASCII cluster (3) must promote");

    const state = JSON.parse(fs.readFileSync(path.join(ROOT, "awareness-state.json"), "utf-8"));
    assert.ok(state.topInsights.some((i) => i.title === ZH_A2), "awareness must contain the promoted zh insight");
    assert.ok(!state.topInsights.some((i) => i.title === ZH_B), "count-2 cluster must NOT promote");
    assert.ok(!state.topInsights.some((i) => i.title === ZH_C), "count-1 singleton must NOT promote");
  });

  it("is idempotent — a second --apply run is a byte-identical no-op", () => {
    const treeAfterFirst = snapshotTree(ROOT);
    const second = runScript(ROOT, ["--apply"]);
    const treeAfterSecond = snapshotTree(ROOT);

    assert.equal(second.changed, false, "second run must detect nothing to merge");
    assert.equal(second.merged_away_total, 0);
    assert.equal(second.merge_clusters.length, 0);
    assert.deepEqual([...treeAfterSecond.keys()].sort(), [...treeAfterFirst.keys()].sort(), "second run must create no new files");
    for (const [rel, bytes] of treeAfterFirst) {
      assert.equal(treeAfterSecond.get(rel), bytes, `second --apply run must not modify ${rel}`);
    }
  });
});

// Production ids are `idx-${Date.now()}` and can collide within a millisecond.
// Code-review HIGH-1 (2026-09-11) reproduced an id-keyed rebuild silently
// dropping an unrelated entry that shared a merged-away member's id and
// emitting the merged row twice — the rebuild must be reference-keyed.
describe("backfill-cjk-insights: duplicate-id safety (review HIGH-1)", () => {
  const ROOT = path.join(os.tmpdir(), "ar-backfill-dupid-" + Date.now());
  const UNRELATED = { id: "idx-dup", title: "Completely unrelated telemetry endpoint guard rule", source: "session", applies_when: [], projects: [], severity: "minor", confirmed_count: 1, last_confirmed: "2026-09-02T00:00:00.000Z" };

  before(() => {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(path.join(ROOT, "awareness-state.json"), JSON.stringify({
      identity: "test-user", topInsights: [], compoundInsights: [], trajectory: "", blindSpots: [], lastUpdated: "2026-09-10T00:00:00.000Z",
    }, null, 2), "utf-8");
    fs.writeFileSync(path.join(ROOT, "insights-index.json"), JSON.stringify({
      version: "1.0.0", updated: "2026-09-10T00:00:00.000Z",
      insights: [
        // merged-away member sharing its id with the UNRELATED entry below
        { id: "idx-dup", title: ZH_A, source: "session", applies_when: [], projects: [], severity: "minor", confirmed_count: 1, last_confirmed: "2026-09-01T00:00:00.000Z" },
        UNRELATED,
        // richer metadata → survives as representative
        { id: "idx-300", title: ZH_A2, source: "session", applies_when: ["deploy"], skill_tags: ["deployment"], projects: ["proj-b"], severity: "important", confirmed_count: 1, last_confirmed: "2026-09-03T00:00:00.000Z" },
      ],
    }, null, 2), "utf-8");
  });
  after(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

  it("an id collision never drops the unrelated entry nor duplicates the merged row", () => {
    const diff = runScript(ROOT, ["--apply"]);
    assert.equal(diff.total_after, 2);

    const index = JSON.parse(fs.readFileSync(path.join(ROOT, "insights-index.json"), "utf-8"));
    assert.equal(index.insights.length, 2);
    assert.deepEqual(
      index.insights.find((i) => i.title === UNRELATED.title),
      UNRELATED,
      "the unrelated entry sharing a collided id must survive verbatim"
    );
    const merged = index.insights.filter((i) => i.id === "idx-300");
    assert.equal(merged.length, 1, "the merged row must appear exactly once");
    assert.equal(merged[0].confirmed_count, 2);

    // and a second run converges (no re-merge of the two identical-count rows)
    const second = runScript(ROOT, ["--apply"]);
    assert.equal(second.changed, false);
  });
});

// Code-review HIGH-2 (2026-09-11): clustering matches against cluster ANCHORS,
// but the surviving entry carries the richest-metadata REP's title — a changed
// match surface. One --apply invocation must reach the FIXED POINT (iterated
// passes), so the second run is a no-op even when rep != anchor.
describe("backfill-cjk-insights: fixed-point convergence (review HIGH-2)", () => {
  const ROOT = path.join(os.tmpdir(), "ar-backfill-fixedpoint-" + Date.now());
  // C misses anchor A (overlap 0.4 < 0.6) but matches rep B's title (0.8):
  const T_A = ZH_A;                    // 部署前必须运行测试 — pass-1 anchor, poor metadata
  const T_B = ZH_A2;                   // 部署之前必须要运行测试 — richest → representative
  const T_C = "部署之前必须要复查";      // matches B (0.8) but not A (0.4)

  before(() => {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(path.join(ROOT, "awareness-state.json"), JSON.stringify({
      identity: "test-user", topInsights: [], compoundInsights: [], trajectory: "", blindSpots: [], lastUpdated: "2026-09-10T00:00:00.000Z",
    }, null, 2), "utf-8");
    fs.writeFileSync(path.join(ROOT, "insights-index.json"), JSON.stringify({
      version: "1.0.0", updated: "2026-09-10T00:00:00.000Z",
      insights: [
        { id: "idx-400", title: T_A, source: "session", applies_when: [], projects: [], severity: "minor", confirmed_count: 1, last_confirmed: "2026-09-01T00:00:00.000Z" },
        { id: "idx-401", title: T_B, source: "session", applies_when: ["deploy"], skill_tags: ["deployment"], projects: ["proj-b"], severity: "important", confirmed_count: 1, last_confirmed: "2026-09-05T00:00:00.000Z" },
        { id: "idx-402", title: T_C, source: "session", applies_when: [], projects: [], severity: "minor", confirmed_count: 1, last_confirmed: "2026-09-03T00:00:00.000Z" },
        // distinct fillers keep the fixture's collapse fraction under the 40% guard
        { id: "idx-403", title: "Never expose internal telemetry endpoints publicly", source: "session", applies_when: [], projects: [], severity: "minor", confirmed_count: 1, last_confirmed: "2026-09-01T00:00:00.000Z" },
        { id: "idx-404", title: "Always pin CI runner versions in workflows", source: "session", applies_when: [], projects: [], severity: "minor", confirmed_count: 1, last_confirmed: "2026-09-01T00:00:00.000Z" },
        { id: "idx-405", title: "Use golden eval parity before shipping retrieval changes", source: "session", applies_when: [], projects: [], severity: "minor", confirmed_count: 1, last_confirmed: "2026-09-01T00:00:00.000Z" },
      ],
    }, null, 2), "utf-8");
  });
  after(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

  it("a single --apply reaches the fixed point (multi-pass) and the second run is a byte-identical no-op", () => {
    const first = runScript(ROOT, ["--apply"]);
    assert.equal(first.total_after, 4, "all three variants must converge into ONE entry in a single invocation (plus 3 fillers)");
    const passes = new Set(first.merge_clusters.map((c) => c.pass));
    assert.ok(passes.has(2), `expected a pass-2 merge, got passes ${[...passes]}`);

    const index = JSON.parse(fs.readFileSync(path.join(ROOT, "insights-index.json"), "utf-8"));
    assert.equal(index.insights.length, 4);
    const kept = index.insights.find((i) => i.id === "idx-401");
    assert.ok(kept, "richest-metadata representative must survive");
    assert.equal(kept.title, T_B);
    assert.equal(kept.confirmed_count, 3, "SUM across BOTH passes (1+1+1), never double-counted");

    // crossed >= 3 via the backfill → promotion candidate + standard promotion
    assert.deepEqual(first.promotion_candidates.map((c) => c.id), ["idx-401"]);
    assert.ok(first.promotion.promoted.includes(T_B), "merged cluster must promote through the standard path");

    const treeAfterFirst = snapshotTree(ROOT);
    const second = runScript(ROOT, ["--apply"]);
    assert.equal(second.changed, false, "rep != anchor must not leave a mergeable residue for the second run");
    const treeAfterSecond = snapshotTree(ROOT);
    for (const [rel, bytes] of treeAfterFirst) {
      assert.equal(treeAfterSecond.get(rel), bytes, `second --apply run must not modify ${rel}`);
    }
  });
});
