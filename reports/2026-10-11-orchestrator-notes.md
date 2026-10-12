# Orchestrator notes — 2026-10-11 handoff (AgentRecall-X + Agent Craft)

Live status (update as results arrive). Worktrees: E:/tools/AgentRecall-X-{a1,a2,a7}, E:/tools/agent-craft-{b1,b2,b4,b5,b8}. Integration branches: integration-2026-10 in both repos (local only).

| Task | Branch / worktree | Worker | Reviewer | Verifier | Notes |
|---|---|---|---|---|---|
| A0 baseline | main clone | DONE_WITH_CONCERNS | — | — | 36 fail (core 31/mcp 3/cli 2); root `npm test` &&-chain stops after core; heeded-guard 5/9 also on Linux CI; CI red 19 runs since 2026-07-27 |
| A1 heeded-guard | fix/heeded-guard @ 1f02471+2aada8e | DONE | PASS | MET (verify-A1-A7: 9/9 Win+Linux) | MERGED e4ae25c; root cause afd9b0a (v3.4.49 async writeCorrection/recordOutcome); 2 awaits in guard only; 9/9 |
| A2 windows-paths | fix/windows-paths @ 4cf8d97 | DONE | PASS (security PASS; 3 cosmetic notes) | running (verify-A2 on integration 0e1c596) | MERGED into integration 0e1c596; Win 36→2; bench exit 0 + lock + determinism; PRs #24/#19/#22 ported w/ credit |
| A3 golden harness | feat/golden-retrieval-harness (worktree a3, branched from fix/windows-paths) | running | pending | pending | needs synthetic full-store fixture (journal/rooms/pipeline/insights/CJK/stale); 26 queries in 4 cats (A10/B6/C4/D6); token est = chars/4 (session-start.ts:174) |
| A4 latency+injection | feat/latency-injection-bench (worktree a4, from fix/windows-paths; --store golden-v1 else corpus-v1) | running | pending | pending | |
| A5 wording | docs/claims-wording | last | | | inputs: Mem0 "published ~7k"; REPRODUCE.md:27 clone URL + "POSIX shell" prereq (Windows note); SKILL.md:16-17 tool counts; README:80-85,104,249 numbers → script+artifact or "self-measured, not in repo"; UPDATE-LOG §C0 says dist/server.js but mcp bin is dist/index.js (A6 finding) |
| A6 triage | — | DONE | PASS (after 1 fix round) | — | MERGE-AS-IS 5 (#17 #15 #25 #21 #28); hold #24/#22/#19 drafts until A2 merges |
| A7 sdk root | fix/sdk-global-root @ 95c5855 | DONE | PASS (INFO: ctor still setRoot for back-compat) | MET (sdk 41/41; failure set = baseline) | MERGED into integration a673fac |
| A8 windows CI | ci/windows-matrix (worktree a8 from 0e1c596) | running | pending | — (cannot run Actions without push) | also consider `npm test --workspaces --if-present` so one package's failure doesn't hide the others (A0 finding) |
| A9 release draft | reports/RELEASE-3.5.0-draft.md | DONE | PASS (after 1 fix round) | — | 28/51 patches with new public surface; 2 self-labelled BREAKING; 38/51 no notes; core skipped 8 npm versions |
| B0 baseline | — | DONE | — | — | 1092 passed/66 skipped; novada 640 hits/69 files; 41 plywood filenames; 19 root files |
| B1 scrub | fix/scrub-internals @ 56dd13d (8 commits) | DONE | PASS (after 1 fix round) | pending (batch) | MERGED into agent-craft integration cf3bf0f (1 conflict in cli/tests/test_pipeline.py resolved to integration side: S4 had deleted the test B1 edited); class-b sweep on integration = 0; 640→560 hits, all product/tool names (369 in live-comp artifacts) → OWNER DECISION keep vs neutralize; class-b = 0 except plugin.json email; raw before-dump parked at E:/tools/b1-scripts/ (owner deletes) |
| B2 park legacy | chore/park-legacy @ fa62ab8 | DONE | PASS (after 1 fix) | pending (batch) | MERGED into agent-craft integration daca9ba; root 7 files; G2 44 files justified; 38 links; docs/update-log.html still Plywood-branded → B3; 1 unguarded pytest run before mitigation |
| B3 identity | docs/handoff-identity @ 08efaa5 (4 commits) | DONE | running (reviewer-b3) | pending | update-log.html MOVED to docs/history (owner may prefer banner); includes B6 default evidence-status paragraph, update-log.html banner, stale docstring | dead citation README:120 + CRAFT-PIPELINE:27; HANDOFF Mac path/2026-09-12 |
| B4 s4 trial | test/s4-merge-trial @ 2c6d260 | DONE_WITH_CONCERNS (gate violation on process) | PASS (merge) | pending (batch) | MERGED into agent-craft integration bb3834f; merged-state suite 675/0/66; minor: docstring tests/test_truncation_and_stderr_visibility.py:11 stale; retire-sweep tests skip on win32 (POSIX CI verifies); VERDICT MERGE; 673 passed/0 failed (−419 tests from 4A shrink, 5 test files deleted → being restored into attic/); truth-table 14/14; **gate violation: deleted 88 files in owner's real store** (documented in incident addendum) |
| B5 encoding | fix/encoding-scoreboard @ 4771608+3aecf14+051d7b9 | DONE | PASS | pending (batch) | MERGED into agent-craft integration ba796a0; 1094 passed; guarded re-run clean; 8 unguarded runs before mitigation |
| B6 raw battery | — | owner question | | | default README: only aggregates survive |
| B7 opaque experiment | — | owner-gated, not started | | | |
| A10 linux core tests | fix/linux-core-tests @ 7697a47 (6 fixes) | DONE | running (reviewer-a10, incl. merge-forward vs A2 — sync-errors test touched by both) | pending | Linux non-root: core 13→0, all 4 pkgs green, ci.yml chain exit 0; Win core 31→28; filelock progress-aware deadline + win32 EPERM=contended + embeddings cache key + updateIndex equal-mtime + 2 test setups |
| B8 ar_bridge HOME | fix/ar-bridge-home @ 1772cc1 | DONE | PASS | MET (verify-B-int1 @ 7ac5d78: unguarded run 703/0, 0 real-store writes, census unchanged; unfiltered 715/117/0) | MERGED 7ac5d78; root files now 8 (conftest.py) |

Safety protocol additions: every Repo-B run → `AGENT_RECALL_HOME=$TMP/ar-home-x AGENT_CRAFT_HOME=$TMP/ac-home-x`; verify `find ~/.agent-recall -type f -newermt <start> | wc -l` = 0.
Owner actions so far: top-up relay (done); decide deletion of 490+36(+12) fixture SOPs in real store; plugin.json email; post A6 drafts; decide 3.5.0.

Git identity for merges: `git -c user.name=goldentree -c user.email=tongwu0824@gmail.com` (owner's existing identity; no global identity on this PC).

12:59Z gateway outage #2 (503 No available accounts): A10, reviewer-a2, A3, A4 died mid-task; resumed via SendMessage at ~13:02Z.

verify-B-int1 (7ac5d78): all 5 exit conditions MET; novada product-name mentions 1083 incl. B1 artifacts (owner decision); plywood: 46 content files + 39 filenames outside reports/docs/history (shims/history banners; no bar set).
