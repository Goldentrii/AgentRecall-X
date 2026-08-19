# Continuity Wave — Design (2026-07-31)

Orchestrator: Fable 5. Workers: Sonnet. Target: next small version (number owner-gated; DO NOT bump any package.json version).
Repo: `~/Projects/AgentRecall` @ main, v3.4.40. Harness: `npm run build` / `npm test` / `npm run lint` (root, workspace-chained).

## Incident (why this wave exists)
A long work session was captured by hook-end but unretrievable next session. Full evidence:
- `reports/2026-07-31-continuity-fixture.md` (REQUIRED READING for all workers — contains raw-archive anatomy, session-card field feasibility table, the e2e fixture, CLI retrieval test results)
- Root causes, each mapped to a feature below.

## Verified facts (from 3 recon reports, spot-checked)
1. **Split-brain hook-end**: `packages/cli/src/index.ts:1069` raw-archive path uses `projectGuess`; `:1091` journal path ignores it → one session's data lands in two project dirs.
2. **Blind namer**: `packages/cli/src/utils/transcript-reader.ts:84-97` `PROJECT_RE` frequency count, no threshold, no boilerplate exclusion. Hook-injected startup text (folder-lint file lists, memory blocks) contaminates the count — proven: it misdirected our own forensics (false-lead sessions e577afbf/4c113109).
3. **Two unrelated namers exist**: hook-end regex guess vs `detectProject()` 7-level priority (`packages/core/src/storage/project.ts:78-157`). Also hook-end raw path only runs `sanitizeSlug()` (paths.ts:308), bypassing `isValidProjectSlug()` deny-list.
4. **Distillation gated on `ar capture`**: `index.ts:1084-1165` — no capture Q&A that day → session leaves ONLY raw + a queued consolidation job that is a no-op (handler `consolidateJournalToPalace` reads `journalDir()` only, never archive/raw; `.consumed.json` offset written but never consumed — archive-write.ts:121-125).
5. **raw is accidentally half-indexed**: `journal-search.ts:65` hardcodes `journalDirs(slug, true)` which includes `archive/raw/` → noisy line-grep of transcript dumps; Bridge verbatim fetch (`drill-down.ts:51-80`) collides raw files with journal files by `${date}--` prefix. Empirical: `ar search --include-palace` hits raw; `ar recall` does NOT surface it usefully.
6. **No recency at cold start**: `session-start.ts:457-488` only discrete today/yesterday buckets; `recallInsights` has zero recency term; the ONLY recency boost lives inside smartRecall hot-window (`smart-recall.ts:668-686`).
7. **Silent failure**: every hook catch is stderr-only (index.ts:932-935, 1079-1082, 1163-1165, 1184-1186); no persistent failure record. Only prior art: `logSyncError` (`packages/core/src/supabase/sync.ts:79-94`, append + 500-line roll).
8. **sync-errors 51/7d is test pollution**: `sync.ts:80` hardcodes `os.homedir()` ignoring HOME/AR_ROOT overrides → test suites' doSync failures write to the real user log (50/51 entries are `/var/folders/.../ar-*-test` fixtures).
9. **80K cap**: `transcript-reader.ts:193 RAW_TAIL_CAP = 80_000`. Fixture agent observed TAIL truncation (decisions/next-steps at end get lost). Worker MUST verify direction empirically with the fixture file; requirement below.
10. **e2e fixture**: real main dialogue = `~/.agent-recall/projects/novada-mcp/journal/archive/raw/2026-07-31--8a02c8b2-d37b-4681-8bf2-bcf0b6b9d37d.md` (novada-mcp page redesign, epic TOW2-357+children, artifacts incl. `~/交付物2_MCP原型_V14.html`, correct work-line name `novada-mcp-page`).

## Features

