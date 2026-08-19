# AgentRecall v3.4.43 Eval — Layer 0: Mechanism Health

Worker: Sonnet eval worker · plywood SOP `c36ba121`
Snapshot: `/tmp/ar-eval-snapshot` (copy of production `~/.agent-recall`, 62M, taken 2026-08-18 ~11:04 CEST)
CLI under test: `node ~/Projects/AgentRecall/packages/cli/dist/index.js` — `ar v3.4.43`
Method: direct file inspection of the snapshot + the shipped CLI run with `AGENT_RECALL_ROOT=/tmp/ar-eval-snapshot HOME=/tmp/ar-eval-snapshot`. No MCP tool calls made against this session's live agent-recall server; real `~/.agent-recall` never touched (verified: this session's ambient `HOME=/Users/tongwu`, not the snapshot — no contamination risk).

Question: does the machine run, unattended, without loss?

---

## Pre-registered definitions

- **capture_rate** = sessions that produced a card OR any journal entry (including a raw-archive dump) / total sessions seen. Denominator = union of sids observed in `recent-sessions.jsonl`, `working-memory/*.jsonl`, `projects/*/journal/**/*--card--*.md`, and `projects/*/journal/archive/raw/*.md`.
- **rescue metrics** = count of cards with `source: working-memory-rescue`; rescue as % of sessions lacking a `hook-end` card.
- **hook_failure surface** = parse `hook-health.jsonl`/`hook-health.json` at store root if present; count + classify.
- **dual-stack correctness** = sid form in `recent-sessions.jsonl` (UUID = hook client, short-hex = MCP-server/non-hook client); expectation per brief was "server-side ~absent" on this hook-owning machine.
- **WM overhead** = bytes of `working-memory/` + `recent-sessions.jsonl`; is "absorb-then-forget" holding (no backlog), or is WM accumulating?
- **storage integrity** = orphaned WM older than the 1h rescue window with no card; duplicate cards per sid; recency dup-sid rows and whether the v3.4.43 read-dedup masks them.

---

## Metrics table

| # | Metric | Raw number | PROPOSED grade | One-line rationale |
|---|--------|-----------|----------------|---------------------|
| 1 | capture_rate (any durable trace) | 123/123 = **100%** | A | Every session seen has at least a raw-archive dump; `archiveSession()` runs unconditionally before any capture logic — nothing is silently lost at the byte level. |
| 1b | capture_rate (compressed card) | 24/123 = **19.5%** (99 raw-only, card-less) | C | But: 99 pre-2026-08-01 sessions have a transcript and NOTHING else — never digested into a card, so `recall`/`session_start`/awareness never see them. All 99 predate 2026-08-01; **zero** raw-only sessions since. |
| 2 | rescue rate | 11 rescue cards / 24 total card-sids = **45.8%**, but **100% of rescues are noise** (see risk) | D | Genuine crash-rescue rate for real work sessions = 0/13 (good — no real session ever needed rescue), but the rescue mechanism itself is entirely consumed by a false-positive class (`check_action` git-status pings misfiled as orphaned sessions). |
| 3 | hook_failure surface | `hook-health.jsonl`/`.json` **absent**; `ar health` → "no failures recorded" | A (18-day window) | Mechanism has existed only since 2026-07-31 (commit `35f93ac`), so this is a clean bill of health for ~18 of the corpus's ~90 days, not the full history. |
| 4 | dual-stack correctness | 13/24 unique sids UUID-form, **11/24 (45.8%) short-hex** | B | Brief expected server-side "~absent" on a hook-owning machine — it is NOT absent by count, but on inspection all 11 short-hex sessions are 100% `check_action`-ping noise, not real dual-capture of genuine Claude-Code sessions. The *gate* (no double-capture of one real session) holds; the *volume* is inflated by noise the gate doesn't filter. |
| 5 | WM overhead | `working-memory/`: 8KB, 1 live file. `recent-sessions.jsonl`: 84KB / 397 rows / 24 unique sids (94% duplicate rows) | A / B | Absorb-then-forget holds for WM (0 orphans at snapshot time). Recency index has heavy write-amplification (16.5 appends/session on average) but v3.4.43's read-time dedup collapses it correctly (verified: `readRecentSessions(500)` returns exactly 24, matching unique sids). |
| 6 | storage integrity — orphan WM | 0 stale WM files (the 1 live file is the active session, well within the 1h window) | A | No backlog. |
| 6b | storage integrity — dup cards/sid | 14 project+sid combos with >2 dated card files, 72 "extra" rows | B | Confirmed legitimate: same sid = same long-running conversation resumed across days, each `hook-end` produces a new dated card. Not a bug, but is real journal clutter that read-side tooling (not `ar list`, which shows every date) must eventually collapse for readability. |
| 6c | `ar doctor` (tool's own integrity check) | **RED** overall | F (as measured) / tool self-diagnosis is the good news | `dreaming_stale` (warn, 8 projects incl. `auto`, `novada-mcp-funnel`'s siblings): consume marker never advanced despite raw segments >7d old. `outcomes_ledger_divergence` (red, 2 projects): materialized counters diverge from ledger replay for 14 corrections total. |
| 6d | `ar hygiene` (store-trash audit) | **YELLOW**, 2 fresh findings | C | 224 `.ambient-counter-*` files at store root (>100 yellow threshold) — 180 of them literally named `.ambient-counter-test-<epoch>-<random>`, i.e. test-suite fixtures that leaked into the **production** store. Plus a stray `projects/test-routing/` directory. |

