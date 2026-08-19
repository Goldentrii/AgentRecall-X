# Continuity Wave — Wave 4 Independent Verifier Report (2026-07-31)

Worktree: `/tmp/ar-wave/integration` @ branch `wave/integration`, commit `bda11f6` ("fix: address continuity wave review findings (4 HIGH, 5 MEDIUM)").
Role: independent verifier. No code was written or modified in the worktree. Verification ran exclusively through the built CLI (`packages/cli/dist/index.js`) and direct filesystem inspection — the `agent-recall` MCP tools in this agent's own toolbox were never invoked (self-review ban).

## Verdict summary

| Exit condition | Verdict | Notes |
|---|---|---|
| V1 — harness (fresh) | **PASS** | `npm ci && npm run lint && npm run build && npm test` all exit 0 once the two leaked Supabase/embedding env vars are unset. The 3 documented pre-existing exceptions reproduce exactly as described. |
| V2 — e2e round-trip (temp root) | **PASS** | Full hook-end → hook-start → resurrect → health round trip works correctly in an isolated temp root/home. Two minor code-quality observations noted (not blocking). |
| V3 — real-store read-only acceptance | **PARTIAL — 2 of 4 sub-checks FAIL** | Store is genuinely read-only (0 files touched). `resurrect("TOW2-357")` puts 8a02c8b2 cleanly at #1. `resurrect("MCP原型 页面设计", days:3)` does **not** put 8a02c8b2 at #1 (self-contamination from this verifier's own live session), and the brief's `artifacts` field is missing the 交付物2 path (real regex bug in `extractArtifacts`). |
| V4 — regression on real store | N/A | Per instructions, no hooks were run against the real store (they write locks). |

---

## V1 — harness (fresh, trust nobody)

```
cd /tmp/ar-wave/integration
npm ci                 → exit 0  (added 212 packages)
npm run lint            → exit 0  (tsc --noEmit across core/mcp-server/sdk/cli)
npm run build            → exit 0  (all 4 packages)
```

**As-is test run** (this shell's real env still carries `AGENT_RECALL_SUPABASE_KEY` / `AGENT_RECALL_EMBEDDING_KEY` from the operator's daily dev setup): `npm test` → **exit 1**, failing at exactly the documented flake:

```
test at test/awareness.test.mjs:209:3
✖ fetchDashboardArchivedTitles uses AgentRecall Supabase config
  AssertionError: expected 'configured-key', got 'sb_publishable_...' (real leaked key)
```
This reproduces identically to the fix-report's own finding (`~/Projects/AgentRecall/reports/2026-07-31-fix-report.md` line 37) — confirms it is env-leakage, not a regression.

**Clean test run** (`env -u AGENT_RECALL_SUPABASE_KEY -u AGENT_RECALL_EMBEDDING_KEY npm test -w packages/core` and then full `npm test`): **exit 0**.

| Package | tests | pass | fail | todo |
|---|---|---|---|---|
| core | 1069 | 1069 | 0 | 0 |
| mcp-server | 25 | 25 | 0 | 0 |
| sdk | 40 | 39 | 0 | 1 (pre-existing, TODO-pinned: "Case B: constructing a second AgentRecall instance leaks its root onto an earlier instance") |
| cli | 166 | 165 | 0 | 1 (pre-existing, TODO-pinned: `audit-cjk-capture-gate.test.mjs` CJK-negation detector gap) |

Both TODO-pinned exceptions are marked `{ todo: true }` / `[EXPECTED TO CURRENTLY FAIL]` in their own test source and match the design/fix-report's documented list exactly — no new failures, no regressions.

**V1 = PASS.**

---

## V2 — e2e round-trip in a temp root (never real store)

Confirmed env var name from `packages/core/src/types.ts:38`: `AGENT_RECALL_ROOT` (not `AR_ROOT`).

Isolation used **both** `AGENT_RECALL_ROOT=<temp>` and `HOME=<temp2>` for every command — this was necessary because hook-end/hook-start still have known-and-documented hardcoded `os.homedir()` call sites (endLockFile, the legacy journal-summary path, `.last-session-summary.txt`, semantic-prefetch) that do **not** go through `getRoot()`. This is finding **L4** from the Wave-3 review, explicitly scoped out of this wave ("Follow-ups... not touched this wave, per instructions" — `~/Projects/AgentRecall/reports/2026-07-31-fix-report.md` line 42) — not a new defect, but it does mean a bare `AGENT_RECALL_ROOT`-only override is **not** sufficient to fully sandbox a hook-end/hook-start run; overriding `HOME` too was required to guarantee zero real-store contamination. Noted as a testability gap worth closing in a future wave.

