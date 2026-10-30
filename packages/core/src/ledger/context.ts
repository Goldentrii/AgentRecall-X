/**
 * Per-process ledger context (spec D10): each entrypoint calls
 * setLedgerContext once; direct library use (tests) defaults to library/system.
 */
import type { LedgerActor, LedgerVia } from "./types.js";

interface LedgerContext {
  via: LedgerVia;
  actor: LedgerActor;
}

let ctx: LedgerContext = { via: "library", actor: "system" };

export function setLedgerContext(partial: Partial<LedgerContext>): void {
  ctx = { ...ctx, ...partial };
}

export function getLedgerContext(): LedgerContext {
  return ctx;
}

/** Test helper. */
export function resetLedgerContext(): void {
  ctx = { via: "library", actor: "system" };
}
