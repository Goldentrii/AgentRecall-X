# AgentRecall Cross-Surface ADAPTER + Agent-Driven Lifecycle — Verified Design Spec

> **Status:** IMPLEMENTED — P0–P5 landed on `feat/cross-surface-adapter` (NOT pushed/merged/version-bumped). This spec is the design of record; see `HOST-TIERS.md` for the as-built per-surface contract.
> **Branch context:** `feat/cross-surface-adapter`. **Naming-P0:** the layer is the **ADAPTER**, never "pipeline" — `pipeline_*` is the live project-narrative-phase domain (11 files) and is untouched/unaliased.
> **Verdict reconciliation:** 2 blockers (over-save/privacy, bootstrap-security) and 4 concerns are folded in below. Blockers that cannot be resolved on paper are listed as **OPEN QUESTIONS the human must answer (§12)**.

---

## 1. Problem & goal

AgentRecall's automatic memory lifecycle (recall-at-start, capture-on-trigger, save-at-stop) only fully fires on **Claude Code**, because that is the only host with `UserPromptSubmit` + `Stop` harness hooks (`~/.claude/settings.json:44-86`). On hook-less hosts the operator actually uses every day — **OpenClaw, Codex, chatbox** — the same primitives exist as MCP tools but nothing fires them automatically, so sessions silently fail to recall or save. The goal is a thin **ADAPTER** seam that reconciles the four host classes against the *already-shipping* primitives (the 4 CLI hooks, the 5+13 MCP tools, `SAVE_PATTERNS`, `isLikelyRealCorrection` v4, `projectBoard()`, `bootstrapScan/Import`), adds **zero new storage tier and zero new capture gate**, makes the agent the lifecycle driver where hooks cannot reach, and — above all — keeps the cross-surface contract **brutally honest**: no fake "AUTO" badge on a host that physically cannot auto-fire.

---

## 2. Per-surface capability matrix (brutally honest)

Legend — every cell is **two-part** where automation is partial (per *honesty* verdict required_fix c):
- **detection** = does infrastructure *notice* the trigger without the agent choosing?
- **persistence** = does the save/recall *actually land* without the agent choosing?
- `AUTO` = fires without the agent deciding · `AGENT` = agent must invoke (description/instructions-driven) · `MANUAL/HUMAN` = only a human prompt drives it · `N/A` = mechanism absent on this host.

| Capability | Claude Code (Tier A) | OpenClaw (Tier B*) | Codex (Tier B) | chatbox (Tier B, most degraded) |
|---|---|---|---|---|
| **recall-at-start** | AUTO (`hook-start`, settings.json:35) | AGENT (`session_start`, driven by MCP `instructions`) | AGENT | AGENT |
| **save-on-trigger — human says "save"** | detection **AUTO** (`hook-save` tests `SAVE_PATTERNS`) / persistence **AGENT-DISCRETION** (hook-save only PRINTS a nudge, `cli/index.ts:1480-1482`; the model must then call `session_end`) | persistence **AGENT** (no hook sees the human msg) | AGENT | AGENT |
| **save-on-trigger — agent says "I saved this"** | detection **SEMI-AUTO** (Stop-time transcript scan, *new* — see §3) / persistence **AUTO** on match | detection **N/A** / persistence **AGENT** (description self-fire) | N/A / AGENT | N/A / AGENT |
| **passive-capture (corrections)** | AUTO, **GATED** by `isLikelyRealCorrection` v4 (`hook-correction`+`hook-ambient`) | **N/A** (no hook) | N/A | N/A |
| **save-at-stop (lossless raw backstop)** | AUTO — **best-effort**; depends on the *unverified* Stop-hook `transcript_path` contract; silently no-ops on payload drift (§7, OQ-4) | **NONE** — no `hook-end` → **DATA-LOSS RISK** (§risks) | NONE — DATA-LOSS RISK | NONE — DATA-LOSS RISK |
| **status board** | pull: `ar status` / `/arstatus` / `project_board` (**--full only**) | `project_board(format:'text')` **only if --full** | same | often **UNREACHABLE** (board + `brief` are both --full; default surface is 5 tools) |

**\* OpenClaw/Hermes tier is unverified per-host.** Classified Tier A *only* when `AR_HOST` is set **AND** a one-time read-only settings.json check confirms `hook-start`/`hook-end` lines are present (per *honesty* required_fix b). Otherwise it conservatively degrades to Tier B — **under-promise beats silent data loss.**