---

## Detailed evidence per metric

### 1. Capture rate (denominator construction)

```
recent-sessions.jsonl:            397 rows,  24 unique sids
working-memory/*.jsonl (live):      1 file,   1 sid (the active orchestrator session, 6c9644e8-...)
cards (journal/**/*--card--*.md): 106 files, 24 unique sids
raw-archive (journal/archive/raw/*.md): 445 files, 112 unique sids
UNION (total sessions seen):      123 unique sids
```
- 123/123 have *some* durable trace (raw dump or card) — nothing vanishes at the byte level.
- Only 24/123 (19.5%) ever got a compressed **card** — the artifact that `recall`/`session_start`/awareness/palace machinery actually consult. 99 sessions are raw-only.
- Bucketing the 99 raw-only sids by their **last** raw-archive activity date (not first — a long-running sid can span weeks, so "first date" undercounts recency) shows **all 99 have last activity ≤ 2026-07-31**, and **zero raw-only sids exist for any date in August**. Evidence:
  ```
  last-activity date range for orphaned raw-only sids: 2026-06-22 to 2026-07-31
  ```
  This lines up exactly with the "Train C" continuity wave (git commit `35f93ac`, 2026-07-31: "fail-loud hook health + resurrect dead-session finder") and the working-memory tier (CHANGELOG 3.4.42, 2026-08-04: crash rescue). Before these shipped, a session that didn't cleanly hit `hook-end` had no safety net — only the raw dump. After, every session observed got a card. This is the single most decision-relevant finding in this eval: **the compounding-memory promise was silently broken for ~6 weeks of history (99 sessions) and has been closed for the last 18 days (0 sessions).**

### 2. Rescue metrics

- 11 cards total have `source: working-memory-rescue` (11/106 = 10.4% of all cards). Every single one is:
  ```
  # check_action: git status — check working tree
  slug_confidence: 0, source: working-memory-rescue
  ```
  Sample raw row from `recent-sessions.jsonl`:
  ```
  {"ts":"2026-08-12T15:11:26.368Z","sid":"e3f747","slug":"auto","title":"check_action: git status — check working tree","artifact_count":0}
  ```
  These 11 sids appear in tight bursts (minutes apart, e.g. `2026-08-13T20:22:26`, `20:22:50`, `20:32:19`, `20:32:55`) across two days (2026-08-12, 2026-08-13), each getting its own fresh short-hex sid.
- Root cause read from the code: Train C's "every tool call appends a scrubbed working-memory gist" (v3.4.43 CHANGELOG) treats an isolated `mcp__agent-recall__check` call (an alignment pre-check before a `git status`, not a real work session) as its own session. Since no `hook-end` ever fires for a one-shot tool call, the 1-hour orphan-rescue sweep faithfully "rescues" it into a full card — promoting pure system noise into permanent journal clutter.
- Net effect: 0 genuine (UUID-form) sessions ever needed rescue (hook-end is reliable for real sessions), but the rescue mechanism's entire observed output in this snapshot is false positives.

