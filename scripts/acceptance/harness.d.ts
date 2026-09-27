/**
 * Driver harness interface for the frozen acceptance contract suite
 * (orchestrator-owned; ADR-001 rev2). Each driver worker ships ONE module
 * default-exporting `createHarness()`:
 *   - local:  packages/core/test/harness/local-harness.mjs   (WP-P1)
 *   - cloud:  packages/core/test/harness/pglite-harness.mjs  (WP-P2; real Postgres semantics, no PostgREST)
 *   - cloud-real: packages/core/test/harness/supabase-harness.mjs (needs a real isolated project; BLOCKED until provided)
 * The suite (scripts/acceptance/contract-suite.mjs, WP-V) selects one via env AR_HARNESS=<path>.
 * Harness modules may use privileged setup (service role / direct files) ONLY inside
 * setup/newOwner/newAgent/grant/revoke/fault hooks — never inside repoFor() calls under test.
 */
import type {
  MemoryRepository, AdminRepository, Principal, WriteContext, ReadContext, GrantSpec, Channel,
} from "../../packages/core/src/repository/contract.js";

export interface Actor {
  label: string;
  principal: Principal;
  /** Plain write context (no trust capability). */
  write(channel?: Channel): WriteContext;
  /** Write context carrying the driver's owner-trust proof (TrustedUserEvent / owner JWT). Throws for agents. */
  ownerWrite(): WriteContext;
  read(opts?: Partial<Omit<ReadContext, "principal">>): ReadContext;
}

export interface HarnessCapabilities {
  /** Distinct human users (U, V). false for local mode (single OS owner). */
  multiUser: boolean;
  /** Agent principals with grants. */
  agents: boolean;
  /** Can inject faults: kill between commit phases, drop ACK, go offline. */
  faults: Array<"crash_before_receipt" | "crash_after_wal" | "ack_lost" | "offline">;
  /** Real network transport to a hosted Supabase (not PGlite). */
  realCloud: boolean;
}

export interface Harness {
  name: string;
  capabilities: HarnessCapabilities;
  setup(): Promise<void>;
  teardown(): Promise<void>;
  newOwner(label: string): Promise<Actor>;
  newAgent(owner: Actor, label: string, grant: Partial<GrantSpec>): Promise<Actor>;
  /** Owner-created workspace + project ids (stable UUIDs). */
  workspace(owner: Actor): Promise<string>;
  project(owner: Actor, workspaceId: string, alias: string): Promise<string>;
  /** Repository bound to the actor's own runtime/JWT — the object under test. */
  repoFor(actor: Actor): Promise<MemoryRepository>;
  adminFor(owner: Actor): Promise<AdminRepository>;
  revoke(owner: Actor, agent: Actor, workspaceId: string): Promise<void>;
  /** Fault hooks; resolve after the fault is armed. Unsupported faults throw. */
  armFault(kind: HarnessCapabilities["faults"][number], actor: Actor): Promise<void>;
  clearFaults(): Promise<void>;
  /** Simulate process restart for the actor (drop in-memory state, reopen repo from durable storage). */
  restart(actor: Actor): Promise<MemoryRepository>;
}

export default function createHarness(): Promise<Harness>;
