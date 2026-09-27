/**
 * repo-cloud-authorization.test.mjs — WP-P2 RED->GREEN suite (ADR-001 rev2
 * R2.1 authorization matrix, R2.3 existence hiding, R2.8 owner-trust).
 *
 * Tests:
 *  - Agent-forged `authority: "explicit_user"` is silently downgraded server
 *    -side unless the caller is owner_trusted (receipt.effective_authority
 *    tells the truth; client-requested authority is never honored blindly).
 *  - A client cannot forge `owner_id`/`source.principal_id` — CreateCommand
 *    has no owner_id field at all, and the server always derives source.
 *    principal_id from auth.uid(), never from the payload.
 *  - A non-owner-trusted create of a constraint / workspace-visibility /
 *    project-less record lands as `candidate`, not `active` (R2.1 row 2).
 *  - Mutating an unreadable id (private record, wrong agent) and mutating a
 *    genuinely nonexistent id both return `rejected:not_found` with the same
 *    shape (R2.3 — indistinguishable).
 *  - Protected constraint retract/update without owner_trusted+can_approve
 *    is rejected / stored as a non-effective proposal (R2.1, rev2.1 D2).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import createHarness from "./harness/pglite-harness.mjs";

describe("WP-P2 cloud authorization matrix (R2.1) + existence hiding (R2.3)", () => {
  let harness;

  before(async () => {
    harness = await createHarness();
    await harness.setup();
  });

  after(async () => {
    await harness.teardown();
  });

  it("agent-forged authority=explicit_user is downgraded to agent_inference server-side", async () => {
    const owner = await harness.newOwner("U-forge-authority");
    const wsId = await harness.workspace(owner);
    const projectId = await harness.project(owner, wsId, "p1");
    const agent = await harness.newAgent(owner, "forger", { workspace_id: wsId, can_read: true, can_write: true });
    const repo = await harness.repoFor(agent);

    const recId = randomUUID();
    const receipt = await repo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: projectId, kind: "fact", visibility: "private", content: "I claim to be explicit_user", authority: "explicit_user" },
      null, randomUUID(), agent.write(),
    );
    assert.equal(receipt.status, "committed");
    assert.equal(receipt.effective_authority, "agent_inference", "agent cannot mint explicit_user authority");

    const stored = await repo.get(recId, agent.read());
    assert.equal(stored.items[0].authority, "agent_inference");
  });

  it("owner_trusted create DOES preserve requested authority=explicit_user", async () => {
    const owner = await harness.newOwner("U-owner-authority");
    const wsId = await harness.workspace(owner);
    const projectId = await harness.project(owner, wsId, "p1");
    const repo = await harness.repoFor(owner);

    const recId = randomUUID();
    const receipt = await repo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: projectId, kind: "fact", visibility: "private", content: "owner says so", authority: "explicit_user" },
      null, randomUUID(), owner.ownerWrite(),
    );
    assert.equal(receipt.status, "committed");
    assert.equal(receipt.effective_authority, "explicit_user");
  });

  it("client-supplied source.principal_id in metadata/source is never trusted — server always uses auth.uid()", async () => {
    const owner = await harness.newOwner("U-forge-identity");
    const wsId = await harness.workspace(owner);
    const agentA = await harness.newAgent(owner, "agent-A", { workspace_id: wsId, can_read: true, can_write: true });
    const agentB = await harness.newAgent(owner, "agent-B", { workspace_id: wsId, can_read: true, can_write: true });
    const repoA = await harness.repoFor(agentA);

    const recId = randomUUID();
    // CreateCommand has no owner_id/source field to forge in the first place
    // (contract.ts) — the closest forgery surface is metadata; confirm a
    // forged principal-looking key there does not change who the server
    // thinks the author is.
    await repoA.mutate(
      {
        op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private",
        content: "forged?", authority: "agent_inference",
        metadata: { principal_id: agentB.principal.principal_id, _ar_fake: "x", dependency_release: "y" },
      },
      null, randomUUID(), agentA.write(),
    );
    const stored = await repoA.get(recId, agentA.read());
    assert.equal(stored.items[0].source.principal_id, agentA.principal.principal_id, "author must be the real caller, not a forged metadata value");
    assert.ok(!("principal_id" in stored.items[0].metadata) === false, "ordinary metadata keys are kept");
    assert.ok(!("_ar_fake" in stored.items[0].metadata), "reserved _ar* metadata keys must be stripped server-side");
    assert.ok(!("dependency_release" in stored.items[0].metadata), "reserved dependency_release metadata key must be stripped server-side");

    // agentB never authored it and has no separate grant scoping — but is NOT
    // the author, so cannot retract it (private + not author + not owner).
    const repoB = await harness.repoFor(agentB);
    const rejected = await repoB.mutate({ op: "retract", id: recId, reason: "trying to claim authorship" }, 1, randomUUID(), agentB.write());
    // agentB can't even read a private record it didn't author -> not_found (R2.3), not "forbidden".
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.reason, "not_found");
  });

  it("non-owner-trusted create of a constraint lands as candidate, not active", async () => {
    const owner = await harness.newOwner("U-constraint-candidate");
    const wsId = await harness.workspace(owner);
    const projectId = await harness.project(owner, wsId, "p1");
    const agent = await harness.newAgent(owner, "constraint-writer", { workspace_id: wsId, can_read: true, can_write: true });
    const repo = await harness.repoFor(agent);

    const recId = randomUUID();
    const receipt = await repo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: projectId, kind: "constraint", visibility: "project", content: "never do X", authority: "agent_inference" },
      null, randomUUID(), agent.write(),
    );
    assert.equal(receipt.status, "committed");
    assert.equal(receipt.effective_status, "candidate");
    assert.equal(receipt.effective, false);
  });

  it("mutation on an unreadable id and on a nonexistent id both return identical rejected:not_found", async () => {
    const owner = await harness.newOwner("U-notfound");
    const wsId = await harness.workspace(owner);
    const author = await harness.newAgent(owner, "author2", { workspace_id: wsId, can_read: true, can_write: true });
    const stranger = await harness.newAgent(owner, "stranger2", { workspace_id: wsId, can_read: true, can_write: true });
    const authorRepo = await harness.repoFor(author);
    const strangerRepo = await harness.repoFor(stranger);

    const recId = randomUUID();
    await authorRepo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: "hidden from stranger", authority: "agent_inference" },
      null, randomUUID(), author.write(),
    );

    const onUnreadable = await strangerRepo.mutate({ op: "retract", id: recId, reason: "x" }, 1, randomUUID(), stranger.write());
    const onNonexistent = await strangerRepo.mutate({ op: "retract", id: randomUUID(), reason: "x" }, 1, randomUUID(), stranger.write());

    assert.equal(onUnreadable.status, "rejected");
    assert.equal(onUnreadable.reason, "not_found");
    assert.equal(onNonexistent.status, "rejected");
    assert.equal(onNonexistent.reason, "not_found");
    assert.equal(onUnreadable.message, onNonexistent.message, "the two rejections must be indistinguishable (R2.3)");
  });

  it("retracting a protected constraint (authority=explicit_user) requires owner_trusted+can_approve", async () => {
    const owner = await harness.newOwner("U-protected");
    const wsId = await harness.workspace(owner);
    const projectId = await harness.project(owner, wsId, "p1");
    const ownerRepo = await harness.repoFor(owner);
    const agent = await harness.newAgent(owner, "no-approve", { workspace_id: wsId, can_read: true, can_write: true, can_approve: false });
    const approverAgent = await harness.newAgent(owner, "approver-but-not-owner", { workspace_id: wsId, can_read: true, can_write: true, can_approve: true });

    const recId = randomUUID();
    const created = await ownerRepo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: projectId, kind: "constraint", visibility: "project", content: "must always X", authority: "explicit_user" },
      null, randomUUID(), owner.ownerWrite(),
    );
    assert.equal(created.effective_authority, "explicit_user");
    assert.equal(created.effective_status, "active");

    const agentRepo = await harness.repoFor(agent);
    const deniedNoApprove = await agentRepo.mutate({ op: "retract", id: recId, reason: "agent tried" }, 1, randomUUID(), agent.write());
    assert.equal(deniedNoApprove.status, "rejected");
    assert.equal(deniedNoApprove.reason, "requires_owner_approval");

    // can_approve=true but still not owner_trusted (not an owner JWT) -> still denied.
    const approverRepo = await harness.repoFor(approverAgent);
    const deniedNotOwnerTrusted = await approverRepo.mutate({ op: "retract", id: recId, reason: "agent with can_approve tried" }, 1, randomUUID(), approverAgent.write());
    assert.equal(deniedNotOwnerTrusted.status, "rejected");
    assert.equal(deniedNotOwnerTrusted.reason, "requires_owner_approval");

    // the real owner CAN retract it.
    const ownerRetract = await ownerRepo.mutate({ op: "retract", id: recId, reason: "owner decision" }, 1, randomUUID(), owner.ownerWrite());
    assert.equal(ownerRetract.status, "committed");
    assert.equal(ownerRetract.effective_status, "retracted");
  });

  it("a protected update without owner trust is stored as a non-effective proposal, not applied to the target (rev2.1 D2)", async () => {
    const owner = await harness.newOwner("U-proposal");
    const wsId = await harness.workspace(owner);
    const projectId = await harness.project(owner, wsId, "p1");
    const ownerRepo = await harness.repoFor(owner);
    const agent = await harness.newAgent(owner, "proposer", { workspace_id: wsId, can_read: true, can_write: true, can_approve: false });

    const recId = randomUUID();
    await ownerRepo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: projectId, kind: "constraint", visibility: "project", content: "original rule", authority: "explicit_user" },
      null, randomUUID(), owner.ownerWrite(),
    );

    const agentRepo = await harness.repoFor(agent);
    const proposeReceipt = await agentRepo.mutate({ op: "update", id: recId, patch: { content: "proposed new rule" } }, 1, randomUUID(), agent.write());
    assert.equal(proposeReceipt.status, "committed");
    assert.equal(proposeReceipt.effective, false, "a proposal is committed as a record but not yet in force");
    assert.notEqual(proposeReceipt.id, recId, "the proposal is a NEW record, the target is untouched");

    // target unchanged
    const stillOriginal = await ownerRepo.get(recId, owner.read());
    assert.equal(stillOriginal.items[0].content, "original rule");
    assert.equal(stillOriginal.items[0].revision, 1);

    // the proposal itself is a readable candidate record with proposal_of set
    const proposal = await ownerRepo.get(proposeReceipt.id, owner.read());
    assert.equal(proposal.items[0].status, "candidate");
    assert.equal(proposal.items[0].proposal_of.id, recId);
    assert.equal(proposal.items[0].proposal_of.revision, 1);
  });
});