**One honest line:** AUTO capture is a Tier-A privilege; Tier B is **best-effort self-driven** (not "self-driven" — per *honesty* required_fix d). The adapter equalizes the *outcome contract* (same stores, same gate, same board) not the *mechanism*.

---

## 3. Trigger / save model — who detects each, per surface

Two message streams; **who can see each differs per surface** — this is the honest crux.

### Human-message stream
- **Tier A:** visible via `UserPromptSubmit`. `hook-save`/`hook-correction`/`hook-ambient` read it from stdin. On a `SAVE_PATTERNS` match, `hook-save` writes a stdout **nudge** — it does **not** call `session_end` (verified `cli/index.ts:1480-1482`). Detection AUTO, persistence agent-discretion.
- **Tier B:** **no hook sees the human message.** The agent is the only reader. "Human said save" lands only if the agent notices and calls `session_end` — driven by the MCP server-level `instructions` field (§5) and the tool descriptions.

### Agent-message stream (the named #1 gap — now partly closed on Tier A)
The synthesized design claimed agent output is "unobservable by construction." **That is wrong for Tier A** (per *trigger* required_fix). The `Stop` hook already receives `transcript_path` to the full turn transcript, and `hook-correction` already parses `m.role==='assistant'` entries (`cli/index.ts:1009,1075`). The agent's prose **is** infrastructurally readable on Tier A — not at emission time, but at the turn boundary.

- **Tier A — REAL mechanism (new):** extend the existing `Stop` hook (`hook-end`, which already holds `transcript_path`) to scan the final assistant message(s) for `DURABLE_INTENT_PATTERNS` via `saveTriggerKind()`. On an `explicit-save` match, auto-route through the lossless session-end/archive path `hook-end` already owns. → **agent trigger: SEMI-AUTO via Stop-time transcript scan.** This must ship with a fixture/eval measuring compliance + false-positive rate before it is claimed reliable.
- **Tier B — honest fallback only:** no Stop event exists, so closure is description/`instructions`-driven self-fire: *"If you state you will remember something or have saved it, you MUST call `session_end` now — saying it does not save it."* Marked **AGENT/MANUAL**, because it honestly is.

> There is genuinely **no synchronous `AssistantMessage` event** on any host (`settings.json` wires only `UserPromptSubmit`+`Stop`). `PostToolUse` (`settings.json:88-138`) is the one agent-observable event already in use; we do **not** build on it for triggers (signal is tool-shaped, not prose-shaped) but we explicitly acknowledge it rather than claiming "no agent-observable infrastructure exists."

### Unified vocabulary & mutual exclusion
- `DURABLE_INTENT_PATTERNS` (extracted `SAVE_PATTERNS`, EN+CJK verbatim from `cli/index.ts:1446-1458`) is the single source. EXPLICIT lane keys off these in either stream; PASSIVE lane keys off `CORRECTION_PATTERNS`+`BEHAVIORAL_SIGNALS` through the v4 gate.
- **Double-save race:** `hook-save` and `hook-correction` both read `UserPromptSubmit`. `saveTriggerKind(text) → 'explicit-save'|'correction-signal'|'none'` classifies **once**: `correction-signal` → defer to correction lane; `explicit-save` → save lane. **Caveat (verified):** `hook-correction`'s on-disk marker `.hook-correction-seen` (`cli/index.ts:942`) only writes when `isCorrection && isBehavioral` — a plain "save this" never enters it, so it cannot dedup a save-nudge today. Introducing `saveTriggerKind()` as the shared arbiter is therefore **net-new cross-process coordination** (the hooks are separate processes → the dedup marker MUST be on-disk), not the "refactor only" originally claimed. Scoped explicitly in the build plan (§11, P1).

**Bottom line on the hard constraint:** on hook-less hosts no stream is observed by infrastructure at session end, so session-end **cannot** truly auto-fire. The adapter makes the agent the observer-of-last-resort via `instructions`+descriptions; it never claims the harness does it.

---

## 4. Two-lane save policy — explicit (liberal) vs passive (gated)

"Save generously" and the Loops-7/8/14 gate are reconciled by splitting on **intent-certainty**, not content. **The over-save verdict (BLOCKER) forced a re-scope of Lane 1** — see the boxed fix.

