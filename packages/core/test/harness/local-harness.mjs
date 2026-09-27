/**
 * Local-mode driver harness for the frozen acceptance contract suite
 * (scripts/acceptance/harness.d.ts). WP-P1 deliverable — implements the
 * interface exactly so WP-V's contract-suite.mjs can plug it in via
 * AR_HARNESS=<path to this file>.
 *
 * multiUser=false (local mode: a single OS owner); agents=true (grants);
 * faults=[crash_after_wal, crash_before_receipt] via a real child process
 * (LocalRepository's AR_FAILPOINT self-terminates at the matching commit
 * step — see repository/local/local-repository.ts's commitRecord()/rev1
 * §5); realCloud=false.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createMemoryRuntime } from "../../dist/repository/runtime.js";
import { mintTrustedUserEvent } from "../../dist/repository/trust.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAULT_CHILD = path.join(__dirname, "fault-mutate-child.mjs");

/** harness.d.ts fault names -> this driver's AR_FAILPOINT values (local-repository.ts). */
const FAULT_TO_FAILPOINT = {
  crash_after_wal: "after_wal",
  crash_before_receipt: "before_receipt",
};

const MEMORY_REPOSITORY_READ_METHODS = ["get", "query", "readSnapshot", "history", "export", "latestHandoff", "readChanges", "getOperation"];