### F1 — One namer, claim-not-generate (Worker W1)
File: `packages/cli/src/utils/transcript-reader.ts` (+ its tests).
New export `resolveSessionProject(...) → {slug, confidence, candidates: Array<{slug, count}>}`:
- Signal 1: most frequent non-home `cwd` field across transcript entries; if under `~/Projects/<name>` → strong candidate.
- Signal 2: existing PROJECT_RE content scan, but EXCLUDE hook-injected boilerplate (entries/segments that are system-reminders, `hook success` startup blocks — fixture report documents transcript anatomy).
- Signal 3 (claim-not-generate): intersect candidates with existing slugs (`~/.agent-recall/projects/*` dirs, resolve via AR_ROOT env). Prefer an existing slug. Creating a BRAND-NEW slug requires: candidate count ≥3 in non-boilerplate content AND corresponding `~/Projects/<name>` exists on disk. Otherwise fall back to best existing slug match, else `"auto"`.
- confidence = top_count / total_candidate_counts (0 when auto).
Slug must pass core's `isValidProjectSlug` semantics (import or replicate check; no deny-list bypass).
NOTE: interactive claim-menu is OUT of this version's scope — instead confidence+candidates are recorded in the session card (F3) so misfiles are re-fileable later.

### F1b — RAW_TAIL_CAP tail-bias (Worker W1, same file)
Verify truncation direction with the 8a02c8b2 fixture. Requirement: the LAST ~60K chars must always be preserved (decisions/next-steps live at the end); head may be sampled (first ~20K). Keep total cap ~80K.

### F2 — Continuity Card, recency-first, cross-slug (Worker W2)
New: `packages/core/src/storage/recency-index.ts`:
- `appendRecentSession(entry)` → append JSONL to `<AR_ROOT>/recent-sessions.jsonl` {ts, sid, slug, slug_confidence, title, next_step?, artifact_count}; rolling truncate 500 lines (logSyncError pattern). Atomic-ish append is fine.
- `readRecentSessions(n)` → last n entries, newest first, cross-project by design.
Consume in `packages/core/src/tools-logic/session-start.ts`: add `continuity: Array<{ago, slug, title, next_step?}>` (top 3) to `SessionStartResult`; ALSO add to lite mode (`session-start-lite.ts`) as a single line. Render in `packages/mcp-server/src/tools/session-start.ts` formatTerse as a top "⏪ Continuity" section. CLI hook-start rendering is Wave-2 integrator's job — do NOT touch `packages/cli/src/index.ts`.
Empty-index behavior: omit section entirely (no noise).

### F3 — Session Card distillation, unconditional, mechanical (Worker W1)
New: `packages/core/src/storage/session-card.ts`. Pure-mechanical (NO LLM, hook path must be fast/offline):
`buildSessionCard(raw: {rawHead, rawTail, meta}) → {markdown, title, nextStep?, artifacts, linearRefs}`
- frontmatter: sid, date, slug, slug_confidence, slug_candidates, source: hook-end
- title: transcript summary entries if present, else first user prompt (trimmed ≤120 chars)
- artifacts: file paths from Write/Edit tool_use inputs (dedup)
- linearRefs: `/\b[A-Z][A-Z0-9]{1,5}-\d+\b/g` dedup (ERRATUM 2026-07-31: original `/[A-Z]{2,6}-\d+/g` cannot match real team keys containing digits, e.g. TOW2-357 — independently caught by W1 and W4)
- last exchange: final user prompt + final assistant text (tail)
- nextStep: best-effort — lines matching /next|下一步|待办|TODO/i from the final assistant text, cap 3
- decisions: lines matching /决定|decided|locked|confirmed/i, cap 5
Card ≤2KB. `writeSessionCard()` → `projects/<slug>/journal/<date>--card--<sid>.md` (a normal journal file: enters existing retrieval + consolidation pipelines for free). Acceptance: card built from the 8a02c8b2 fixture must contain TOW2-357 and the 交付物 artifact path.

