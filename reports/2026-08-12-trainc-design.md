# Train C — Zero-action lifecycle on non-hook hosts (design, 2026-08-12)

Doctrine (owner, 2026-07-26): customer's only action is describing intent; memory arrives front-to-back with zero commands. On Claude Code, hooks guarantee this. On Codex/Cursor/raw MCP there are no hooks — the loop currently depends on agent goodwill. Train C = make the MCP server process itself carry the loop.

## Recon facts (2026-08-12, file:line in recon report)
- stdio: 1 process = 1 client session; `SESSION_ID` already generated once per process (`core/storage/session.ts:35`).
- NO lifecycle callbacks exist: SDK's StdioServerTransport doesn't listen stdin end/close; graceful client close → zero signal. SIGKILL uncatchable regardless.
- No unified tool dispatch — passive capture must be wired per-tool or via a registerTool wrapper.
- working-memory.ts is currently hook-only (single call site in cli hook-ambient).

## Key correction to recon's feasibility judgment
Recon rated "partial — can capture, can't guarantee exit trigger". Wrong frame: **exit triggers are unnecessary for durability.** `wmAppend` is a per-call DISK append (v3.4.42), not a memory buffer. Disk WM + the existing orphan-rescue (v3.4.42) = crash-proof by construction, independent of how the process dies. Exit callbacks are a freshness optimization, not the mechanism.

## Design (minimal, composes with shipped machinery)

### C-1. Passive capture at the tools layer
A thin `withAmbientCapture(name, handler)` wrapper applied at each `registerTool` site (recall, remember, check, session_start, session_end — and any future tool by construction: the wrapper is the class, per-tool wiring is the anti-pattern). On every call: `wmAppend(SESSION_ID, {ts, gist})` where gist = tool name + scrubbed/byte-capped param digest (query text, remember content head, check goal). Reuses the v3.4.42 scrub-at-choke-point — no new privacy surface. Never-throws, O(1), same guarantees as hook-ambient capture.

### C-2. Rescue everywhere, not just CLI
Move/duplicate the orphan-rescue sweep (currently CLI hook-start only) into core `sessionStart()` (best-effort, post-assembly) so ANY host calling the `session_start` MCP tool self-heals prior dead sessions. Guarded: same idempotency (card-exists), same >1h window, same recordHookFailure on error.

### C-3. Best-effort freshness (optional, small)
`packages/mcp-server/src/index.ts`: register `process.stdin.on("end"|"close")` + SIGTERM/SIGINT → one-shot distill of own WM → card (reuse hook-end's card path via core). Covers graceful client close (better than today's zero). kill -9 falls through to C-2 by design.

### Explicitly NOT in scope (v1)
- Idle timers (C-2 covers cooled sessions; timers add state for marginal freshness)
- HTTP/multi-tenant transports (repo is stdio-only today; wrapper design must not ASSUME 1:1 — key WM by SESSION_ID, which stays correct either way)
- Codex process-management semantics (unverified; C-1/C-2 are host-agnostic so uncertainty doesn't block)

## Acceptance
Temp root, NO hooks: (1) simulate MCP tool calls via mcp-server stdio (session_start + recall + remember) → WM file grows, scrubbed; (2) kill -9 the server; (3) new server process, session_start tool → prior session rescued into card + recency + continuity shows it; (4) graceful stdin close → card exists immediately (C-3). Fixture-class axes mandatory (CJK params, no-param-defaults, concurrent two-process, unwritable root).

## Sequencing
Build AFTER wave/followups lands (B touches core catch sites; C-2 touches session-start.ts — serialize to avoid conflicts). Ship candidate: v3.4.43 together with follow-ups, owner confirms number.