### Lane 1 — EXPLICIT-TRIGGER (liberal, correction-gate bypassed)
A human or agent uses a `DURABLE_INTENT_PATTERN` or calls `session_end` directly. Intent is unambiguous, so `isLikelyRealCorrection` is **not** run (re-judging explicit intent with a gate tuned to drop hedged filler would reject legitimate saves). A false positive costs one cheap entry, reclaimed by existing hygiene (§8).

> **BLOCKER FIX (over-save verdict required_fix 1–4) — Lane 1 re-scoped:**
> 1. **Lane 1 writes ONLY the local-only raw archive tier** (`archive-write.ts`, sync-free by invariant, `archive-write.ts:7`). It **MUST NOT** call `journalWrite` — because `journalWrite` unconditionally calls `syncToSupabase(...,'journal')` (`journal-write.ts:140`) which uploads `parsed.body` verbatim **and** computes a remote embedding (`sync.ts:161,177`), with **no scrub and no secret filter** on the live path. Liberal saving must not multiply cloud egress.
> 2. **Before ANY content reaches `journalWrite`/`syncToSupabase` on EITHER lane**, route it through `scrubPromptInjection` **and a content-level secret scan** (the current `isSecretFile` is filename-only and the live save path skips even that). This closes the live-path cloud-exfiltration hole that liberal saving multiplies. *(This is the one privacy item that may exceed adapter scope — see OQ-1.)*
> 3. **Extract the four HARD noise gates** (`len<12`, `<`-prefix, bare-number, bare-file-path; welded inside `isLikelyRealCorrection` at `corrections.ts:316-330`) into one exported `dropHardNoise()` and apply it on Lane 1. The "still drops garbage" guard must rest on real code, not an assumed primitive. **This is the single allowed net-new gate-adjacent extraction** (documented exception to "ZERO new gate").
> 4. Keep loose `DURABLE_INTENT_PATTERNS` (esp. `/remember (this|that|what we did)/`) **out of any cloud-writing path** until `saveTriggerKind()` has a concrete, fixture-tested rule that demotes hedged / task-reminder phrasing — otherwise the Loop-14 false-accept ships to Supabase.

### Lane 2 — PASSIVE-CAPTURE (gated, precision floor)
No one asked; durability is *inferred* from ambient text. `isLikelyRealCorrection` v4 (`corrections.ts:309-383`, STRONG/WEAK_IMPERATIVE + PREFERENCE + HEDGE_FRAME — the Loop 8 / Loop 14 hardening) **gates it, untouched**. The adapter routes inferred captures *through* it. Liberal here re-opens closed holes.

### Pivot rule (one branch at the top of the capture path)
```
text = incoming_message
IF NOT dropHardNoise(text):            // shared hard floor, BOTH lanes
  DISCARD
ELIF saveTriggerKind(text) == 'explicit-save':
  LANE 1 → raw-archive only (local, sync-free); journal/Supabase ONLY after scrub+secret-scan
ELSE:
  LANE 2 → isLikelyRealCorrection(v4) decides   // gate untouched
```

### How the lanes stay separate
`saveTriggerKind()` is the single arbiter, evaluated once. Lane 1 never touches the correction store or `isLikelyRealCorrection`; Lane 2 never bypasses it. Lane 1's destination (raw-only) is physically distinct from Lane 2's (correction/awareness). The journal/Supabase tier is reachable from neither lane without passing scrub + secret-scan first.

---

## 5. MCP tool-description + brief design — the agent-first self-driving lifecycle

The operator's favorite idea. **The MCP-reliability verdict forced the primary carrier to move** off per-tool descriptions onto the server-level `instructions` field.

> **CONCERN FIX (MCP-reliability required_fix) — `instructions` is the primary carrier:**
> The MCP SDK exposes a server-level `instructions` field (`@modelcontextprotocol/sdk/.../server/index.d.ts:12-15`) returned in the `initialize` result, which clients inject **once as standing system context at connect time** — exactly where a cold agent reads orientation. AgentRecall's `server.ts:4-8` leaves it **UNSET**. Per-tool descriptions are read only at tool-*selection* time, i.e. only when the agent is already deciding to call the tool — too late to prompt a call it never considered. So:
> - **Set `instructions` in `packages/mcp-server/src/server.ts`** as the primary Tier-B lifecycle carrier: the 3-rule lifecycle + trigger vocab + the host-honest "this host cannot auto-save — YOU must call `session_end`" line.
> - Keep **terse timing tags** in the 5 default descriptions as reinforcement (they are the *only* carrier on chatbox where `brief`/`--full` may be absent).

