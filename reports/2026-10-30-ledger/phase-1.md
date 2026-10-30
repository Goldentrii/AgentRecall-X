# Phase P1 — ledger core, verify/trace/backfill, class-wide wiring, MCP/commands (DRAFT — numbers filled at phase end)

Dispatch/cost table: `python scripts/phase-report.py --session 7818e012-5426-49a3-8d01-96886f3dce68` (Agent Craft hooks recorded every dispatch).

| worker | model | commit(s) | tests added | result |
|---|---|---|---|---|
| RT adversarial-falsify | sonnet-5-5 | — | — | RECOMPILE: 17 findings (5 CRIT, 3 gating HIGH); 12 applied as W1 A1, 3 process-only, 2 waived (out of W1 scope) |
| W1 core library | sonnet-5-5 | e0a6d81 + f32d92c (A1) + _A2 pending_ | ulid 6, append 16→33 | green; CHALLENGED F1 correctly before RT reported it |
| W2 verify/trace/backfill + CLI | sonnet-5-5 | e073f42 + _A2 pending_ | verify 11, cli 11 | green alone; 6 integration failures after W3 → A2 |
| W3 class-fix wiring | sonnet-5-5 | 6c0fc43 | enforcement 4, class 17 | 28 modules wired, 37 derived, 0 not_fixed; RED proof via stash |
| W4 MCP + commands | sonnet-5-5 | _pending_ | | |
| R code-reviewer | sonnet-5-5 | | | |
| V verifier | sonnet-5-5 | | | → verify.md (SW-10) |

**Did:** spec with 14 decisions + normative schema; W1–W3 merged on `feat/ledger`; preview on a copy of the real store: 518 files → backfill 20 s → `verify: clean`, 42 projects with born/last dates, `orbitcard-clone` trace shows the 7 template files that this morning's `recall` bug created.
**Decided:** hashes not content (D6); reads not ledgered (D5); local-only (D7); append never throws (D8); semantic events via per-site wiring + enforcement test because no fs choke point exists (W3).
**Deviated:** W4 sequenced after W2 (needs `verifyLedger`); W1 dispatched before validator ran (cosmetic loop-shape flag); spec §8 amended after W3 (corrections paths, exclusions, move convention, full-ULID trace line); SW-3 "exactly three events" impossible once the class is closed → chain properties asserted instead.
**Open:** sync writers + immediate `process.exit()` can lose a queued event (orphan; backfill heals); `project.create` may land after scaffold events (chronology, not chain); Agent Craft still mirrors SOPs to the stale C: store (`AGENT_RECALL_HOME` vs `AGENT_RECALL_ROOT`); `agent-craft use` output is codepage-encoded on Windows unless `PYTHONUTF8=1`.
**Template restock candidates (RT/W FEEDBACK_HINTS):** briefs must state cwd for test runs and pin TEMP/TMP; baselines must be recorded before edits (or taken from the previous worker's numbers); `--vars` cannot carry commas; adversarial-falsify needs a seed invariant list and a scope rule for incidents owned by later workers; class-fix must not assume one choke point or fixed event counts.
