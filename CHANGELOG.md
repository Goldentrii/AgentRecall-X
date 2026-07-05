# Changelog

All notable changes to AgentRecall are documented here.
Detailed engineering rationale for each change lives in [UPDATE-LOG.md](./UPDATE-LOG.md).
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [3.4.36] — 2026-07-05

### BREAKING

- **C3 heed-instrumentation semantic break (boundary: 2026-07-03).** The default `session_end` outcome for a retrieved correction with no positive trigger evidence has changed from `"heeded"` to `"unknown"`. A `"heeded"` verdict now requires at least one `"triggered"` outcome written by `check_action` during the same day. Pre-C3 `heeded` events where `evidence` contains `"default-heeded"` are instrument-generated artifacts, not evidence-grounded verdicts. The boundary date separates the two regimes in `rmr-report.mjs` output (`c3_semantic_boundary: "2026-07-03"`).

- **11 `--full` MCP tools deleted** (`skill_write`, `skill_recall`, `skill_list`, `dashboard_export`, `session_end_reflect`, `project_board`, `project_status`, `bootstrap_scan`, `bootstrap_import`, `memory_query`, `brief`). All had zero organic use across 2,649 transcripts (60-day corpus). CLI equivalents remain functional: `ar status`, `ar consolidate`, `ar bootstrap`, `ar recognition`. If any tool is required, use the CLI command or set `AR_EXTRAS=1` for the extras tier (13 tools).

- **`knowledge_write` routing redirect.** The `remember` MCP tool's `knowledgeWrite` routing path now redirects to the journal store. New content is no longer written to the `knowledge/` directory. Existing `knowledge/` files on disk are untouched.

### Added

- **C3: verdict taxonomy extended.** `CorrectionOutcome.kind` gains three new kinds: `"triggered"` (correction consulted via `check_action`), `"not_triggered"` (confirmed not relevant, dream-audit path only), `"unknown"` (no positive evidence — new default). Old readers that filter by `"retrieved" | "heeded" | "recurred"` are unaffected; new kinds are silently skipped.

- **C3: `check_action` records `"triggered"` outcomes.** Every correction matched by `checkAction()` gets a `"triggered"` event appended to `_outcomes.jsonl` (1/day dedup per correction). This is the authoritative trigger signal for session-end's `"heeded"` classification.

- **C3: verdict coverage metrics.** `getCorrectionKPIs()` and `rmr-report.mjs` now compute `verdict_coverage = (heeded + recurred + not_triggered) / injected` (canonical definition, consistent across both consumers). Also added: `triggered_count`, `unknown_count`, `not_triggered_count` to `CorrectionKPI`.

- **C3b: dream-audit verdict surface.** `ar outcomes audit-candidates` lists corrections whose verdict is still `"unknown"` for a given date. `ar outcomes record` writes a dream-audit verdict (`not_triggered | recurred | heeded`) with backdated `at` semantics. `"not_triggered"` is single-producer enforced at core level — `evidence` must start with `"dream-audit:"`.

- **C3b: `recorded_at` forensic anchor.** `recordOutcome()` now stamps `recorded_at: new Date().toISOString()` on every event unconditionally, diverging from the semantic `at` field when the dream backdates events. Pre-C3b jsonl lines lack `recorded_at`; old readers ignore unknown fields.

- **C2: injection diet.** Session-start correction payload reduced from ~2010 to 1489 median tokens. `SlimCorrection` shape strips KPI counter fields. Per-section char budgets enforced (`corrections_total` 1200 chars). P0 corrections unconditionally survive the cap (controlled overflow, not silent truncation). Context omitted when identical to rule or shorter by ≤20 chars.

- **L1: `MemoryBackend` write seam.** `MemoryBackend` interface (`retain()`, `available()`, `name()`) with `DisabledMemoryBackend` default (zero cloud egress until `AR_MEMORY_BACKEND` is set). `LocalArchiveMemoryBackend` reference implementation writes to `<root>/exports/local-archive/YYYY-MM-DD.json`. `ar corrections export --to-backend` opt-in flag. `SAFE_MODULE_RE` + `BUILTIN_DENYLIST` import-injection guards on `AR_MEMORY_BACKEND`.

- **L2: `ar scrub` CLI.** Reads stdin, writes scrubbed content to stdout. Exit codes: 0 clean/redacted, 1 (`--check` only) secrets found and scrubbable, 2 scrub-resistant residue (stdout empty on exit 2). Covers: AWS AKIA keys, GitHub `ghp_`/`ghs_`, OpenAI/Anthropic `sk-` keys, bidi override chars, prompt-injection tags. `Authorization: Bearer` headers are documented fail-open (tested with executable regression guard).

- **L2: corrections sync store.** `corrections` added to `syncToSupabase` store union behind double opt-in: `sync_personal === true` AND `sync_corrections === true` (via `AR_SYNC_CORRECTIONS=1`). Raw `CorrectionRecord` never reaches `doSync` directly — scrub upstream enforced via `exportCorrections()`.

- **P3a: `AR_EXTRAS=1` quarantine tier.** Third MCP surface tier for tools that are structurally sound but not default-path. 7 tools moved from `--full` to extras: `pipeline_open/close/list/current/show`, `register_rule`, `digest`. `tool-surface-purity.test.mjs` snapshot guard locks all 3 tiers: default 5 / `--full` 6 / `AR_EXTRAS` 13.

- **P2: harness-artifact early-exit.** `hook-ambient`, `hook-correction`, `hook-save` all exit 0 (silent) when stdin matches harness XML wrappers (`<task-notification>`, `<agent-message>`, `<system-reminder>`, `<parameter name="command">`, `<result>`, `<search_results>`, and 7 others). Fixed 18 of 23 noise cases found by census. `hook-correction` had no early-exit before this wave.

