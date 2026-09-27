/**
 * repo-cloud-frozen-suite-findings.test.mjs — Fix round 1, follow-up.
 *
 * Two defects surfaced by the independent verifier's own run of the frozen
 * acceptance suite (scripts/acceptance/contract-suite.mjs) against this
 * harness under suite v1 — NOT by a test written in this worktree first.
 * RED evidence for both is the verifier's own partial TAP transcript
 * (reports/.../tests/prelim-p2/contract-suite.tap), which is what this
 * worktree was told to diagnose:
 *
 *   ▶ G-validate
 *     ✖ path-traversal id ("../x") rejected before any effect is observable
 *   ▶ G-authz
 *     ✖ positive control: agent create of a plain private fact is directly effective
 *     [suite then hung >40 min inside/after the very next test]
 *
 * These tests reproduce both defects directly against CloudRepository/
 * ar2_mutate (not the frozen suite, which this worktree must not edit) as
 * this worktree's own committed regression coverage.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import createHarness from "./harness/pglite-harness.mjs";

describe("WP-P2 fix round 1 / frozen-suite finding: path-traversal id must not throw", () => {
  let harness;

  before(async () => {
    harness = await createHarness();
    await harness.setup();
  });

  after(async () => {
    await harness.teardown();
  });

  it('get()/history() with a non-UUID id ("../x") return empty, not an uncaught PgError', async () => {
    const owner = await harness.newOwner("U-frozen-path-traversal");
    const repo = await harness.repoFor(owner);
    const trickId = "../x";

    // Root cause: CloudRepository.get()/history() passed `id` straight
    // through to ar2_get/ar2_history's uuid-typed RPC parameter with no
    // client-side shape check. Postgres (and, identically, a real
    // PostgREST-fronted Supabase) raises a hard 22P02
    // invalid_text_representation error casting "../x" to uuid — which
    // propagated as an UNCAUGHT PgError out of get()/history() instead of
    // the graceful empty/not-found result a malformed id should produce.
    const readBack = await repo.get(trickId, owner.read());
    assert.equal(readBack.items.length, 0);
    assert.equal(readBack.freshness, "fresh", "a malformed id is unconditionally unreadable — no network round trip is needed to know that");

    const hist = await repo.history(trickId, owner.read());
    assert.deepEqual(hist, []);
  });

  it("a create() with a non-UUID id is still rejected:schema client-side before any network call (sanity — this half already worked)", async () => {
    const owner = await harness.newOwner("U-frozen-path-traversal-2");
    const wsId = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);
    const receipt = await repo.mutate(
      { op: "create", id: "../x", workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: "x", authority: "explicit_user" },
      null, randomUUID(), owner.ownerWrite(),
    );
    assert.equal(receipt.status, "rejected");
    assert.equal(receipt.reason, "schema");
  });
});

describe("WP-P2 fix round 1 / frozen-suite finding: a plain private fact create is directly active", () => {
  let harness;

  before(async () => {
    harness = await createHarness();
    await harness.setup();
  });

  after(async () => {
    await harness.teardown();
  });

  it("agent create of kind=fact, visibility=private, project_id=null (the ordinary case) is committed AND effective=true/status=active", async () => {
    // Root cause: ar2_mutate's create-status logic treated `project_id IS
    // NULL` as equivalent to R2.1 row 2's "project_id != resolved project"
    // (candidate-unless-owner-trusted) — but a null project_id is simply
    // "this record isn't scoped to any one project" (the normal case for
    // most facts/preferences/decisions), not a foreign/mismatched one. The
    // frozen suite's "positive control" exists specifically to catch this:
    // its OWN comment notes a wrong answer here used to silently cancel
    // every subsequent subtest in the group.
    const owner = await harness.newOwner("U-frozen-positive-control");
    const wsId = await harness.workspace(owner);
    const agent = await harness.newAgent(owner, "worker", { workspace_id: wsId, project_ids: null, can_read: true, can_write: true, can_approve: false, personal: true });
    const agentRepo = await harness.repoFor(agent);

    const receipt = await agentRepo.mutate(
      { op: "create", id: randomUUID(), workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: "agent-plain-fact", authority: "agent_inference" },
      null, randomUUID(), agent.write(),
    );
    assert.equal(receipt.status, "committed");
    assert.equal(receipt.effective, true, "a plain private fact must be immediately effective, not silently downgraded to a candidate proposal");
    assert.equal(receipt.effective_status, "active");
  });

  it("kind=constraint and visibility=workspace/owner_shared are UNAFFECTED — still candidate for a non-owner-trusted writer (regression guard)", async () => {
    const owner = await harness.newOwner("U-frozen-regression-guard");
    const wsId = await harness.workspace(owner);
    const agent = await harness.newAgent(owner, "worker2", { workspace_id: wsId, project_ids: null, can_read: true, can_write: true });
    const agentRepo = await harness.repoFor(agent);

    const constraintReceipt = await agentRepo.mutate(
      { op: "create", id: randomUUID(), workspace_id: wsId, project_id: null, kind: "constraint", visibility: "workspace", content: "rule", authority: "agent_inference" },
      null, randomUUID(), agent.write(),
    );
    assert.equal(constraintReceipt.effective_status, "candidate", "kind=constraint must still land candidate for a non-owner-trusted writer");

    const ownerSharedReceipt = await agentRepo.mutate(
      { op: "create", id: randomUUID(), workspace_id: wsId, project_id: null, kind: "preference", visibility: "owner_shared", content: "pref", authority: "agent_inference" },
      null, randomUUID(), agent.write(),
    );
    assert.equal(ownerSharedReceipt.effective_status, "candidate", "visibility=owner_shared must still land candidate for a non-owner-trusted writer");
  });
});
