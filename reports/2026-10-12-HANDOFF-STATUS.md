# AgentRecall-X — Handoff status 2026-10-12 (Repo A)

Branch `integration-2026-10` on `E:/tools/AgentRecall-X`, base `main` @ db6338a (v3.4.51). **2026-10-12: owner approved → versions bumped to 3.5.0 in lockstep, merged into `main`, tagged `v3.5.0`, pushed (npm publish NOT done — separate owner call).** Merge order: A7 → A1 → A2 → A3 → A8 → A10 → A4 → A5 (docs). Worktrees `E:/tools/AgentRecall-X-{a1,a2,a3,a4,a5,a7,a8,a10}` (owner may remove). Final verification `reports/2026-10-12-verify-final.md` @ cae060a: **Windows 0 failures** (core 1859/1860 + 1 named skip, mcp 76/79 + 3 named skips, sdk 41/41, cli 293/293), **Linux non-root ci.yml chain exit 0**, heeded-guard 9/9, `npm run bench` exit 0 + lock + determinism, `bench:golden` 19/26 determinism PASS, `bench:injection` 244/264 identical on both OS, YAML valid, owner's `~/.agent-recall` untouched all day.

| Task | Branch @ head | Worker | Reviewer | Verifier | Evidence | Owner action |
|---|---|---|---|---|---|---|
| A0 baseline | — | DONE | — | — | `reports/2026-10-11-baseline-A.md` (36 Windows fails; bench FATAL; CI red 19 runs since 2026-07-27) | — |
| A1 heeded-guard (CI red root cause) | `fix/heeded-guard` @ 2aada8e | DONE | PASS | MET (9/9 Win+Linux) | `…-A1-report.md`, `…-A1-review.md` | open PR (draft text in report) |
| A2 Windows portability | `fix/windows-paths` @ 4cf8d97 | DONE | PASS (security PASS) | MET | `…-A2-report.md`, `…-A2-review.md`, `…-verify-A2.md` | open PR; post the draft replies to PRs #24/#22/#19 AFTER merge (Co-authored-by credit) |
| A3 golden retrieval harness | `feat/golden-retrieval-harness` @ 762d8af | DONE | PASS | MET (19/26 both OS; embeddings leg 21/26 local-only, no artifact) | `…-A3-report.md`, `…-A3-review.md`; fixture `scripts/eval/fixtures/golden-v1`, `baselines/golden-v1-2026-10-11.json` | decide CV wording: fixture hit@5 **73.1% keyword / 80.8% local embeddings** (regenerable) vs private-store 75→90% (self-measured) |
| A4 latency + injection bench | `feat/latency-injection-bench` @ 6084ffe | DONE | PASS (after 1 fix: merge markers) | MET (244/264) | `…-A4-report.md`, `…-A4-review.md`; `baselines/injection-2026-10-11.json`, `latency-2026-10-11.json` | fixture: **244 tokens median injection, p95 session_start 97 ms / recall 209 ms (under load)**; private-store 1,489 / 363 labelled non-regenerable; untracked `baselines/*-2026-10-12.json` left by the verifier — delete or keep |
| A5 wording | `docs/claims-wording` @ c2099c4 | DONE | PASS (after 1 fix round: 80.8% relabelled, /arstart bootstrap → CLI) | docs-only (links 28/0, package copies synced) | `reports/2026-10-12-A5-report.md`, `…-A5-review.md` | CHANGELOG "Unreleased" → version (3.5.0 proposed); MCPVault badge loads a third-party image with utm params (egress) — keep or drop |
| A6 community triage | — (drafts) | DONE | PASS (after 1 reword) | — | `reports/2026-10-11-A6-triage.md` | post the 22 PR + 3 issue comments in the stated order; merge #17 #15 #25 #21 #28 (MERGE-AS-IS); close #26 (fixed v3.4.36), #4 (links fixed in A5), answer #1 |
| A7 SDK global-root leak | `fix/sdk-global-root` @ 95c5855 | DONE | PASS | MET (41/41) | `…-A7-report.md`, `…-A7-review.md` | open PR |
| A8 Windows CI lane | `ci/windows-matrix` @ 471464a | DONE | PASS (after 1 fix: fan-in `build-and-test` job) | YAML valid; first real Actions run is the proof | `…-A8-report.md`, `…-A8-review.md` | after push: confirm both lanes green; branch protection keeps context `build-and-test` |
| A9 release 3.5.0 draft | — | DONE | PASS (after 5 corrections) | — | `reports/RELEASE-3.5.0-draft.md`, `…-A9-review.md` | decide bump (28/51 of 3.4.x patches had new public surface; 2 self-labelled BREAKING; 38/51 no notes); keep PR #42 out → `next` dist-tag |
| A10 Linux `npm test` (NEW) | `fix/linux-core-tests` @ 61b4a02 | DONE | PASS (after 2 fixes) | MET (Linux all green) | `…-A10-report.md`, `…-A10-review.md` | open PR |

