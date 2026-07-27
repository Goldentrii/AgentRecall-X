# Changelog

All notable changes to AgentRecall are documented here.
Detailed engineering rationale for each change lives in [UPDATE-LOG.md](./UPDATE-LOG.md).
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [3.4.40] — 2026-07-27

Patch release: the naming-at-scale wave — slug/theme quality, hot-path performance, store self-description, and the hygiene "trash scan".

### Fixed

- **Theme/sig classifier over-matching**: `autoClassifyTheme`/`autoClassifySig` matched vocabulary, not conditions — `\bmcp\b` treated the hyphen in "novada-mcp" as a word boundary, so any summary mentioning that project name classified as `mcp-unavailable` (measured: 29/32 = 90.6% of one project's journal filenames). Classifiers now require co-occurring condition signals in the same clause; misclassification drops to 1/31 with the survivor genuine. Two shadow epidemics (`version-bump`, `agent-fix`) that would have surfaced behind the first fix are fixed in the same pass. Enums unchanged — old filenames parse forever.
- **`alignment` KPI staleness**: the session_start scan-dedup initially threaded a pre-write snapshot into `getCorrectionKPIs`, making `alignment` null exactly when a never-retrieved P0 was first surfaced. The KPI call site reads fresh after this call's own retrieved-outcome writes (caught by independent integration review, pinned as a regression test).

### Added

- **`ar hygiene` — the trash scan**: 8 detection-only store checks (junk/test project dirs, ambient-counter accumulation, theme epidemics, case-fold fork dirs, stale derived caches, root-level credential patterns, missing `corrections/_index.md`, reserved-word slugs) with a baseline so repeat runs report only NEW findings. Detection-only by contract: it never deletes, renames, or quarantines; every finding carries an `agent_instruction`; secret findings report pattern name + line number, never the matched text. Fresh RED findings → exit 1 (cron-friendly). Not part of the MCP tool surface.
- **Store-root `MANIFEST.md`** (write-once, generated beside the per-project `MEMORY-PROTOCOL.md`): makes a bare store directory self-describing for any agent with filesystem access — cold-agent read order, sync / never-sync / regenerable file classification (`config.json` explicitly marked never-sync, do-not-read), and a condensed naming-grammar cheat-sheet. All paths store-root-relative; the `MEMORY-PROTOCOL.md` template's hardcoded `~` path is now root-relative too.

### Performance

- **session_start corrections scans: 4 → 2.** One shared snapshot feeds P0 surfacing, prediction, and recognition; the KPI computation deliberately re-reads after this call's own outcome writes (see Fixed). At the measured 50k-file extreme this cuts ~2s from every session_start.
- **Legacy journal index (`index.md`/`index.jsonl`) is incremental**: only files with mtime newer than the index are re-read; unchanged rows merge from the previous `index.jsonl` by filename. It previously re-read every journal body TWICE per `journal_write`/rollup/merge/archive (2.8s at 50k files; now pays only for what changed). Kept rather than removed because a live MCP resource (`agent-recall://{project}/index`) reads it verbatim.

## [3.4.39] — 2026-07-27

Patch release: the 2026-07-25 Codex audit fixes (Release Trains A–D, all 8 findings reproduced-then-fixed) plus ambient-recall groundwork.

### Fixed

- **Silent correction loss on slug collision** (found by a performance round-table during this release, reproduced before fixing): two distinct same-day corrections whose rules sanitize to the same slug were written to the same file — the second silently overwrote the first while both callers saw `written: true`. Pure-CJK rules made this the common case (every Chinese-only rule collapsed to the bare `unnamed` fallback). Two-layer fix: `sanitizeName`'s degenerate fallback is now `unnamed-<hash8>` (content-hashed, deterministic), and brand-new correction writes disambiguate an occupied filename with an id-hash suffix inside the slug field (the `--` delimiter grammar is preserved). Same-rule merging is unchanged. This also stops distinct pure-CJK **project names** from collapsing into one shared `unnamed` store directory. **Migration note:** a store that already has a bare `unnamed/` project directory (only possible if a pre-3.4.39 session ran with a fully-degenerate project name) will see new sessions write to the correctly-hashed directory instead — the old commingled directory stays readable on disk but no longer accumulates writes. That directory was already a defect (every degenerate project name shared it); resuming writes into it would preserve the bug.
- **Concurrency**: `recordOutcome` / `retractCorrection` / merge-consolidation read-modify-write cycles now run inside the per-project file lock — concurrent sessions can no longer drop outcome-ledger rows or regenerate a stale index (TOW2-321).
- **Retrieval fusion**: `smart_recall` cross-source fusion accumulates RRF scores on a canonical excerpt identity instead of object identity — the same fact found by 2–3 searchers now ranks above single-source hits, with `alsoFoundIn` provenance and true pre-fusion `total_searched` counts. Insight items carry a real fusion identity (title + excerpt), not severity + tags (TOW2-330, TOW2-331).
- **CJK matching**: the check-action tokenizer is CJK-aware — Han runs segment via `Intl.Segmenter` with bigram fallback, and the token length floor is script-scoped — so Chinese P0 rules now match Chinese action descriptions (TOW2-325). Chinese absolute-prohibition markers (禁止 / 不得 / 不能 / 不要, with idiom guards for 不得不 / 不能不 and benign 不要-completions) join the durable-rule behavioral gate (TOW2-326).

### Added

- **Outcomes ledger rebuild**: `ar outcomes rebuild --project <slug> [--apply] [--json]` + a store-doctor divergence check — counters are recomputable from the append-only ledger; malformed rows are quarantined, dry-run is the default, apply runs inside the same lock as normal writes (TOW2-322).
- **SDK modern composite API**: `sessionStart` / `remember` / `recall` / `sessionEnd` / `check` on the `AgentRecall` class — 1:1 with the MCP tools of the same names, additive alongside the existing low-level API (TOW2-323).
- **3-tier host profiles**: hooks (Tier A, Claude Code) / mcp-instructions (Tier B, Codex, Cursor, raw MCP) / manual (Tier C, SDK + CLI), with `AR_HOST` override; `lifecycleInstructions(tier)` is the one canonical source both MCP server instructions and skill docs render from (TOW2-327).
- **Idempotent lifecycle + local telemetry**: `session_start` claims are once-per-session-per-project, `session_end` dedupes by content fingerprint, and an append-only JSONL telemetry ledger (`lifecycleStats()`) records event counts by host tier — local-only, never leaves the machine (TOW2-328).
- **Pre-action P0 blocking in `check`**: pass `action_description` and the default `check` tool consults active P0 corrections before the action runs — no extra tool call on the 5-tool surface (TOW2-329).
- **Ambient topic profile (CLI)**: a rolling 8-turn topic state with distance decay powers ambient-recall precision tiers, so background conversation informs what gets recalled (TOW2-340).

### CI

- Full test suite + typecheck wired into `ci.yml` (SHA-pinned actions, failure-log artifact). The 2 tracked known gaps (SDK root isolation TOW2-324; standalone-prohibition capture design TOW2-326) are `todo`-marked, so a red CI now means new breakage only (TOW2-318).

### Security

- 10/12 `npm audit` findings resolved via transitive bumps (TOW2-320). The remaining 2 are the documented Hono / MCP-SDK pair whose fix requires a transport-removing SDK downgrade — tracked, not silently accepted.

## [3.4.38] — 2026-07-20

### Added

- **Naming System v2** (spec: `docs/proposals/2026-07-20-naming-v2-spec.md`, designed by a 5-seat round table). Two-audience ruling: the filename is the human/triage index (immutable-at-birth fields only); a materialized per-store `_index.md` is the machine fast-path (mutable state lives there, never in the path).
- **Shared sanitizer** `sanitizeName()`: lowercase + Unicode NFC + byte-capped (not UTF-16 chars) + structurally cannot emit `--` — one function behind project slugs, journal/correction/skill slugs.
- **Materialized indexes**, regenerated atomically on write (regen failure never fails the write): `corrections/_index.md` (severity-first: severity/failure_class/status/date/rule), `journal/_index.md` (last 10, filename-derived), `palace/rooms/_index.md` (per-room overview).
- **v2 journal grammar**: `none` sig/theme segments are omitted, never printed; 4th parser generation (SaveType-anchored, enum-membership classification) alongside the 3 legacy generations.
- **v2 corrections grammar**: `{date}--{rule-slug}.json` — slug derives from the rule (leading interjections stripped, EN + CJK incl. full-width punctuation), no longer from the trigger utterance.
- **Source-level guard test**: raw `projects` path construction outside `storage/paths.ts` now fails the suite — the bypass class is unrecreatable.

### Fixed

- **Case-fold corpus split**: `agentrecall` vs `AgentRecall` resolve to one directory via `resolveProjectDirName()` (existing-dir case-insensitive reuse; deterministic pick + stderr warning when a fork already exists). ~21 call sites that built project paths independently now route through `paths.ts`.
- **Byte-vs-char filename budgets**: component caps are byte-aware (CJK/emoji slugs can no longer exceed the 255-byte filesystem limit while passing a char cap).
- **Rewrite forks**: `retractCorrection`/`recordOutcome`/merge-consolidation and skill rewrites reuse the record's on-disk filename instead of recomputing it — a grammar change can no longer orphan-duplicate existing records.
- **Vanishing-project hazard**: `isJournalFile` excludes underscore-prefixed files; an `_index.md` can no longer knock a project off the status board.
- **Same-day journal TOCTOU**: decide-filename + write now run under a per-project file lock (lock keys case-normalized).
- **FSRS reinforce lookup**: case-insensitive — legacy skills with uppercase slugs no longer silently starve of reinforcement.

### Migration

- Zero-rename, new-writes-only. Existing files keep their names permanently; all legacy generations keep parsing. Room/topic-level case-folding is explicitly deferred (spec §7).

## [3.4.37] — 2026-07-14

- RD-1: `failure_class` at capture (9-value enum) + cross-project recurrence join at session-end; Phase-0 eval PASS (first cross-project detection, 0/53 stride FPs). Experimental `experimental/harness-kit/`. Full notes: `warroom/changelog.html` and the [v3.4.37 GitHub Release](https://github.com/Goldentrii/AgentRecall-X/releases/tag/v3.4.37). *(Entry backfilled 2026-07-20 — this release shipped without a CHANGELOG.md entry.)*

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