export default async function createHarness() {
  const baseTmp = fs.mkdtempSync(path.join(os.tmpdir(), "ar-local-harness-"));
  /** actor (object identity) -> { runtime, root, principal } — mutable so restart() can swap runtime in place. */
  const actorState = new WeakMap();
  /** principal_id -> armed fault kind (single-shot: cleared on first use). */
  const armedFaults = new Map();
  const allRuntimes = new Set();

  function makeActor(label, principal, root) {
    const actor = {
      label,
      principal,
      write(channel) {
        return { principal, channel: channel ?? "sdk" };
      },
      ownerWrite() {
        if (principal.kind !== "user") {
          throw new Error(`ownerWrite(): actor "${label}" is an agent principal — agents cannot mint owner trust (R2.8)`);
        }
        const trustedInput = {
          source: "tty_confirm",
          host: "local-harness",
          host_event_id: crypto.randomUUID(),
          raw_text_hash: crypto.createHash("sha256").update(`${label}:${crypto.randomUUID()}`).digest("hex"),
        };
        const ctx = { principal, channel: "cli", trusted_user_event: mintTrustedUserEvent(trustedInput) };
        // Harness-internal only (not part of the WriteContext contract) — lets
        // the fault-armed mutate() path re-mint an equivalent trusted event
        // inside the forked child process (a TrustedUserEvent's WeakSet brand
        // does not survive a process boundary).
        Object.defineProperty(ctx, "__trustedInput", { value: trustedInput, enumerable: false });
        return ctx;
      },
      read(opts) {
        return { principal, channel: "sdk", ...opts };
      },
    };
    actorState.set(actor, { runtime: null, root, principal });
    return actor;
  }

  function buildRuntime(root, principal) {
    const runtime = createMemoryRuntime({ root, mode: "local" }, principal);
    allRuntimes.add(runtime);
    return runtime;
  }

  function wrapRepository(state, actor) {
    const repo = {
      mode: "local",
      close: () => state.runtime.run(() => state.runtime.repository.close()),
      async mutate(cmd, expectedRevision, operationId, ctx) {
        const faultKind = armedFaults.get(actor.principal.principal_id);
        if (!faultKind) {
          return state.runtime.run(() => state.runtime.repository.mutate(cmd, expectedRevision, operationId, ctx));
        }
        armedFaults.delete(actor.principal.principal_id); // single-shot
        const failpoint = FAULT_TO_FAILPOINT[faultKind];
        if (!failpoint) throw new Error(`local-harness: unsupported fault "${faultKind}"`);

        const childArgs = {
          root: state.root,
          principal: actor.principal,
          channel: ctx.channel,
          sessionId: ctx.session_id,
          trustedInput: ctx.__trustedInput ?? null,
          cmd,
          expectedRevision,
          operationId,
        };
        const result = spawnSync(process.execPath, [FAULT_CHILD], {
          env: { ...process.env, AR_FAILPOINT: failpoint, AR_HARNESS_CHILD_ARGS: JSON.stringify(childArgs) },
          encoding: "utf-8",
        });

        const okLine = (result.stdout ?? "").split("\n").find((l) => l.startsWith("{"));
        if (okLine) {
          // The failpoint never actually fired (e.g. the op was rejected or
          // conflicted before reaching a commit) — relay the real receipt.
          return JSON.parse(okLine).receipt;
        }
        // The child crashed at the armed failpoint — a genuinely unresolved
        // operation until getOperation()/restart() settles it (rev1 §5).
        return {
          status: "unknown",
          operation_id: operationId,
          id: cmd.id,
          reason: `fault_injected:${faultKind} (child exit code ${result.status}, signal ${result.signal})`,
        };
      },
    };
    for (const m of MEMORY_REPOSITORY_READ_METHODS) {
      repo[m] = (...args) => state.runtime.run(() => state.runtime.repository[m](...args));
    }
    return repo;
  }

  return {
    name: "local",
    capabilities: {
      multiUser: false,
      agents: true,
      faults: ["crash_after_wal", "crash_before_receipt"],
      realCloud: false,
    },

    async setup() {
      // Nothing global to prepare — each newOwner() gets its own isolated
      // temp root, so tests are independent by construction.
    },

    async teardown() {
      for (const rt of allRuntimes) {
        await rt.close().catch(() => {});
      }
      allRuntimes.clear();
      armedFaults.clear();
      fs.rmSync(baseTmp, { recursive: true, force: true });
    },

    async newOwner(label) {
      const root = fs.mkdtempSync(path.join(baseTmp, `owner-${label}-`));
      const principal = { principal_id: `local:${label}`, owner_id: `local:${label}`, kind: "user", auth: "local" };
      const actor = makeActor(label, principal, root);
      const state = actorState.get(actor);
      state.runtime = buildRuntime(root, principal);
      return actor;
    },

    async newAgent(owner, label, grant) {
      const ownerState = actorState.get(owner);
      const principal = { principal_id: `agent:${label}`, owner_id: owner.principal.owner_id, kind: "agent", auth: "local" };
      const actor = makeActor(label, principal, ownerState.root);
      const state = actorState.get(actor);
      state.runtime = buildRuntime(ownerState.root, principal);

      if (grant && grant.workspace_id) {
        const spec = {
          grantee_principal_id: principal.principal_id,
          workspace_id: grant.workspace_id,
          project_ids: grant.project_ids ?? null,
          can_read: grant.can_read ?? true,
          can_write: grant.can_write ?? true,
          can_approve: grant.can_approve ?? false,
          personal: grant.personal ?? false,
          expires_at: grant.expires_at ?? null,
        };
        await ownerState.runtime.run(() => ownerState.runtime.admin.grant(spec, owner.ownerWrite()));
      }
      return actor;
    },

    async workspace(owner) {
      const state = actorState.get(owner);
      const { workspace_id } = await state.runtime.run(() => state.runtime.admin.createWorkspace(`ws-${owner.label}`, owner.write()));
      return workspace_id;
    },

    async project(owner, workspaceId, alias) {
      const state = actorState.get(owner);
      const projectId = crypto.randomUUID();
      void workspaceId; // local mode's ProjectAlias is not workspace-scoped (single owner) — accepted for interface parity
      await state.runtime.run(() => state.runtime.admin.setProjectAlias(alias, projectId, owner.ownerWrite()));
      return projectId;
    },

    async repoFor(actor) {
      const state = actorState.get(actor);
      return wrapRepository(state, actor);
    },

    async adminFor(owner) {
      const state = actorState.get(owner);
      return state.runtime.admin;
    },

    async revoke(owner, agent, workspaceId) {
      const state = actorState.get(owner);
      await state.runtime.run(() => state.runtime.admin.revokeGrant(agent.principal.principal_id, workspaceId, owner.ownerWrite()));
    },

    async armFault(kind, actor) {
      if (!FAULT_TO_FAILPOINT[kind]) throw new Error(`local-harness: fault "${kind}" is not supported (capabilities.faults: ${Object.keys(FAULT_TO_FAILPOINT).join(", ")})`);
      armedFaults.set(actor.principal.principal_id, kind);
    },

    async clearFaults() {
      armedFaults.clear();
    },

    async restart(actor) {
      const state = actorState.get(actor);
      await state.runtime.close().catch(() => {});
      allRuntimes.delete(state.runtime);
      state.runtime = buildRuntime(state.root, state.principal);
      return wrapRepository(state, actor);
    },
  };
}