### `instructions` text (≤ ~120 tokens, standing context)
```
AgentRecall lifecycle (this host has NO auto-hooks — you drive it):
1. ENTRY: call session_start once before working.
2. ON DURABLE INTENT: if you OR the user says "save / remember / checkpoint /
   记住 / 记下", call session_end now — stating it does not save it.
3. EXIT: call session_end before the session ends.
Triggers: save, checkpoint, retain, remember this, don't forget, 记住这个.
```

### Enriched description wording (lead with a timing tag)
| Tool | File:line | New lead |
|---|---|---|
| `session_start` | `session-start.ts:182` | `[ENTRY POINT — call first, before recalling] Use when starting/resuming a project…` |
| `session_end` | `session-end.ts:39` | `[EXIT + ON-TRIGGER — call at session end AND whenever you or the user signals durable intent; if you say you saved something, you MUST call this now] Use when…` |
| `remember` | `remember.ts:8` | `[ON-DEMAND — call the moment a specific decision must persist] Use when…` |
| `recall` | `recall.ts:25` | `[CONTINUOUS — call before acting when prior context may exist] Use when…` |
| `check` | `check.ts:8` | `[CONTINUOUS — call to verify alignment before/while acting] Use when…` |

### `brief` tool (new, read-only, deterministic, **--full only**)
`brief(project?)` → ≤200 tokens, modeled on `check_action` + `sessionStartLite` (no LLM): identity line, active phase, top corrections/`watch_for`, the 3-rule lifecycle, the trigger vocab, and a tier-conditional "no hooks on this host — YOU must call session_end" line. **Not** in the default 5-tool surface (Automaticity Law). `session_start`'s return adds one pointer line: *"Hook-less host? call `brief()` once for lifecycle rules."*

