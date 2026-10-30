## Per-phase
| phase | dispatches | models | tool calls | tokens in | out | cache-write | cache-read | wall ¦² | elapsed |
|---|---|---|---|---|---|---|---|---|---|
| (unphased) | 8 | claude-sonnet-5-5 | 373 | 1,286 | 654,902 | 4,158,163 | 80,475,725 | 221m 28s | 282m 42s |
| P1/W1 | 1 | claude-sonnet-5-5 | 64 | 216 | 180,599 | 1,241,275 | 11,274,938 | 112m 11s | 112m 11s |
| (orchestrator) | - | claude-fable-5-1, claude-opus-5-5 | 222 | 7,154 | 908,145 | 11,159,920 | 106,366,499 | ¨C | 386m 24s |
| TOTAL | 9 | claude-fable-5-1, claude-opus-5-5, claude-sonnet-5-5 | 659 | 8,656 | 1,743,646 | 16,559,358 | 198,117,162 | 333m 39s | 386m 24s |
wall ¦² sums each dispatch's own span (parallel dispatches add up); elapsed is calendar time.

## Per-dispatch
| phase | description | model | tool calls | tokens in | out | cache-write | cache-read | wall | transcript |
|---|---|---|---|---|---|---|---|---|---|
| (unphased) | Review AgentRecall recall fix | claude-sonnet-5-5 | 10 | 38 | 13,100 | 165,980 | 568,359 | 9m 34s | ok |
| P1/W1 | W1: ledger core library | claude-sonnet-5-5 | 64 | 216 | 180,599 | 1,241,275 | 11,274,938 | 112m 11s | ok |
| (unphased) | RT: red-team the W1 SOP | claude-sonnet-5-5 | 9 | 26 | 52,186 | 218,760 | 699,519 | 3m 08s | ok |
| (unphased) | W2: verify/trace/backfill + CLI | claude-sonnet-5-5 | 68 | 216 | 128,404 | 2,227,049 | 9,875,151 | 110m 02s | ok |
| (unphased) | W3: class-fix unledgered mutations | claude-sonnet-5-5 | 125 | 466 | 253,654 | 559,288 | 46,292,313 | 49m 55s | ok |
| (unphased) | W4: MCP trace tool + arsave verify | claude-sonnet-5-5 | 45 | 154 | 59,774 | 230,505 | 6,883,270 | 15m 37s | ok |
| (unphased) | R: review the P1 ledger diff | claude-sonnet-5-5 | 41 | 136 | 77,364 | 364,466 | 5,699,412 | 4m 34s | ok |
| (unphased) | W5: fix round after review R | claude-sonnet-5-5 | 55 | 180 | 52,103 | 196,750 | 8,303,204 | 12m 17s | ok |
| (unphased) | V: verify P1 SUCCESS_WHEN | claude-sonnet-5-5 | 20 | 70 | 18,317 | 195,365 | 2,154,497 | 16m 20s | ok |

(skipped_lines=0, duplicate_tool_use_ids=0)