Built a synthetic transcript (`/tmp/<sid>.jsonl`) matching real transcript shape: `last-prompt`/`mode`/`permission-mode` preamble lines, an `attachment`-type hook-boilerplate record mentioning a **decoy** project (`decoy-project-xyz`) 5× in its stdout content, a real user turn (CJK) naming a pre-existing slug `ar-verify-fixture` (pre-created under `$AGENT_RECALL_ROOT/projects/ar-verify-fixture/`) plus `TOW2-999`, a `Write` tool_use (artifact), a `tool_result` block carrying an unrelated ref `ZZZ9-000` (must never leak), and a final assistant turn with `Decided:` / `Next:` lines.

```
HOME=$FAKE_HOME AGENT_RECALL_ROOT=$AR_ROOT node packages/cli/dist/index.js hook-end < stop-stdin.json
→ EXIT=0
```

Result tree under `$AR_ROOT`:
```
projects/ar-verify-fixture/journal/archive/raw/2026-07-31--<sid>.md   ← raw archive under the REAL slug (NOT decoy, NOT auto)
projects/ar-verify-fixture/journal/2026-07-31--card--<sid>.md          ← session card
recent-sessions.jsonl                                                  ← recency index entry
```
No `projects/decoy-project-xyz/` and no `projects/auto/` were created — F1's claim-not-generate correctly excluded the boilerplate-only decoy and correctly preferred the pre-existing real slug.

Card frontmatter: `slug: ar-verify-fixture`, `slug_confidence: 1`, `slug_candidates: [{"slug":"ar-verify-fixture","count":4}]`. Card body contains `## Linear\nTOW2-999` (the `ZZZ9-000` tool_result ref does **not** leak — M9's fix holds), `## Artifacts` with the Write's file_path, `## Decisions` and `## Next steps` lines pulled from the final assistant turn. `recent-sessions.jsonl` has one line with matching `sid`/`slug`/`title`/`next_step`.

**Continuity, cross-slug, from a different cwd:**
```
cd /tmp/ar-verify-different-cwd  (unrelated cwd → CLI resolves project="ar-verify-different-cwd")
HOME=$FAKE_HOME AGENT_RECALL_ROOT=$AR_ROOT node .../index.js hook-start
→ [AgentRecall] Session context loaded
  ⏪ Continuity (recent work, other projects included):
     - just now [ar-verify-fixture] 启动关于 ar-verify-fixture 项目的验证测试会话... → next: Next: verify hook-end writes the card correctly and appends recency index.
  Project: ar-verify-different-cwd
→ EXIT=0
```
Confirms F2's continuity card is genuinely cross-project (surfaces from an unrelated project's cold start).

**Resurrect + health:**
```
ar resurrect "TOW2-999"  → returns the ar-verify-fixture brief (slug/sid/date/artifacts/nextSteps all populated)  → EXIT=0
ar health                → "✓ hook health: no failures recorded."                                                  → EXIT=0
```

**Failure path** (`AGENT_RECALL_ROOT` pointed at a `chmod 000` directory, fresh sid, run from the different-cwd dir):
```
→ EXIT=0, stdout empty, stderr empty
```
Confirmed the target directory really was unwritable (`ls` → "Permission denied") both before and immediately after. Restored `chmod 755` and `rm -rf`'d it afterward. Hook-end never crashes on an unwritable root — **PASS** on the literal acceptance bar ("process does not crash").

One nuance worth recording: the silence is *total* — no stderr line at all, not even the `[AgentRecall hook-end archive]` message the code appears to print on failure. Root cause: `archiveSession()` (`packages/core/src/storage/archive-write.ts:85-135`) has its **own** internal `try/catch` that swallows the `EACCES` before it ever reaches `index.ts`'s outer `catch (e) { core.recordHookFailure(...) }` block, so F5's fail-loud health recording is never invoked for this specific failure mode. Given the root itself is unwritable this is somewhat structurally unavoidable (there is nowhere to persist a "we failed to write" record), but it does mean F5 does not currently give end-to-end fail-loud coverage for every failure class — only for exceptions that escape as far as the specific outer catch blocks that call `recordHookFailure`.

