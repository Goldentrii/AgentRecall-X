# v3.4.42 — Working Memory (minutes-level, crash-proof) — Design

Owner intent (2026-07-31, verbatim spirit): "like a human brain — you can forget, you can decay, but you need to know what happened 10 minutes before, 5 minutes before." The only missing tier after v3.4.41 is minutes-level durability: AR writes nothing until Stop fires, so crash/kill/compact vaporizes the live session, and concurrent windows are mutually blind.

## Mechanism (minimal: one new module, no new process, no settings.json change)

### Capture — piggyback on hook-ambient (fires on every UserPromptSubmit)
NEW `packages/core/src/storage/working-memory.ts`:
- `wmAppend(sid, {ts, prompt, cwd})` → append JSONL line to `<AR_ROOT>/working-memory/<sid>.jsonl`
  - prompt: boilerplate-excluded (reuse `isSystemText` from storage/extraction.ts), UTF-8-safe truncated ≤300 bytes (reuse shared helper)
  - never-throws (hook path); failure → `recordHookFailure("working-memory", err)`
  - per-file line cap 2000 (beyond: skip append — bound disk)
  - per-sid file ⇒ NO shared-file write race between windows (deliberate; do not add a shared ledger)
- `wmList()` → [{sid, mtime, lines}] · `wmRead(sid)` · `wmDelete(sid)` — root-aware via getRoot()
Call site: `packages/cli/src/index.ts` hook-ambient case, AFTER stdin parse, best-effort, must never delay/deny the ambient injection output.

### Consume
1. **Cross-window "live" line** (core `session-start.ts`, continuity assembly): WM files with mtime <6h AND sid ≠ current session → prepend ONE line to continuity: `🔴 live · <ago> · <slug-or-cwd-base> — <last prompt gist>` (max 1 line, newest only; omit when none). Current sid comes from hook-start stdin (verify field name in existing hook-start parse) — MCP session_start path: no sid available → skip self-exclusion gracefully (show newest non-stale WM regardless; document).
2. **Orphan rescue** (CLI hook-start, after render, best-effort try/catch): WM file with mtime >1h AND no `*--card--<sid>.md` in any project AND no recency entry for sid → distill mini-card from WM lines (title = first real prompt ≤120B; body = first/last prompts + line count + ts range; frontmatter `source: working-memory-rescue`, slug via cwd field majority from WM lines through the SAME resolution family as F1, fallback `auto`) → writeSessionCard + appendRecentSession + wmDelete. Idempotent (card-exists guard). This closes the kill -9 loop: a crashed session becomes a searchable card at the NEXT session start.
3. **Sleep consolidation** (CLI hook-end): after successful card write → wmDelete(own sid). WM is never archived — natural forgetting by design.
4. **resurrect**: add WM as freshest source (live sessions surface with `[working-memory · live]` provenance).

## Tests — fixture-class rules apply ([[fixture-class-coverage]], non-negotiable)
- CJK prompts (byte caps, no U+FFFD), deployment-default params, TWO sids appending concurrently (different files — assert no cross-talk), orphan-rescue idempotency (run twice → one card), line-cap boundary, boilerplate-only prompt → no line appended, unwritable root → hook output unaffected.
- e2e: temp root — simulate prompts → kill (no hook-end) → next hook-start rescues orphan into card + recency; continuity shows it.

## Ship (owner-approved: version 3.4.42, "do it to .42")
Bump 4 packages + core dep refs + types.ts VERSION + CHANGELOG (house style) → harness (true exit codes) → commit `chore(release): v3.4.42 — working memory (minutes-level crash-proof tier)` → push origin+org → publish core→sdk→mcp-server→cli → registry verify. Reports stay local (standing owner default).

## Constraints
No new deps. No settings.json changes. English code/comments. Per-prompt hot path: wmAppend must be O(1) append — no reads, no directory scans (line-cap via cheap stat size heuristic or first-write counter file is acceptable; document choice). Respect getRoot() everywhere.