What the CV can now say truthfully (A5 report has the one-liner): correction-first memory (MCP + SDK + CLI + skill), RRF retrieval, FSRS-lite decay; hash-locked fixture benches with CI determinism + claim gates (`npm run bench`, `bench:golden`, `bench:injection`, `bench:latency`); golden-set hit@5 73.1% keyword on fixture v1 (regenerable, `npm run bench:golden`); 80.8% with the opt-in local embeddings model (measured locally on the same fixture, no committed artifact — needs the ~145 MB model); private-store run 90% (self-measured); ~250-token session injection and p95 < 100 ms on fixture v1 (private-store 1.5k / 363 ms, self-measured); CI green on ubuntu + windows once the branch is pushed.

Incidents: relay outages (403 insufficient balance; 503 no available accounts ×2) killed agents three times — all resumed from transcripts. No gate crossed: nothing pushed, published, bumped, deleted (except the temp scratch clone the handoff authorised), or posted to GitHub.

Suggested next step: `git checkout main && git merge --no-ff integration-2026-10` → push → watch `build-and-test` on both lanes → then `gh pr` the community merges and post the A6 comments → decide 3.5.0.

## Post-release (2026-10-12, owner-approved push/merge/version)

- Real-store cleanup done (backup `E:/tools/ar-store-backup-2026-10-12.tgz`); Agent Craft `main` @ 005ee2f pushed; AgentRecall-X **v3.5.0** tagged + pushed (lockstep bump, CHANGELOG 3.4.51 stub + 3.5.0 entry); the pre-existing `release.yml` auto-created the GitHub Release (War Room zip); notes replaced with `reports/RELEASE-NOTES-v3.5.0.md`. **npm publish NOT done** (owner call).
- First Actions runs exposed starved-runner defects; fixed on `main` after the tag (each reviewed, see table):

| Task | Branch @ head | Reviewer | CI effect |
|---|---|---|---|
| A11 | `fix/ci-post-release` @ a6c9653 | PASS (ITEM 1 + ITEM 2) | bench lane green (home-leak guard); windows: recordOutcome counters from ledger, 8.3 path keys, NTFS rename retry |
| A12 | `fix/alignment-log-rmw` @ da57a4d | PASS after 1 fix round | check()/feedback-log waitForLiveHolder; recall never stalls on the feedback write (≤1 s grace, `feedback_log_pending`) |
| A13 | `fix/rename-retry-budget` @ 3d5d7d6 | PASS | renameAtomic 5 s budget; deterministic rename-retry test |
| A14 | `fix/alignment-log-lock-robustness` @ 38ab632 | PASS after 1 fix round | lock release tombstone (NTFS pin); alignment/feedback logs append-only NDJSON; 17 new format tests |

- **CI run 38266476493 on `main` @ 9b84e68: `test (ubuntu-latest)`, `test (windows-latest)`, `build-and-test`, and the bench-fixture lane all GREEN** — the first fully green main since 2026-07-27, now on two platforms.
- Follow-ups (INFO, not blocking): cli spawned-process timeout flakes on heavily loaded local machines (runner unaffected); `.json` files holding NDJSON kept for path compatibility; recordOutcome replay cost grows linearly with ledger size (prefilter later); 3.5.1 could carry the post-tag fixes; npm publish of 3.5.0 (core → mcp → cli → sdk).
