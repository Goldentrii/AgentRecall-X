# Cards v2 (G6) — injection bench (2026-10-31 / 11-01)

Payload = `formatTerse(sessionStart({ project, mode }))`, i.e. agent-recall-core's `renderSessionStart` with the hook-less tail (what the MCP `session_start` tool returns at `verbose=false`); tokens = ceil(chars/4). Same estimator and harness as the v1 report (`scripts/eval/session-start-size.mjs`, now `session-start-size-v2` with `--mode cards|full`). `cards` is the new default of the MCP tool, `ar hook-start` and the SDK; `full` is the previous payload. Measured on this Windows box at branch head (Part 1 + G6 commits), `AGENT_RECALL_ROOT` unset, fresh temp copy per project row.

| Store | mode | projects | median tokens | p95 | max | median chars | min–max chars | P0 survival |
|---|---|---|---|---|---|---|---|---|
| golden-v1 (no cards) | **cards** | 3 | **88** | 91 | 91 | 351 | 343–362 | 2/2 OK |
| golden-v1 (no cards) | full | 3 | 231 | 251 | 251 | 924 | 712–1003 | 2/2 OK |
| cards-at-cap (identity 1,600 chars + max state card per project) | **cards** | 3 | **1,071** | 1,074 | 1,074 | 4,284 | 4,170–4,295 | 2/2 OK |
| cards-at-cap | full | 3 | 1,215 | 1,234 | 1,234 | 4,857 | 4,645–4,936 | 2/2 OK |
| lived-in copy (owner's store: 45 projects, 40 with journals, 150 recency entries, 14 P0s in 7 projects, **no cards yet**) | **cards** | 45 | **91** | 131 | 160 | 361 | 331–638 | 14/14 OK |
| lived-in copy | full | 45 | 354 | 538 | 591 | 1,415 | 1,194–2,363 | 14/14 OK |

- `full` reproduces the v1 report exactly (golden 231 / 924, at-cap 1,215 / 4,857): the shared renderer is byte-compatible with the old MCP `formatTerse` on these fixtures (the Trajectory/Next dedupe does not fire on them — neither fixture has a journal `## Next`).
- `cards` on the card-less golden fixture is header + HARD RULES only: −62 % tokens (231 → 88). With both cards at cap the payload is the cards themselves: −12 % (1,215 → 1,071; the 144 tokens saved are the full-mode sections the fixture carries).
- Lived-in store: the default injection drops from 354 to 91 median tokens (−74 %); per project the cards payload is 19–29 % of the full one (median 25 %). The store has no identity card and no state cards yet (cards v1 is not installed on this machine), so once the owner runs `ar identity init` and a few `session_end`s write state cards, expect roughly +400 tokens for the owner card plus 140–600 per project for the state card (v1 report's estimate), i.e. a typical default payload of ~600–1,100 tokens instead of today's 354 — but now all of it is owner rules and curated state rather than journal excerpts.
- The 16,384-byte cap never engaged on any row (largest rendered payload: 4,936 chars at-cap full).

## Determinism and baseline

`--check-determinism` (double run, byte-identical excluding `generated_utc`) passed on golden-v1 (cards), cards-at-cap (cards) and cards-at-cap (full). The committed injection baseline for the new default is `scripts/eval/baselines/injection-2026-11-01-cards.json` (cards, golden-v1, median 88 tokens / 351 chars); `injection-2026-10-31.json` (full, 231 / 924, bench v1) stays as the full-mode reference. `verifyBaseline` checks internal consistency only (tokens = ceil(chars/4), headline stats), so both files keep verifying.

## Commands

```bash
# build first; AGENT_RECALL_ROOT must be unset
B=.superpowers/bench && npm run build \
&& node scripts/eval/cards-at-cap-fixture.mjs $B/cards-at-cap \
&& for mode in cards full; do \
     node scripts/eval/session-start-size.mjs --no-artifact --json --mode $mode > $B/golden-$mode.json; \
     node scripts/eval/session-start-size.mjs --store $B/cards-at-cap --no-artifact --json --mode $mode > $B/atcap-$mode.json; \
     node scripts/eval/session-start-size.mjs --store <copy of the live store> --no-artifact --json --mode $mode > $B/lived-$mode.json; \
   done \
&& node scripts/eval/session-start-size.mjs --check-determinism \
&& node scripts/eval/session-start-size.mjs --store $B/cards-at-cap --check-determinism \
&& npm run bench:injection            # writes scripts/eval/baselines/injection-<utc date>-cards.json
```

The lived-in store was measured on a temporary copy that was deleted afterwards; its per-project artifact is not committed (project slugs are the owner's).
