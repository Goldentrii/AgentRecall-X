# Orchestrator notes — 2026-10-11 handoff (AgentRecall-X + Agent Craft)

Live status (update as results arrive). Worktrees: E:/tools/AgentRecall-X-{a1,a2,a7}, E:/tools/agent-craft-{b1,b2,b4,b5,b8}. Integration branches: integration-2026-10 in both repos (local only).

| Task | Branch / worktree | Worker | Reviewer | Verifier | Notes |
|---|---|---|---|---|---|
| A0 baseline | main clone | DONE_WITH_CONCERNS | — | — | 36 fail (core 31/mcp 3/cli 2); root `npm test` &&-chain stops after core; heeded-guard 5/9 also on Linux CI; CI red 19 runs since 2026-07-27 |
| A1 heeded-guard | fix/heeded-guard @ 1f02471+2aada8e | DONE | PASS | MET (verify-A1-A7: 9/9 Win+Linux) | MERGED e4ae25c; root cause afd9b0a (v3.4.49 async writeCorrection/recordOutcome); 2 awaits in guard only; 9/9 |
| A2 windows-paths | fix/windows-paths @ 4cf8d97 | DONE | PASS (security PASS) | MET (verify-A2 @ 0e1c596: bench exit 0 + lock + determinism; persistent Windows failures = 1 (race → A10); 12 load-timeout flakes all pass isolated) | MERGED 0e1c596 |
| A3 golden harness | feat/golden-retrieval-harness @ 762d8af | DONE | PASS (3 INFO advisories) | reproduced 19/26 Win+Linux, determinism PASS | MERGED 3c8b095; fixture hit@5 73.1% keyword / 80.8% embeddings (local only); structural bugs (pipeline dir, loose rooms file, cross-project silo) reproduce → next product wave |
| A4 latency+injection | feat/latency-injection-bench @ 6084ffe | DONE | PASS (after 1 fix round: yml markers) | reproduced 244/264 Win+Linux | MERGED 050593a; golden-v1 injection median 244 / p95 264 tokens; recall p95 209 ms, session_start p95 97 ms (under load) |
| A5 wording | docs/claims-wording @ c2099c4 | DONE | PASS (after 1 fix round) | docs-only | MERGED (final); README numbers: a=4 regenerable, b=8 labelled private-store, c=1 local-no-artifact (80.8%), third-party=2 attributed |
| A6 triage | — | DONE | PASS (after 1 fix round) | — | MERGE-AS-IS 5 (#17 #15 #25 #21 #28); hold #24/#22/#19 drafts until A2 merges |
| A7 sdk root | fix/sdk-global-root @ 95c5855 | DONE | PASS (INFO: ctor still setRoot for back-compat) | MET (sdk 41/41; failure set = baseline) | MERGED into integration a673fac |
| A8 windows CI | ci/windows-matrix @ 471464a | DONE | PASS (after 1 fix round: fan-in `build-and-test` job for branch protection) | — (first Actions run is the proof) | MERGED cb46349; both lanes expected red until A10 lands, then green |
| A9 release draft | reports/RELEASE-3.5.0-draft.md | DONE | PASS (after 1 fix round) | — | 28/51 patches with new public surface; 2 self-labelled BREAKING; 38/51 no notes; core skipped 8 npm versions |
| B0 baseline | — | DONE | — | — | 1092 passed/66 skipped; novada 640 hits/69 files; 41 plywood filenames; 19 root files |
| B1 scrub | fix/scrub-internals @ 56dd13d (8 commits) | DONE | PASS (after 1 fix round) | pending (batch) | MERGED into agent-craft integration cf3bf0f (1 conflict in cli/tests/test_pipeline.py resolved to integration side: S4 had deleted the test B1 edited); class-b sweep on integration = 0; 640→560 hits, all product/tool names (369 in live-comp artifacts) → OWNER DECISION keep vs neutralize; class-b = 0 except plugin.json email; raw before-dump parked at E:/tools/b1-scripts/ (owner deletes) |
| B2 park legacy | chore/park-legacy @ fa62ab8 | DONE | PASS (after 1 fix) | pending (batch) | MERGED into agent-craft integration daca9ba; root 7 files; G2 44 files justified; 38 links; docs/update-log.html still Plywood-branded → B3; 1 unguarded pytest run before mitigation |
| B3 identity | docs/handoff-identity @ 20a2b17 (5 commits) | DONE | PASS (after 3 one-line fixes) | docs-only | MERGED 28dd8e0; Repo B HANDOFF-STATUS written + committed; update-log.html MOVED to docs/history (owner may prefer banner); includes B6 default evidence-status paragraph, update-log.html banner, stale docstring | dead citation README:120 + CRAFT-PIPELINE:27; HANDOFF Mac path/2026-09-12 |
| B4 s4 trial | test/s4-merge-trial @ 2c6d260 | DONE_WITH_CONCERNS (gate violation on process) | PASS (merge) | pending (batch) | MERGED into agent-craft integration bb3834f; merged-state suite 675/0/66; minor: docstring tests/test_truncation_and_stderr_visibility.py:11 stale; retire-sweep tests skip on win32 (POSIX CI verifies); VERDICT MERGE; 673 passed/0 failed (−419 tests from 4A shrink, 5 test files deleted → being restored into attic/); truth-table 14/14; **gate violation: deleted 88 files in owner's real store** (documented in incident addendum) |
| B5 encoding | fix/encoding-scoreboard @ 4771608+3aecf14+051d7b9 | DONE | PASS | pending (batch) | MERGED into agent-craft integration ba796a0; 1094 passed; guarded re-run clean; 8 unguarded runs before mitigation |
| B6 raw battery | — | owner question | | | default README: only aggregates survive |
| B7 opaque experiment | — | owner-gated, not started | | | |
| A10 linux core tests | fix/linux-core-tests @ 61b4a02 | DONE | PASS (after 1 fix round) | Linux non-root chain exit 0 (core 1860/0); Win core 1858/1860 (1 named skip + 1 load flake) | MERGED aff5b22; CI should go green on both lanes now |
| B8 ar_bridge HOME | fix/ar-bridge-home @ 1772cc1 | DONE | PASS | MET (verify-B-int1 @ 7ac5d78: unguarded run 703/0, 0 real-store writes, census unchanged; unfiltered 715/117/0) | MERGED 7ac5d78; root files now 8 (conftest.py) |

Safety protocol additions: every Repo-B run → `AGENT_RECALL_HOME=$TMP/ar-home-x AGENT_CRAFT_HOME=$TMP/ac-home-x`; verify `find ~/.agent-recall -type f -newermt <start> | wc -l` = 0.
Owner actions so far: top-up relay (done); decide deletion of 490+36(+12) fixture SOPs in real store; plugin.json email; post A6 drafts; decide 3.5.0.

Git identity for merges: `git -c user.name=goldentree -c user.email=tongwu0824@gmail.com` (owner's existing identity; no global identity on this PC).

12:59Z gateway outage #2 (503 No available accounts): A10, reviewer-a2, A3, A4 died mid-task; resumed via SendMessage at ~13:02Z.

verify-B-int1 (7ac5d78): all 5 exit conditions MET; novada product-name mentions 1083 incl. B1 artifacts (owner decision); plywood: 46 content files + 39 filenames outside reports/docs/history (shims/history banners; no bar set).

2026-10-11 ~16:00Z gateway outage #3 (503); overnight gap; agents resumed 2026-10-12 ~07:40Z.
- 2026-10-12: scratch clone C:/Users/tong/AppData/Local/Temp/eval/AgentRecall-X deleted per handoff §4 (patch ported in A2 a81a250).

FINAL VERIFICATION (reports/2026-10-12-verify-final.md @ cae060a): Windows core 1859/1860 (1 named skip) · mcp 76/79 (3 named skips) · sdk 41/41 · cli 293/293 · heeded 9/9 · bench exit 0 lock+determinism · golden 19/26 determinism PASS · injection 244/264 · YAML ok · 0 markers. Linux non-root ci.yml chain exit 0; all 4 packages 0 fail; golden + injection identical. ~/.agent-recall untouched. Untracked artifacts left by the benches: scripts/eval/baselines/{injection,latency}-2026-10-12.json (owner: delete or keep; not committed). Docker from Git Bash needs MSYS_NO_PATHCONV=1 for -e HOME=/tmp/h.

2026-10-12 owner approval: real-store cleanup done (backup E:/tools/ar-store-backup-2026-10-12.tgz; agent-craft 472→0, tong 36→0, cli 17→5); agent-craft main @ 005ee2f pushed; AgentRecall-X: 3.5.0 bump (4 pkgs + core pins + types.ts VERSION + CHANGELOG 3.4.51 stub + 3.5.0 entry), lockfile had stale 3.4.48 workspace versions → nested registry copies shadowed the core link (fixed by relinking); merged to main, tagged v3.5.0, pushed. npm publish not requested. Linear dropped by owner. MCPVault badge kept.

2026-10-12 post-release: first Actions runs on main @ 9072d37 — ubuntu lane GREEN (first since 2026-07-27); windows lane RED (recordOutcome stress 290/480 on 2-vCPU runner; identity-trust 8.3 short-name path compare); bench lane RED (home-leak guard false positive: runner checkout lives under /home/runner). release.yml (pre-existing) auto-created GitHub Release v3.5.0 (War Room zip + generated notes; NO npm publish). A11 on fix/ci-post-release: ITEM 1 (guard) 12c4ec3 PASS; ITEM 2 067bf16 (counters re-derived from ledger under waitForLiveHolder; realpath.native + case-folded compare keys; win32 renameAtomic retry) under review (reviewer-a11b). Release notes prepared: reports/RELEASE-NOTES-v3.5.0.md (apply via gh release edit after CI green). Worktrees removed except a11.
