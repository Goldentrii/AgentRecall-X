# AgentRecall Ledger P1 — Run Report (2026-10-30 09:38 → 16:03 CET)

**Status:** P1 done and independently verified; **paused at the phase gate** (owner rule: stop dispatching at phase end, report, wait). Resume = P2 (migrate C: store → E:, backfill the real store, install patched commands, release).
**Repo:** Goldentrii/AgentRecall-X (local worktree `F:\Projects\arx-ledger`, branch `feat/ledger`) · code end SHA **283e9cd**, docs HEAD 70ed010 · **CI:** no CI run for 283e9cd (nothing pushed; local only) · **Ledger:** `reports/2026-10-30-ledger/run-ledger-dispatches.jsonl` (Agent Craft dispatch records, content-hashed) + `cost-table.md` (phase-report.py over the session transcript).

> Corrections: (1) earlier in the session I said "everything is derived from the ledger" — corrected in spec D6: content files stay canonical, the ledger holds hashes and proves them. (2) My preview counted 518 ledgered files; after W2's A2 exclusions (`log.md`, `_index.md`, corrections reclassified) the verifier measured 491 — the later number is the correct one. (3) This run did not use `reporting-agent-runs/ledger.py`; the during-run records are Agent Craft's dispatch hooks + the transcript-based cost table. `run_metrics.py` was therefore not run (disclosure, see §4).

## 1. What was done

| task | result | evidence |
|---|---|---|
| Step 0 (pre-phase): 3 recall bugs (split store, write-on-read, substring noise) | fixed, reviewed (2 rounds), 2473/0 tests | `ce4feea` on `fix/recall-project-scope`; `test/recall-owner-repro-2026-10-30.test.mjs` |
| Spec / interview (14 decisions, schema, 10 SUCCESS_WHEN) | written, amended twice (§8) | `00-interview.md` @ fbc35c8 → 12b25d3 → 5d192f0 |
| RT red-team of W1 SOP | RECOMPILE, 17 findings → 12 applied | `rt-report.md` |
| W1 core library (ulid, append, heads, read) + 2 amendments | done | `e0a6d81`, `f32d92c`, `c8ddb9c`; `w1-report.md` |
| W2 verify / trace / backfill + CLI + 1 amendment | done | `e073f42`, `386afed`; `w2-report.md` |
| W3 class-fix: 28 modules wired, enforcement test | done; RED proof via stash | `6c0fc43`; `w3-report.md` (class table) |
| W4 MCP `trace`, lifecycle line, arsave fallback + verify card | done | `e8f12e4`; `w4-report.md` |
| Fence-manifest entries (orchestrator) | done | `5163418` |
| R independent review | 0 CRIT / 0 HIGH / 4 MED / 11 LOW | `review-R.md` |
| W5 fix round (M1 M2 M4 L3 L5 L6 L7) | done, 2 RED-tested fixes | `d247fbc`; `w5-report.md` |
| V independent verification SW-1..9 | **P1 VERIFIED** | `verify.md` |
| Preview on a copy of the real store | 518→(491) files, backfill 20 s, clean | `preview-real-store-copy.md`, `verify.md` |

Timeline (CET, from git + dispatch records): 09:38 session start, recall probe reproduces the bug · 10:20 step-0 review dispatched · 12:37 spec committed · 12:41 W1 + RT · 13:03 W2 ∥ W3 · 13:33–13:53 W1 A2 / W2 A2 · 15:04 W4 · 15:25 R · 15:32 W5 · 15:47 V · 16:03 verifier report committed.

## 2. Agents used

- **Dispatches (ledger rows): 9** — step-0 reviewer 1 · W1 · RT · W2 · W3 · W4 · R · W5 · V. **Follow-up rounds via message: 4** (step-0 re-review, W1 A1, W1 A2, W2 A2) — usage of rounds is included in the dispatch's totals. All on `claude-sonnet-5-5`; orchestrator Fable 5.1 (Opus 5.5 before the model switch at ~12:30).

