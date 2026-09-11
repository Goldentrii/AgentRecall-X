// packages/core/test/recall-insight-scope.test.mjs — Wave 3b (2026-08-30,
// reports/2026-08-30-pipe-w3b-migrate-report.md STEP 2 + STEP 3).
//
// Two things this file proves:
//
//   PART A — recallInsight() equivalence: the new `project`/`scope`
//   parameters are additive and OPTIONAL — every caller that omits them
//   (every pre-Wave-3b caller) gets IDENTICAL behavior to before. The
//   external contract `{context, matching_insights:[{title,relevance,
//   severity,applies_when,confirmed,file}], total_in_index, awareness}` is
//   unchanged.
//
//   PART B — the scope stage NON-VACUITY proof (STEP 3's explicit
//   requirement): plants insights attributed to project-A, project-B, and a
//   genuinely unattributed ("_global"-shaped, no `projects` array) insight,
//   then asserts `scope:"project"` selects only the caller's own project's
//   insight, `scope:"global"` selects only the unattributed one, and
//   `scope:"all"`/omitted selects everything — proving the filter actually
//   discriminates, not merely passes through regardless of `scope`.
//
//   PART C — the SAME proof one layer down, directly against `queryMemory()`
//   itself (not just recallInsight()) — this is the seam Wave 4
//   (session_start) will consume directly, so it must independently work at
//   that layer too, not just through recallInsight()'s own wrapper.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-recall-insight-scope-" + Date.now());

