/**
 * repo-cloud-exceptions.test.mjs — Fix round 1, B5 + mutation-survival #1/#2.
 *
 * B5: rev2.1 D3 requires "clearing exceptions[] on every non-exception
 * revision of T" so a stale, owner-approved exception (tied to an old
 * target_revision) doesn't silently keep applying after the constraint's
 * content/applicability changes. The update/retract/quarantine/confirm/
 * supersede-target branches all bumped revision without ever resetting
 * `exceptions`.
 *
 * Also closes the reviewer's "mutation-survival" gap: `exception` and
 * `release_dependency` had zero test coverage, so their
 * `owner_trusted AND can_approve` guards were invisible to the suite (a
 * mutation testing tool deleting either guard would go undetected).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import createHarness from "./harness/pglite-harness.mjs";

describe("WP-P2 fix round 1 / B5: exception op + exceptions[] clearing", () => {
  let harness;

  before(async () => {
    harness = await createHarness();
    await harness.setup();
  });

  after(async () => {
    await harness.teardown();
  });

  it("exception op (positive): owner_trusted + can_approve succeeds and appends to exceptions[]", async () => {
    const owner = await harness.newOwner("U-exc-positive");
    const wsId = await harness.workspace(owner);
    const projectId = await harness.project(owner, wsId, "exc-p1");
    const repo = await harness.repoFor(owner);
    const recId = randomUUID();
    await repo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: projectId, kind: "constraint", visibility: "project", content: "never do X", authority: "explicit_user" },
      null, randomUUID(), owner.ownerWrite(),
    );

    const receipt = await repo.mutate(
      { op: "exception", id: recId, exception_id: randomUUID(), applicability: { task_types: ["one-off"] }, valid_until: new Date(Date.now() + 3600_000).toISOString(), reason: "owner-approved one-off" },
      1, randomUUID(), owner.ownerWrite(),
    );
    assert.equal(receipt.status, "committed");

    const stored = await repo.get(recId, owner.read());
    assert.equal(stored.items[0].exceptions.length, 1);
    assert.equal(stored.items[0].exceptions[0].reason, "owner-approved one-off");
  });

  it("exception op (negative, mutation-survival #1): a can_write-only agent (no can_approve) is rejected", async () => {
    const owner = await harness.newOwner("U-exc-negative");
    const wsId = await harness.workspace(owner);
    const projectId = await harness.project(owner, wsId, "exc-p2");
    const ownerRepo = await harness.repoFor(owner);
    const agent = await harness.newAgent(owner, "exc-no-approve-agent", { workspace_id: wsId, can_read: true, can_write: true, can_approve: false });
    const agentRepo = await harness.repoFor(agent);

    const recId = randomUUID();
    await ownerRepo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: projectId, kind: "constraint", visibility: "project", content: "never do Y", authority: "explicit_user" },
      null, randomUUID(), owner.ownerWrite(),
    );

    const receipt = await agentRepo.mutate(
      { op: "exception", id: recId, exception_id: randomUUID(), applicability: {}, valid_until: new Date(Date.now() + 3600_000).toISOString(), reason: "agent tries to self-approve" },
      1, randomUUID(), agent.write(),
    );
    assert.equal(receipt.status, "rejected");
    assert.equal(receipt.reason, "requires_owner_approval");

    const stored = await ownerRepo.get(recId, owner.read());
    assert.equal(stored.items[0].exceptions.length, 0, "a rejected exception attempt must not appear in exceptions[]");
  });

  it("release_dependency (negative, mutation-survival #2): a can_write-only agent is rejected", async () => {
    const owner = await harness.newOwner("U-reldep-negative");
    const wsId = await harness.workspace(owner);
    const ownerRepo = await harness.repoFor(owner);
    const agent = await harness.newAgent(owner, "reldep-no-approve-agent", { workspace_id: wsId, can_read: true, can_write: true, can_approve: false });
    const agentRepo = await harness.repoFor(agent);

    const sourceId = randomUUID();
    await ownerRepo.mutate(
      { op: "create", id: sourceId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: "source fact", authority: "explicit_user" },
      null, randomUUID(), owner.ownerWrite(),
    );
    const derivedId = randomUUID();
    await ownerRepo.mutate(
      {
        // workspace visibility (not private) so the whole-workspace-scoped
        // agent below can actually READ the record and reach the
        // owner_trusted/can_approve authorization check being tested here —
        // a private record would bounce at ar2_visible first (not_found),
        // never exercising the release_dependency guard at all.
        op: "create", id: derivedId, workspace_id: wsId, project_id: null, kind: "experience", visibility: "workspace",
        content: "derived from the source fact", authority: "explicit_user", derived_from: [{ id: sourceId, revision: 1 }],
      },
      null, randomUUID(), owner.ownerWrite(),
    );

    const receipt = await agentRepo.mutate(
      { op: "release_dependency", id: derivedId, redaction_report_ref: "report-123" },
      1, randomUUID(), agent.write(),
    );
    assert.equal(receipt.status, "rejected");
    assert.equal(receipt.reason, "requires_owner_approval");

    const stored = await ownerRepo.get(derivedId, owner.read());
    assert.equal(stored.items[0].dependency_release, null, "a rejected release_dependency attempt must not set dependency_release");
  });

  it("B5: updating a constraint clears exceptions[] on the new revision", async () => {
    const owner = await harness.newOwner("U-b5-update-clears");
    const wsId = await harness.workspace(owner);
    const projectId = await harness.project(owner, wsId, "b5-p1");
    const repo = await harness.repoFor(owner);
    const recId = randomUUID();
    await repo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: projectId, kind: "constraint", visibility: "project", content: "never do Z", authority: "explicit_user" },
      null, randomUUID(), owner.ownerWrite(),
    );
    await repo.mutate(
      { op: "exception", id: recId, exception_id: randomUUID(), applicability: {}, valid_until: new Date(Date.now() + 3600_000).toISOString(), reason: "temp exception" },
      1, randomUUID(), owner.ownerWrite(),
    );
    const withException = await repo.get(recId, owner.read());
    assert.equal(withException.items[0].exceptions.length, 1, "sanity: exception was actually recorded before the update");

    const updateReceipt = await repo.mutate({ op: "update", id: recId, patch: { content: "never do Z (revised wording)" } }, 2, randomUUID(), owner.ownerWrite());
    assert.equal(updateReceipt.status, "committed");

    const afterUpdate = await repo.get(recId, owner.read());
    assert.equal(afterUpdate.items[0].exceptions.length, 0, "a non-exception revision (update) must clear stale exceptions[] (rev2.1 D3)");
  });

  it("B5: confirming a candidate constraint clears exceptions[] on the new revision", async () => {
    const owner = await harness.newOwner("U-b5-confirm-clears");
    const wsId = await harness.workspace(owner);
    const projectId = await harness.project(owner, wsId, "b5-p2");
    const ownerRepo = await harness.repoFor(owner);
    const agent = await harness.newAgent(owner, "b5-confirm-agent", { workspace_id: wsId, can_read: true, can_write: true });
    const agentRepo = await harness.repoFor(agent);

    const recId = randomUUID();
    await agentRepo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: projectId, kind: "constraint", visibility: "project", content: "candidate rule", authority: "agent_inference" },
      null, randomUUID(), agent.write(),
    );
    // Force an exception onto the still-candidate row directly through the
    // owner (exceptions can be attached regardless of current status —
    // the op only checks owner_trusted+can_approve).
    await ownerRepo.mutate(
      { op: "exception", id: recId, exception_id: randomUUID(), applicability: {}, valid_until: new Date(Date.now() + 3600_000).toISOString(), reason: "pre-confirm exception" },
      1, randomUUID(), owner.ownerWrite(),
    );
    const withException = await ownerRepo.get(recId, owner.read());
    assert.equal(withException.items[0].exceptions.length, 1);
    assert.equal(withException.items[0].status, "candidate");

    const confirmReceipt = await ownerRepo.mutate({ op: "confirm", id: recId }, 2, randomUUID(), owner.ownerWrite());
    assert.equal(confirmReceipt.status, "committed");

    const afterConfirm = await ownerRepo.get(recId, owner.read());
    assert.equal(afterConfirm.items[0].status, "active");
    assert.equal(afterConfirm.items[0].exceptions.length, 0, "confirm (a non-exception revision) must clear stale exceptions[]");
  });
});
