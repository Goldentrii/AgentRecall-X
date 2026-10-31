# Cards v1 — injection bench (2026-10-31)

Payload = `formatTerse(sessionStart({project}))` (MCP `session_start` default, `verbose=false`); tokens = ceil(chars/4). Same estimator, same harness (`scripts/eval/session-start-size.mjs`, `session-start-size-v1`) for every row.

| Store | median tokens | p95 | max | median chars | per-project chars |
|---|---|---|---|---|---|
| golden-v1 before (cfdd084) | 231 | 251 | 251 | 924 | alpha-platform=924 beta-api=1003 gamma-cli=712 |
| golden-v1 after (36987d3 + Task 7) | 231 | 251 | 251 | 924 | alpha-platform=924 beta-api=1003 gamma-cli=712 |
| cards-at-cap after | 1215 | 1234 | 1234 | 4857 | alpha-platform=4857 beta-api=4936 gamma-cli=4645 |

- golden-v1 holds no cards, so cards v1 adds 0 chars to it (delta 0, per project and in aggregate).
- Cards at cap: identity card 1,674 bytes on disk (body 1,600 chars + frontmatter), each state card 2,357 bytes on disk (file cap 2,400).

## Added at cap (limit 4,200 chars)

| Measure | Added chars | Headroom to 4,200 | Source |
|---|---|---|---|
| Terse payload (what the model reads) | **3,933** | 267 | cards-at-cap minus golden-v1 after, identical for all three projects (4857-924, 4936-1003, 4645-712); +984 median tokens (1215-231) |
| JSON payload (`JSON.stringify(sessionStart())`) | **4,034** | 166 | Test 15 `json_delta` |
| Terse sections only (`formatOwnerSection` + blank line + `formatStateSection`) | 3,931 | 269 | Test 15 `terse_added`; 2 chars less than the bench delta because the bench also counts the section-joining newlines |

Both measures pass the §7.5 acceptance (≤ 4,200). Hand estimate in the plan was json 4,057 / terse 3,931; measured json is 23 chars lower, terse matches exactly.

## Why the committed baseline moved (223 -> 231 median tokens)

`scripts/eval/baselines/injection-2026-10-31.json` is regenerated on purpose and committed. The previous baseline (`injection-2026-10-15.json`, core 3.5.1 at c52e37e) recorded median 223 tokens / 890 chars. The untouched 3.5.2 base (cfdd084) already measures 231 tokens / 924 chars: a uniform +34 chars per project that landed with the 3.5.2 release (suspected cause: the per-render fence nonce widened from 4 to 16 hex chars, 1ee606b, plus other 3.5.2 rendering changes; not bisected). Cards v1 itself contributes 0 to golden-v1: before (cfdd084) and after (36987d3 + Task 7) are identical per project. The new baseline has the same `store_hash` as before (`6816ea41d9f9...`), so only the code moved, not the fixture.

Note: the `before` artifact's `git_commit` reads `8324155`, the pre-rebase hash of the docs-only spec commit now `a8b1ded` on top of cfdd084; no source differs from cfdd084.

## Commands

```bash
# build, then measure (AGENT_RECALL_ROOT must be unset)
B=.superpowers/bench && npm run build \
&& node scripts/eval/session-start-size.mjs --no-artifact --json > $B/after-golden.json \
&& node scripts/eval/cards-at-cap-fixture.mjs $B/cards-at-cap \
&& node scripts/eval/session-start-size.mjs --store $B/cards-at-cap --no-artifact --json > $B/after-at-cap.json \
&& node scripts/eval/session-start-size.mjs --check-determinism \
&& npm run bench:injection          # writes scripts/eval/baselines/injection-2026-10-31.json

# budget test (prints cards-at-cap: json_delta=4034 terse_added=3931)
node --test packages/core/test/session-start-injection.test.mjs
```

`--check-determinism` printed `determinism OK (double-run byte-identical excluding generated_utc)`. P0 survival is OK for all three projects in both stores.
