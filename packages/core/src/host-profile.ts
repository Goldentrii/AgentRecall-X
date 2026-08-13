/**
 * Host profile — the 3-tier lifecycle-capability model behind AgentRecall's
 * "memory arrives unasked" doctrine.
 *
 * The customer's only action is describing intent. Memory lifecycle
 * (session_start / session_end) is invisible runtime machinery — it must
 * never require the customer to type a command. How that invisibility is
 * achieved differs by host:
 *
 *   Tier A — hooks       Host fires the lifecycle for the agent (Claude Code's
 *                         SessionStart/Stop hooks). The agent doesn't have to
 *                         remember anything; calls it makes anyway are safe
 *                         and idempotent alongside the hooks.
 *   Tier B — mcp-instructions
 *                         MCP is available but no hook fires automatically
 *                         (Codex, Cursor, raw MCP clients). Nothing saves
 *                         itself — the AGENT must drive session_start at
 *                         entry and session_end at exit, unprompted. This is
 *                         non-negotiable, not optional: on these hosts the
 *                         MCP `instructions` string (see lifecycleInstructions
 *                         below) is the only carrier telling the agent it is
 *                         the sole lifecycle driver.
 *   Tier C — manual       No MCP session at all — the caller is integrating
 *                         directly via the SDK or CLI. There is no server
 *                         `instructions` handshake to piggyback on, so the
 *                         calling code must invoke session_start/session_end
 *                         itself.
 *
 * Detection order (resolveHostProfile):
 *   1. Explicit `AR_HOST` env override — always wins, never guessed away.
 *      Known values: claude-code, codex, cursor, raw, openclaw, chatbox,
 *      generic (all Tier B except claude-code) and sdk, cli (Tier C).
 *      An unrecognized explicit value conservatively resolves to Tier B —
 *      under-promising "hooks will save you" beats silently losing data.
 *   2. Best-effort inference when AR_HOST is unset:
 *        - `CLAUDECODE` or any `CLAUDE_CODE_*` env var present → Tier A
 *          (Claude Code sets these in every subprocess it spawns).
 *        - Otherwise → Tier B, on the assumption that a process resolving
 *          this at all is running as (or on behalf of) an MCP server with
 *          no confirmed hook signal. SDK/CLI callers do not get inferred
 *          into Tier C — they must pass `AR_HOST=sdk`/`AR_HOST=cli`
 *          explicitly, since there is no environment signal that reliably
 *          distinguishes "no MCP at all" from "MCP host that just didn't
 *          set CLAUDE_CODE_*".
 */

export type HostTier = "A" | "B" | "C";
export type Lifecycle = "hook-driven" | "agent-driven" | "manual";

export interface HostProfile {
  /** Normalized host identifier (explicit AR_HOST value, or an inferred name). */
  host: string;
  tier: HostTier;
  lifecycle: Lifecycle;
}

/** Known `AR_HOST` values and the tier they map to. Unlisted values default to Tier B (see resolveHostProfile). */
const KNOWN_HOST_TIERS: Readonly<Record<string, HostTier>> = {
  "claude-code": "A",
  "codex": "B",
  "cursor": "B",
  "raw": "B",
  "openclaw": "B",
  "chatbox": "B",
  "generic": "B",
  "sdk": "C",
  "cli": "C",
};

function tierToLifecycle(tier: HostTier): Lifecycle {
  if (tier === "A") return "hook-driven";
  if (tier === "C") return "manual";
  return "agent-driven";
}

/**
 * Resolve the current host's lifecycle-capability tier.
 *
 * Safe to call repeatedly and cheaply (no I/O) — callers should not cache
 * the result across process env mutations in tests.
 */
export function resolveHostProfile(): HostProfile {
  const explicit = process.env["AR_HOST"]?.trim().toLowerCase();
  if (explicit) {
    // Unknown explicit host names default to Tier B, never Tier A — a host
    // must be a KNOWN hook-driven host to earn the "hooks will save you" claim.
    const tier = KNOWN_HOST_TIERS[explicit] ?? "B";
    return { host: explicit, tier, lifecycle: tierToLifecycle(tier) };
  }

  const hasClaudeCodeSignal =
    Boolean(process.env["CLAUDECODE"]) ||
    Object.keys(process.env).some((key) => key.startsWith("CLAUDE_CODE_"));
  if (hasClaudeCodeSignal) {
    return { host: "claude-code", tier: "A", lifecycle: "hook-driven" };
  }

  // No AR_HOST, no Claude Code signal — conservatively assume an MCP host
  // with no confirmed hooks (Tier B). This is the correct default for
  // packages/mcp-server, which is the only caller that resolves this
  // without an explicit AR_HOST today.
  return { host: "mcp", tier: "B", lifecycle: "agent-driven" };
}

