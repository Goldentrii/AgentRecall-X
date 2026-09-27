/**
 * scripts/acceptance/fixtures/hang-harness.mjs
 *
 * Adversarial self-test fixture (fix round 2): every `mutate()` call returns a
 * Promise that NEVER settles (neither resolves nor rejects nor throws). This
 * simulates the real failure mode reported against wp-p1/wp-p2's real drivers
 * (contract-suite.mjs hung indefinitely inside G-authz, >40 minutes, had to be
 * killed by hand). A hanging driver must produce a FAIL, not a stuck
 * verifier -- this fixture exists purely to prove that mechanically, without
 * needing to wait on (or diagnose) a real driver bug.
 *
 * Every other Harness/MemoryRepository method resolves normally (empty/no-op)
 * so the failure mode under test is isolated to "mutate() hangs", not "the
 * whole harness is unusable".
 *
 * DO NOT use this as a template for a real driver.
 */

import { randomUUID } from "node:crypto";

function emptyResult() {
  return {
    items: [], authority: "local", snapshot_cursor: "0", freshness: "fresh", partial: false,
    withheld_derived: 0, pending_ops: 0, overflow: false, access_epoch: 0, errors: [],
  };
}

function principalFor(kind, label) {
  return { principal_id: `${kind}:${label}:${randomUUID()}`, owner_id: `user:${label}:${randomUUID()}`, kind, auth: "local" };
}

function makeActor(label, principal) {
  return {
    label,
    principal,
    write(channel) {
      return { principal, channel: channel ?? "sdk" };
    },
    ownerWrite() {
      if (principal.kind === "agent") throw new Error("hang-harness: ownerWrite() is not available to agent principals");
      return {
        principal, channel: "sdk",
        trusted_user_event: { source: "tty_confirm", host: "hang-harness", host_event_id: randomUUID(), raw_text_hash: "0".repeat(64), minted_at: new Date().toISOString() },
      };
    },
    read(opts) {
      return { principal, channel: "sdk", ...opts };
    },
  };
}

class HangRepo {
  constructor() {
    this.mode = "local";
  }
  async get() { return emptyResult(); }
  async query() { return emptyResult(); }
  async readSnapshot() { return emptyResult(); }
  async list() { return { items: [], next_page_cursor: null }; }
  async history() { return []; }
  async export() { return { records: [], scrub_report: { redacted_fields: 0, quarantined: 0, reasons: {} } }; }
  async latestHandoff() { return emptyResult(); }
  /** THE adversarial behavior under test: a promise that never settles. */
  async mutate(_cmd, _expectedRevision, _operationId, _ctx) {
    return new Promise(() => {});
  }
  async readChanges() { return { events: [], next_cursor: "0", has_more: false, access_epoch: 0 }; }
  async recordOutcome() { return new Promise(() => {}); }
  async getOperation() { return null; }
  async close() {}
}

export default async function createHarness() {
  const repo = new HangRepo();
  return {
    name: "adversarial-hang-on-mutate",
    capabilities: { multiUser: true, agents: true, faults: ["crash_before_receipt", "crash_after_wal", "ack_lost", "offline"], realCloud: false },
    async setup() {},
    async teardown() {
      // Diagnostic marker only (this fixture is not committed for production use): lets fix-round-2
      // verification confirm harness.teardown() actually ran even when the process is force-exited by
      // the watchdog rather than by node:test's own natural completion.
      console.error("hang-harness: teardown() called");
    },
    async newOwner(label) { return makeActor(label, principalFor("user", label)); },
    async newAgent(_owner, label) { return makeActor(label, principalFor("agent", label)); },
    async workspace() { return randomUUID(); },
    async project() { return randomUUID(); },
    async repoFor() { return repo; },
    async adminFor() {
      return {
        async createWorkspace() { return { workspace_id: randomUUID() }; },
        async grant() { return new Promise(() => {}); },
        async revokeGrant() { return new Promise(() => {}); },
        async setProjectAlias() { return new Promise(() => {}); },
        async resolveProject() { return null; },
      };
    },
    async revoke() {},
    async armFault(kind) {
      if (!["crash_before_receipt", "crash_after_wal", "ack_lost", "offline"].includes(kind)) throw new Error(`unsupported fault ${kind}`);
    },
    async clearFaults() {},
    async restart() { return repo; },
  };
}
