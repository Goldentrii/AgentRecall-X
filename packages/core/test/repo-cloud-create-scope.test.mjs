/**
 * repo-cloud-create-scope.test.mjs — Fix round 1, B3 + B4.
 *
 * B3: `ar2_mutate`'s create-path grant resolution checked only the boolean
 * `can_write`, never whether the caller's grant's `project_ids` actually
 * covers the target `project_id` (R2.1 row 1: "project_ids subset of grant
 * | can_write | rejected:forbidden"). An agent granted
 * `can_write=true, project_ids=[A]` could `create` a `visibility="project"`
 * record with `project_id=B` — a project it has no grant for — landing
 * `active` and immediately visible to anyone legitimately scoped to B.
 * Orchestrator decision: reject as `forbidden` (not candidate-downgrade).
 *
 * B4: create id-collision returned a raw existence check (`rejected:schema
 * "id already exists"`) with no `ar2_visible` gate, leaking "something
 * exists at this id" to a caller who cannot even read the colliding row.
 * Orchestrator decision: unreadable collision -> `not_found`; readable
 * collision -> keep `schema`/"id already exists".
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import createHarness from "./harness/pglite-harness.mjs";

describe("WP-P2 fix round 1 / B3: create() must enforce grant project_ids scope", () => {
  let harness;

  before(async () => {
    harness = await createHarness();
    await harness.setup();
  });

  after(async () => {
    await harness.teardown();
  });

  it("an agent granted can_write on project A cannot create a project-B record in the same workspace", async () => {
    const owner = await harness.newOwner("U-b3-cross-project");
    const wsId = await harness.workspace(owner);
    const projectA = await harness.project(owner, wsId, "b3-proj-a");
    const projectB = await harness.project(owner, wsId, "b3-proj-b");
    const agent = await harness.newAgent(owner, "b3-scoped-agent", { workspace_id: wsId, project_ids: [projectA], can_read: true, can_write: true });
    const agentRepo = await harness.repoFor(agent);

    const crossProjectId = randomUUID();
    const receipt = await agentRepo.mutate(
      { op: "create", id: crossProjectId, workspace_id: wsId, project_id: projectB, kind: "fact", visibility: "project", content: "cross-project injection attempt", authority: "agent_inference" },
      null, randomUUID(), agent.write(),
    );
    assert.equal(receipt.status, "rejected", `create into an ungranted project must be rejected, got ${JSON.stringify(receipt)}`);
    assert.equal(receipt.reason, "forbidden");

    // must not have landed in the DB at all — check from the OWNER's side (who can read everything).
    const ownerRepo = await harness.repoFor(owner);
    const check = await ownerRepo.get(crossProjectId, owner.read());
    assert.equal(check.items.length, 0, "the cross-project record must not exist server-side after a rejected create");
  });

  it("the SAME agent CAN create into project A (the project it actually has a grant for)", async () => {
    const owner = await harness.newOwner("U-b3-same-project");
    const wsId = await harness.workspace(owner);
    const projectA = await harness.project(owner, wsId, "b3-proj-a2");
    const agent = await harness.newAgent(owner, "b3-scoped-agent-2", { workspace_id: wsId, project_ids: [projectA], can_read: true, can_write: true });
    const agentRepo = await harness.repoFor(agent);

    const recId = randomUUID();
    const receipt = await agentRepo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: projectA, kind: "fact", visibility: "project", content: "legitimate", authority: "agent_inference" },
      null, randomUUID(), agent.write(),
    );
    assert.equal(receipt.status, "committed", `create into the granted project must succeed, got ${JSON.stringify(receipt)}`);
  });

  it("a whole-workspace grant (project_ids=null) CAN create into any project in that workspace", async () => {
    const owner = await harness.newOwner("U-b3-whole-ws");
    const wsId = await harness.workspace(owner);
    const projectC = await harness.project(owner, wsId, "b3-proj-c");
    const agent = await harness.newAgent(owner, "b3-whole-ws-agent", { workspace_id: wsId, project_ids: null, can_read: true, can_write: true });
    const agentRepo = await harness.repoFor(agent);

    const recId = randomUUID();
    const receipt = await agentRepo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: projectC, kind: "fact", visibility: "project", content: "whole-workspace grant", authority: "agent_inference" },
      null, randomUUID(), agent.write(),
    );
    assert.equal(receipt.status, "committed");
  });
});

describe("WP-P2 fix round 1 / B4: create id-collision respects existence hiding", () => {
  let harness;

  before(async () => {
    harness = await createHarness();
    await harness.setup();
  });

  after(async () => {
    await harness.teardown();
  });

  it("a colliding id the caller CANNOT read returns not_found, not schema", async () => {
    const owner = await harness.newOwner("U-b4-unreadable-collision");
    const wsId = await harness.workspace(owner);
    const author = await harness.newAgent(owner, "b4-author", { workspace_id: wsId, can_read: true, can_write: true });
    const stranger = await harness.newAgent(owner, "b4-stranger", { workspace_id: wsId, can_read: true, can_write: true });

    const authorRepo = await harness.repoFor(author);
    const recId = randomUUID();
    await authorRepo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: "author's private record", authority: "agent_inference" },
      null, randomUUID(), author.write(),
    );

    const strangerRepo = await harness.repoFor(stranger);
    const collision = await strangerRepo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: "stranger tries the same id", authority: "agent_inference" },
      null, randomUUID(), stranger.write(),
    );
    assert.equal(collision.status, "rejected");
    assert.equal(collision.reason, "not_found", `a collision on an unreadable id must look like a nonexistent id (R2.3), got ${JSON.stringify(collision)}`);
  });

  it("a colliding id the caller CAN read returns schema 'id already exists'", async () => {
    const owner = await harness.newOwner("U-b4-readable-collision");
    const wsId = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);
    const recId = randomUUID();
    await repo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "owner_shared", content: "owner's own record", authority: "explicit_user" },
      null, randomUUID(), owner.ownerWrite(),
    );

    const collision = await repo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "owner_shared", content: "owner retries with the same id, different op", authority: "explicit_user" },
      null, randomUUID(), owner.ownerWrite(),
    );
    assert.equal(collision.status, "rejected");
    assert.equal(collision.reason, "schema");
    assert.match(collision.message, /already exists/i);
  });
});
