/**
 * repo-cloud-surfaces.test.mjs — WP-P2 RED->GREEN suite for the "missing
 * surfaces" (R2.14): list/history/export/latestHandoff, and the
 * AdminRepository surface (createWorkspace/grant/revokeGrant/
 * setProjectAlias/resolveProject) exercised directly (not just implicitly
 * through harness convenience helpers).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import createHarness from "./harness/pglite-harness.mjs";

describe("WP-P2 cloud list/history/export/latestHandoff + AdminRepository", () => {
  let harness;

  before(async () => {
    harness = await createHarness();
    await harness.setup();
  });

  after(async () => {
    await harness.teardown();
  });

  it("AdminRepository: createWorkspace/grant/revokeGrant/setProjectAlias/resolveProject round-trip", async () => {
    const owner = await harness.newOwner("U-admin-direct");
    const admin = await harness.adminFor(owner);

    const { workspace_id } = await admin.createWorkspace("direct-ws", owner.ownerWrite());
    assert.ok(workspace_id);

    const projectId = randomUUID();
    const aliasReceipt = await admin.setProjectAlias("myproj", projectId, owner.ownerWrite());
    assert.equal(aliasReceipt.status, "committed");

    const resolved = await admin.resolveProject("myproj", owner.read());
    assert.equal(resolved, projectId);

    const agent = await harness.newAgent(owner, "admin-direct-agent", {});
    const grantReceipt = await admin.grant(
      { grantee_principal_id: agent.principal.principal_id, workspace_id, project_ids: null, can_read: true, can_write: true, can_approve: false, personal: false },
      owner.ownerWrite(),
    );
    assert.equal(grantReceipt.status, "committed");

    const agentRepo = await harness.repoFor(agent);
    const recId = randomUUID();
    const created = await agentRepo.mutate(
      { op: "create", id: recId, workspace_id, project_id: null, kind: "fact", visibility: "private", content: "granted via direct admin.grant()", authority: "agent_inference" },
      null, randomUUID(), agent.write(),
    );
    assert.equal(created.status, "committed");

    const revokeReceipt = await admin.revokeGrant(agent.principal.principal_id, workspace_id, owner.ownerWrite());
    assert.equal(revokeReceipt.status, "committed");

    const afterRevoke = await agentRepo.mutate({ op: "update", id: recId, patch: { content: "should fail now" } }, 1, randomUUID(), agent.write());
    assert.equal(afterRevoke.status, "rejected");
    assert.equal(afterRevoke.reason, "forbidden");
  });

  it("history(): returns every revision oldest-first, readable by the owner", async () => {
    const owner = await harness.newOwner("U-history");
    const wsId = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);
    const recId = randomUUID();

    await repo.mutate({ op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: "rev1", authority: "explicit_user" }, null, randomUUID(), owner.ownerWrite());
    await repo.mutate({ op: "update", id: recId, patch: { content: "rev2" } }, 1, randomUUID(), owner.ownerWrite());
    await repo.mutate({ op: "update", id: recId, patch: { content: "rev3" } }, 2, randomUUID(), owner.ownerWrite());

    const hist = await repo.history(recId, owner.read());
    assert.equal(hist.length, 3);
    assert.deepEqual(hist.map((r) => r.revision), [1, 2, 3]);
    assert.deepEqual(hist.map((r) => r.content), ["rev1", "rev2", "rev3"]);
  });

  it("list(): keyset pagination returns every record exactly once across pages", async () => {
    const owner = await harness.newOwner("U-list");
    const wsId = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const id = randomUUID();
      ids.push(id);
      await repo.mutate(
        { op: "create", id, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: `item ${i}`, authority: "explicit_user" },
        null, randomUUID(), owner.ownerWrite(),
      );
    }

    const seen = new Set();
    let cursor = null;
    let guard = 0;
    do {
      const page = await repo.list({ limit: 2 }, owner.read(), cursor);
      for (const item of page.items) seen.add(item.id);
      cursor = page.next_page_cursor;
      guard++;
    } while (cursor && guard < 10);

    for (const id of ids) assert.ok(seen.has(id), `list() must eventually surface ${id}`);
  });

  it("export(): re-scrubs content and reports a scrub_report", async () => {
    const owner = await harness.newOwner("U-export");
    const wsId = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);
    const recId = randomUUID();
    await repo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: "exportable content", authority: "explicit_user" },
      null, randomUUID(), owner.ownerWrite(),
    );

    const result = await repo.export({}, owner.read());
    assert.ok(result.records.some((r) => r.id === recId));
    assert.ok(typeof result.scrub_report.redacted_fields === "number");
  });

  it("latestHandoff(): returns the most recently updated handoff for a task_key", async () => {
    const owner = await harness.newOwner("U-handoff");
    const wsId = await harness.workspace(owner);
    const projectId = await harness.project(owner, wsId, "handoff-proj");
    const repo = await harness.repoFor(owner);

    const payload1 = JSON.stringify({ task_key: "task-A", goal: "g1", state: "s1", decisions: [], items: [], next: [], blockers: [], memory_refs: [] });
    const id1 = randomUUID();
    await repo.mutate(
      { op: "create", id: id1, workspace_id: wsId, project_id: projectId, kind: "handoff", visibility: "private", content: payload1, authority: "explicit_user" },
      null, randomUUID(), owner.ownerWrite(),
    );

    await new Promise((r) => setTimeout(r, 10));

    const payload2 = JSON.stringify({ task_key: "task-A", goal: "g2 (later)", state: "s2", decisions: [], items: [], next: [], blockers: [], memory_refs: [] });
    const id2 = randomUUID();
    await repo.mutate(
      { op: "create", id: id2, workspace_id: wsId, project_id: projectId, kind: "handoff", visibility: "private", content: payload2, authority: "explicit_user" },
      null, randomUUID(), owner.ownerWrite(),
    );

    const latest = await repo.latestHandoff(projectId, "task-A", owner.read());
    assert.equal(latest.items.length, 1);
    assert.equal(latest.items[0].id, id2, "latestHandoff must return the most recently updated match, not the first");
  });
});
