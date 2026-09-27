import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";

// Smoke test for packages/core/test/harness/local-harness.mjs against
// scripts/acceptance/harness.d.ts. The real frozen contract-suite.mjs
// (WP-V) is not in this worktree (brief step 9 explicitly skipped) — this
// is WP-P1's own verification that the harness is pluggable and behaves per
// the interface, so it "can be plugged in later" as the brief requires.

describe("local-harness.mjs against harness.d.ts", () => {
  let harness;
  let owner;
  let agent;
  let workspaceId;
  let projectId;

  before(async () => {
    const mod = await import("./harness/local-harness.mjs");
    harness = await mod.default();
    await harness.setup();
  });

  after(async () => {
    await harness.teardown();
  });

  it("declares the capabilities the brief specifies", () => {
    assert.deepEqual(harness.capabilities, {
      multiUser: false, agents: true, faults: ["crash_after_wal", "crash_before_receipt"], realCloud: false,
    });
  });

  it("newOwner/newAgent/workspace/project/grant wiring works end to end", async () => {
    owner = await harness.newOwner("U");
    workspaceId = await harness.workspace(owner);
    projectId = await harness.project(owner, workspaceId, "demo-project");
    assert.ok(workspaceId && projectId);

    agent = await harness.newAgent(owner, "bot1", { workspace_id: workspaceId, can_write: true, can_approve: false });
    assert.equal(agent.principal.kind, "agent");
    assert.equal(agent.principal.owner_id, owner.principal.owner_id);
  });

  it("repoFor(owner) create + repoFor(agent) read respects grants", async () => {
    const ownerRepo = await harness.repoFor(owner);
    const id = crypto.randomUUID();
    const receipt = await ownerRepo.mutate(
      { op: "create", id, workspace_id: workspaceId, project_id: projectId, kind: "fact", visibility: "project", content: "shared fact", authority: "explicit_user" },
      null, crypto.randomUUID(), owner.write(),
    );
    assert.equal(receipt.status, "committed");

    const agentRepo = await harness.repoFor(agent);
    const read = await agentRepo.get(id, agent.read());
    assert.equal(read.items.length, 1, "agent's project-scoped grant should allow reading the record");
    assert.equal(read.items[0].content, "shared fact");
  });

  it("ownerWrite() throws for an agent actor", () => {
    assert.throws(() => agent.ownerWrite());
  });

  it("armFault + a real child-process crash -> unknown receipt, then restart() recovers the record", async () => {
    const ownerRepo = await harness.repoFor(owner);
    const id = crypto.randomUUID();
    const operationId = crypto.randomUUID();

    await harness.armFault("crash_after_wal", owner);
    const crashedReceipt = await ownerRepo.mutate(
      { op: "create", id, workspace_id: workspaceId, project_id: projectId, kind: "fact", visibility: "project", content: "will recover", authority: "explicit_user" },
      null, operationId, owner.write(),
    );
    assert.equal(crashedReceipt.status, "unknown");
    assert.equal(crashedReceipt.operation_id, operationId);

    const recoveredRepo = await harness.restart(owner);
    const op = await recoveredRepo.getOperation(operationId, owner.principal);
    assert.ok(op, "operation should have been recovered from the WAL");
    assert.equal(op.receipt.status, "committed");

    const read = await recoveredRepo.get(id, owner.read());
    assert.equal(read.items.length, 1);
    assert.equal(read.items[0].content, "will recover");
  });

  it("armFault('crash_before_receipt') also recovers, and is single-shot (only the next mutate is faulted)", async () => {
    const ownerRepo = await harness.repoFor(owner);
    const id1 = crypto.randomUUID();
    await harness.armFault("crash_before_receipt", owner);
    const first = await ownerRepo.mutate(
      { op: "create", id: id1, workspace_id: workspaceId, project_id: projectId, kind: "fact", visibility: "project", content: "faulted", authority: "explicit_user" },
      null, crypto.randomUUID(), owner.write(),
    );
    assert.equal(first.status, "unknown");

    const recovered = await harness.restart(owner);
    const id2 = crypto.randomUUID();
    const second = await recovered.mutate(
      { op: "create", id: id2, workspace_id: workspaceId, project_id: projectId, kind: "fact", visibility: "project", content: "not faulted", authority: "explicit_user" },
      null, crypto.randomUUID(), owner.write(),
    );
    assert.equal(second.status, "committed", "the fault must not still be armed for a later call (single-shot)");
  });

  it("revoke() removes the agent's grant-derived access", async () => {
    await harness.revoke(owner, agent, workspaceId);
    const agentRepo = await harness.repoFor(agent);
    const ownerRepo = await harness.repoFor(owner);
    const id = crypto.randomUUID();
    await ownerRepo.mutate(
      { op: "create", id, workspace_id: workspaceId, project_id: projectId, kind: "fact", visibility: "project", content: "post-revoke", authority: "explicit_user" },
      null, crypto.randomUUID(), owner.write(),
    );
    const read = await agentRepo.get(id, agent.read());
    assert.equal(read.items.length, 0, "revoked agent must no longer read project-scoped content");
  });
});
