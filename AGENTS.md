# AgentRecall — Codex Agent Instructions

AgentRecall gives you persistent memory across sessions. The only thing the human ever does is describe intent — loading and saving memory is invisible runtime machinery that YOU, the agent, must drive without being asked.

**This host (Codex, Cursor, or any raw MCP client) has no lifecycle hooks.** Claude Code auto-fires memory at session start/stop via hooks; here there is no such hook. That means: if you don't call these tools yourself, nothing loads and nothing saves — silently. This is non-negotiable, not a nice-to-have:

1. **ENTRY — ALWAYS, every session, not just on trigger phrases.** The moment a session resumes prior work, call `session_start` FIRST, before acting on anything else. Do not wait for the user to say "load my context" — that phrase (see trigger table below) is an *additional* signal, not the only permitted trigger.
2. **EXIT — ALWAYS, before you stop.** Before ending a turn/session where you did meaningful work, call `session_end` with a real summary. Do not wait for the user to say "save this" — that phrase is an *additional* durable-intent trigger, not a gate you wait behind. Saying it is not saving it: only the tool call saves it.
3. **DURABLE INTENT — call immediately, don't defer.** The moment you or the user says save / remember / checkpoint / 记住 / 保存, call `session_end` (or `remember` for a single fact) right then, not at some later "natural" stopping point.
4. `recall` and `check` are safe to call freely, any time, with no gating at all.

---

## Tool surface (verified against `packages/mcp-server/src/index.ts` + `tool-surface-purity.test.mjs`)

AgentRecall's real MCP surface is **5 tools by default**, **6 with `--full`**, **13 with `AR_EXTRAS=1 --full`** — not the 10-tool list this file used to describe. That old list mixed in four project-board/status and bootstrap-scan/import tools that were deleted from the MCP surface on 2026-07-05 (zero organic MCP use); their logic lives on in the CLI only, see the CLI-equivalents table below.

### Default (5) — always registered, every session

| Tool | Purpose |
|------|---------|
| `session_start` | Load project context — corrections, insights, watch_for warnings. Call at ENTRY, always. |
| `session_end` | Save journal, insights, trajectory. Call at EXIT, always, and on any durable-intent trigger. |
| `remember` | Write a single fact/decision — auto-routes to the right store. Durable-intent trigger. |
| `recall` | Search all memory — keyword/RRF fusion + optional vector. Safe to call any time. |
| `check` | Record understanding; anticipates the likely correction before you make it. Pass `action_description` before a risky action (publish/deploy/delete/credential/external-send) for a matching + `blocked`/`advisory` verdict. Safe to call any time. |

### `--full` adds (1 more, 6 total)

| Tool | Purpose |
|------|---------|
| `check_action` | Pre-action safety matcher — warns on publish/push/deploy before you run them. |

### `AR_EXTRAS=1 --full` adds (7 more, 13 total) — quarantined, low-use

| Tool | Purpose |
|------|---------|
| `pipeline_open` | Open a new project narrative phase. |
| `pipeline_close` | Close active phase with reflection fields. |
| `pipeline_list` | List all narrative phases as JSON summaries. |
| `pipeline_current` | Return content of the currently active phase. |
| `pipeline_show` | Render project narrative spine — all phases. |
| `register_rule` | Save an IF-THEN behavior policy. |
| `digest` | Context cache — store/recall/read/invalidate pre-computed analysis. |

---

## Trigger Phrases → Actions

Trigger phrases below are **additional** signals for durable intent — they are not the only conditions under which you call these tools. `session_start` fires at session begin regardless of phrasing; `session_end` fires before you stop regardless of phrasing. The phrases below just make the *save/recall content* explicit when the user names it directly.

**Session begin (always, no trigger phrase required):**
> First action of every session that resumes prior work
→ Call `session_start(project="[slug or auto]")`
→ Show: project intention, last session summary, top insights, watch_for corrections

**Explicit load phrasing (reinforces the same call):**
> "load my context" / "what was I working on" / "load AgentRecall for [project]"
→ Call `session_start(project="[slug or auto]")`

