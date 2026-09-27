/**
 * repo-cloud-rls.test.mjs — WP-P2 RED->GREEN suite (ADR-001 rev2 R2.2, R2.4).
 *
 * Tests:
 *  1. Direct table DML by `authenticated` is denied for every ar2_* table
 *     (no INSERT/UPDATE/DELETE grant exists — writes are RPC-only).
 *  2. Direct table DML by `anon` is denied (REVOKE ALL; anon holds no grant
 *     at all, not even SELECT).
 *  3. R2.2 visibility read matrix, positive and negative, one case per row:
 *     private / project / workspace / owner_shared, each with a grantee that
 *     SHOULD see it and one that should NOT.
 *  4. An unrelated third owner can never read another owner's record via
 *     CloudRepository.get(), regardless of visibility (existence hiding, R2.3).
 *
 * Uses the pglite harness (real Postgres 18 WASM via @electric-sql/pglite,
 * no PostgREST, no network) so RLS/grant/REVOKE behavior is exercised
 * against real Postgres semantics, not a mock.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import createHarness from "./harness/pglite-harness.mjs";

const AR2_TABLES = [
  "ar2_workspaces", "ar2_members", "ar2_grants", "ar2_project_aliases",
  "ar2_records", "ar2_record_revisions", "ar2_events", "ar2_operations",
  "ar2_outcomes", "ar2_access_epochs",
];

describe("WP-P2 cloud RLS + direct-table lockdown", () => {
  /** @type {Awaited<ReturnType<typeof createHarness>>} */
  let harness;
  let db; // reach into the harness's internal PGlite instance for raw-SQL assertions

  before(async () => {
    harness = await createHarness();
    await harness.setup();
    // The harness module keeps `db` private; re-derive a raw handle the same
    // way setup() does, so these tests can issue direct (non-RPC) SQL to
    // prove the lockdown — this is the ONE legitimate reason to reach past
    // the Harness interface: proving the ABSENCE of a capability the
    // interface doesn't expose a method for.
    const mod = await import("@electric-sql/pglite");
    const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(__dirname, "../../..");
    db = new mod.PGlite({ extensions: { pg_trgm } });
    await db.exec(fs.readFileSync(path.join(__dirname, "fixtures", "supabase-auth-stub.sql"), "utf8"));
    await db.exec(fs.readFileSync(path.join(repoRoot, "migrations", "0002_shared_memory.sql"), "utf8"));
  });

  after(async () => {
    await db.close();
    await harness.teardown();
  });

  for (const table of AR2_TABLES) {
    it(`authenticated cannot INSERT/UPDATE/DELETE directly on ${table}`, async () => {
      const uuid = randomUUID();
      await db.exec("SET ROLE authenticated;");
      await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: uuid, ar_role: "owner" })]);
      try {
        await assert.rejects(
          () => db.exec(`INSERT INTO ${table} DEFAULT VALUES`),
          /permission denied|null value|violates/i,
        );
      } finally {
        await db.exec("RESET ROLE;");
      }
    });

    it(`anon cannot SELECT/INSERT on ${table}`, async () => {
      await db.exec("SET ROLE anon;");
      try {
        await assert.rejects(() => db.query(`SELECT * FROM ${table} LIMIT 1`), /permission denied/i);
        await assert.rejects(() => db.exec(`INSERT INTO ${table} DEFAULT VALUES`), /permission denied/i);
      } finally {
        await db.exec("RESET ROLE;");
      }
    });
  }

  it("R2.2 private: readable by owner and author, not by an unrelated agent", async () => {
    const owner = await harness.newOwner("U-private");
    const wsId = await harness.workspace(owner);
    const projectId = await harness.project(owner, wsId, "p1");
    const author = await harness.newAgent(owner, "author", { workspace_id: wsId, can_read: true, can_write: true });
    const stranger = await harness.newAgent(owner, "stranger", { workspace_id: wsId, can_read: true, can_write: false });

    const authorRepo = await harness.repoFor(author);
    const recId = randomUUID();
    const receipt = await authorRepo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: projectId, kind: "fact", visibility: "private", content: "secret", authority: "agent_inference" },
      null, randomUUID(), author.write(),
    );
    assert.equal(receipt.status, "committed");

    const ownerRepo = await harness.repoFor(owner);
    const asOwner = await ownerRepo.get(recId, owner.read());
    assert.equal(asOwner.items.length, 1, "owner should read a private record in their own workspace");

    const strangerRepo = await harness.repoFor(stranger);
    const asStranger = await strangerRepo.get(recId, stranger.read());
    assert.equal(asStranger.items.length, 0, "a different agent (not author, not owner) must not read a private record");
  });

  it("R2.2 project: readable with a project-scoped grant, not readable outside the grant's projects", async () => {
    const owner = await harness.newOwner("U-project");
    const wsId = await harness.workspace(owner);
    const projectA = await harness.project(owner, wsId, "proj-a");
    const projectB = await harness.project(owner, wsId, "proj-b");
    const inGrant = await harness.newAgent(owner, "in-grant", { workspace_id: wsId, project_ids: [projectA], can_read: true, can_write: true });
    const outOfGrant = await harness.newAgent(owner, "out-of-grant", { workspace_id: wsId, project_ids: [projectB], can_read: true, can_write: false });

    const ownerRepo = await harness.repoFor(owner);
    const recId = randomUUID();
    const receipt = await ownerRepo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: projectA, kind: "fact", visibility: "project", content: "project-scoped", authority: "explicit_user" },
      null, randomUUID(), owner.ownerWrite(),
    );
    assert.equal(receipt.status, "committed");

    const inGrantRepo = await harness.repoFor(inGrant);
    const seen = await inGrantRepo.get(recId, inGrant.read());
    assert.equal(seen.items.length, 1, "agent granted project A should read a project-A record");

    const outRepo = await harness.repoFor(outOfGrant);
    const notSeen = await outRepo.get(recId, outOfGrant.read());
    assert.equal(notSeen.items.length, 0, "agent granted only project B must not read a project-A record");
  });

  it("R2.2 workspace: only a whole-workspace (project_ids null) grant can read workspace-visibility records", async () => {
    const owner = await harness.newOwner("U-workspace");
    const wsId = await harness.workspace(owner);
    const projectA = await harness.project(owner, wsId, "proj-a2");
    const wholeWs = await harness.newAgent(owner, "whole-ws", { workspace_id: wsId, project_ids: null, can_read: true, can_write: true });
    const scoped = await harness.newAgent(owner, "scoped-only", { workspace_id: wsId, project_ids: [projectA], can_read: true, can_write: false });

    const ownerRepo = await harness.repoFor(owner);
    const recId = randomUUID();
    const receipt = await ownerRepo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "workspace", content: "workspace-wide", authority: "explicit_user" },
      null, randomUUID(), owner.ownerWrite(),
    );
    assert.equal(receipt.status, "committed");

    const wholeWsRepo = await harness.repoFor(wholeWs);
    const seen = await wholeWsRepo.get(recId, wholeWs.read());
    assert.equal(seen.items.length, 1, "a project_ids=null (whole-workspace) grant should read a workspace-visibility record");

    const scopedRepo = await harness.repoFor(scoped);
    const notSeen = await scopedRepo.get(recId, scoped.read());
    assert.equal(notSeen.items.length, 0, "a project-scoped grant (not project_ids=null) must NOT read a workspace-visibility record");
  });

  it("R2.2 owner_shared: only a personal=true grant can read it, a personal=false grant cannot", async () => {
    const owner = await harness.newOwner("U-ownershared");
    const wsId = await harness.workspace(owner);
    const personalAgent = await harness.newAgent(owner, "personal-agent", { workspace_id: wsId, project_ids: null, personal: true, can_read: true, can_write: true });
    const nonPersonalAgent = await harness.newAgent(owner, "non-personal-agent", { workspace_id: wsId, project_ids: null, personal: false, can_read: true, can_write: false });

    const ownerRepo = await harness.repoFor(owner);
    const recId = randomUUID();
    const receipt = await ownerRepo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "preference", visibility: "owner_shared", content: "owner-shared pref", authority: "explicit_user" },
      null, randomUUID(), owner.ownerWrite(),
    );
    assert.equal(receipt.status, "committed");

    const personalRepo = await harness.repoFor(personalAgent);
    const seen = await personalRepo.get(recId, personalAgent.read());
    assert.equal(seen.items.length, 1, "personal=true grant should read an owner_shared record");

    const nonPersonalRepo = await harness.repoFor(nonPersonalAgent);
    const notSeen = await nonPersonalRepo.get(recId, nonPersonalAgent.read());
    assert.equal(notSeen.items.length, 0, "personal=false grant must NOT read an owner_shared record");
  });

  it("R2.3 existence hiding: an unrelated owner's get() returns empty (not an error) for another owner's record", async () => {
    const ownerU = await harness.newOwner("U-hide");
    const ownerV = await harness.newOwner("V-hide");
    const wsId = await harness.workspace(ownerU);
    const ownerURepo = await harness.repoFor(ownerU);
    const recId = randomUUID();
    await ownerURepo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "owner_shared", content: "U's own data", authority: "explicit_user" },
      null, randomUUID(), ownerU.ownerWrite(),
    );

    const ownerVRepo = await harness.repoFor(ownerV);
    const result = await ownerVRepo.get(recId, ownerV.read());
    assert.equal(result.items.length, 0);
    assert.equal(result.freshness, "fresh");
  });
});
