/**
 * promoteConfirmedInsights — saturation churn guard (fix12 hygiene, 2026-09-12).
 *
 * Pre-guard behavior (observed during the fix3 CJK backfill, flagged for the
 * #8 hygiene batch): against a SATURATED awareness (top-insights cap reached,
 * every slot outranking the candidate) each promotion run resurrected the
 * candidate from the archive (+1 confirmations), pushed it, and immediately
 * demoted it back — promote→demote→resurrect churn on EVERY session_end /
 * `ar awareness rollup`, with an artificial confirmations escalator on the
 * archived entry (no real confirmation behind the +1s).
 *
 * Guard contract pinned here:
 *   1. saturated + archived twin already >= index confirmed_count → SKIP,
 *      archive byte-untouched (no +1 inflation, no writes).
 *   2. saturated + index confirmed_count GREW past the archived count → the
 *      attempt proceeds (real new confirmations); churn is bounded — once the
 *      archived count catches up, runs go quiet again.
 *   3. non-saturated awareness → guard never fires; archived candidates
 *      resurrect and stay (organic path preserved).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-promotion-churn-" + Date.now());

let core;

function seedIndexCandidate(confirmedCount) {
  core.writeInsightsIndex({
    version: "1.0.0",
    updated: new Date().toISOString(),
    insights: [{
      id: "cand-1",
      title: "Prefer streaming parser for giant ledgers",
      source: "test",
      applies_when: ["ledger", "parser"],
      severity: "important",
      confirmed_count: confirmedCount,
      last_confirmed: new Date().toISOString(),
    }],
  });
}

function archivedCandidate() {
  return core.readAwarenessArchive().find((a) => /streaming parser/i.test(a.title));
}

describe("promoteConfirmedInsights — saturation churn guard", () => {
  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core = await import("../dist/index.js");
    await core.initAwareness("churn tester");

    // Saturate awareness at the cap with high-confirmation insights that the
    // candidate can never displace.
    const topics = [
      "GraphQL federation gateway", "Rust borrow checker lifetimes",
      "Postgres logical replication", "Kubernetes admission webhooks",
      "Terraform state locking", "Redis cluster resharding",
      "Kafka exactly-once semantics", "WebAssembly component model",
      "OAuth token rotation", "CDN edge invalidation",
      "SQLite WAL checkpointing", "gRPC deadline propagation",
      "Elasticsearch shard sizing", "Vault dynamic secrets",
      "Istio sidecar injection", "Prometheus remote write",
      "Airflow dag backfills", "Spark shuffle partitions",
      "Nginx upstream retries", "Consul service mesh",
    ];
    for (const title of topics) {
      await core.addInsight({
        title,
        evidence: `Evidence for ${title}`,
        appliesWhen: [title.split(" ")[0].toLowerCase()],
        source: "test",
      });
    }
    const state = core.readAwarenessState();
    assert.equal(state.topInsights.length, core.AWARENESS_TOP_INSIGHTS_CAP, "fixture must saturate the cap");
    for (const i of state.topInsights) i.confirmations = 50;
    await core.writeAwarenessState(state);
  });

  after(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("skips a saturated-doomed candidate whose archive twin already carries its confirmations (no churn, no +1 inflation)", async () => {
    seedIndexCandidate(3);
    await core.writeAwarenessArchive([{
      id: "insight-archived-cand",
      title: "Prefer streaming parser for giant ledgers",
      evidence: "archived evidence",
      confirmations: 3,
      lastConfirmed: "2026-09-01T00:00:00.000Z",
      appliesWhen: ["ledger", "parser"],
      source: "test",
    }]);
    const archiveBefore = JSON.stringify(core.readAwarenessArchive());

    const result = await core.promoteConfirmedInsights(3);

    assert.ok(result.skipped.includes("Prefer streaming parser for giant ledgers"), "candidate must be skipped");
    assert.ok(!result.promoted.includes("Prefer streaming parser for giant ledgers"));
    assert.equal(
      JSON.stringify(core.readAwarenessArchive()),
      archiveBefore,
      "archive must be byte-identical — no resurrect/demote round-trip, no artificial +1"
    );
    // Run again: steady state, still quiet.
    const again = await core.promoteConfirmedInsights(3);
    assert.ok(again.skipped.includes("Prefer streaming parser for giant ledgers"));
    assert.equal(JSON.stringify(core.readAwarenessArchive()), archiveBefore);
  });

  it("re-attempts when confirmed_count grows past the archived count, and the churn is BOUNDED (stops once the archive catches up)", async () => {
    seedIndexCandidate(5); // archived twin sits at 3 → 5 > 3, attempt proceeds

    // Attempt 1: resurrect (+1) → demoted back (cap outranks it) → archived 4.
    await core.promoteConfirmedInsights(3);
    let arch = archivedCandidate();
    assert.ok(arch, "candidate must be back in the archive after the doomed attempt");
    assert.equal(arch.confirmations, 4, "one bounded +1 per real-confirmation gap");

    // Attempt 2: 5 > 4 → one more attempt → archived 5.
    await core.promoteConfirmedInsights(3);
    arch = archivedCandidate();
    assert.equal(arch.confirmations, 5);

    // Attempt 3: 5 >= 5 → guard re-armed, quiet forever until real growth.
    const result = await core.promoteConfirmedInsights(3);
    assert.ok(result.skipped.includes("Prefer streaming parser for giant ledgers"));
    arch = archivedCandidate();
    assert.equal(arch.confirmations, 5, "no unbounded escalator once the archive caught up");
  });

  it("never guards a non-saturated awareness — archived candidates resurrect and stay", async () => {
    // Free a slot: drop one insight from the top list.
    const state = core.readAwarenessState();
    state.topInsights = state.topInsights.filter((i) => !/Consul service mesh/.test(i.title));
    await core.writeAwarenessState(state);

    seedIndexCandidate(6); // any value ≥ threshold; guard must not even be consulted

    const result = await core.promoteConfirmedInsights(3);
    assert.ok(result.promoted.includes("Prefer streaming parser for giant ledgers"), "candidate must promote into the free slot");
    const after = core.readAwarenessState();
    assert.ok(
      after.topInsights.some((i) => /streaming parser/i.test(i.title)),
      "resurrected candidate must STAY in topInsights (organic path preserved)"
    );
    assert.equal(archivedCandidate(), undefined, "archive entry consumed by the resurrection");
  });

  // fix12 review MEDIUM-1 (fix round 2026-09-13) — the reviewer's exact
  // adversarial case: a saturated top-20 whose WEAKEST slot has 1
  // confirmation, plus an archived twin whose count the pre-fix escalator
  // inflated to 50, and an index candidate at confirmed_count 5. The first
  // fix-round guard compared ONLY archived-vs-index (50 >= 5 → skip) and
  // blocked an ORGANIC promotion: the resurrected twin (50+1=51) would have
  // displaced the weak slot and STAYED. The guard now also requires "cannot
  // outrank the current weakest slot" (archived+1 <= min) before skipping —
  // a survivable promotion must always go through, at ANY index count.
  //
  // Runs LAST deliberately: the previous test's end state (19 slots @50 +
  // the re-promoted streaming-parser insight = 20, archive empty) is exactly
  // the saturated fixture this case needs; the streaming-parser slot becomes
  // the weak 1-confirmation incumbent.
  it("REVIEWER CASE: an inflated archived twin must NOT block an organic promotion that can displace a weak slot", async () => {
    const title = "Prefer columnar storage for archival scans";

    // Weaken one slot to 1 confirmation (the other 19 stay at 50).
    const state = core.readAwarenessState();
    assert.equal(state.topInsights.length, core.AWARENESS_TOP_INSIGHTS_CAP, "fixture must be saturated");
    const weak = state.topInsights.find((i) => /streaming parser/i.test(i.title));
    assert.ok(weak, "prior test left the streaming-parser insight in topInsights");
    weak.confirmations = 1;
    await core.writeAwarenessState(state);

    // Archived twin inflated by the (pre-fix) escalator.
    await core.writeAwarenessArchive([{
      id: "insight-archived-columnar",
      title,
      evidence: "archived evidence",
      confirmations: 50,
      lastConfirmed: "2026-09-01T00:00:00.000Z",
      appliesWhen: ["columnar", "storage"],
      source: "test",
    }]);

    // Index candidate at confirmed_count 5 — 50 >= 5, so the OLD guard skipped here.
    core.writeInsightsIndex({
      version: "1.0.0",
      updated: new Date().toISOString(),
      insights: [{
        id: "cand-columnar",
        title,
        source: "test",
        applies_when: ["columnar", "storage"],
        severity: "important",
        confirmed_count: 5,
        last_confirmed: new Date().toISOString(),
      }],
    });

    const result = await core.promoteConfirmedInsights(3);

    assert.ok(result.promoted.includes(title), "organic promotion must NOT be blocked by the inflated archived twin");
    assert.ok(!result.skipped.includes(title));
    const after = core.readAwarenessState();
    const landed = after.topInsights.find((i) => i.title === title);
    assert.ok(landed, "resurrected candidate must be IN topInsights (promote-and-stay, zero churn)");
    assert.equal(landed.confirmations, 51, "resurrection carries archived count + 1");
    assert.ok(
      !after.topInsights.some((i) => /streaming parser/i.test(i.title)),
      "the weak 1-confirmation slot is the one displaced"
    );
    assert.ok(
      core.readAwarenessArchive().some((a) => /streaming parser/i.test(a.title)),
      "displaced slot is archived, not deleted"
    );
  });
});