Two minor code-quality observations from `ar resurrect "TOW2-999"`'s own output (not blocking V2's pass, both reproduced later in V3 too):
1. `resurrect.ts`'s own `extractLinearRefs` (a different, lower-rigor implementation than `session-card.ts`'s M9-fixed one) re-leaked the `ZZZ9-000` tool_result ref into the `linear:` line — this is explicitly acknowledged/accepted in the file's own header comment ("not a citation of record, just a lead"), so not a defect against spec, just an inconsistency in rigor between F3 and F6 worth flagging.
2. `resurrect.ts`'s `extractNextSteps` doesn't exclude markdown section headers, so a card's own `"## Next steps"` heading line matches its own `/next/i` regex and appears as a spurious duplicate "next step" entry alongside the real one.

**V2 = PASS** (isolation held after adding a `HOME` override; zero contamination of the real store; both minor findings noted, neither blocks the stated acceptance bar).

---

## V3 — real-store read-only acceptance (the incident test)

Marker established: `touch /tmp/ar-verify-marker`; confirmed `find ~/.agent-recall -newer /tmp/ar-verify-marker` = 0 files before running any resurrect query.

```
cd /tmp/ar-wave/integration
node packages/cli/dist/index.js resurrect "MCP原型 页面设计" --days 3
```

**Result: top-ranked result is NOT 8a02c8b2.** Rank #1 is `[AgentRecall] 6c9644e8-8ed0-4328-b1c8-3896cc55cb24` (score 6.823) — **this verifier's own currently-running session**, whose raw archive (already checkpointed earlier today under the real store, unrelated to any V2 temp-root activity) discusses the identical subject matter (novada-mcp, MCP原型, TOW2-357) because verifying that exact fixture *is* this session's own content. `8a02c8b2` (slug `novada-mcp`) ranks **#5 of 20**, tied at score 3.823 with 6 other unrelated sessions (`auto/4c113109`, `auto/249e71c1`, `novada-mcp/3f79f23e`, `novada-mcp/f53ef382`, `novada-mcp-funnel/e577afbf`, `tchin-talk/300886cc`).

Sub-checks on the 8a02c8b2 brief itself (via `--json`):
- `linearRefs` contains `TOW2-357` — **PASS**.
- `artifacts` = `["/Users/tongwu/.claude/projects/-Users-tongwu/memory/MEMORY.md"]` only — **no 交付物2 path** — **FAIL**.

