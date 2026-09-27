/**
 * pglite-harness.mjs — WP-P2 cloud driver harness, implementing
 * scripts/acceptance/harness.d.ts exactly. Real Postgres semantics (RLS,
 * SECURITY DEFINER, xid8 snapshots) via @electric-sql/pglite 0.5.8
 * (PostgreSQL 18.3 WASM, in-memory, no PostgREST, no network).
 *
 * Identity model: PGlite has no real multi-connection/session concept — it
 * serializes every top-level `db.exec()`/`db.query()` call through a single
 * internal queue (verified empirically: concurrent Promise.all calls with
 * distinct `request.jwt.claims` never observed each other's identity — see
 * WP-P2-report.md). Each RPC call is therefore built as ONE atomic
 * `db.exec()` string: `SET ROLE authenticated; select set_config(...); select
 * <fn>(<named args>); RESET ROLE;` — never as separate awaited calls, which
 * WOULD be racy under concurrent actors.
 *
 * Privileged setup (stub + migration apply) runs as the ambient PGlite
 * superuser (no role switch) — matches how a real migration is applied to
 * Supabase. Everything else (workspace/project/grant/revoke, and of course
 * repoFor()) goes through the same owner-authenticated RPC path production
 * code uses — no service_role shortcut, so the harness incidentally
 * exercises ar2_admin_* authorization too.
 */

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { CloudRepository } from "../../dist/repository/cloud/cloud-repository.js";
import { CloudAdminRepository } from "../../dist/repository/cloud/admin-repository.js";
import { NetworkError, PgError, TimeoutError } from "../../dist/repository/cloud/sql-executor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const MIGRATION_PATH = path.join(REPO_ROOT, "migrations", "0002_shared_memory.sql");
const STUB_PATH = path.join(__dirname, "..", "fixtures", "supabase-auth-stub.sql");

// Explicit Postgres type for every RPC arg name this driver ever sends —
// avoids relying on untyped-literal inference across every function's
// (single) overload, and makes NULL vs. empty-array unambiguous.
const ARG_TYPES = {
  p_owner_id: "uuid", p_workspace_id: "uuid", p_project_id: "uuid", p_id: "uuid",
  p_operation_id: "uuid", p_proposal_id: "uuid", p_grantee_principal_id: "uuid",
  p_principal_id: "uuid", p_after_id: "uuid",
  p_cmd: "jsonb", p_outcome: "jsonb",
  p_payload_hash: "text", p_alias: "text", p_task_key: "text", p_cursor: "text",
  p_text: "text", p_name: "text", p_reason: "text",
  p_expected_revision: "integer", p_limit: "integer",
  p_snapshot_only_active: "boolean", p_include_non_active: "boolean",
  p_can_read: "boolean", p_can_write: "boolean", p_can_approve: "boolean", p_personal: "boolean",
  p_expires_at: "timestamptz", p_after_updated_at: "timestamptz",
  p_kinds: "text[]", p_ids: "uuid[]", p_project_ids: "uuid[]",
};

function sqlQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function literal(argName, value) {
  const type = ARG_TYPES[argName] ?? "text";
  if (value === null || value === undefined) return `NULL::${type}`;
  if (type === "jsonb") return `${sqlQuote(JSON.stringify(value))}::jsonb`;
  if (type.endsWith("[]")) {
    if (!Array.isArray(value)) throw new Error(`pglite-harness: ${argName} expected an array, got ${typeof value}`);
    if (value.length === 0) return `ARRAY[]::${type}`;
    return `ARRAY[${value.map((v) => sqlQuote(v)).join(",")}]::${type}`;
  }
  if (type === "boolean") return value ? "true" : "false";
  if (type === "integer") return String(Number(value));
  return `${sqlQuote(String(value))}::${type}`;
}

function claimsFor(principal) {
  return { sub: principal.principal_id, ar_role: principal.kind === "user" ? "owner" : "agent" };
}