### 3. Hook-failure surface

- `hook-health.jsonl` / `hook-health.json` absent at store root.
- `ar health` (CLI, run against the snapshot): `✓ hook health: no failures recorded.`
- The instrumentation (`packages/core/src/storage/hook-health.ts`, `recordHookFailure`/`readHookHealth`) is wired into ~30 call sites across `session-end.ts`, `working-memory.ts`, `archive-write.ts`, `recency-index.ts`, `consolidation-queue.ts`, and the CLI's own hook-start/hook-end catch blocks — this is not a stub, it is live instrumentation. First shipped 2026-07-31 (`git log --follow`, commit `35f93ac`).
- Caveat: this only covers the last ~18 days of the corpus's ~90-day history. Zero failures in that window is a clean signal, but it says nothing about the pre-instrumentation era (which is exactly where finding #1's 99-session capture gap lives — consistent with "no visibility → the gap went unnoticed for 6 weeks").

### 4. Dual-stack correctness

- Unique sids in `recent-sessions.jsonl`: 13 UUID-form (hook), 11 short-hex (server/non-hook MCP path).
- Brief's prior ("server-side capture should be ~absent, gate working") is only half right: the *volume* isn't absent, but every single short-hex entry is the `check_action` noise class from #2, not a genuine duplicate-capture of a real Claude Code session. I found **zero** cases of one real session producing both a UUID-form hook card and a short-hex server-side card — i.e., no evidence the "dual-stack ownership gate" (CHANGELOG 3.4.43: hooks stand down server-side capture when `CLAUDECODE`/`CLAUDE_CODE_*` env is observed) has actually double-captured a real session. The gate appears to hold; it's just that it doesn't (and isn't designed to) filter out non-session tool pings from the short-hex path.

### 5/6. WM overhead + storage integrity