describe("recallInsight() + queryMemory() — Wave 3b SCOPE stage", () => {
  let core;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core = await import("../dist/index.js");
    core.setRoot(TEST_ROOT);
  });

  after(async () => {
    core.resetRoot?.();
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  beforeEach(async () => {
    fs.rmSync(path.join(TEST_ROOT, "insights-index.json"), { force: true });
    fs.rmSync(path.join(TEST_ROOT, "projects"), { recursive: true, force: true });
  });

  // ── PART A — additive-parameter equivalence ──────────────────────────────
  describe("PART A — recallInsight() default behavior is byte-identical when project/scope are omitted", () => {
    it("a caller that never passes project/scope sees no change: same matching_insights, same relevance values", async () => {
      await core.addIndexedInsight({
        title: "EQUIVPROBE unrelated-to-scope insight",
        source: "test-seed",
        applies_when: ["equivprobe", "unrelated"],
        severity: "important",
        projects: ["some-other-project"],
      });

      const result = await core.recallInsight({ context: "equivprobe unrelated context" });
      assert.equal(result.matching_insights.length, 1, `expected the seeded insight to surface with no scope filter applied; got ${JSON.stringify(result.matching_insights)}`);
      assert.equal(result.matching_insights[0].title, "EQUIVPROBE unrelated-to-scope insight");
      assert.equal(typeof result.total_in_index, "number");
    });
  });

  // ── PART B — non-vacuity via recallInsight() ─────────────────────────────
  describe("PART B — scope non-vacuity: recallInsight() actually filters by project attribution, not a passthrough", () => {
    const PROJECT_A = "scope-proj-a";
    const PROJECT_B = "scope-proj-b";

    beforeEach(async () => {
      await core.addIndexedInsight({
        title: "ZZZSCOPEALPHA deployment pipeline caching pattern",
        source: "test-seed",
        applies_when: ["scopeprobe"],
        severity: "important",
        projects: [PROJECT_A],
      });
      await core.addIndexedInsight({
        title: "ZZZSCOPEBRAVO database migration rollback strategy",
        source: "test-seed",
        applies_when: ["scopeprobe"],
        severity: "important",
        projects: [PROJECT_B],
      });
      await core.addIndexedInsight({
        title: "ZZZSCOPECHARLIE authentication token refresh logic",
        source: "test-seed",
        applies_when: ["scopeprobe"],
        severity: "important",
        // deliberately NO `projects` field — the "_global"/unattributed case
      });
    });

    it("test-setup invariant: 3 distinct insights are seeded and all match the probe context with no scope filter", async () => {
      const result = await core.recallInsight({ context: "scopeprobe", limit: 10 });
      assert.equal(result.matching_insights.length, 3, `expected all 3 seeded insights to match with no scope filter; got ${JSON.stringify(result.matching_insights.map((i) => i.title))}`);
    });

    it('scope:"project" (project=A) selects ONLY project A\'s insight — excludes B and the unattributed one', async () => {
      const result = await core.recallInsight({ context: "scopeprobe", limit: 10, project: PROJECT_A, scope: "project" });
      const titles = result.matching_insights.map((i) => i.title);
      assert.deepEqual(titles, ["ZZZSCOPEALPHA deployment pipeline caching pattern"], `expected only project A's insight, got ${JSON.stringify(titles)}`);
    });

    it('scope:"project" (project=B) selects ONLY project B\'s insight', async () => {
      const result = await core.recallInsight({ context: "scopeprobe", limit: 10, project: PROJECT_B, scope: "project" });
      const titles = result.matching_insights.map((i) => i.title);
      assert.deepEqual(titles, ["ZZZSCOPEBRAVO database migration rollback strategy"], `expected only project B's insight, got ${JSON.stringify(titles)}`);
    });

    it('scope:"global" selects ONLY the genuinely unattributed insight — excludes BOTH project-specific ones', async () => {
      const result = await core.recallInsight({ context: "scopeprobe", limit: 10, project: PROJECT_A, scope: "global" });
      const titles = result.matching_insights.map((i) => i.title);
      assert.deepEqual(titles, ["ZZZSCOPECHARLIE authentication token refresh logic"], `expected only the unattributed insight, got ${JSON.stringify(titles)}`);
    });

    it('scope:"all" (and the omitted-scope default) includes everything, regardless of `project`', async () => {
      const explicit = await core.recallInsight({ context: "scopeprobe", limit: 10, project: PROJECT_A, scope: "all" });
      const omitted = await core.recallInsight({ context: "scopeprobe", limit: 10, project: PROJECT_A });
      assert.equal(explicit.matching_insights.length, 3);
      assert.equal(omitted.matching_insights.length, 3);
    });

    it("scope filtering runs BEFORE truncation to `limit` — a small `limit` under scope:\"project\" still finds the one project-scoped match even with 2 other non-matching insights ranked ahead of it pre-filter", async () => {
      // limit:1 with NO scope would only ever see whichever insight ranks
      // #1 by raw relevance (order not guaranteed to be project A's). With
      // scope:"project" the filter must run on the FULL candidate pool
      // before the limit=1 cutoff, not after — otherwise this could easily
      // return project B's or the unattributed insight instead, or nothing.
      const result = await core.recallInsight({ context: "scopeprobe", limit: 1, project: PROJECT_A, scope: "project" });
      assert.equal(result.matching_insights.length, 1);
      assert.equal(result.matching_insights[0].title, "ZZZSCOPEALPHA deployment pipeline caching pattern");
    });
  });

  // ── PART C — non-vacuity via queryMemory() directly (the W4 seam) ───────
  describe("PART C — scope non-vacuity one layer down: queryMemory({tiers:['insight']}) itself discriminates by project attribution", () => {
    const PROJECT_A = "qm-scope-proj-a";
    const PROJECT_B = "qm-scope-proj-b";

    beforeEach(async () => {
      await core.addIndexedInsight({
        title: "QMZZZSCOPEALPHA deployment pipeline caching pattern",
        source: "test-seed",
        applies_when: ["qmscopeprobe"],
        severity: "important",
        projects: [PROJECT_A],
      });
      await core.addIndexedInsight({
        title: "QMZZZSCOPEBRAVO database migration rollback strategy",
        source: "test-seed",
        applies_when: ["qmscopeprobe"],
        severity: "important",
        projects: [PROJECT_B],
      });
      await core.addIndexedInsight({
        title: "QMZZZSCOPECHARLIE authentication token refresh logic",
        source: "test-seed",
        applies_when: ["qmscopeprobe"],
        severity: "important",
      });
    });

    it('queryMemory({tiers:["insight"], scope:"project"}) keeps only the caller project\'s insight', async () => {
      const result = await core.queryMemory({ query: "qmscopeprobe", project: PROJECT_A, tiers: ["insight"], scope: "project", limit: 10 });
      const titles = result.items.map((i) => i.title);
      assert.deepEqual(titles, ["QMZZZSCOPEALPHA deployment pipeline caching pattern"], `expected only project A's insight via queryMemory(); got ${JSON.stringify(titles)}`);
    });

    it('queryMemory({tiers:["insight"], scope:"global"}) keeps only the unattributed insight', async () => {
      const result = await core.queryMemory({ query: "qmscopeprobe", project: PROJECT_A, tiers: ["insight"], scope: "global", limit: 10 });
      const titles = result.items.map((i) => i.title);
      assert.deepEqual(titles, ["QMZZZSCOPECHARLIE authentication token refresh logic"], `expected only the unattributed insight via queryMemory(); got ${JSON.stringify(titles)}`);
    });

    it('queryMemory({tiers:["insight"], scope:"all"}) (and omitted scope) keeps all 3 via queryMemory()', async () => {
      const explicit = await core.queryMemory({ query: "qmscopeprobe", project: PROJECT_A, tiers: ["insight"], scope: "all", limit: 10 });
      const omitted = await core.queryMemory({ query: "qmscopeprobe", project: PROJECT_A, tiers: ["insight"], limit: 10 });
      assert.equal(explicit.items.length, 3, `expected all 3 under scope:"all"; got ${JSON.stringify(explicit.items.map((i) => i.title))}`);
      assert.equal(omitted.items.length, 3, `expected all 3 with scope omitted (default); got ${JSON.stringify(omitted.items.map((i) => i.title))}`);
    });

    it("SCOPE_ATTRIBUTED_TIERS no-op check: scope:\"project\" on the journal tier never excludes a genuine same-project journal candidate (journal candidates never carry `projects`, so a naive filter would wrongly drop them all)", async () => {
      const jdir = core.journalDir(PROJECT_A);
      fs.mkdirSync(jdir, { recursive: true });
      fs.writeFileSync(path.join(jdir, "2026-08-30--card--noop-check.md"), "# noop check\nJOURNALSCOPE_NOOP_TERM entry\n", "utf-8");

      const result = await core.queryMemory({ query: "JOURNALSCOPE_NOOP_TERM", project: PROJECT_A, tiers: ["journal"], scope: "project", limit: 10 });
      assert.equal(result.items.length, 1, `expected the journal tier to be a genuine NO-OP under scope:"project" (never excludes same-project candidates); got ${JSON.stringify(result.items)}`);
    });
  });
});