export default async function createHarness() {
  let db;
  let tmpRoot;
  /** @type {Map<string, Set<string>>} principal_id -> armed fault kinds */
  const faultState = new Map();
  const actors = new Map(); // label -> Actor (for restart/debug convenience)

  // Serialize every db.exec() call through a JS-level mutex (promise chain).
  // PGlite is empirically safe for concurrent CALLS that only read session
  // state (verified: distinct JWT claims across overlapping calls never
  // cross-contaminate — see WP-P2-report.md), but a hang was independently
  // observed by the verifier running the frozen acceptance suite's deeply
  // nested subtests against this harness, and could not be reproduced via a
  // hand-rolled script issuing the same operations sequentially — the one
  // structural difference is that node:test's subtest scheduling does not
  // guarantee the same actor-call ordering/exclusivity a flat script gets
  // "for free". If two overlapping calls ever land row-level DML on the
  // same table (e.g. two SET ROLE + DML batches interleaving at the wire-
  // protocol level) inside PGlite's single WASM instance, a lock a session
  // can only release by finishing its OWN still-pending statement batch
  // creates a real, permanent deadlock (matching the reported ">40 min"
  // hang exactly: not a slow query, an unbounded wait). This mutex removes
  // that possibility categorically by construction, regardless of whether
  // that is confirmed as the exact mechanism: no two rpcAs() calls are ever
  // in flight at the same time, full stop.
  let mutexTail = Promise.resolve();
  function withDbMutex(fn) {
    const run = mutexTail.then(fn, fn);
    mutexTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function rpcAs(principal, fn, args) {
    return withDbMutex(async () => {
      const parts = Object.entries(args).map(([k, v]) => `${k} => ${literal(k, v)}`);
      const claimsJson = JSON.stringify(claimsFor(principal));
      const sql = [
        "SET ROLE authenticated;",
        `SELECT set_config('request.jwt.claims', ${sqlQuote(claimsJson)}, false);`,
        `SELECT ${fn}(${parts.join(", ")}) AS result;`,
        "RESET ROLE;",
      ].join("\n");
      let results;
      try {
        results = await db.exec(sql);
      } catch (e) {
        throw new PgError(e.message ?? String(e), e.code, e.detail, e.hint);
      }
      const row = results[results.length - 2].rows[0];
      return row ? row.result : null;
    });
  }

  function executorFor(actor) {
    return {
      async rpc(fn, args) {
        const armed = faultState.get(actor.principal.principal_id);
        if (armed?.has("offline")) {
          throw new NetworkError(`pglite-harness: offline fault armed for actor "${actor.label}"`);
        }
        const result = await rpcAs(actor.principal, fn, args);
        if (armed?.has("ack_lost")) {
          throw new TimeoutError(`pglite-harness: ack_lost fault armed for actor "${actor.label}" — ${fn} ran server-side, ack simulated as lost`);
        }
        return result;
      },
    };
  }

  function rootFor(actor) {
    const dir = path.join(tmpRoot, actor.label.replace(/[^a-zA-Z0-9_-]/g, "_"));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function makeActor(label, principal) {
    const actor = {
      label,
      principal,
      write(channel = "sdk") {
        return { principal, channel };
      },
      ownerWrite() {
        if (principal.kind !== "user") {
          throw new Error(`pglite-harness: ownerWrite() called for a non-owner-kind actor "${label}" (kind=${principal.kind})`);
        }
        // Cloud owner-trust comes from the JWT (ar_role='owner' + auth.uid()
        // = target workspace owner_id) — not a TrustedUserEvent (that's the
        // LOCAL driver's mechanism, R2.8). The server still independently
        // verifies auth.uid() against the specific workspace's owner_id, so
        // this does not itself grant trust over another owner's workspace.
        return { principal, channel: "sdk" };
      },
      read(opts = {}) {
        return { principal, channel: opts.channel ?? "sdk", ...opts };
      },
    };
    actors.set(label, actor);
    return actor;
  }

  return {
    name: "pglite (PostgreSQL 18.3 WASM, real RLS, no PostgREST)",
    capabilities: { multiUser: true, agents: true, faults: ["offline", "ack_lost"], realCloud: false },

    async setup() {
      db = new PGlite({ extensions: { pg_trgm } });
      await db.exec(fs.readFileSync(STUB_PATH, "utf8"));
      await db.exec(fs.readFileSync(MIGRATION_PATH, "utf8"));
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ar2-pglite-"));
    },

    async teardown() {
      faultState.clear();
      actors.clear();
      if (db) await db.close();
      if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    },

    async newOwner(label) {
      const principal_id = randomUUID();
      const principal = { principal_id, owner_id: principal_id, kind: "user", auth: "supabase_jwt" };
      return makeActor(label, principal);
    },

    async newAgent(owner, label, grant) {
      const principal_id = randomUUID();
      const principal = {
        principal_id, owner_id: owner.principal.owner_id, kind: "agent",
        agent_label: label, auth: "supabase_jwt",
      };
      const actor = makeActor(label, principal);
      if (grant?.workspace_id) {
        await rpcAs(owner.principal, "ar2_admin_grant", {
          p_operation_id: randomUUID(),
          p_workspace_id: grant.workspace_id,
          p_grantee_principal_id: principal_id,
          p_project_ids: grant.project_ids ?? null,
          p_can_read: grant.can_read ?? true,
          p_can_write: grant.can_write ?? false,
          p_can_approve: grant.can_approve ?? false,
          p_personal: grant.personal ?? false,
          p_expires_at: grant.expires_at ?? null,
        });
      }
      return actor;
    },

    async workspace(owner) {
      const row = await rpcAs(owner.principal, "ar2_admin_workspace", { p_name: `ws-${owner.label}-${randomUUID().slice(0, 8)}` });
      if (!row?.workspace_id) throw new Error(`pglite-harness: ar2_admin_workspace failed: ${JSON.stringify(row)}`);
      return row.workspace_id;
    },

    async project(owner, workspaceId, alias) {
      const projectId = randomUUID();
      const row = await rpcAs(owner.principal, "ar2_admin_alias", {
        p_operation_id: randomUUID(), p_alias: alias, p_project_id: projectId,
      });
      if (row?.status !== "committed") throw new Error(`pglite-harness: ar2_admin_alias failed: ${JSON.stringify(row)}`);
      return projectId;
    },

    async repoFor(actor) {
      return new CloudRepository({ executor: executorFor(actor), root: rootFor(actor), principal: actor.principal });
    },

    async adminFor(owner) {
      return new CloudAdminRepository(executorFor(owner));
    },

    async revoke(owner, agent, workspaceId) {
      const row = await rpcAs(owner.principal, "ar2_admin_revoke", {
        p_operation_id: randomUUID(), p_workspace_id: workspaceId, p_grantee_principal_id: agent.principal.principal_id,
      });
      if (row?.status !== "committed") throw new Error(`pglite-harness: ar2_admin_revoke failed: ${JSON.stringify(row)}`);
    },

    async armFault(kind, actor) {
      if (kind !== "offline" && kind !== "ack_lost") {
        throw new Error(`pglite-harness: unsupported fault "${kind}" (this harness only supports offline, ack_lost)`);
      }
      const key = actor.principal.principal_id;
      if (!faultState.has(key)) faultState.set(key, new Set());
      faultState.get(key).add(kind);
    },

    async clearFaults() {
      faultState.clear();
    },

    async restart(actor) {
      // No in-process state beyond CloudRepository's read cache/lastEpoch
      // (never persisted) and the outbox (already durable under rootFor()).
      // A fresh instance bound to the same root+executor IS "reopen from
      // durable storage" for this driver.
      return new CloudRepository({ executor: executorFor(actor), root: rootFor(actor), principal: actor.principal });
    },
  };
}