- `working-memory/`: 8KB total, exactly 1 file (`6c9644e8-....jsonl` + its `.count` sidecar), matching the currently-active orchestrator session. No stale files — "absorb-then-forget" (v3.4.42: hook-end absorbs into a card and deletes the WM file) holds at this snapshot instant, and the total absence of any older orphan is consistent with it holding continuously, not just by luck at this exact moment.
- `recent-sessions.jsonl`: 397 rows / 24 unique sids — a 16.5× write-amplification factor, explained in the source (`recency-index.ts`) as a known cross-process race (two independent callers — CLI hook-start sweep and core's `sessionStart()` — can each observe "no entry yet" and both append). The **v3.4.43 fix is read-side, not write-side**: `readRecentSessions()` dedupes by sid at read time, keeping the newest. I verified this directly against the snapshot by importing `packages/core/dist` and calling `readRecentSessions(500)`:
  ```
  readRecentSessions(500) returned 24 entries
  unique sids among returned: 24
  ```
  Exact match to the unique-sid count — the dedup is not just present in source, it demonstrably works on real production data.
- Duplicate cards per (project, sid): 14 combos, 72 "extra" dated files. Spot-checked two dates for the same sid (`novada-mcp-funnel/8a02c8b2`, 2026-08-05 vs 2026-08-10) — content differs (different day's conversation excerpt), confirming these are legitimate daily snapshots of one long-running resumed session, not a duplication bug. `ar list` does **not** dedupe these (shows every dated title, including 4x "Novada MCP 页面设计回顾" from different dates in one project) — only the cross-project recency index gets read-deduped, not the per-project journal listing. Worth flagging as a UX/read-side gap, distinct from the recency-index fix.

### 6c/6d. Tool's own self-diagnosis (bonus — ran `ar doctor` and `ar hygiene`, not explicitly requested but directly load-bearing for "storage integrity")

`ar doctor --json` on the snapshot: overall **RED**.
```
dreaming_stale [warn]: 8 project(s) have raw segments older than 7d but a consume
  marker that never advanced (login-free seam may have failed silently):
  auto, novada-test-engineering, prismma-vault, prismma-ai, website, novada-web (+2 more)
outcomes_ledger_divergence [red]: materialized outcome counters diverge from the
  ledger replay in 2 project(s): AgentRecall (12 corrections), prismma-web (2 corrections)
```
Manually corroborated `dreaming_stale`: sampled `.consumed.json` markers directly —
```
projects/novada-claude-plugins/journal/archive/raw/.consumed.json: {"lastConsumedOffset":0,"lastConsumedAt":null}
projects/pareto-loop/...: {"lastConsumedOffset":0,"lastConsumedAt":"2026-05-14T07:11:39.349Z"}
```
— several projects' consume marker has not advanced since May, while raw archives keep accumulating (445 files, 36.7MB total, ~59% of the entire 62M store) with pruning gated on that marker (`archive-prune.ts`: "while lastConsumedAt is null ⇒ nothing pruned"). This is a live, unremediated backlog-growth risk, not just historical debt.

`ar hygiene --json` on the snapshot: **YELLOW**, 2 fresh findings:
```
junk-project-dirs: projects/test-routing — literal test/placeholder slug sitting in production
counter-accumulation: 224 .ambient-counter-* files at store root (yellow>100, red>500)
```
Of those 224, 180 are literally named `.ambient-counter-test-<epoch-ms>-<random>` (e.g. `.ambient-counter-test-1785315422471-ox7y6tz8zrm`), and 5 more are named after test fixtures found verbatim in `packages/cli/test/topic-state.test.mjs` (`cjk-e2e-session`, `bare-session`, `precision-guard-session`, `stale-e2e-session`, `e2e-fire-session`). This is **test-suite output that leaked into the real production store**, not synthetic session activity — directly corroborated by CHANGELOG 3.4.43's own "Root-resolution bypass class in the CLI (full enumeration, 12 sites): `--root` was silently ignored by `ar stats` and `ar setup supabase --backfill`... plus 10 further internal sites." The last pollution file is dated **2026-08-12**, one day before the 3.4.43 release (2026-08-13) that fixed this bug class — consistent with the fix holding since: no new test-pollution files after Aug 12.

### Fixture-class / CJK-path note
- The `cjk-e2e-session` file is a fixture **name** (ASCII, from the test file), not actual CJK bytes — don't conflate it with real CJK content.
- Real CJK content in the store renders correctly end-to-end: `ar list` returned `"title": "Novada MCP 页面设计回顾"` with correct UTF-8, both from the CLI JSON output and from raw file `head` — no mojibake, no filename corruption, no path-shape breakage observed anywhere in 106 card files or 445 raw-archive files scanned.

---

## Biggest mechanism risk

**Test-suite pollution of the production store, caused by the (now-fixed-in-3.4.43) `--root` bypass bug, has left 224 stray marker files and at least one stray project directory (`projects/test-routing`) sitting in `~/.agent-recall` with no automatic cleanup path** (`hygiene.ts` is explicitly detection-only, never deletes). This is the most concrete, tool-corroborated, still-open finding: `ar hygiene` calls it out today as a fresh (non-baselined) YELLOW. It's contained (not growing since Aug 12) but unremediated, and it sits alongside a second, more serious open finding — `ar doctor`'s RED `outcomes_ledger_divergence` (14 corrections across 2 projects where materialized counters disagree with the ledger) and `dreaming_stale` (8 projects whose raw-archive consolidation has been silently stalled since May) — meaning the store's own built-in integrity tools (`doctor`, `hygiene`) are currently failing their own checks on the real corpus, and nothing is currently closing that loop automatically.

Second-place risk, more relevant to the product promise specifically: the 99-session (6-week) capture gap in history (finding #1) shows the "user does nothing, agent stops repeating mistakes" promise was silently unmet for a real, multi-week stretch with zero visibility until `hook-health` shipped — the gap is now closed (0 raw-only sessions since Aug 1), but the fact that it existed for 6 weeks with no alarm is the class of failure this whole L0 layer exists to catch early next time.

---

```
SOP_ID: c36ba121
FEEDBACK_HINTS: outcome=success edited=clean escalated=smooth
```