Root cause of the artifact miss, confirmed by grepping the raw fixture directly:
```
grep -o '.{80}交付物2[^"]{0,120}' .../8a02c8b2....md
→ "...- `~/交付物2_MCP原型_V14.html` = 早期独立原型(我一开始读的那个),仅参考..."
```
The real content wraps the path in markdown backticks (`` `~/...` ``). `resurrect.ts`'s markdown-list-item fallback regex is:
```js
const li = line.match(/^\s*[-*]\s+(~\/[^\s`]+|\/[^\s`]+)/);
```
This requires the captured path to start immediately after `- ` — a leading backtick before `~/` breaks the match (the char right after `\s+` is `` ` ``, not `~`), so the line is never recognized as a path-bearing list item. This is a genuine, reproducible bug: a very common real-world markdown convention (backtick-quoted inline paths in a bullet, exactly as this repo's own agents write them) silently defeats the artifact extractor for the flagship acceptance fixture.

**Second query, per the alternative instructed by the design doc:**
```
node packages/cli/dist/index.js resurrect "TOW2-357"
```
`8a02c8b2` is **rank #1** (score 10.823), cleanly ahead of #2 (0.823) — this query **PASSES** the "top result" bar cleanly, because "TOW2-357" alone is specific enough that this verifier's own session (which does not contain that literal token) doesn't also score a HIGH-confidence keyword hit.

**Read-only assertion (the load-bearing part of V3):**
```
find ~/.agent-recall -newer /tmp/ar-verify-marker  → 0 files, both before and after all resurrect calls
```
**PASS** — `resurrect()` is genuinely read-only in practice, not just by code inspection (its own source, `packages/core/src/tools-logic/resurrect.ts`, uses only `fs.readFileSync`/`readdirSync`, no write calls at all — confirmed by reading the module).

**V3 verdict: PARTIAL.**
- Store-is-read-only: **PASS**.
- `resurrect("TOW2-357")` → top result is 8a02c8b2: **PASS**.
- `resurrect("MCP原型 页面设计", days:3)` → top result is 8a02c8b2: **FAIL** — but the failure's proximate cause is this verification session's own self-contamination of the real store (an inherent hazard of "verify a live-recall feature against the real store while narrating the exact same incident"), not a demonstrated ranking-logic defect in isolation. The two-query design already anticipated some fragility here by offering an alternative query, and that alternative passes cleanly.
- `artifacts` contains a 交付物2 path: **FAIL** — this one is a real, isolated code bug (backtick-quoted markdown list items are never matched by `extractArtifacts`'s fallback regex), independent of any contamination, and should be fixed before this wave is considered fully done.

---

## Surprises / additional findings

1. **L4 (documented, not new)**: hook-end/hook-start still hardcode `os.homedir()` for lock files and the legacy journal-summary path — `AGENT_RECALL_ROOT` alone does not fully sandbox a hook run; a `HOME` override is also required for clean test isolation. Already tracked as a Wave-3 review follow-up, explicitly deferred.
2. **F5 coverage gap (new observation)**: when a lower-level module (e.g. `archiveSession`) swallows its own exception internally without re-throwing, the failure never reaches the specific `catch` blocks in `index.ts` that call `recordHookFailure` — so `ar health` stays silent even though a real failure occurred. Confirmed via the unwritable-root failure-path test (V2): total silence, no health record, but also no crash.
3. **F6/resurrect artifact-extraction bug (new, concrete)**: `extractArtifacts`'s markdown-list regex in `packages/core/src/tools-logic/resurrect.ts` does not tolerate a backtick immediately after the list marker (`` - `~/path` ``), a common real-world convention in this repo's own agent output — causes a real acceptance-fixture artifact to be silently dropped.
4. **F6 ranking under keyword-tie + self-contamination (new observation)**: `computeScore`'s keyword weighting is binary per unique query term (present/absent), not frequency-weighted, so multiple sessions that each merely *mention* the same terms once tie exactly on `keywordScore`, and the tiebreaker becomes raw recency — this let this verifier's own live, topically-identical session outrank the actual fixture for a two-term query. Not necessarily wrong behavior by design, but worth the wave owner's awareness given how easily it manifested here.
5. `resurrect.ts`'s `extractLinearRefs` and `extractNextSteps` are separate, less-rigorous reimplementations of logic that already exists (with fixes) in `session-card.ts` (M9's tool_result exclusion; no markdown-heading exclusion in either). The file's own header explains this is deliberate (resurrect must not import W1's module), but the resulting inconsistency (same bug class fixed in one module, present in the other) is worth flagging for a future consolidation pass.

## Cleanup confirmation

- `/tmp/ar-verify-root-*`, `/tmp/ar-verify-home-*`, `/tmp/ar-verify-different-cwd`, all synthetic `*.jsonl` transcripts, stdin fixtures, marker file, and scratch logs: all removed. Confirmed via `ls /tmp | grep ar-verify` → empty.
- The `chmod 000` unwritable test directory was `chmod 755`'d back and `rm -rf`'d.
- Zero files under `~/.agent-recall` were created or modified by any verifier action outside the marker window (confirmed by `find -newer`, both immediately and at report time) — the ambient `.ambient-counter-*` / `.hook-end-lock` / consolidation-queue entries touched in the last 30 minutes are this verifier's own live session's normal background hook activity (SessionStart/ambient tracking), unrelated to and predating the V3 query calls; they are not artifacts of any command run in this verification.
- The worktree `/tmp/ar-wave/integration` itself was left untouched (no edits) — only `npm ci` populated `node_modules` (already present before this session) and `packages/*/dist` (already present from a prior build).

SOP_ID: 05a886cc
FEEDBACK_HINTS: outcome=partial edited=clean escalated=escalated
