/**
 * repo-cloud-cas-idempotency.test.mjs — WP-P2 RED->GREEN suite (ADR-001
 * rev2 R2.5: CAS + idempotency order; R2.12: outcome uniqueness).
 *
 * Tests:
 *  - CAS conflict: wrong expectedRevision -> `conflict`, current revision
 *    exposed (caller can read the record).
 *  - Idempotent replay: same operation_id + same payload -> the ORIGINAL
 *    receipt, `replayed:true`, no second mutation (revision unchanged).
 *  - Idempotency mismatch: same operation_id, different payload ->
 *    `rejected:idempotency_mismatch`.
 *  - A revoked grant rejects a replay attempt with `rejected:grant_revoked`
 *    -shaped forbidden (grant revocation takes effect immediately, R2.2).
 *  - recordOutcome is idempotent per (owner_id, memory_id, memory_revision,
 *    source_event_id) — a duplicate produces no second effect (R2.12).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import createHarness from "./harness/pglite-harness.mjs";

describe("WP-P2 cloud CAS + idempotency (R2.5, R2.12)", () => {
  let harness;

  before(async () => {
    harness = await createHarness();
    await harness.setup();
  });

  after(async () => {
    await harness.teardown();
  });

  it("CAS conflict on wrong expectedRevision exposes the current revision/status", async () => {
    const owner = await harness.newOwner("U-cas");
    const wsId = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);
    const recId = randomUUID();
    await repo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: "v1", authority: "explicit_user" },
      null, randomUUID(), owner.ownerWrite(),
    );

    const conflict = await repo.mutate({ op: "update", id: recId, patch: { content: "v2 via wrong revision" } }, 999, randomUUID(), owner.ownerWrite());
    assert.equal(conflict.status, "conflict");
    assert.equal(conflict.expected_revision, 999);
    assert.equal(conflict.current.revision, 1);
    assert.equal(conflict.current.status, "active");
  });

  it("idempotent replay: same operation_id + same command -> original receipt, replayed=true, no new mutation", async () => {
    const owner = await harness.newOwner("U-replay");
    const wsId = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);
    const recId = randomUUID();
    const opId = randomUUID();
    const cmd = { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: "replay me", authority: "explicit_user" };

    const first = await repo.mutate(cmd, null, opId, owner.ownerWrite());
    assert.equal(first.status, "committed");
    assert.equal(first.replayed, false);

    const second = await repo.mutate(cmd, null, opId, owner.ownerWrite());
    assert.equal(second.status, "committed");
    assert.equal(second.replayed, true);
    assert.equal(second.revision, first.revision);

    const stored = await repo.get(recId, owner.read());
    assert.equal(stored.items[0].revision, 1, "a replay must not bump the revision a second time");
  });

  it("idempotency mismatch: same operation_id, different payload -> rejected:idempotency_mismatch", async () => {
    const owner = await harness.newOwner("U-mismatch");
    const wsId = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);
    const recId = randomUUID();
    const opId = randomUUID();

    await repo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: "original content", authority: "explicit_user" },
      null, opId, owner.ownerWrite(),
    );
    const mismatched = await repo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: "DIFFERENT content, same op id", authority: "explicit_user" },
      null, opId, owner.ownerWrite(),
    );
    assert.equal(mismatched.status, "rejected");
    assert.equal(mismatched.reason, "idempotency_mismatch");
  });

  it("a revoked grant rejects a write attempt (grant revocation takes effect immediately)", async () => {
    const owner = await harness.newOwner("U-revoke-mutate");
    const wsId = await harness.workspace(owner);
    const agent = await harness.newAgent(owner, "soon-revoked", { workspace_id: wsId, can_read: true, can_write: true });
    const agentRepo = await harness.repoFor(agent);

    const recId = randomUUID();
    const created = await agentRepo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: "before revoke", authority: "agent_inference" },
      null, randomUUID(), agent.write(),
    );
    assert.equal(created.status, "committed");

    await harness.revoke(owner, agent, wsId);

    const afterRevoke = await agentRepo.mutate({ op: "update", id: recId, patch: { content: "after revoke" } }, 1, randomUUID(), agent.write());
    assert.equal(afterRevoke.status, "rejected");
    assert.equal(afterRevoke.reason, "forbidden");
  });

  it("recordOutcome is idempotent on (owner_id, memory_id, memory_revision, source_event_id) — R2.12", async () => {
    const owner = await harness.newOwner("U-outcome");
    const wsId = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);
    const recId = randomUUID();
    const created = await repo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: "outcome target", authority: "explicit_user" },
      null, randomUUID(), owner.ownerWrite(),
    );
    assert.equal(created.status, "committed");

    const changes = await repo.readChanges(null, owner.read());
    const createEvent = changes.events.find((e) => e.record_id === recId && e.op === "create");
    assert.ok(createEvent, "the create event must be discoverable via readChanges");

    const outcome = {
      task_id: "t1", session_id: "s1", memory: { id: recId, revision: 1 },
      injected: true, applicable: true, action_taken: "used it", result: "success",
      evidence_refs: [], judged_by: "test", judge_version: "1", source_event_id: createEvent.event_id,
    };

    const first = await repo.recordOutcome(outcome, randomUUID(), owner.ownerWrite());
    assert.equal(first.status, "committed");
    assert.equal(first.replayed, false);

    // Same logical outcome key, but issued as a genuinely NEW operation_id
    // (e.g. a naive retry that regenerated one) — the server-side UNIQUE
    // constraint on (owner_id, memory_id, memory_revision, source_event_id)
    // still catches it: no second effect, receipt reports replayed=true.
    const second = await repo.recordOutcome(outcome, randomUUID(), owner.ownerWrite());
    assert.equal(second.status, "committed");
    assert.equal(second.replayed, true);
  });
});
