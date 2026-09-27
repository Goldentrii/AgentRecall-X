import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

// LocalRepository core CRUD + CAS + idempotency + WAL-backed commit (ADR-001
// rev1 §3/§5, rev2 R2.1/R2.5, rev2.1 D2/D3) — brief priority (4).

describe("LocalRepository core", () => {
  let runtimeMod;
  let root;
  let rt;
  let owner;
  let agent;
  let workspaceId;

  before(async () => {
    runtimeMod = await import("../dist/repository/runtime.js");
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ar-repo-core-"));
    owner = { principal_id: "local:owner", owner_id: "local:owner", kind: "user", auth: "local" };
    agent = { principal_id: "agent:bot1", owner_id: "local:owner", kind: "agent", auth: "local" };
    rt = runtimeMod.createMemoryRuntime({ root, mode: "local" }, owner);
    workspaceId = crypto.randomUUID();
    // Give the agent can_write (never can_approve) on the workspace — mirrors
    // the "Implementability clarifications" default (rev2.1).
    rt.repository.saveGrants([{
      grantee_principal_id: agent.principal_id, workspace_id: workspaceId, project_ids: null,
      can_read: true, can_write: true, can_approve: false, personal: false, expires_at: null, revoked_at: null,
    }]);
  });

  afterEach(async () => {
    await rt.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  let trustMod;
  before(async () => { trustMod = await import("../dist/repository/trust.js"); });

  /**
   * R2.1/R2.8: owner_trusted(P) in local mode is "WriteContext carries a
   * valid TrustedUserEvent" — being the owner PRINCIPAL is not, by itself,
   * proof of a genuine human action. Tests that need an approve-gated op
   * (confirm, protected update/retract, supersede, exception,
   * release_dependency, admin grant/alias) must mint one explicitly.
   */
  function trustedEvent() {
    return trustMod.mintTrustedUserEvent({
      source: "tty_confirm", host: "test-host", host_event_id: crypto.randomUUID(),
      raw_text_hash: crypto.createHash("sha256").update("test-confirm").digest("hex"),
    });
  }
  function writeCtx(principal, opts) {
    return { principal, channel: "sdk", trusted_user_event: opts?.trusted ? trustedEvent() : undefined };
  }
  function readCtx(principal) {
    return { principal, channel: "sdk" };
  }

  it("create as an agent produces an active, agent_inference fact (non-gating kind)", async () => {
    const id = crypto.randomUUID();
    const opId = crypto.randomUUID();
    const receipt = await rt.run(() => rt.repository.mutate(
      { op: "create", id, workspace_id: workspaceId, project_id: null, kind: "fact", visibility: "private", content: "hello", authority: "explicit_user" },
      null, opId, writeCtx(agent),
    ));
    assert.equal(receipt.status, "committed");
    assert.equal(receipt.effective_authority, "agent_inference", "explicit_user request from a non-trusted agent must be downgraded (D6/D7 fix)");
    assert.equal(receipt.effective_status, "active");
    assert.equal(receipt.revision, 1);
  });

  it("create a constraint as an agent -> candidate; confirm as owner -> active/explicit_user", async () => {
    const id = crypto.randomUUID();
    const opId = crypto.randomUUID();
    const createReceipt = await rt.run(() => rt.repository.mutate(
      { op: "create", id, workspace_id: workspaceId, project_id: null, kind: "constraint", visibility: "private", content: "never do X", authority: "agent_inference", applicability: { polarity: "forbid" } },
      null, opId, writeCtx(agent),
    ));
    assert.equal(createReceipt.effective_status, "candidate");

    const confirmReceipt = await rt.run(() => rt.repository.mutate(
      { op: "confirm", id }, createReceipt.revision, crypto.randomUUID(), writeCtx(owner, { trusted: true }),
    ));
    assert.equal(confirmReceipt.status, "committed");
    assert.equal(confirmReceipt.effective_status, "active");
    assert.equal(confirmReceipt.effective_authority, "explicit_user");
  });

  it("mutate idempotency: same operation_id + same payload replays; different payload rejects", async () => {
    const id = crypto.randomUUID();
    const opId = crypto.randomUUID();
    const cmd = { op: "create", id, workspace_id: workspaceId, project_id: null, kind: "fact", visibility: "private", content: "v1", authority: "agent_inference" };

    const first = await rt.run(() => rt.repository.mutate(cmd, null, opId, writeCtx(agent)));
    assert.equal(first.replayed, false);

    const replay = await rt.run(() => rt.repository.mutate(cmd, null, opId, writeCtx(agent)));
    assert.equal(replay.status, "committed");
    assert.equal(replay.replayed, true);
    assert.equal(replay.revision, first.revision);

    const differentPayload = { ...cmd, content: "v2-different" };
    const mismatch = await rt.run(() => rt.repository.mutate(differentPayload, null, opId, writeCtx(agent)));
    assert.equal(mismatch.status, "rejected");
    assert.equal(mismatch.reason, "idempotency_mismatch");

    // The original record must be untouched by the mismatched retry.
    const read = await rt.run(() => rt.repository.get(id, readCtx(owner)));
    assert.equal(read.items[0].content, "v1");
    assert.equal(read.items[0].revision, 1);
  });

  it("CAS: update with a stale expectedRevision returns a conflict receipt with current state", async () => {
    const id = crypto.randomUUID();
    const created = await rt.run(() => rt.repository.mutate(
      { op: "create", id, workspace_id: workspaceId, project_id: null, kind: "fact", visibility: "private", content: "v1", authority: "agent_inference" },
      null, crypto.randomUUID(), writeCtx(agent),
    ));
    assert.equal(created.revision, 1);

    const staleUpdate = await rt.run(() => rt.repository.mutate(
      { op: "update", id, patch: { content: "v2" } }, 999, crypto.randomUUID(), writeCtx(agent),
    ));
    assert.equal(staleUpdate.status, "conflict");
    assert.equal(staleUpdate.expected_revision, 999);
    assert.equal(staleUpdate.current.revision, 1);

    const okUpdate = await rt.run(() => rt.repository.mutate(
      { op: "update", id, patch: { content: "v2" } }, 1, crypto.randomUUID(), writeCtx(agent),
    ));
    assert.equal(okUpdate.status, "committed");
    assert.equal(okUpdate.revision, 2);
  });

  it("rev2.1 D2: an update on an explicit_user constraint by a non-trusted agent becomes a proposal; owner confirm applies it with CAS", async () => {
    const id = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    // "project" visibility so the agent's grant lets it READ the record —
    // "private" would make it unreadable to a non-author agent (not_found,
    // R2.3), short-circuiting before the propose logic under test ever runs.
    // Seed a candidate constraint (owner create without a TrustedUserEvent
    // still lands at agent_inference/candidate — being the owner PRINCIPAL
    // is not, by itself, owner_trusted per R2.1/R2.8), then mint it to
    // explicit_user/active via a genuinely trusted confirm.
    const created = await rt.run(() => rt.repository.mutate(
      { op: "create", id, workspace_id: workspaceId, project_id: projectId, kind: "constraint", visibility: "project", content: "forbid Y", authority: "explicit_user", applicability: { polarity: "forbid" } },
      null, crypto.randomUUID(), writeCtx(owner),
    ));
    assert.equal(created.effective_authority, "agent_inference");
    assert.equal(created.effective_status, "candidate");

    const confirmSeed = await rt.run(() => rt.repository.mutate(
      { op: "confirm", id }, created.revision, crypto.randomUUID(), writeCtx(owner, { trusted: true }),
    ));
    assert.equal(confirmSeed.effective_authority, "explicit_user");
    assert.equal(confirmSeed.effective_status, "active");

    const proposeReceipt = await rt.run(() => rt.repository.mutate(
      { op: "update", id, patch: { content: "forbid Y and Z" } }, confirmSeed.revision, crypto.randomUUID(), writeCtx(agent),
    ));
    assert.equal(proposeReceipt.status, "committed");
    assert.equal(proposeReceipt.effective, false, "a proposal must be committed but not yet in force");
    assert.equal(proposeReceipt.effective_status, "candidate");
    assert.notEqual(proposeReceipt.id, id, "the proposal gets its own deterministic id, not the target's");

    // The original is untouched until the owner confirms the proposal.
    const stillOld = await rt.run(() => rt.repository.get(id, readCtx(owner)));
    assert.equal(stillOld.items[0].content, "forbid Y");
    assert.equal(stillOld.items[0].revision, confirmSeed.revision);

    const applyReceipt = await rt.run(() => rt.repository.mutate(
      { op: "confirm", id: proposeReceipt.id }, proposeReceipt.revision, crypto.randomUUID(), writeCtx(owner, { trusted: true }),
    ));
    assert.equal(applyReceipt.status, "committed");
    assert.equal(applyReceipt.id, id, "confirming a proposal reports the ORIGINAL record's id as the primary receipt");
    assert.equal(applyReceipt.revision, confirmSeed.revision + 1);

    const finalRead = await rt.run(() => rt.repository.get(id, readCtx(owner)));
    assert.equal(finalRead.items[0].content, "forbid Y and Z");
    assert.equal(finalRead.items[0].authority, "explicit_user");
  });

  it("retract: forbidden for a non-author non-owner agent without can_write+author/owner", async () => {
    const id = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    // "project" visibility (not "private") so the agent's grant lets it READ
    // the record at all — otherwise mutate() would report not_found
    // (existence hiding, R2.3) rather than exercising retract's forbidden
    // branch, since a "private" record is unreadable to a non-author agent.
    const created = await rt.run(() => rt.repository.mutate(
      { op: "create", id, workspace_id: workspaceId, project_id: projectId, kind: "fact", visibility: "project", content: "v1", authority: "agent_inference" },
      null, crypto.randomUUID(), writeCtx(owner),
    ));
    // owner authored it; agent (not the author, though it DOES have
    // can_write+can_read via the grant) is not the author and is not the
    // owner -> per R2.1 "retract: can_write and (author or O)" the grant
    // alone is insufficient without being the author or the owner.
    const rejected = await rt.run(() => rt.repository.mutate(
      { op: "retract", id, reason: "not needed" }, created.revision, crypto.randomUUID(), writeCtx(agent),
    ));
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.reason, "forbidden");

    const ok = await rt.run(() => rt.repository.mutate(
      { op: "retract", id, reason: "not needed" }, created.revision, crypto.randomUUID(), writeCtx(owner),
    ));
    assert.equal(ok.status, "committed");
    assert.equal(ok.effective_status, "retracted");

    // Retracted content is never returned (A16) — existence-hiding shape.
    const read = await rt.run(() => rt.repository.get(id, readCtx(owner)));
    assert.equal(read.items.length, 0);
  });

  it("history() returns every revision oldest-first", async () => {
    const id = crypto.randomUUID();
    const r1 = await rt.run(() => rt.repository.mutate(
      { op: "create", id, workspace_id: workspaceId, project_id: null, kind: "fact", visibility: "private", content: "v1", authority: "agent_inference" },
      null, crypto.randomUUID(), writeCtx(owner),
    ));
    await rt.run(() => rt.repository.mutate({ op: "update", id, patch: { content: "v2" } }, r1.revision, crypto.randomUUID(), writeCtx(owner)));
    await rt.run(() => rt.repository.mutate({ op: "update", id, patch: { content: "v3" } }, r1.revision + 1, crypto.randomUUID(), writeCtx(owner)));

    const hist = await rt.run(() => rt.repository.history(id, readCtx(owner)));
    assert.deepEqual(hist.map((h) => h.content), ["v1", "v2", "v3"]);
    assert.deepEqual(hist.map((h) => h.revision), [1, 2, 3]);
  });

  it("readSnapshot/query only return active+candidate records the caller can read", async () => {
    const idA = crypto.randomUUID();
    const idB = crypto.randomUUID();
    await rt.run(() => rt.repository.mutate(
      { op: "create", id: idA, workspace_id: workspaceId, project_id: null, kind: "fact", visibility: "private", content: "visible to owner only", authority: "agent_inference" },
      null, crypto.randomUUID(), writeCtx(owner),
    ));
    await rt.run(() => rt.repository.mutate(
      { op: "create", id: idB, workspace_id: workspaceId, project_id: null, kind: "fact", visibility: "private", content: "authored by agent", authority: "agent_inference" },
      null, crypto.randomUUID(), writeCtx(agent),
    ));

    const asOwner = await rt.run(() => rt.repository.readSnapshot(readCtx(owner)));
    assert.equal(asOwner.items.length, 2, "owner reads everything");

    const asAgent = await rt.run(() => rt.repository.readSnapshot(readCtx(agent)));
    // private visibility: readable by author and O only — the agent is the
    // author of idB but NOT idA (owner-authored, private).
    assert.deepEqual(asAgent.items.map((r) => r.id).sort(), [idB].sort());
  });
});
