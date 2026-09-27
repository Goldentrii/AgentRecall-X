/**
 * repo-cloud-owner-trust.test.mjs — Fix round 1, B1.
 *
 * Review finding: owner-trust gated on `auth.jwt() ->> 'ar_role' = 'owner'`,
 * a flat top-level JWT claim real Supabase never issues without a Custom
 * Access Token Auth Hook this repo does not ship. As shipped, the claim is
 * always NULL in production, so `v_owner_trusted` is always false and every
 * owner-gated action permanently rejects the real owner.
 *
 * Orchestrator decision: owner_trusted := auth.uid() = owner_id (agents are
 * always separate Supabase Auth users, R2.8) + defense-in-depth: reject
 * owner-trust outright if the JWT carries ar_role='agent' anywhere
 * (top-level, user_metadata, app_metadata) — guards a future custom hook
 * misconfiguration, never the primary mechanism.
 *
 * This file bypasses the harness's Actor abstraction (same precedent as
 * repo-cloud-rls.test.mjs) to craft arbitrary JWT claim shapes the
 * `Actor.write()`/`ownerWrite()` surface doesn't expose.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

function sqlQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

describe("WP-P2 fix round 1 / B1: owner-trust without an issued ar_role claim", () => {
  let db;

  before(async () => {
    db = new PGlite({ extensions: { pg_trgm } });
    await db.exec(fs.readFileSync(path.join(__dirname, "fixtures", "supabase-auth-stub.sql"), "utf8"));
    await db.exec(fs.readFileSync(path.join(REPO_ROOT, "migrations", "0002_shared_memory.sql"), "utf8"));
  });

  after(async () => {
    await db.close();
  });

  /** Runs `fn` under role=authenticated with the given raw claims object (whatever shape the test wants). */
  async function asClaims(claims, fn) {
    await db.exec("SET ROLE authenticated;");
    await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(claims)]);
    try {
      return await fn();
    } finally {
      await db.exec("RESET ROLE;");
    }
  }

  async function callFn(fn, argsSql) {
    const r = await db.query(`SELECT ${fn}(${argsSql}) AS result`);
    return r.rows[0].result;
  }

  it("REAL owner with NO ar_role claim at all (the actual production JWT shape) can still perform an owner-gated action", async () => {
    const ownerId = randomUUID();
    const agentId = randomUUID();

    // Production JWT shape: sub only, no ar_role anywhere.
    const ws = await asClaims({ sub: ownerId }, () => callFn("ar2_admin_workspace", `${sqlQuote("prod-shaped-ws")}`));
    assert.ok(ws.workspace_id, "owner must be able to create a workspace with a bare {sub} JWT");
    const workspaceId = ws.workspace_id;

    const grantOpId = randomUUID();
    const grant = await asClaims({ sub: ownerId }, () =>
      callFn(
        "ar2_admin_grant",
        `${sqlQuote(grantOpId)}::uuid, ${sqlQuote(workspaceId)}::uuid, ${sqlQuote(agentId)}::uuid, NULL::uuid[], true, true, true, false, NULL::timestamptz`,
      ),
    );
    assert.equal(grant.status, "committed", `owner-gated ar2_admin_grant must succeed for the real owner with a bare {sub} JWT; got ${JSON.stringify(grant)}`);
  });

  it("an AGENT claiming ar_role='owner' at the JWT TOP LEVEL gains nothing", async () => {
    const ownerId = randomUUID();
    const agentId = randomUUID();
    const workspaceId = (await asClaims({ sub: ownerId }, () => callFn("ar2_admin_workspace", sqlQuote("ws-toplevel")))).workspace_id;
    await asClaims({ sub: ownerId }, () =>
      callFn("ar2_admin_grant", `${sqlQuote(randomUUID())}::uuid, ${sqlQuote(workspaceId)}::uuid, ${sqlQuote(agentId)}::uuid, NULL::uuid[], true, true, false, false, NULL::timestamptz`),
    );

    const forged = await asClaims({ sub: agentId, ar_role: "owner" }, () =>
      callFn("ar2_admin_grant", `${sqlQuote(randomUUID())}::uuid, ${sqlQuote(workspaceId)}::uuid, ${sqlQuote(randomUUID())}::uuid, NULL::uuid[], true, true, false, false, NULL::timestamptz`),
    );
    assert.equal(forged.status, "rejected");
    assert.equal(forged.reason, "forbidden", "an agent forging ar_role=owner at the top level must not gain owner-trust");
  });

  it("an AGENT claiming ar_role='owner' inside user_metadata gains nothing", async () => {
    const ownerId = randomUUID();
    const agentId = randomUUID();
    const workspaceId = (await asClaims({ sub: ownerId }, () => callFn("ar2_admin_workspace", sqlQuote("ws-usermeta")))).workspace_id;
    await asClaims({ sub: ownerId }, () =>
      callFn("ar2_admin_grant", `${sqlQuote(randomUUID())}::uuid, ${sqlQuote(workspaceId)}::uuid, ${sqlQuote(agentId)}::uuid, NULL::uuid[], true, true, false, false, NULL::timestamptz`),
    );

    const forged = await asClaims({ sub: agentId, user_metadata: { ar_role: "owner" } }, () =>
      callFn("ar2_admin_grant", `${sqlQuote(randomUUID())}::uuid, ${sqlQuote(workspaceId)}::uuid, ${sqlQuote(randomUUID())}::uuid, NULL::uuid[], true, true, false, false, NULL::timestamptz`),
    );
    assert.equal(forged.status, "rejected");
    assert.equal(forged.reason, "forbidden", "an agent forging ar_role=owner in user_metadata must not gain owner-trust");
  });

  it("an AGENT claiming ar_role='owner' inside app_metadata gains nothing", async () => {
    const ownerId = randomUUID();
    const agentId = randomUUID();
    const workspaceId = (await asClaims({ sub: ownerId }, () => callFn("ar2_admin_workspace", sqlQuote("ws-appmeta")))).workspace_id;
    await asClaims({ sub: ownerId }, () =>
      callFn("ar2_admin_grant", `${sqlQuote(randomUUID())}::uuid, ${sqlQuote(workspaceId)}::uuid, ${sqlQuote(agentId)}::uuid, NULL::uuid[], true, true, false, false, NULL::timestamptz`),
    );

    const forged = await asClaims({ sub: agentId, app_metadata: { ar_role: "owner" } }, () =>
      callFn("ar2_admin_grant", `${sqlQuote(randomUUID())}::uuid, ${sqlQuote(workspaceId)}::uuid, ${sqlQuote(randomUUID())}::uuid, NULL::uuid[], true, true, false, false, NULL::timestamptz`),
    );
    assert.equal(forged.status, "rejected");
    assert.equal(forged.reason, "forbidden", "an agent forging ar_role=owner in app_metadata must not gain owner-trust");
  });

  it("defense-in-depth: the REAL owner explicitly labeled ar_role='agent' is refused owner-trust even though auth.uid()=owner_id", async () => {
    const ownerId = randomUUID();
    const workspaceId = (await asClaims({ sub: ownerId }, () => callFn("ar2_admin_workspace", sqlQuote("ws-selflabeled-agent")))).workspace_id;

    const selfLabeledAgent = await asClaims({ sub: ownerId, ar_role: "agent" }, () =>
      callFn("ar2_admin_grant", `${sqlQuote(randomUUID())}::uuid, ${sqlQuote(workspaceId)}::uuid, ${sqlQuote(randomUUID())}::uuid, NULL::uuid[], true, true, false, false, NULL::timestamptz`),
    );
    assert.equal(selfLabeledAgent.status, "rejected");
    assert.equal(selfLabeledAgent.reason, "forbidden", "owner-trust must be refused when the JWT explicitly self-labels ar_role=agent, even if auth.uid()=owner_id");
  });
});

