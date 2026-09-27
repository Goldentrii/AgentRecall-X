import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";

// Review B2 (WP-P1-review.md #2, HIGH): policy.ts had zero test coverage —
// "the easiest possible module to unit test in isolation... has no test file
// at all." This is a table-driven test with one case per R2.1 row
// (contracts-rev2.md R2.1) and one per R2.2 row (visibility read/write
// matrix), asserting policy.ts's pure functions directly (no I/O).

describe("policy.ts — R2.1 / R2.2 table-driven", () => {
  let policyMod;
  let trustMod;

  before(async () => {
    policyMod = await import("../dist/repository/policy.js");
    trustMod = await import("../dist/repository/trust.js");
  });

  const OWNER_ID = "local:owner";
  const AGENT_ID = "agent:bot1";
  const WORKSPACE = crypto.randomUUID();
  const PROJECT = crypto.randomUUID();

  const owner = { principal_id: OWNER_ID, owner_id: OWNER_ID, kind: "user", auth: "local" };
  const agent = { principal_id: AGENT_ID, owner_id: OWNER_ID, kind: "agent", auth: "local" };

  function grant(overrides) {
    return {
      grantee_principal_id: AGENT_ID, workspace_id: WORKSPACE, project_ids: null,
      can_read: false, can_write: false, can_approve: false, personal: false,
      expires_at: null, revoked_at: null, ...overrides,
    };
  }

  function trustedCtx() {
    return {
      trusted_user_event: trustMod.mintTrustedUserEvent({
        source: "tty_confirm", host: "test", host_event_id: crypto.randomUUID(),
        raw_text_hash: crypto.createHash("sha256").update("x").digest("hex"),
      }),
    };
  }

  function record(overrides) {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(), owner_id: OWNER_ID, workspace_id: WORKSPACE, project_id: PROJECT,
      kind: "fact", visibility: "private", applicability: {}, content: "c",
      content_hash: "h", metadata: {}, authority: "agent_inference", status: "active", revision: 1,
      source: { principal_id: OWNER_ID, captured_at: now, channel: "sdk" },
      evidence_refs: [], derived_from: [], derived_closure: [], dependency_release: null,
      exceptions: [], proposal_of: null, created_at: now, updated_at: now,
      ...overrides,
    };
  }

  // ---------------------------------------------------------------------
  // R2.1 — one case per row
  // ---------------------------------------------------------------------

  describe("R2.1 row 1: create, not row-2-triggered — can_write required, else forbidden", () => {
    it("agent WITHOUT can_write on a private fact -> rejected:forbidden", () => {
      const out = policyMod.authorize({
        op: "create", principal: agent, ownerId: OWNER_ID, grants: [grant({ can_write: false })], trusted: false,
        create: { workspaceId: WORKSPACE, projectId: PROJECT, kind: "fact", visibility: "private", requestedAuthority: "agent_inference", channel: "sdk" },
      });
      assert.equal(out.kind, "reject");
      assert.equal(out.reason, "forbidden");
    });
    it("agent WITH can_write on a private fact -> allow, active (no candidate-gating on row 1)", () => {
      const out = policyMod.authorize({
        op: "create", principal: agent, ownerId: OWNER_ID, grants: [grant({ can_write: true })], trusted: false,
        create: { workspaceId: WORKSPACE, projectId: PROJECT, kind: "fact", visibility: "private", requestedAuthority: "agent_inference", channel: "sdk" },
      });
      assert.equal(out.kind, "allow");
      assert.equal(out.effectiveStatus, "active");
    });
  });

  describe("R2.1 row 2: create, row-2-triggered (kind=constraint OR visibility in {workspace,owner_shared}) — can_write->candidate, owner_trusted->active, for EVERY kind", () => {
    it("kind=constraint, not trusted, can_write -> candidate (B2 baseline, was already correct)", () => {
      const out = policyMod.authorize({
        op: "create", principal: agent, ownerId: OWNER_ID, grants: [grant({ can_write: true })], trusted: false,
        create: { workspaceId: WORKSPACE, projectId: PROJECT, kind: "constraint", visibility: "private", requestedAuthority: "agent_inference", channel: "sdk" },
      });
      assert.equal(out.kind, "allow");
      assert.equal(out.effectiveStatus, "candidate");
    });
    it("REGRESSION (review B2): kind=fact, visibility=workspace, not trusted, can_write -> MUST be candidate, not active", () => {
      const out = policyMod.authorize({
        op: "create", principal: agent, ownerId: OWNER_ID, grants: [grant({ can_write: true })], trusted: false,
        create: { workspaceId: WORKSPACE, projectId: null, kind: "fact", visibility: "workspace", requestedAuthority: "agent_inference", channel: "sdk" },
      });
      assert.equal(out.kind, "allow");
      assert.equal(out.effectiveStatus, "candidate", "a non-constraint kind at visibility=workspace must still be gated to candidate without owner_trusted");
    });
    it("REGRESSION (review B2): kind=decision, visibility=owner_shared, not trusted, can_write -> candidate", () => {
      const out = policyMod.authorize({
        op: "create", principal: agent, ownerId: OWNER_ID, grants: [grant({ can_write: true, personal: true })], trusted: false,
        create: { workspaceId: WORKSPACE, projectId: null, kind: "decision", visibility: "owner_shared", requestedAuthority: "agent_inference", channel: "sdk" },
      });
      assert.equal(out.kind, "allow");
      assert.equal(out.effectiveStatus, "candidate");
    });
    it("kind=fact, visibility=workspace, owner_trusted -> active", () => {
      const out = policyMod.authorize({
        op: "create", principal: owner, ownerId: OWNER_ID, grants: [], trusted: true,
        create: { workspaceId: WORKSPACE, projectId: null, kind: "fact", visibility: "workspace", requestedAuthority: "explicit_user", channel: "cli" },
      });
      assert.equal(out.kind, "allow");
      assert.equal(out.effectiveStatus, "active");
    });
  });

  it("R2.1 row 3: requested authority explicit_user without owner_trusted is downgraded silently (never rejected)", () => {
    const out = policyMod.authorize({
      op: "create", principal: agent, ownerId: OWNER_ID, grants: [grant({ can_write: true })], trusted: false,
      create: { workspaceId: WORKSPACE, projectId: PROJECT, kind: "fact", visibility: "private", requestedAuthority: "explicit_user", channel: "sdk" },
    });
    assert.equal(out.kind, "allow");
    assert.equal(out.effectiveAuthority, "agent_inference", "explicit_user must never stick without owner_trusted (D6/D7)");
  });

  describe("R2.1 row 4: update, not protected, no widening — can_write and (author or O), else forbidden", () => {
    it("author with can_write -> allow", () => {
      const target = record({ visibility: "project", authority: "agent_inference", source: { principal_id: AGENT_ID, captured_at: new Date().toISOString(), channel: "sdk" } });
      const out = policyMod.authorize({
        op: "update", principal: agent, ownerId: OWNER_ID, grants: [grant({ can_write: true, can_read: true })], trusted: false,
        target, updatePatch: {},
      });
      assert.equal(out.kind, "allow");
    });
    it("non-author, non-owner, even with can_write -> forbidden", () => {
      const target = record({ visibility: "project", authority: "agent_inference", source: { principal_id: OWNER_ID, captured_at: new Date().toISOString(), channel: "sdk" } });
      const out = policyMod.authorize({
        op: "update", principal: agent, ownerId: OWNER_ID, grants: [grant({ can_write: true, can_read: true })], trusted: false,
        target, updatePatch: {},
      });
      assert.equal(out.kind, "reject");
      assert.equal(out.reason, "forbidden");
    });
  });

  describe("R2.1 row 5: update, protected (or widening) — owner_trusted+can_approve applies; else stored as a proposal", () => {
    it("protected (explicit_user constraint), not trusted -> propose (never forbidden/reject)", () => {
      const target = record({ kind: "constraint", authority: "explicit_user", visibility: "project" });
      const out = policyMod.authorize({
        op: "update", principal: agent, ownerId: OWNER_ID, grants: [grant({ can_write: true, can_read: true })], trusted: false,
        target, updatePatch: {},
      });
      assert.equal(out.kind, "propose");
    });
    it("protected, owner_trusted + can_approve -> applied directly", () => {
      const target = record({ kind: "constraint", authority: "explicit_user", visibility: "project" });
      const out = policyMod.authorize({
        op: "update", principal: owner, ownerId: OWNER_ID, grants: [], trusted: true,
        target, updatePatch: {},
      });
      assert.equal(out.kind, "allow");
    });
  });

  describe("R2.1 rows 6/7: retract/quarantine — not protected: can_write+(author|O); protected: owner_trusted+can_approve", () => {
    it("not protected, non-author non-owner -> forbidden", () => {
      const target = record({ authority: "agent_inference", source: { principal_id: OWNER_ID, captured_at: new Date().toISOString(), channel: "sdk" } });
      const out = policyMod.authorize({ op: "retract", principal: agent, ownerId: OWNER_ID, grants: [grant({ can_write: true })], trusted: false, target });
      assert.equal(out.kind, "reject");
      assert.equal(out.reason, "forbidden");
    });
    it("protected (legacy constraint), not owner_trusted -> requires_owner_approval", () => {
      const target = record({ kind: "constraint", authority: "legacy" });
      const out = policyMod.authorize({ op: "quarantine", principal: agent, ownerId: OWNER_ID, grants: [grant({ can_write: true, can_approve: true })], trusted: false, target });
      assert.equal(out.kind, "reject");
      assert.equal(out.reason, "requires_owner_approval");
    });
  });

  it("R2.1 row 8: confirm — T.status=candidate requires owner_trusted+can_approve, else untrusted_confirm", () => {
    const target = record({ status: "candidate" });
    const rejected = policyMod.authorize({ op: "confirm", principal: agent, ownerId: OWNER_ID, grants: [grant({ can_approve: false })], trusted: false, target });
    assert.equal(rejected.kind, "reject");
    assert.equal(rejected.reason, "untrusted_confirm");
    const allowed = policyMod.authorize({ op: "confirm", principal: owner, ownerId: OWNER_ID, grants: [], trusted: true, target });
    assert.equal(allowed.kind, "allow");
  });

  it("R2.1 row 9: supersede — owner_trusted+can_approve required, else requires_owner_approval", () => {
    const target = record({});
    const out = policyMod.authorize({ op: "supersede", principal: agent, ownerId: OWNER_ID, grants: [grant({ can_approve: false })], trusted: false, target });
    assert.equal(out.kind, "reject");
    assert.equal(out.reason, "requires_owner_approval");
  });

  it("R2.1 row 10: exception — owner_trusted+can_approve required, else requires_owner_approval", () => {
    const target = record({ kind: "constraint" });
    const out = policyMod.authorize({ op: "exception", principal: agent, ownerId: OWNER_ID, grants: [grant({ can_approve: false })], trusted: false, target });
    assert.equal(out.kind, "reject");
    assert.equal(out.reason, "requires_owner_approval");
  });

  it("R2.1 row 11: release_dependency — owner_trusted+can_approve required, else requires_owner_approval", () => {
    const target = record({ derived_from: [{ id: crypto.randomUUID(), revision: 1 }] });
    const out = policyMod.authorize({ op: "release_dependency", principal: agent, ownerId: OWNER_ID, grants: [grant({ can_approve: false })], trusted: false, target });
    assert.equal(out.kind, "reject");
    assert.equal(out.reason, "requires_owner_approval");
  });

  // ---------------------------------------------------------------------
  // R2.2 — one case per visibility row
  // ---------------------------------------------------------------------

  it("R2.2 row 1: local_only — readable only by the owner, never an agent", () => {
    const rec = record({ visibility: "local_only" });
    assert.equal(policyMod.canRead(rec, { principal: owner }, OWNER_ID, []), true);
    assert.equal(policyMod.canRead(rec, { principal: agent }, OWNER_ID, [grant({ can_read: true })]), false);
  });

  it("R2.2 row 2: private — readable by the author and O only", () => {
    const rec = record({ visibility: "private", source: { principal_id: AGENT_ID, captured_at: new Date().toISOString(), channel: "sdk" } });
    assert.equal(policyMod.canRead(rec, { principal: agent }, OWNER_ID, []), true, "author can read");
    assert.equal(policyMod.canRead(rec, { principal: owner }, OWNER_ID, []), true, "owner can read");
    const other = { principal_id: "agent:other", owner_id: OWNER_ID, kind: "agent", auth: "local" };
    assert.equal(policyMod.canRead(rec, { principal: other }, OWNER_ID, []), false, "a different agent cannot");
  });

  it("R2.2 row 3: project — O, or G.can_read on (workspace,project) (project_ids null = all)", () => {
    const rec = record({ visibility: "project", project_id: PROJECT });
    assert.equal(policyMod.canRead(rec, { principal: agent }, OWNER_ID, [grant({ can_read: true, project_ids: null })]), true);
    assert.equal(policyMod.canRead(rec, { principal: agent }, OWNER_ID, [grant({ can_read: true, project_ids: [crypto.randomUUID()] })]), false, "a grant scoped to a DIFFERENT project must not apply");
  });

  it("R2.2 row 4: workspace — O, or G.can_read on workspace with project_ids null (a project-scoped grant does not count)", () => {
    const rec = record({ visibility: "workspace", project_id: null });
    assert.equal(policyMod.canRead(rec, { principal: agent }, OWNER_ID, [grant({ can_read: true, project_ids: null })]), true);
    assert.equal(policyMod.canRead(rec, { principal: agent }, OWNER_ID, [grant({ can_read: true, project_ids: [PROJECT] })]), false, "workspace-visibility requires a workspace-wide (project_ids null) grant");
  });

  it("R2.2 row 5: owner_shared — O, or O's AGENTS with can_read AND personal=true (not a plain user, not without personal)", () => {
    const rec = record({ visibility: "owner_shared", project_id: null });
    assert.equal(policyMod.canRead(rec, { principal: agent }, OWNER_ID, [grant({ can_read: true, personal: true, project_ids: null })]), true);
    assert.equal(policyMod.canRead(rec, { principal: agent }, OWNER_ID, [grant({ can_read: true, personal: false, project_ids: null })]), false, "can_read without personal=true must not grant owner_shared access");
    const otherUser = { principal_id: "local:other-user", owner_id: "local:other-user", kind: "user", auth: "local" };
    assert.equal(policyMod.canRead(rec, { principal: otherUser }, OWNER_ID, []), false, "owner_shared is scoped to THIS owner's agents, not any user principal");
  });
});
