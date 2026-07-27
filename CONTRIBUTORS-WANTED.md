# Contributors Wanted

**English** · [中文见底部](#中文-tldr)

---

## The gap

Every agent memory tool claims "never repeats the same mistake." None of them publishes a number for it. No public benchmark measures whether a captured correction changes what a fresh agent does in a new session — not LongMemEval, not LoCoMo, not MemoryAgentBench. AgentRecall built that instrument and published what it found, including the unflattering numbers (35.3% capture recall, 0/4 offline transfer on our own sparse corpus). The instrument is open; the field needs external baselines.

---

## The 15-minute test

```bash
# 1. Install
claude mcp add --scope user agent-recall -- npx -y agent-recall-mcp

# 2. Use it for a week — let the agent correct you, let it save

# 3. Run the benchmark against your own corpus
#    (the bench lives in the repo, not the npm package — clone once)
git clone https://github.com/Goldentrii/AgentRecall-MCP.git && cd AgentRecall-MCP
npm ci && npm run bench    # reads your local ~/.agent-recall corpus

# 4. Post your numbers in GitHub Discussions → Benchmark Numbers
```

A low score is a valid result. Honest nulls are as useful as headline numbers — the field has enough vendor-selected positives.

---

## Three contribution tracks

### Track A — Benchmark adapters and external baselines

**What:** Implement a `MemoryBackend` adapter for Mem0 OSS or Letta, run HeedBench on your own correction corpus, and publish the numbers.

**Why it matters:** Every baseline in the field is self-reported. The first external corpus baseline — even if it scores 0 — breaks the self-report monopoly.

**First step:**

1. Read the `MemoryBackend` interface: `packages/core/src/tools-logic/memory-backend.ts`
2. Read the benchmark spec §5 adapter interface signatures: `docs/proposals/2026-07-02-correction-transfer-benchmark-spec.md`
3. Run the fixture corpus to confirm your setup: `docs/eval/REPRODUCE.md`
4. Implement `retain()` / `available()` / `name()` against the Mem0 or Letta SDK
5. Set `AR_MEMORY_BACKEND=your-adapter-package` and run `ar corrections export | your-adapter`
6. Open a Benchmark Numbers discussion with your `bench-result/v1` artifact

See issue drafts (a) and (b) in `docs/proposals/good-first-issues-2026-07-14.md` for the exact acceptance criteria.

---

### Track B — Host adapters

**What:** Document and implement the session lifecycle for Cursor, Codex, or Windsurf so AR's `session_start`/`session_end` fires reliably on those hosts.

**Why it matters:** AR currently auto-fires on Claude Code hooks only. Every other host is Tier B (agent-driven, best-effort, unmeasured). The open question — does the agent actually call `session_end` at exit ≥80% of the time on Codex? — has no answer yet.

**First step:**

1. Read `docs/internal/HOST-TIERS.md` — the honest per-surface contract and the OQ-6 measurement bar
2. Pick a host (Cursor MCP, Codex, Windsurf)
3. Run 5+ real sessions and record whether `session_start` / `session_end` actually fire
4. Open a Field Report issue with your log

See issue draft (c) in `docs/proposals/good-first-issues-2026-07-14.md`.

---

### Track C — Scrubbed corrections-corpus donation

**What:** Run `ar scrub` (fail-closed) on your corrections, verify no secrets survive, and share the scrubbed export in a Benchmark Numbers discussion.

**Why it matters:** Our own live corpus is 32 active corrections across 19 projects — too sparse to support any transfer-recall point estimate (claim-gate: needs 39 classes). External corpus donations are the only path to a claimable number.

**First step:**

```bash
ar corrections export --all-projects | ar scrub > my-corpus.jsonl
# If ar scrub exits non-zero, a secret survived — do not share until it exits 0
```

Post the result to GitHub Discussions → Benchmark Numbers with:
- `n_counted` (total records passing the count rule)
- `corpus_hash` from the benchmark artifact
- The command you ran

---

## Anti-track

Adding memory layers, retrieval models, or new tool surfaces is NOT wanted right now. The design is in a subtraction phase: we just removed 11 tools and 2,100 lines to get to 5 MCP tools. PRs that add features without a paired benchmark result showing the feature helps will not be merged. Open an issue to discuss before building.

---

## Links

| Resource | Path |
|---|---|
| Measured numbers table | [README.md §Measured, not promised](README.md#measured-not-promised) |
| Benchmark reproduction steps | [docs/eval/REPRODUCE.md](docs/eval/REPRODUCE.md) |
| Benchmark spec (HeedBench v1) | [docs/proposals/2026-07-02-correction-transfer-benchmark-spec.md](docs/proposals/2026-07-02-correction-transfer-benchmark-spec.md) |
| MemoryBackend adapter seam | [packages/core/src/tools-logic/memory-backend.ts](packages/core/src/tools-logic/memory-backend.ts) |
| Host tiers (lifecycle contract) | [docs/internal/HOST-TIERS.md](docs/internal/HOST-TIERS.md) |
| Good-first issue drafts | [docs/proposals/good-first-issues-2026-07-14.md](docs/proposals/good-first-issues-2026-07-14.md) |

---

## Contact

**GitHub Discussions** is the primary channel — open a thread in the relevant category (Field Reports / Benchmark Numbers / Adapters / 中文区).

**WeChat** (中文交流): `<WECHAT>`

---

## 中文 TL;DR

AgentRecall 是一个纠正记录账本 + 测量工具，追踪 AI agent 是否真的停止重复错误。整个领域没有任何公开 benchmark 测量跨会话行为变化——我们建了这个测量工具，并公开了包括难看数字在内的所有结果。

**三条贡献路径：**
- **A（benchmark 适配器）**：为 Mem0/Letta 实现 `MemoryBackend` 适配器，在自己的语料库上跑 HeedBench，发布数字
- **B（Host 适配器）**：为 Cursor/Codex/Windsurf 记录会话生命周期行为，实测 `session_end` 是否在退出时真正触发
- **C（语料库捐赠）**：用 `ar scrub`（fail-closed）清洗自己的纠正记录，发布到 Benchmark Numbers 讨论区

**不欢迎**：添加 memory 层或新工具。项目当前处于减法阶段，没有配对 benchmark 结果的 feature PR 不会被合并。

联系方式：GitHub Discussions（中文区欢迎），或在讨论区询问作者微信：`<WECHAT>`。