### ToolAnnotations (zero-config, SDK-native; shipped 2026-11, see `packages/mcp-server/src/tools/annotations.ts`, which supersedes the note below)
`readOnlyHint` on `brief` only (as-built: `recall` writes feedback-log, `check` writes decision-trail — neither is read-only). `idempotentHint` on `session_start` was removed (recordPolicyLoad increments `rule.hits` on every call — not idempotent). *(Caveat: clients that don't expose hints ignore them — reinforcement, not load-bearing.)*

### Falsifiability (MCP-reliability required_fix)
The reliability claim is **not load-bearing until measured.** Ship a per-host call-rate eval (Codex, chatbox, Cursor) for the three lifecycle moments (`session_start` at entry, `session_end` at exit, self-fire on durable-intent), with a stated pass threshold mirroring the Loops 7/8/14 eval discipline. **If a host falls below threshold, its row in `HOST-TIERS.md` downgrades from "AGENT/self-driven" to "HUMAN-prompted only"** (matching the already-shipped `meta/integrations/codex.md` model, which is human-triggered today). Contract reflects measured behavior, not aspiration.

---

## 6. Surface-agnostic status board

Rendering logic is trapped in 800-line Python (`.claude/scripts/ar-sync-status.py`); `projectBoard()` (`packages/core/src/tools-logic/project-board.ts:82`) already returns structured JSON. **Port only the renderer.**

- **`core` renderer** — port **only** `render_board()`+`classify_status()`+CJK display-width+ICON map+dream banner into core. Input = `ProjectBoardResult` (+optional dream status). Output = string. **PURE — no Supabase side effect** (split the DB upsert out of the renderer; semantic cache + recommendations stay in the optional Python layer). Re-exported from the core barrel. Ship a width-math fixture test (CJK alignment is the port's main risk).
  - **Naming (per *naming* required_fix):** file is **`packages/core/src/display/board-render.ts` exporting `renderBoard()`** — satisfies `<domain>-<verb>.ts` with the file verb echoing the export verb. **NOT** `board-formatter.ts↔renderBoard()` (mismatched, zero precedent). *(Alt accepted: `board-builder.ts↔buildBoard()` to match the `-builder↔build` pair.)*
- **CLI `ar status`** — thin wrapper: `core.projectBoard()` → `core.renderBoard()`; `--json` passes raw through. (`ar projects` bare list stays as-is.)
- **MCP `project_board` `format` param** — add `format:'json'|'text'` to the **existing** `project_board` tool (do **not** add a second tool); text path calls `renderBoard()`. **Verified caveat:** `project_board` is `--full`-only (`index.ts:209`), so the rendered board is reachable on Tier B **only when `--full` is enabled** — stated in the matrix (§2).
- **Web dashboard** — JSON path for structured view, `renderBoard()` for text fallback.

---

## 7. Transfer / bootstrap failsafe — empty-store nudge

Build on the existing two-step bootstrap (`core/bootstrap.ts:1-921`, `cli/index.ts:1911-2068`, MCP `bootstrap_scan`/`bootstrap_import`) — do not rebuild. The adapter adds exactly one thing: an **empty-store nudge that auto-OFFERS (never auto-mutates)**.

1. **Empty-store detection** at the two first-touch entry points every surface hits — `session_start` (MCP) and `ar status` (CLI). When `getRoot()/projects` is empty, return a FIRST-RUN payload instead of "no memory".
2. **Payload** is produced by the existing read-only `bootstrapScan()` scoped to the **current project folder first** (cwd: git remote, README, package.json, CLAUDE.md) + `DEFAULT_SCAN_DIRS` — so a cold start in `/Users/x/myapp` surfaces `myapp` as top candidate (closes "no auto-detection of which project to start with").
3. **One-call import for Tier B** — the payload + `brief` give the single instruction "call `bootstrap_import` with these results" (`bootstrap.ts:51`).
4. **Post-import board** — `ar bootstrap --import` ends by calling `renderBoard()` inline so the user SEES what imported (closes "bootstrap builds no board").

**No auto-import** — import is a state-creating mutation (REDLINE): the adapter NUDGES; a human (or agent under explicit instruction) runs it. Idempotent `already_in_ar` check makes the nudge safe to fire on every cold start.

> **BLOCKER FIX (bootstrap-security verdict required_fix 1–4) — these are CONDITIONS on shipping the failsafe, NOT inherited security, because the adapter raises call-volume on exactly these holes:**
> 1. **Re-validate the trust boundary on `bootstrap_import`.** Today `scan_result: z.union([z.string(), z.record(...)])` (`mcp-server/src/tools/bootstrap.ts:51`) is unconstrained agent-supplied input handed straight to `bootstrapImport()` — a prompt-injected agent can fabricate a `scan_result` whose `source_path` points at **any file**. Fix: tighten the inputSchema so `source_path` is not free-form; validate each `item.source_path` server-side against the allowlisted scan roots and reject anything not produced by the *same-session* scan (in-memory scan token/nonce). *(May exceed adapter scope — see OQ-2.)*
> 2. **Symlink escape of the home-jail.** The only read guard is `source_path.startsWith(home)` with no `realpath` (`bootstrap.ts:765,787,867`); `~/Projects/x/leak -> /etc/shadow` passes. Fix: replace the string check with `fs.realpathSync` resolution and re-assert the resolved real path is inside the allowed scan roots.
> 3. **`isSecretFile` is a sieve, not a filter** (basename-regex only, `bootstrap.ts:152-164`): blocks `.env` but imports `.env.local`, `.env.production`, `.npmrc`, `.netrc`, `.pgpass`, `~/.aws/config`, `~/.ssh/config`, `~/.docker/config.json`, `~/.config/gh/hosts.yml`, `kube/config`. Fix: add a content pre-scan (high-entropy + known token prefixes: `AKIA…`, `ghp_/gho_`, `sk-…`, `BEGIN PRIVATE KEY`, `_authToken=`) and expand the filename denylist; redact or skip on match.
> 4. **Consent on the new auto-scan.** Today bootstrap is 100% human-invoked; the nudge auto-fires `bootstrapScan()` on `session_start`/`ar status`. Fix: the nudge may **DESCRIBE** candidates but must **not READ file contents** until the user opts in; gate the content-reading scan behind explicit first-run consent.

Inherited (still true): `scrubPromptInjection` on imported content; write-side path traversal is genuinely closed (`sanitizeProject`+`assertInsideRoot`, `paths.ts:20,33`). The exposure is entirely **read-side**, which the synthesized design wrongly treated as already-secured.

---

## 8. Storage under over-saving — how generous saving stays clean

No new quota/cap/throttle/scheduler (infra-over-revenue, fights save-generously). Growth is bounded by the existing self-cleaning machinery:
- **Login-free `safety-consolidation`** (decay + prune + graduate) runs at every `session_end` (`safety-consolidation.ts:1-360`).
- **`retention.ts`** single-source window (env > config > default 90d), shared by prune and store-doctor → no drift.
- **`compress.ts`** near-duplicate collapse (keyword overlap ≥0.6; originals archived not deleted).
- **`awareness.addInsight`** merge (>0.6 auto-merge), `topInsights` max 20, `MAX_ARCHIVE` 50, awareness ceiling 200 lines.
- **`decay-pass.ts`** FSRS+salience (flags `archived:true`, never deletes), `archive-prune.ts` dual-guard (age + consumed marker) gzip-then-delete.

**Honest caveats carried (not hidden):**
- **(a)** On Tier B with no `hook-end`, `safety-consolidation` only runs when the agent calls `session_end`. Generous saving on a host where the agent forgets to close = unbounded growth until next close. Mitigation is the description/`instructions` nudge, **not** a limiter.
- **(b)** Lane 1 raises the stakes on the consolidation seam staying healthy — if `dreaming_stale` goes RED and stalls the consumed marker, raw grows unbounded. Remediation lives in `store-doctor`/`store-repair`, **outside adapter scope** (OQ-5).
- **(c)** *(from over-save verdict)* the local hygiene machinery operates on **local** tiers; Supabase journal rows are upserted by content-hash (`sync.ts:139`) with **no prune path** in grounding. Because Lane 1 is now **raw-only / local-only** (§4 fix), generous saving no longer points at the remote store — the unbounded-cloud-growth path is closed by the re-scope. Any *intentional* journal save still pays scrub+secret-scan but inherits the no-remote-prune caveat (OQ-3).

---

## 9. Explicit scope cuts — what we are NOT building

1. **No `AssistantMessage`/`AgentOutputSignal` synchronous hook** — no host exposes one. Tier A agent-trigger is closed via **Stop-time transcript scan** (real, §3); Tier B via description/`instructions` self-fire.
2. **No promise of auto-fire session-end on hook-less hosts** — physically impossible without a Stop event. Best-effort nudge, stated as such.
3. **No weakening of `isLikelyRealCorrection` v4** — Loops 7/8/14 hardened it; passive lane routes *through* it untouched. "Save generously" is scoped to Lane 1 only.
4. **No second board MCP tool** — extend `project_board` with a `format` param.
5. **No `brief` in the default 5-tool surface** — `--full` only; discovered via a one-line pointer in `session_start`.
6. **No port of the full ~800-line `ar-sync-status.py`** — only `render_board()`+`classify_status()`; Supabase upsert + semantic cache stay in the optional Python layer.
7. **No rewrite of `ar bootstrap`** — only the empty-store nudge + post-import board render. No auto-import (mutation = REDLINE).
8. **No new storage quota / size-cap / save-throttle / background scheduler.**
9. **No runtime hook-probing from inside the MCP process** to classify tier — not observable, produces confident-wrong answers. Use an `AR_HOST` env table with a conservative Tier-B default. *(The one read-only exception: the settings.json "hooks present?" check in §2/§7 honesty fix — a file read, not a runtime probe.)*
10. **No fix for the Codex `mcp-unavailable` root cause** — host MCP-process reachability, orthogonal to the contract. Named as a known Tier-B risk only.
11. **No rejected over-engineering:** NO typed 9-phase registry, NO `detectPipeline`, NO tool aliases. **Do NOT touch/alias `pipeline_*`** (project-narrative-phase domain, naming-P0).

---

## 10. Naming (zero collision, convention-matching)

| Artifact | Name | Rationale |
|---|---|---|
| The layer | **ADAPTER** | Never "pipeline" — `pipeline_*` is a live 11-file domain (`tools-logic/pipeline-*.ts`, `palace/pipeline.ts`, `mcp-server/.../pipeline-*.ts`, registered `index.ts:20-24`). Verified: **no collision, no aliasing**. |
| Shared trigger constant | `packages/core/src/storage/durable-intent.ts` exporting `DURABLE_INTENT_PATTERNS` + `saveTriggerKind()` | **Per *naming* required_fix: NOT a new `adapter/` dir.** Placed under `storage/` next to `corrections.ts`/`retention.ts` where this category already lives. Noun-file + verb-export is precedented. |
| Board renderer | `packages/core/src/display/board-render.ts` exporting `renderBoard()` | **Per *naming* required_fix:** `<domain>-<verb>.ts` with file verb echoing export verb. NOT `board-formatter.ts` (zero `*-formatter.ts` precedent). Alt: `board-builder.ts↔buildBoard()`. |
| Hard-noise extraction | `dropHardNoise()` exported from `corrections.ts` | Lives with the gate it was extracted from. |
| New MCP tool | `packages/mcp-server/src/tools/brief.ts` → tool name `brief` | **Note (per *naming* finding):** `'brief'` already exists as a *view enum value* inside `journal_read` (`journal-read.ts:26`) — NOT a registered tool name, so no collision. Flagged so a reviewer grepping `brief` isn't misled. |
| Tier doc | `docs/internal/HOST-TIERS.md` | The missing single source of truth. |

---

## 11. Phased build plan (smallest-valuable-first; operator uses OpenClaw + Codex → those are P0)

Each phase has a **build/test gate** and a **round-table verify gate**. Nothing merges without both.

### P0 — Tier-B lifecycle carrier (operator's daily hosts) — *highest value*
- Set MCP server-level `instructions` in `server.ts` (the primary Tier-B carrier).
- Enrich the 5 default tool descriptions with timing tags **+ sync the duplicated copies in `--list-tools` (`index.ts:139-143`) and `--help` (`index.ts:79-128`) in the SAME commit**, guarded by a build-time assert test that inline `registerTool` descriptions == `--list-tools` entries (prevents drift).
- Add `ToolAnnotations`.
- **Build/test gate:** unit + the drift-assert test green; `--list-tools`/`--help`/inline identical.
- **Verify gate:** per-host call-rate eval (Codex, chatbox, Cursor) for entry/exit/self-fire with a stated threshold. **If below threshold → downgrade that host's row in `HOST-TIERS.md` to "HUMAN-prompted only".**

### P1 — Unified trigger vocabulary + two-lane pivot (+ Lane-1 re-scope)
- Extract `DURABLE_INTENT_PATTERNS` + `saveTriggerKind()` into `storage/durable-intent.ts`; `hook-save` imports it.
- Extract `dropHardNoise()` from `corrections.ts`.
- Implement the pivot rule (§4) with **Lane 1 = raw-archive only** (no `journalWrite`).
- Implement the **on-disk** double-save dedup marker (cross-process; this is net-new coordination, scope it honestly).
- **Build/test gate:** fixture tests for `saveTriggerKind()` (must demote `/remember this/`-style hedged/task-reminder phrasing), `dropHardNoise()`, and double-save dedup across two processes.
- **Verify gate:** round-table confirms Lane 1 cannot reach `journalWrite`/Supabase; Loop-14 hedged-filler cases do **not** false-accept into any syncing tier.

### P2 — Surface-agnostic board
- Port `renderBoard()` into `display/board-render.ts` (pure, no Supabase); add `ar status` + `project_board` `format` param.
- **Build/test gate:** CJK width-math fixture test (alignment); `ar status` == Python board on shared fixtures.
- **Verify gate:** round-table on render fidelity + confirmed no DB side effect in the renderer.

### P3 — Tier-A agent-trigger (Stop-time transcript scan)
- Extend `hook-end` to scan final assistant message(s) for `DURABLE_INTENT_PATTERNS` via `saveTriggerKind()`; on `explicit-save`, auto-route the lossless archive path.
- **Build/test gate:** fixture/eval for Stop-time scan compliance **and false-positive rate**; assert the `Stop` payload `transcript_path` contract against a **captured live payload** (closes the unverified-contract caveat, OQ-4).
- **Verify gate:** round-table confirms no double-archive vs `hook-end`'s existing archive; FP rate within threshold.

### P4 — `brief` tool + empty-store transfer failsafe
- Add `brief` (`--full` only) + `session_start` pointer line.
- Empty-store nudge (describe-only until consent) + post-import `renderBoard()`.
- **Ship the §7 security conditions** (realpath jail, content secret-scan, `scan_result` re-validation, consent gate) **as part of this phase** — or block on OQ-1/OQ-2 if the human scopes them elsewhere.
- **Build/test gate:** security fixtures — symlink-escape rejected, fabricated `scan_result` rejected, secret-content files skipped/redacted, no file read before consent.
- **Verify gate:** security-reviewer round-table on the read-side trust boundary.

### P5 — `HOST-TIERS.md` + matrix
- Write the doc with the two-part badges, the caveat column, the `AR_HOST=A but hooks-absent` downgrade path, and the measured per-host lifecycle claims from P0/P3 evals.
- **Verify gate:** consistency-reviewer confirms matrix == measured behavior == code.

---

## 12. Open questions for the human (go/no-go decisions)

1. **OQ-1 (from over-save BLOCKER) — live-path scrub+secret-scan scope.** Fix #2 requires routing *all* content through `scrubPromptInjection` + a content secret-scan **before `journalWrite`/`syncToSupabase`**. That touches the live save path beyond the adapter seam (it currently has *no* scrub/secret filter). **Do we expand adapter scope to harden the live `journalWrite`→Supabase egress, or is this a separate security workstream that must land before the adapter ships?** The adapter cannot honestly enable "save generously" while this egress is open.
2. **OQ-2 (from bootstrap-security BLOCKER) — `bootstrap_import` trust boundary.** Re-validating `scan_result.source_path` server-side (nonce/allowlist) is a change to an *existing* MCP tool, not the adapter. **Approve hardening it as an adapter precondition, or block the empty-store nudge until a separate security task lands?** The nudge increases call-volume on this hole, so it cannot ship before the fix.
3. **OQ-3 — Supabase journal retention.** Remote journal rows have no prune path (`sync.ts:139`). Lane-1 re-scope removes the *generous-save* growth vector, but intentional journal saves still accumulate remotely forever. **Acceptable for now, or do we need a remote retention/prune job?**
4. **OQ-4 — Stop-hook contract verification.** The Tier-A "lossless backstop" and the P3 agent-trigger both depend on the **unverified** `Stop` payload `transcript_path` field name (flagged CRITICAL in `MEMORY-TO-UNDERSTANDING-PLAN`). **Can the operator capture one live Stop payload** so we can assert the field in a test before P3? Until then the backstop is "best-effort, silent no-op on drift."
5. **OQ-5 — consolidation-seam health on Tier B.** If `dreaming_stale` goes RED on a hook-less host, raw grows unbounded and remediation needs a human running `ar repair --apply`. **Is the description nudge + manual repair acceptable, or do we want a Tier-B-safe auto-drain trigger?** (Out of current adapter scope.)
6. **OQ-6 — eval thresholds.** §5/P0 require a stated pass threshold for per-host agent-call-rate before the lifecycle claim is load-bearing. **What call-rate (e.g. ≥80% on `session_end` at exit) is the bar for keeping a host's row as "AGENT/self-driven" vs downgrading to "HUMAN-prompted only"?**

---

### Residual risks the operator must see (not papered over)
- **Agent-trigger closure on Tier B is description/`instructions`-only** → probabilistic compliance; the single biggest residual gap on hook-less hosts. Mitigated (not eliminated) by `instructions` as standing context + terse default-description tags + the P0 eval gate.
- **Tier B has no session-end backstop** → a Codex/OpenClaw/chatbox agent that crashes mid-work loses the session. Only a host `Stop` event (absent) would fully fix it.
- **Board + `brief` unreachable on default Tier B** (`--full`-only) → on chatbox the 5 default descriptions + `instructions` are the *only* lifecycle carriers.
- **`ownedFiles` singleton** (`audit P0-5`) accumulates across `session_end` calls on long-running Tier-B MCP processes; generous saving raises call volume → contamination exposure. The adapter amplifies but does not fix it — **flag to fix alongside** or generous saving can corrupt journal file selection.
- **`DURABLE_INTENT_PATTERNS` is loose** (`/remember this/`, looser CJK) → centralizing makes it a single shared liability; safe only because Lane 1 is raw-only and the cloud path is gated behind the fixture-tested `saveTriggerKind()` demotion rule.
- **`SaveType` is a 6-member union** (`session.ts:35-41`); `'mcp-unavailable'` is a *theme*, not a saveType. Any new lane tag must be added carefully and checked through `journalFileName`+`autoClassifyTheme` so it doesn't fall through to a legacy default (audit P1-7: only 2/88 files use the current naming format — observability already diluted).
