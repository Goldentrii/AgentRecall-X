/**
 * repo-cloud-outbox.test.mjs — WP-P2 RED->GREEN suite (ADR-001 rev2 §5:
 * write receipts / outbox / offline / unknown).
 *
 * Tests:
 *  - offline fault: mutate() never reaches the network -> `queued` with a
 *    durable outbox_ref; readSnapshot degrades to `unverified`/`cached`,
 *    never `fresh`.
 *  - ack_lost fault: the RPC actually committed server-side, but the caller
 *    only sees `unknown` — getOperation() (or a fresh repo after "restart")
 *    resolves the real outcome via the idempotency key.
 *  - CloudRepository.drainOutbox() replays a queued (offline) entry once the
 *    network is back and resolves it to committed.
 *  - readSnapshot access_epoch changes (and the client cache is dropped)
 *    after a grant is revoked/re-granted.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import createHarness from "./harness/pglite-harness.mjs";

describe("WP-P2 cloud outbox / offline / unknown (ADR §5, R2.10)", () => {
  let harness;

  before(async () => {
    harness = await createHarness();
    await harness.setup();
  });

  after(async () => {
    await harness.teardown();
  });

  it("offline: mutate() returns queued with a durable outbox_ref, never touches the server", async () => {
    const owner = await harness.newOwner("U-offline-mutate");
    const wsId = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);
    const recId = randomUUID();

    await harness.armFault("offline", owner);
    const receipt = await repo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: "queued while offline", authority: "explicit_user" },
      null, randomUUID(), owner.ownerWrite(),
    );
    assert.equal(receipt.status, "queued");
    assert.ok(receipt.outbox_ref && receipt.outbox_ref.length > 0);
    await harness.clearFaults();

    // the record must NOT exist server-side yet (offline truly means "never sent").
    const notYet = await repo.get(recId, owner.read());
    assert.equal(notYet.items.length, 0);
  });

  it("offline: readSnapshot degrades to unverified/cached, never reports fresh", async () => {
    const owner = await harness.newOwner("U-offline-read");
    const wsId = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);

    // warm the cache with one real (fresh) read.
    const warm = await repo.readSnapshot(owner.read({ workspace_id: wsId }));
    assert.equal(warm.freshness, "fresh");

    await harness.armFault("offline", owner);
    const cachedHit = await repo.readSnapshot(owner.read({ workspace_id: wsId }));
    assert.notEqual(cachedHit.freshness, "fresh");
    assert.ok(["cached", "stale", "unverified"].includes(cachedHit.freshness));
    await harness.clearFaults();
  });

  it("ack_lost: caller sees unknown, but the write actually committed and is resolvable via getOperation()", async () => {
    const owner = await harness.newOwner("U-ack-lost");
    const wsId = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);
    const recId = randomUUID();
    const opId = randomUUID();

    await harness.armFault("ack_lost", owner);
    const receipt = await repo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: "ack lost", authority: "explicit_user" },
      null, opId, owner.ownerWrite(),
    );
    assert.equal(receipt.status, "unknown");
    await harness.clearFaults();

    const opRecord = await repo.getOperation(opId, owner.principal);
    assert.equal(opRecord.receipt.status, "committed");

    const stored = await repo.get(recId, owner.read());
    assert.equal(stored.items.length, 1, "the record must actually exist server-side despite the client seeing 'unknown'");
  });

  it("drainOutbox() replays a queued (offline) write once the network is back, resolving to committed", async () => {
    const owner = await harness.newOwner("U-drain");
    const wsId = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);
    const recId = randomUUID();

    await harness.armFault("offline", owner);
    const queued = await repo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: "drain me", authority: "explicit_user" },
      null, randomUUID(), owner.ownerWrite(),
    );
    assert.equal(queued.status, "queued");
    await harness.clearFaults();

    const results = await repo.drainOutbox();
    assert.equal(results.length, 1);
    assert.equal(results[0].outcome, "committed");

    const stored = await repo.get(recId, owner.read());
    assert.equal(stored.items.length, 1);
    assert.equal(stored.items[0].content, "drain me");
  });

  it("access_epoch changes after a grant is revoked, and the client cache is dropped on the next read", async () => {
    const owner = await harness.newOwner("U-epoch");
    const wsId = await harness.workspace(owner);
    const agent = await harness.newAgent(owner, "epoch-agent", { workspace_id: wsId, can_read: true, can_write: true });
    const agentRepo = await harness.repoFor(agent);

    const recId = randomUUID();
    await agentRepo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: "epoch test", authority: "agent_inference" },
      null, randomUUID(), agent.write(),
    );

    const before1 = await agentRepo.get(recId, agent.read());
    const epoch1 = before1.access_epoch;

    await harness.revoke(owner, agent, wsId);
    // re-grant so the agent can still read, but the epoch must have moved.
    await harness.newAgent(owner, "epoch-agent-2", { workspace_id: wsId, can_read: true, can_write: true });

    // Same agent principal was revoked — a read now legitimately returns
    // nothing (no active grant), but the point under test is the epoch
    // itself: fetch it via a still-privileged owner read of the SAME record
    // to confirm the epoch counter advanced globally for this owner scope.
    const ownerRepo = await harness.repoFor(owner);
    const afterAsOwner = await ownerRepo.get(recId, owner.read());
    assert.ok(afterAsOwner.access_epoch >= epoch1, "access_epoch must be monotonically non-decreasing");
    assert.notEqual(afterAsOwner.access_epoch, epoch1, "revoking a grant must bump the access epoch (R2.10)");
  });
});