| role | count | model |
|---|---|---|
| implementer | 4 (W1–W4) | sonnet-5-5 |
| fixer | 1 (W5) | sonnet-5-5 |
| reviewer / red-team | 3 (step-0 reviewer, RT, R) | sonnet-5-5 |
| verifier | 1 (V) | sonnet-5-5 |

- **Peak concurrency: 2** (W1 ∥ RT; W2 ∥ W3) — measured from dispatch timestamps.
- **Usage, orchestrator excluded (measured, transcript):** 9 of 9 agents reported · tool calls **437** · output tokens **835 k** (median 59.8 k) · cache-read 92 M (dominated by context reloads; not comparable across runs) · agent wall-time **333 min 39 s** (median 15 m 37 s). Orchestrator: 222 tool calls, 908 k output tokens.
- **Reviews:** W1 → RT (pre-execution) + R; W2, W3, W4 → R; step-0 fix → code-reviewer (2 rounds). **W5 was checked by V (verification against SUCCESS_WHEN), not code-reviewed** — list W5 as unreviewed for code quality. No self-review anywhere.

## 3. Duration

- Run: **09:38 → 16:03 = 6 h 25 min** wall clock (phase-report elapsed 386 min, measured).
- Lead-in (step-0 fix + spec + briefs): 09:38–12:41 ≈ 3 h 03 min; build window (first dispatch → verifier commit): 12:41–16:03 ≈ 3 h 22 min.
- Agent-time 333.7 min vs build-window wall 202 min → parallelism **1.65** (derived); vs whole run 386 min → 0.86.
- Longest task: W1, 112 min across 3 rounds; W2 110 min across 2 rounds (both held the machine during 15-min suites).

## 4. Outcome

| command | where | result |
|---|---|---|
| `npm run build`, `npm run lint` | local `F:\Projects\arx-ledger` @ 283e9cd (orchestrator) | 0 errors (measured) |
| core / cli / mcp-server / sdk suites | V's own runs @ 283e9cd, pinned temp env | core 2128: 2126 pass + 1 load-flake (19/19 alone) + 1 skipped · cli 308/0 · mcp 89 (86 pass, 3 skipped) · sdk 41/0 (measured by V) |
| core / cli / sdk suites | local @ 5163418 (pre-W5, orchestrator) | 2128/0 · 306/0 · 41/0 (measured) |
| core / cli / mcp-server / sdk suites | local worktree @ 283e9cd, pinned temp env (orchestrator, after W5) | core 2128: 2127 pass / 0 fail / 1 skipped · cli 308/0 · mcp 89 (86 pass, 3 skipped) · sdk 41/0 (measured) |
| clean snapshot `git archive 7801e4f` → npm ci, build, lint, 4 suites | `E:\Users\tong\tmp\snapshot-7801e4f` | **PARTIAL**: on the clean archive `npm ci` + `npm run build` + `npm run lint` passed (measured, `BUILD_LINT_EXIT=0`) and mcp-server 89 tests: 86 pass / 0 fail / 3 skipped (measured); the cli and core suites did not complete — the host killed the background run for low system memory (first attempt had aborted on the archive symlink `packages/cli/bin/ar`). Not restarted without the owner's go. The same suites are green on the worktree at the same code SHA (row above). |
| store smoke on `cp -rp` copy: verify → backfill → verify → backfill | V, copy under tmp | 491 orphans/exit 2 → 491 written → clean/exit 0 → 0 written (measured by V) |
| CI | — | no run for 283e9cd (not pushed) |

