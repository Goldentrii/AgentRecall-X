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

describe("WP-P2 fix round 1 / frozen-suite finding (evaluator v3): history() must show a retracted record as a tombstone", () => {
  // Root cause: ar2_record_revisions_select's RLS policy did `EXISTS (SELECT
  // 1 FROM ar2_records r WHERE ... AND ar2_visible(...))` — a naive
  // reference to ar2_records from inside ANOTHER table's policy. Postgres
  // does not bypass a table's own RLS just because the reference sits
  // inside a different policy's USING clause, so ar2_records_select's
  // OWN `status <> 'retracted'` clause (A16's read-path exclusion) silently
  // zeroed out the subquery for any retracted record — hiding its entire
  // history even from its own owner. history() is explicitly NOT covered by
  // A16's exclusion ("history shows the retraction as a tombstone, not
  // silently omitted" — G-retract, contract-suite.mjs). Same bug, same
  // fix, applied to ar2_events_select and ar2_outcomes_select too (both had
  // the identical EXISTS-against-ar2_records pattern).
  let harness;

  before(async () => {
    harness = await createHarness();
    await harness.setup();
  });

  after(async () => {
    await harness.teardown();
  });

  it("history() still reports a retracted record's revisions, with the last one status=retracted", async () => {
    const owner = await harness.newOwner("U-history-tombstone");
    const wsId = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);
    const recId = randomUUID();

    const created = await repo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: "will be retracted", authority: "explicit_user" },
      null, randomUUID(), owner.ownerWrite(),
    );
    assert.equal(created.status, "committed");

    const retracted = await repo.mutate({ op: "retract", id: recId, reason: "cleanup" }, created.revision, randomUUID(), owner.ownerWrite());
    assert.equal(retracted.status, "committed");
    assert.equal(retracted.effective_status, "retracted");

    const hist = await repo.history(recId, owner.read());
    assert.ok(hist.length > 0, "history must still report the record existed, even after retraction");
    assert.equal(hist[hist.length - 1].status, "retracted");

    // get()/query() must still correctly EXCLUDE the retracted content (A16) — this fix must not
    // accidentally widen those paths back open.
    const stillDenied = await repo.get(recId, owner.read());
    assert.equal(stillDenied.items.length, 0, "get() must still deny retracted content (A16) after this fix");
  });
});

describe("WP-P2 fix round 1 / frozen-suite finding (evaluator v3): getOperation() must not throw while offline", () => {
  // Root cause: getOperation() always called the remote RPC directly, so a
  // genuinely-queued (never-sent) operation threw an uncaught NetworkError
  // while offline instead of being reported from the durable outbox
  // getOperation() itself could already see (G-outbox: "queued op must
  // survive a restart while still offline"). A `reconcile_only` entry
  // (ack_lost) is different: the outbox doesn't know the true outcome, so
  // it must still try the network first, falling back to the outbox's own
  // "unknown" shape only if the network is genuinely unreachable.
  let harness;

  before(async () => {
    harness = await createHarness();
    await harness.setup();
  });

  after(async () => {
    await harness.teardown();
  });

  it("a genuinely-queued (offline, never-sent) operation is reported queued without a network call", async () => {
    const owner = await harness.newOwner("U-getop-offline-queued");
    const wsId = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);
    const opId = randomUUID();

    await harness.armFault("offline", owner);
    const receipt = await repo.mutate(
      { op: "create", id: randomUUID(), workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: "queued", authority: "explicit_user" },
      null, opId, owner.ownerWrite(),
    );
    assert.equal(receipt.status, "queued");

    // still offline — getOperation() must not throw, and must report queued from the durable outbox.
    const op = await repo.getOperation(opId, owner.principal);
    assert.ok(op, "getOperation() must not throw/return undefined while offline for a queued op");
    assert.equal(op.receipt.status, "queued");
    await harness.clearFaults();
  });

  it("an ack_lost (reconcile_only) operation still resolves the real server status once online (regression guard)", async () => {
    const owner = await harness.newOwner("U-getop-acklost-online");
    const wsId = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);
    const opId = randomUUID();

    await harness.armFault("ack_lost", owner);
    const receipt = await repo.mutate(
      { op: "create", id: randomUUID(), workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: "ack lost", authority: "explicit_user" },
      null, opId, owner.ownerWrite(),
    );
    assert.equal(receipt.status, "unknown");
    await harness.clearFaults();

    const op = await repo.getOperation(opId, owner.principal);
    assert.equal(op.receipt.status, "committed", "once online, getOperation() must report the REAL server status, not a stale 'queued' guess from the reconcile-only outbox entry");
  });

  it("getOperation() one-shot-replays an undrained queued entry once online (nothing else auto-drains the outbox)", async () => {
    // Root cause: G-outbox's own test never calls drainOutbox() explicitly —
    // it just clears the offline fault and polls getOperation() expecting
    // eventual "committed". Nothing in this architecture auto-drains the
    // outbox in the background, so without this fix the poll would spin
    // forever reporting a stale "queued" from the un-replayed local entry.
    const owner = await harness.newOwner("U-getop-autoreplay");
    const wsId = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);
    const recId = randomUUID();
    const opId = randomUUID();

    await harness.armFault("offline", owner);
    const queued = await repo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: "will auto-replay", authority: "explicit_user" },
      null, opId, owner.ownerWrite(),
    );
    assert.equal(queued.status, "queued");
    await harness.clearFaults();

    // No explicit drainOutbox() call — matches the frozen suite's own G-outbox test shape exactly.
    const op = await repo.getOperation(opId, owner.principal);
    assert.equal(op.receipt.status, "committed", "getOperation() must replay an undrained queued entry itself once the network is reachable, not just report stale 'queued' forever");

    const stored = await repo.get(recId, owner.read());
    assert.equal(stored.items.length, 1, "the replayed write must actually exist server-side");
  });
});
