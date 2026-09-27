/**
 * Experience-evolution contract (ADR-002). Freeze candidate for P5; driver
 * implementers must not edit after freeze. Builds on contract.ts (ADR-001).
 */

import type { Principal, ReadContext, RevisionRef, WriteContext, WriteReceipt } from "./contract.js";

export type EvolutionState =
  | "observed"
  | "candidate"
  | "validated"
  | "active_version"
  | "rejected"
  | "needs_more_evidence"
  | "superseded"
  | "rolled_back"
  | "retracted";

/** Server-set on kind=experience records as metadata._ar_evo. */
export interface EvolutionMeta {
  state: EvolutionState;
  lineage_id: string;
  version: number;
  validation_report_ref?: string;
  rollback_of?: RevisionRef;
}

export interface CaseSetRef {
  /** sha256 of the canonical case-set file, registered by the verification owner. */
  sha256: string;
  count: number;
}

export interface ValidationReport {
  report_id: string;
  candidate: RevisionRef;
  verifier_principal_id: string;
  held_in: CaseSetRef & { old_failures_reproduced: number; old_failures_fixed: number; regressions: number };
  held_out: CaseSetRef & {
    non_applicable: number;
    new_regressions: number;
    misapplications: number;
    hard_safety_failures: number;
  };
  independent_sources: number;
  scope_leak: boolean;
  secret_leak: boolean;
  created_at: string;
}

export interface EvolutionThresholds {
  held_in_min: 10;
  held_in_old_failures_min: 3;
  held_in_fixed_min: 2;
  held_out_min: 30;
  held_out_non_applicable_min: 10;
  independent_sources_min: 3;
}

export const EVOLUTION_THRESHOLDS: EvolutionThresholds = {
  held_in_min: 10,
  held_in_old_failures_min: 3,
  held_in_fixed_min: 2,
  held_out_min: 30,
  held_out_non_applicable_min: 10,
  independent_sources_min: 3,
};

/** Pure gate check; the driver still verifies registry membership and principal separation. */
export function reportPasses(r: ValidationReport, t: EvolutionThresholds = EVOLUTION_THRESHOLDS): boolean {
  return (
    r.held_in.count >= t.held_in_min &&
    r.held_in.old_failures_reproduced >= t.held_in_old_failures_min &&
    r.held_in.old_failures_fixed >= t.held_in_fixed_min &&
    r.held_in.regressions === 0 &&
    r.held_out.count >= t.held_out_min &&
    r.held_out.non_applicable >= t.held_out_non_applicable_min &&
    r.held_out.new_regressions === 0 &&
    r.held_out.misapplications === 0 &&
    r.held_out.hard_safety_failures === 0 &&
    r.independent_sources >= t.independent_sources_min &&
    !r.scope_leak &&
    !r.secret_leak
  );
}

export interface Lease {
  lease_id: string;
  scope: string;
  holder_principal_id: string;
  fencing_token: number;
  expires_at: string;
}

export interface LeaseService {
  acquire(scope: string, ttlMs: number, ctx: WriteContext): Promise<Lease | null>;
  renew(lease: Lease, ttlMs: number, ctx: WriteContext): Promise<Lease | null>;
  release(lease: Lease, ctx: WriteContext): Promise<void>;
}

export interface ProposeExperience {
  lineage_id: string;
  content: string;
  workspace_id: string;
  project_id: string | null;
  source_event_ids: string[];
  derived_from: RevisionRef[];
}

export interface RunReport {
  scope: string;
  dry_run: boolean;
  processed_source_events: number;
  deduped: number;
  candidates_created: number;
  rejections: Record<string, number>;
  validated: number;
  activated: number;
  rolled_back: number;
  wall_ms: number;
  model_calls: number;
  tokens: number;
  cost_usd: number;
  status: "OK" | "NO_ELIGIBLE_DATA" | "PARTIAL" | "FAILED";
}

export interface ExperienceRepository {
  propose(p: ProposeExperience, lease: Lease, operationId: string, ctx: WriteContext): Promise<WriteReceipt>;
  attachValidation(report: ValidationReport, operationId: string, ctx: WriteContext): Promise<WriteReceipt>;
  /** Owner, or auto-activation per ADR-002 §4 when caller holds the verifier role. */
  activate(candidate: RevisionRef, operationId: string, ctx: WriteContext): Promise<WriteReceipt>;
  rollback(lineageId: string, toVersion: number, operationId: string, ctx: WriteContext): Promise<WriteReceipt>;
  lineage(lineageId: string, ctx: ReadContext): Promise<Array<{ ref: RevisionRef; meta: EvolutionMeta }>>;
  /** Distinct lineage roots among the given source events (A35 independence). */
  independentSources(sourceEventIds: string[], principal: Principal): Promise<number>;
}