Review findings: RT 17 (12 fixed in W1 A1, 3 process-only, 2 waived as out of W1 scope) · R MED 4 (3 fixed, M3 deferred) · R LOW 11 (4 fixed: L3 L5 L6 L7; 7 deferred: L1 L2 L4 L8 L9 L10 L11).
Irreversible actions: **none under REDLINE** (no push, no publish, no deploy, no version bump). Deletions: 7 merged worker worktrees + 7 merged branches removed under the standing CLAUDE.md rule ("after merge, worktree remove + delete branch") — authority kind **blanket**, listed here as the skill requires. Config changes (reversible, backed up): `~/.claude.json` agent_craft → Python 3.14 (`~/.claude.json.agent-craft-py314.backup`), `pip install mcp` into Python 3.14. `run_metrics.py` not run: WARN (no ledger.py ledger; counts above come from Agent Craft records + git).
Things the checks did not cover (from V): genesis note is wall-clock while backfill events are mtime-stamped, so `_global.last_ts < first_ts` after a backfill; `ar verify` on the real store exits 2 until backfill runs; backfill prints every path (491 lines).

## 5. Deliverables

| deliverable | path |
|---|---|
| Spec (normative) | `reports/2026-10-30-ledger/00-interview.md` |
| Ledger library | `packages/core/src/ledger/{ulid,types,context,append,heads,read,walk,verify,trace,backfill,index}.ts`, `packages/core/src/storage/ledger-queue.ts` |
| Wired call sites (28) + enforcement test | `packages/core/src/{tools-logic,palace,storage}/*`, `packages/core/test/ledger-no-unledgered-mutation.test.mjs` |
| CLI | `ar trace`, `ar verify`, `ar ledger tail\|backfill\|append` in `packages/cli/src/index.ts` |
| MCP | tool `trace` (`packages/mcp-server/src/tools/trace.ts`), lifecycle line (`src/lib/lifecycle-line.ts`), exit flush (`src/lib/lifecycle-exit.ts`) |
| Commands | `commands/arsave.md`, `experimental/harness-kit/commands/arsave.md` (fallback + Verify row) |
| Tests | `packages/core/test/ledger-*.test.mjs`, `packages/cli/test/ledger-cli.test.mjs`, `packages/mcp-server/test/ledger-trace-tool.test.mjs` |
| Reports | `rt-report.md`, `w1..w5-report.md`, `review-R.md`, `verify.md`, `phase-1.md`, `cost-table.md`, `preview-real-store-copy.md`, briefs in `briefs/` |
| Team config file (unrelated side task) | `C:\Users\tong\Desktop\set-opus55-medium.md` |

## 6. Gap to final delivery

Remaining (P2, 5 tasks, owner go required): (1) merge the 55 C:-only store files into E: with mtimes preserved (`cp -rp` / `robocopy /COPY:DAT`), conflicts resolved one by one; (2) `ar ledger backfill` on the real E: store (measured 20 s on the copy); (3) install the patched `arsave.md`/`arstart.md` into `~/.claude/commands/`; (4) delete the 7 empty `orbitcard-clone/palace` templates created by this morning's recall (owner-gated delete); (5) release: push `fix/recall-project-scope` + `feat/ledger`, version bump 3.5.2 → 3.6.0, npm publish — all REDLINE.
Deferred engineering (not blocking): R's M3 (session_start verify cost — cache or cheap mode), L1 (stale heads self-heal), L2 (write/event reorder drift), L4 (stronger enforcement test), L8 (load-sensitive tests), L9 (shared `scanEvents`), genesis `ts` vs backfill `ts`; Agent Craft honoring `AGENT_RECALL_ROOT` (other repo); `agent-craft use` needs `PYTHONUTF8=1` on Windows.
Estimate: P2 tasks 1–4 ≈ 1 agent × 60–90 min (basis: 55 files to reconcile, backfill 20 s measured, two command files); task 5 is minutes once approved. Top risks: the C:→E: merge may surface content conflicts in `job-applications` (20 differing files); the two load-sensitive tests can flake on a busy CI runner; the Windows CRLF warnings on every commit hint at a missing `.gitattributes`.

---
Numbers are labelled `measured` (command output), `derived` (computed from measured), or `agent-reported` (not re-verified). Worker test counts inside w1–w5 reports are agent-reported; the suite numbers in §4 are measured by the orchestrator or the verifier as stated.
