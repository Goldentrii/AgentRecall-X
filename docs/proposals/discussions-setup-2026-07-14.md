# GitHub Discussions Setup — 2026-07-14

10-line plan for enabling GitHub Discussions on Goldentrii/AgentRecall-MCP.

---

## Step 1: Enable Discussions

Repository Settings → Features → check "Discussions."

## Step 2: Create four categories

| Category | Type | Purpose |
|---|---|---|
| Field Reports | Open-ended | Real-use observations: what AR did, what you expected, scrubbed correction if relevant |
| Benchmark Numbers | Open-ended | `bench-result/v1` artifacts, corpus baselines, honest nulls |
| Adapters | Open-ended | MemoryBackend adapter work, host lifecycle reports, design questions |
| 中文区 | Open-ended | All Chinese-language discussion; mirrors the other categories |

## Step 3: Welcome post for each category

### Field Reports

> Field reports are the primary quality signal. Post what AR did, what you expected, and whether `session_start`/`session_end` fired. Scrub correction content with `ar scrub` before pasting — it is fail-closed (exits non-zero if a secret survives). Numbers and session counts beat prose. The `field_report` issue template collects the same fields if you prefer a structured format.

### Benchmark Numbers

> Post your `npm run bench` output here. Low scores and "CANNOT CLAIM" results are as useful as high ones — the field has enough vendor-selected positives. Minimum: `n_counted`, `corpus_hash`, the command you ran, and headline metrics with Wilson intervals. See `docs/eval/REPRODUCE.md` for reproduction steps and the `benchmark_result` issue template for the full field list.

### Adapters

> Design questions, implementation notes, and progress updates for `MemoryBackend` adapters (Mem0, Letta, others) and host lifecycle adapters (Cursor, Codex, Windsurf). Start here before opening a PR. The good-first issue drafts in `docs/proposals/good-first-issues-2026-07-14.md` have the acceptance criteria for the first adapter tracks.

### 中文区

> AgentRecall 的中文讨论区。Field Report、benchmark 数字、适配器问题都可以在这里发。提纠正内容时请先跑 `ar scrub`（fail-closed，有 secret 存活则非零退出）。数字和会话次数比文字描述有用。