**Session end / durable intent (always before stopping, no trigger phrase required):**
> Before ending any turn/session with meaningful work done
→ Call `session_end(summary="...", insights=[...], trajectory="...")`
→ Confirm: "Saved to ~/.agent-recall/projects/[slug]/journal/[date].md"

**Explicit save phrasing (reinforces the same call, call it NOW, don't defer):**
> "save this session" / "save to memory" / "wrap up" / "记住" / "保存"
→ Call `session_end(...)` immediately

**Recall specific knowledge (any time, no gating):**
> "recall [topic]" / "what do I know about [X]" / "any past notes on [X]"
→ Call `recall(query="[topic]")`
→ Show results inline

**Save a single fact (durable-intent trigger, call it NOW):**
> "remember this" / "save this decision" / "note: [X]"
→ Call `remember(content="[X]")`

**Checkpoint (mid-session, durable-intent trigger):**
> "checkpoint" / "quick save"
→ Call `session_end` with a lightweight summary: "Checkpoint: just completed X, next is Y"

---

## Token Cost Guide

| Action | Approx tokens | When |
|--------|--------------|------|
| `session_start` | ~800–1200 | Once per session — ENTRY, always |
| `recall` | ~200–400 | On demand |
| `remember` | ~100 | On demand |
| `session_end` | ~400–600 | Once at end — EXIT, always |
| `check` | ~150 | Before risky actions |

The only session where `session_start`/`session_end` may be reasonably skipped is a self-contained one-off that touches no prior context and produces nothing worth remembering — even then, `session_end` costs ~400-600 tokens against silently losing the work, so default to calling it.

---

## MCP Tool → CLI Equivalent

If you don't have MCP available, use the `ar` CLI instead:

| MCP Tool | CLI Command | Notes |
|----------|-------------|-------|
| `session_start` | `ar cold-start` | Loads context for current project |
| `remember` | `ar write "<content>"` | Freeform journal entry. `ar capture "<question>" "<answer>"` for Q&A format |
| `recall` | `ar recall "<query>"` | Search palace + journal. Alias: `ar insight "<query>"` |
| `session_end` | `ar saveall` | Batch-saves all today's sessions; or `ar write "<summary>"` for manual entry |
| `check` | *(no CLI equivalent)* | MCP only — correction tracking via hook-correction hook |

> Note: `ar remember` does not exist. Use `ar write` for freeform notes or `ar capture` for Q&A pairs.
>
> A handful of tools that existed on the MCP surface before 2026-07-05 (project/board-status and bootstrap-import helpers) were removed from MCP as part of a purity cleanup — zero organic MCP use — but their logic lives on behind `ar status` and `ar bootstrap` on the CLI. If you don't have MCP available at all, `ar status` and `ar bootstrap` are your board/status and note-import commands.

---

## Project Slugs

Projects live at `~/.agent-recall/projects/<slug>/`. Common slugs:
- Run `session_start(project="auto")` to let AgentRecall detect from context
- Or use the explicit slug: `session_start(project="novada-site")`

---

## Notes for the Agent

- Call `session_start` at the start of every session that resumes prior work, and call `session_end` before you stop — unprompted. Waiting for the user to say "load"/"save" defeats the point of persistent memory; those phrases are reinforcement, not the gate.
- For `session_end`, extract 1–3 non-obvious insights from the conversation — not "fixed a bug" but "API returns null on session expiry — always null-check"
- Palace is selective — only store decisions, patterns, goal hierarchy. Not full transcripts.
- This file's lifecycle doctrine must match `packages/mcp-server/src/server.ts`'s live MCP `instructions` (both derive conceptually from `packages/core/src/host-profile.ts`'s `lifecycleInstructions("B")`). See `packages/mcp-server/test/lifecycle-canonical-drift.test.mjs` — it fails the build if this file regresses toward gating session_start/session_end on the user asking first, or restates the stale 10-tool surface.