describe("WP-P2 fix round 1 / B1: NULL-swallow divergence (genuine RED signal)", () => {
  // The harness's Actor abstraction always injects ar_role from
  // principal.kind (pglite-harness.mjs claimsFor()), which MASKS the real
  // bug: a production Supabase JWT never carries ar_role at all. This block
  // bypasses the harness to use the actual production JWT shape ({sub}
  // only) and hits a spot where SQL's three-valued NULL logic makes the
  // old ar_role-dependent code observably wrong (not just "accidentally
  // works"): `CASE WHEN v_owner_trusted THEN 'active' ELSE 'candidate' END`
  // treats a NULL v_owner_trusted as the ELSE branch, silently downgrading
  // a real owner's create to `candidate` — the opposite direction from the
  // `IF NOT (v_owner_trusted ...)` guards elsewhere, which treat NULL as
  // "don't reject" and so accidentally still let a real owner through.
  let db;

  before(async () => {
    db = new PGlite({ extensions: { pg_trgm } });
    await db.exec(fs.readFileSync(path.join(__dirname, "fixtures", "supabase-auth-stub.sql"), "utf8"));
    await db.exec(fs.readFileSync(path.join(REPO_ROOT, "migrations", "0002_shared_memory.sql"), "utf8"));
  });

  after(async () => {
    await db.close();
  });

  async function asClaims(claims, fn) {
    await db.exec("SET ROLE authenticated;");
    await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(claims)]);
    try {
      return await fn();
    } finally {
      await db.exec("RESET ROLE;");
    }
  }

  it("real owner (bare {sub} JWT, no ar_role) creating a constraint gets effective_status=active, not candidate", async () => {
    const ownerId = randomUUID();
    const workspaceId = (
      await asClaims({ sub: ownerId }, async () => {
        const r = await db.query("SELECT ar2_admin_workspace($1) AS result", ["null-swallow-ws"]);
        return r.rows[0].result;
      })
    ).workspace_id;

    const recId = randomUUID();
    const cmd = {
      op: "create", id: recId, workspace_id: workspaceId, project_id: null,
      kind: "constraint", visibility: "project", content: "owner-authored constraint", authority: "explicit_user",
    };
    const receipt = await asClaims({ sub: ownerId }, async () => {
      const r = await db.query(
        "SELECT ar2_mutate($1, $2, $3, $4, $5, $6) AS result",
        [ownerId, JSON.stringify(cmd), null, randomUUID(), "irrelevant-hash-for-first-write", null],
      );
      return r.rows[0].result;
    });
    assert.equal(receipt.status, "committed");
    assert.equal(receipt.effective_status, "active", "a REAL owner's constraint create must land active, not candidate, even with a bare {sub} JWT (no ar_role claim)");
    assert.equal(receipt.effective, true);
  });
});
