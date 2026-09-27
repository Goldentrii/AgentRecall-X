/**
 * TrustedUserEvent capability (ADR-001 rev2 R2.8).
 *
 * Only instances minted here are accepted by drivers as evidence of a real
 * user action. Membership is tracked in a module-private WeakSet, so a
 * structurally identical plain object is rejected.
 *
 * Honest limit: locally this defends the MCP/SDK surfaces, NOT against an
 * agent that has shell access as the same OS user (it can fake a TTY or
 * invoke the hook itself). Cloud owner actions additionally require an owner
 * JWT, which agent runtimes never load.
 */

export type TrustedUserEventSource = "tty_confirm" | "host_user_prompt_hook" | "owner_jwt";

export interface TrustedUserEvent {
  readonly source: TrustedUserEventSource;
  readonly host: string;
  readonly host_event_id: string;
  readonly raw_text_hash: string;
  readonly minted_at: string;
}

const minted = new WeakSet<object>();

export function mintTrustedUserEvent(input: {
  source: TrustedUserEventSource;
  host: string;
  host_event_id: string;
  raw_text_hash: string;
}): TrustedUserEvent {
  if (!input.host || !input.host_event_id || !/^[0-9a-f]{64}$/.test(input.raw_text_hash)) {
    throw new Error("mintTrustedUserEvent: host, host_event_id and a sha256 raw_text_hash are required");
  }
  const ev: TrustedUserEvent = Object.freeze({ ...input, minted_at: new Date().toISOString() });
  minted.add(ev);
  return ev;
}

export function isTrustedUserEvent(v: unknown): v is TrustedUserEvent {
  return typeof v === "object" && v !== null && minted.has(v);
}