const TIER_A_INSTRUCTIONS =
  "AgentRecall is your memory across sessions. In this host, lifecycle hooks call session_start automatically at session entry and session_end at session exit — you do not need to drive the lifecycle yourself. session_start, session_end, remember, recall, and check remain safe to call directly at any time; those calls are idempotent alongside the hooks. DURABLE INTENT still applies: the moment you or the user says save / remember / checkpoint / 记住 / 保存, call session_end (or remember for a single fact) immediately rather than waiting for the exit hook.";

const TIER_B_INSTRUCTIONS =
  "AgentRecall is your memory across sessions. YOU drive its lifecycle — no harness fires it for you; if you don't call these tools, nothing is saved. (1) ENTRY: when a session resumes prior work, call session_start FIRST, before acting. (2) DURABLE INTENT: the moment you or the user says save / remember / checkpoint / 记住 / 保存, call session_end (or remember for a single fact). Saying it is not saving it. (3) EXIT: before you stop, call session_end. recall and check are safe to call freely, any time. Hooks auto-fire only in Claude Code; in every other host (Codex, chatbox, raw API) you are the sole lifecycle driver.";

const TIER_C_INSTRUCTIONS =
  "AgentRecall has no MCP session and no hooks here — this is a direct SDK/CLI integration. Nothing saves itself: call session_start (or `ar cold-start`) yourself when a run begins, session_end (or `ar saveall`) yourself before it ends, and remember/recall on demand. Saying it is not saving it.";

/**
 * H1 (Train C review, 2026-08-12 wave) — single exported predicate for "does
 * this host already own the memory lifecycle via hooks, independent of
 * anything the MCP server process does on its own." Tier A (hook-driven) is
 * EXACTLY that case: Claude Code's SessionStart/Stop hooks fire
 * session_start/session_end keyed on the REAL `CLAUDE_CODE_SESSION_ID`.
 *
 * WHY this exists as its OWN predicate rather than callers inlining
 * `resolveHostProfile().tier === "A"` (or, worse, re-deriving the
 * CLAUDECODE/CLAUDE_CODE_* check directly): a class-not-instance guard — any
 * future host-lifecycle mechanism that needs "is hooks already covering
 * this?" must ask THIS question, not reimplement env-var sniffing per call
 * site. Reimplementing it would (a) silently diverge the moment
 * `resolveHostProfile`'s detection logic changes, and (b) ignore the
 * explicit `AR_HOST` override entirely (an inline `CLAUDECODE` check would
 * wrongly say "hook-owned" even when `AR_HOST=codex` explicitly overrides
 * an actual Claude Code process — `resolveHostProfile` already handles that
 * precedence correctly).
 *
 * Root cause this closes: `packages/mcp-server/src/lib/ambient-capture.ts`
 * (C-1) and `lib/lifecycle-exit.ts` (C-3) both key their working-memory
 * writes on `getSessionId()` — a RANDOM id generated once per MCP-server
 * process (`storage/session.ts`), uncorrelated with the hook stack's real
 * `CLAUDE_CODE_SESSION_ID`. On a host running Claude Code with hooks AND
 * this MCP server simultaneously (the common case), hook-ambient already
 * captures every prompt under the real session id; C-1 capturing AGAIN under
 * the MCP process's own fake id produces a SECOND, independently-orphaned
 * working-memory file for the same logical session, which C-2's sweep and
 * C-3's graceful-exit handler each turn into a SECOND card + recency entry.
 * Both call sites gate their installation on this predicate being false —
 * see their own doc comments for the accepted v1 tradeoff (a Claude Code
 * user who has somehow disabled hooks but still runs this MCP server gets
 * no ambient capture from the MCP side either).
 */
export function isHookOwnedHost(): boolean {
  return resolveHostProfile().tier === "A";
}

/**
 * The single canonical source for AgentRecall's lifecycle instructions, one
 * variant per host tier. `packages/mcp-server/src/server.ts` and any
 * documentation describing the lifecycle (e.g. root AGENTS.md) must derive
 * their text from this function rather than hardcoding it, so the two
 * surfaces can never silently diverge again.
 */
export function lifecycleInstructions(tier: HostTier): string {
  if (tier === "A") return TIER_A_INSTRUCTIONS;
  if (tier === "C") return TIER_C_INSTRUCTIONS;
  return TIER_B_INSTRUCTIONS;
}