### F4 — Explicit archive fallback source in recall (Worker W3)
`packages/core/src/tools-logic/smart-recall.ts` + `drill-down.ts`:
- Remove raw/ from journalSearch's implicit scan (make the includeArchive flag NOT descend into `archive/raw/`; rollup `archive/*.md` behavior unchanged) — kill the accidental noisy path.
- Add explicit 4th source "archive": triggered ONLY when the fused top-confidence of palace/journal/insight < CONFIDENCE_FLOOR.medium (mirror Bridge gate at smart-recall.ts:864-876). Scans `archive/raw/*.md` line-grep, returns excerpts labeled `[raw-archive · low-confidence]` with provenance path.
- `drill-down.ts`: new `VerbatimKey kind:"archive"` branch so raw files stop colliding with journal `${date}--` prefix matching.
Acceptance: query for fixture content (e.g. "交付物2 MCP原型") with sparse journal → archive source surfaces 8a02c8b2 with label.

### F5 — Fail-loud hook health (Worker W4)
New: `packages/core/src/storage/hook-health.ts` (logSyncError pattern):
- `recordHookFailure(hook: string, err: unknown)` → append `<AR_ROOT>/hook-health.jsonl` (roll 500) + rewrite `<AR_ROOT>/hook-health.json` {last_failure:{ts,hook,message}, failures_24h}.
- `readHookHealth()` → parsed state for renderers.
Root-fix test pollution: `packages/core/src/supabase/sync.ts:79-80` — resolve log path via the same AR_ROOT/HOME resolution the store uses (respect env overrides) so test-suite doSync failures stop polluting the real user log.
CLI catch-block wiring + `ar health` + ⚠️ top-line are Wave-2 integrator's job — do NOT touch `packages/cli/src/index.ts`.

### F6 — `ar resurrect` core (Worker W4)
New: `packages/core/src/tools-logic/resurrect.ts` — encode the incident-recovery forensics as a function:
`resurrect({query?, days=14}) → ContinuityBrief[]`
- Sources: recent-sessions.jsonl (if present) + ALL projects' `journal/archive/raw/*.md` (filename date within window) + `journal/*--card--*.md`.
- Rank: recency × keyword match (query terms against card/title/linearRefs first, raw line-grep second). No query → pure recency.
- Brief: {slug, sid, date, title, goal_excerpt, artifacts, linearRefs, nextSteps, provenance paths}. Markdown renderer included.
- Read-only over the store. CLI command wiring = Wave-2.
Acceptance (against the REAL store, read-only): query "MCP原型 页面设计" or "TOW2-357" must return the 8a02c8b2 session ranked #1 with TOW2-357 + artifact path in the brief.

## Build plan
- **Wave 1 (NOW, 4 parallel Sonnet workers)**: W1(F1+F1b+F3) · W2(F2) · W3(F4) · W4(F5+F6). File ownership strictly disjoint (see feature sections). NOBODY touches `packages/cli/src/index.ts`.
  - Barrel rule: if exporting from `packages/core/src/index.ts`, append your export lines at the very END of the file only.
  - Tests mandatory per module, following existing repo test conventions (look at sibling `*.test.mjs`/test dirs first). Run the repo harness: `npm run lint && npm run build && npm test` at repo root before reporting done.
  - Worker Done-Definition (all 4): trace ≥1 error path; no global binaries; ternary ordering; date-vs-today logic.
- **Wave 2 (single integrator)**: wire everything into `packages/cli/src/index.ts` hook-end (unified slug via F1, unconditional F3 card, F2 recency append, F5 catch wiring) + hook-start (⏪ continuity render, ⚠️ health line at `index.ts:846` position) + new `ar health`, `ar resurrect` commands.
- **Wave 3**: parallel code-reviewers (never the author) + one fix worker.
- **Wave 4**: independent verifier — repo harness green + e2e: temp AR_ROOT hook-end→hook-start round-trip using fixture; real-store read-only `ar resurrect` acceptance. Verification via CLI/filesystem, NEVER via the AR MCP client (self-review ban).

## Hard constraints (every worker)
- English code/comments/commits. Match surrounding idiom. No new deps without orchestrator approval. No version bumps. No push. No file deletions outside your ownership. Respect AR_ROOT env in ALL new file paths (testability). Report = file paths + test results, not prose promises.