- **P2: `MAX_INJECT=2` cap and `BLIND_SPOT_DOMAIN_NOISE` 24-token filter.** Ambient hook injects at most 2 items per turn. Two noisy global blind-spot entries now require ≥24 distinctive domain tokens before firing (correction injection path unaffected).

- **Phase 0 artifacts.** `docs/research/agent-memory-landscape-2026-07.md` (market/literature scan) and `docs/proposals/2026-07-02-rmr-orchestration-plan.md` (RMR orchestration plan) committed as program of record.

- **M1 baseline artifacts.** `scripts/eval/rmr-report.mjs` (rerunnable) + `scripts/eval/baselines/rmr-baseline-2026-07-02.json` (frozen). Capture recall baseline: **35.3%** [17.3–58.7 bootstrap 95% CI], root cause: hook-no-fire (coverage bug, not classification bug). Pre-C3 heed rate: 96.9% — instrument-optimistic artifact.

- **D1-apply: measured-truth README.** Unfalsifiable marketing claims replaced with artifact-cited metrics table: capture recall 35.3% [CI], heed-rate N/A pending C3 data accumulation, verdict coverage 0/3 evidence-grounded, B2 bench gates green, 891 tests. `README.zh-CN.md` carries sync-pending note.

### Changed

- **C3: session-end heed loop redesigned.** The verdict determination order is now: (1) recurrence marker + trigger/topical evidence → `"recurred"`, (2) trigger evidence (check-action) + no recurrence → `"heeded"`, (3) topical overlap only or no evidence → `"unknown"`. The meta-content guard (`hasGenuineRecurrenceMarker`) applies sentence-level eval-vocabulary filtering to prevent AR's own measurement prose from producing false `"recurred"` verdicts.

- **`recordOutcome` early-return for ledger-only kinds.** `"triggered"`, `"not_triggered"`, `"unknown"` do not rewrite the denormalized `heeded_count`/`recurrence_count`/`precision` fields on the correction record. They are ledger events only, avoiding the lost-update race flagged in M1.

- **MCP surface reduced from 25 to 6 tools (default 5, `--full` 6).** After P3a quarantine and P3b deletions: default mode exposes `session_start`, `remember`, `recall`, `session_end`, `check`, `check_action` (in `--full`). `AR_EXTRAS=1` adds 7 more.

- **`knowledge_write` routing → journal.** `remember` MCP tool and `smart-remember.ts` no longer write to the `knowledge/` directory for new content. The routing path redirects to journal, closing the write-only graveyard identified by census. Existing `knowledge/` files on disk are preserved.

- **C0: npx +x hotfix.** `packages/mcp-server/package.json` build script changed to `tsc && chmod +x dist/server.js`. `tsc` does not preserve the execute bit; `npx agent-recall-mcp` silently failed since v3.4.21. Pack-test verified correct mode (0755 in tarball).

### Removed

- **11 `--full` MCP tool wrappers** (see BREAKING above): `skill_write`, `skill_recall`, `skill_list`, `dashboard_export`, `session_end_reflect`, `project_board`, `project_status`, `bootstrap_scan`, `bootstrap_import`, `memory_query`, `brief`.

- **4 orphaned tools-logic modules**: `packages/core/src/tools-logic/brief.ts`, `dashboard-export.ts`, `memory-query.ts`, `project-status.ts` — no CLI or SDK consumers remained after MCP wrapper deletion.

- **`arsave-quick` skill** (`~/.claude/commands/arsave-quick`): superseded by `arsave`; owner-approved.

- **Competitor comparison table, precision-KPI quote, stale benchmark link, 2 unanchored badges** from `README.md` (D1-apply). Unfalsifiable without measured data; owner-approved.

### Fixed

- **`outcomes-audit.test.mjs` TZ-naive date assertion.** Test was asserting `recorded_at` local-date against UTC `new Date().toISOString().slice(0,10)`. Replaced with `todayStr()` (local-timezone). Pinned-date regression guard added.

- **`heeded-guard.mjs` updated for C3 semantics.** The benchmark previously asserted `heeded_count=1` after two same-day `sessionEnd` calls with an unrelated summary — pre-C3 default-heeded behavior now deliberately eliminated. T1 now exercises (a) the evidence-grounded path via `checkAction` → `sessionEnd` → `heeded=1`, and (b) the dead-code guard: `sessionEnd` with no trigger → `heeded=0`, outcome `"unknown"` (old default-heeded stays dead). 1/day dedup guard still exercised (T1c).

- **`hook-end-p3-backstop.test.mjs` flaky test isolation.** Root cause: the hook-end lockFile at `os.homedir()/.agent-recall/.hook-end-lock` is a global path shared across test files and persists between runs. Two races: (1) `hook-end-archive.test.mjs` and this file run concurrently under `node --test` (separate worker threads), writing to the same lockFile; (2) `nextSid()` produces a deterministic UUID sequence — a stale lock from a prior run matching the current test's sid causes run1 to silently exit 0 before any archive is written. Fix: `runHookEnd()` now passes `HOME=ISOLATED_HOME` (a per-file `mkdtempSync` dir) to each child process, so `os.homedir()` resolves to the isolated dir inside the hook. The `(c)` test's explicit lockFile deletion updated to target `ISOLATED_HOME/.agent-recall/.hook-end-lock`. `before()` and `after()` hooks clean up `ISOLATED_HOME`.

---

*Detailed engineering log with rationale, reviewer findings, and verifier results: [UPDATE-LOG.md](./UPDATE-LOG.md)*
