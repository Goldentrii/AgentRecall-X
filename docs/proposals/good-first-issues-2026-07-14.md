# Good First Issues — 2026-07-14

Six ready-to-post issue drafts. Each is self-contained: a stranger can start without asking.
Non-goals are explicit; acceptance criteria are testable; files to read first are listed with paths verified to exist.

---

## (a) Mem0 OSS adapter for the HeedBench offline harness

**Title:** `feat(adapters): Mem0 OSS MemoryBackend adapter`

**Labels:** `good first issue`, `adapters`, `benchmark`

**Body:**

### What

Implement a `MemoryBackend` adapter that pushes scrubbed `CorrectionExport` records into a local Mem0 OSS instance. The adapter is a small npm package (`ar-mem0-adapter` or similar) that satisfies the three-method interface.

### Why

The `MemoryBackend` seam exists to make external belief stores a configured sync destination, but no third-party adapter exists yet. A Mem0 adapter is the first external baseline for HeedBench — even a score of 0 breaks the self-report monopoly.

### Files to read first

1. `packages/core/src/tools-logic/memory-backend.ts` — the `MemoryBackend` interface (three methods: `retain()`, `available()`, `name()`) and the dynamic-import factory contract
2. `docs/proposals/2026-07-02-correction-transfer-benchmark-spec.md` §5 — adapter interface signatures and what the offline scorer needs from the public core API
3. `docs/eval/REPRODUCE.md` — how to run the fixture corpus as a dev target
4. `scripts/eval/fixtures/corpus-v1/` — the frozen fixture corpus (23 counted records across 4 synthetic projects)

### Acceptance criteria

- [ ] Package exports a default class satisfying `MemoryBackend` (`retain`, `available`, `name`)
- [ ] `AR_MEMORY_BACKEND=ar-mem0-adapter npm run bench` completes without error on the fixture corpus
- [ ] `available()` returns `false` (not an exception) when Mem0 is not running
- [ ] `retain()` input is always pre-scrubbed `CorrectionExport[]` — the adapter must NOT re-implement scrubbing
- [ ] Tests use a local Mem0 instance (not a mock) or document why mocking is necessary
- [ ] `bench-result/v1` artifact posted in a Benchmark Numbers GitHub Discussion

### Non-goals

- Do NOT modify `packages/core` to add Mem0 as a built-in backend — the dynamic-import path exists precisely to keep third-party adapters out-of-tree
- Do NOT implement the deferred live-tier `MemoryEngineAdapter` (spec §5 bottom section) — that interface is for future cross-session live execution, not for v1 offline scoring
- Do NOT add embeddings or semantic recall — the benchmark uses keyword + RRF; adding retrieval to the adapter without a paired eval is out of scope

---

## (b) Letta adapter for the HeedBench offline harness

**Title:** `feat(adapters): Letta MemoryBackend adapter`

**Labels:** `good first issue`, `adapters`, `benchmark`

**Body:**

### What

Same shape as issue (a), targeting Letta (formerly MemGPT). Implement a `MemoryBackend` adapter that pushes scrubbed `CorrectionExport` records into a Letta agent's memory store.

### Why

Letta claims long-term memory with automatic compaction. An independent HeedBench run on a Letta backend — even scoring 0 — is more useful than any self-reported number from their own benchmarks.

### Files to read first

1. `packages/core/src/tools-logic/memory-backend.ts` — the `MemoryBackend` interface
2. `docs/proposals/2026-07-02-correction-transfer-benchmark-spec.md` §5 — what the offline scorer needs
3. `docs/eval/REPRODUCE.md` — fixture corpus reproduction
4. `scripts/eval/fixtures/corpus-v1/` — dev target (23 counted records)

### Acceptance criteria

- [ ] Package exports a default class satisfying `MemoryBackend`
- [ ] `AR_MEMORY_BACKEND=ar-letta-adapter npm run bench` completes on the fixture corpus
- [ ] `available()` returns `false` without throwing when no Letta server is reachable
- [ ] `retain()` respects the `accepted`/`rejected` shape in `RetainResult`
- [ ] `bench-result/v1` artifact posted in a Benchmark Numbers discussion
- [ ] Adapter README states which Letta SDK version was tested (SDK versions matter — the Mem0/Zep dispute was partly a created_at timestamp disagreement)

### Non-goals

- Same as issue (a): no built-in backend modification, no live-tier interface, no new retrieval layers

---

## (c) Cursor host lifecycle adapter

**Title:** `docs(hosts): Cursor MCP lifecycle — measure whether session_start/session_end fire reliably`

**Labels:** `good first issue`, `host-adapters`, `measurement`

**Body:**

### What

Document what AR's `session_start` / `session_end` lifecycle actually does on Cursor (MCP client), and measure whether the agent calls them reliably without explicit prompting.

### Why

`docs/internal/HOST-TIERS.md` is honest: Cursor is Tier B (no hooks, agent-driven). The open question (OQ-6) — does the agent reliably call `session_end` at exit (≥80% of the time)? — has no data. The Tier-B "AGENT" label means "the agent is told to," not "the agent does." We need real numbers.

### Files to read first

1. `docs/internal/HOST-TIERS.md` — the host-tier framework, the Tier-A/B distinction, and OQ-6 (the measurement bar: ≥80% `session_end`-at-exit per host)
2. `README.md` Quick Start — Cursor MCP config
3. `packages/mcp-server/src/tools/session-start.ts:152` — where the Tier-B agent-driver instructions are surfaced (the `CLAUDE_CODE_HOOKS` branch)

### Acceptance criteria

- [ ] Run ≥10 real Cursor sessions with AR installed as an MCP server
- [ ] Record for each session: did `session_start` fire? did `session_end` fire? was there an explicit user "save" prompt or did the agent self-fire?
- [ ] Report raw counts and session notes as a Field Report issue (use the field_report template)
- [ ] If `session_end` fires < 80% of the time, open a follow-up issue proposing an improvement to the `instructions` carrier or tool descriptions — not a downgrade to "HUMAN-prompted"
- [ ] Do NOT modify the MCP server to add a Cursor-specific hook — the host does not expose hooks; workarounds that simulate hooks are out of scope for this issue

### Non-goals

- Building a Cursor extension or plugin
- Implementing the `AR_HOST` profile selector (deferred in HOST-TIERS.md — requires a separate design discussion)

---

## (d) Codex/raw-API explicit session-end pattern

**Title:** `feat(tier-b): Codex explicit session-end + export pattern (backlog #7)`

**Labels:** `good first issue`, `host-adapters`, `tier-b`

**Body:**

### What

Document and implement the explicit-call pattern for Tier-B hosts (Codex, chatbox, raw API) so the AR lifecycle works beyond Claude Code hooks. This is backlog item #7 from `contrib/hindsight-cookbook/AGENTRECALL-BACKLOG.md`.

### Why

`docs/internal/HOST-TIERS.md` states plainly: Tier B has a data-loss risk on crash because no adapter can manufacture a hook the host doesn't provide. The integration needs a documented explicit-call pattern: agent calls `session_end`, then runs `ar corrections export | (optional adapter retain)`. Without it, every non-Claude-Code host is undocumented best-effort.

### Files to read first

1. `contrib/hindsight-cookbook/AGENTRECALL-BACKLOG.md` backlog #7 — the original ask and its framing
2. `docs/internal/HOST-TIERS.md` — the Tier-B capability matrix and "What makes Tier B work" section
3. `packages/core/src/tools-logic/memory-backend.ts` — the export/retain flow the pattern should call

### Acceptance criteria

- [ ] A documented pattern (in `docs/` or inline in `HOST-TIERS.md`) showing the explicit-call sequence for Codex: `session_start` → work → explicit `session_end` → `ar corrections export`
- [ ] The pattern works without any code changes — it documents what the agent should call, not a new tool
- [ ] A field report from ≥3 real Codex sessions confirming the pattern works end-to-end (posted as a Field Report issue)
- [ ] The HOST-TIERS.md Codex row is updated to reflect confirmed vs. aspirational behavior

### Non-goals

- Adding a new MCP tool specifically for Codex
- Implementing the `AR_HOST` environment variable profile selector (noted as deferred in HOST-TIERS.md — design discussion required before building)
- Fabricating hook behavior that the host does not provide

---

## (e) Run HeedBench on your own corpus and publish the first external baseline

**Title:** `benchmark: first external corpus baseline — run HeedBench on your own corrections and publish numbers`

**Labels:** `good first issue`, `benchmark`, `help wanted`

**Body:**

### What

Run the `npm run bench` pipeline on your own real correction corpus (not the synthetic fixture) and post your `bench-result/v1` artifact in GitHub Discussions → Benchmark Numbers.

### Why

Our own live corpus is 32 active corrections across 19 projects — the claim-gate for a transfer-recall point estimate requires 39 correction classes. Every external baseline, even one scoring 0, advances the field claim. The field has no external HeedBench baselines at all.

### Walkthrough

```bash
# 1. Clone and build
git clone https://github.com/Goldentrii/AgentRecall-MCP.git agentrecall
cd agentrecall
npm ci && npm run build

# 2. Verify the fixture corpus (sanity check)
node scripts/eval/fixtures/validate-fixture.mjs
# Expected: ALL ASSERTIONS PASSED

# 3. Run the benchmark against your own corpus
#    AR must have been running for your sessions — corrections live at ~/.agent-recall/
TZ=UTC node scripts/eval/run-bench.mjs --corpus real

# 4. Post the artifact in GitHub Discussions → Benchmark Numbers
#    Use the benchmark_result issue template for structured reporting
```

Full step-by-step: `docs/eval/REPRODUCE.md`

### What to report

Use the `benchmark_result` issue template. Required fields:
- `n_counted` — how many records passed the count rule
- `corpus_hash` — SHA-256 from the artifact
- Headline metrics with Wilson intervals
- Command used

Low scores and honest nulls are explicitly welcome. State the reason. "Too sparse to claim" is a valid and useful result.

### Acceptance criteria

- [ ] Reproduction steps from `docs/eval/REPRODUCE.md` followed without modification
- [ ] `bench-result/v1` artifact posted in GitHub Discussions → Benchmark Numbers using the template
- [ ] Corpus was scrubbed before posting — run `ar scrub` if posting any correction content
- [ ] Any metric below its claim-gate threshold reports "CANNOT CLAIM (n=X < gate Y)", not a point estimate

### Non-goals

- Tuning the retrieval to improve scores before posting — post the raw first run
- Posting numbers from the fixture corpus only — the fixture is synthetic and does not represent real use

---

## (f) Sync README.zh-CN.md to the 2026-07-05 measured-truth English rewrite

**Title:** `docs: sync README.zh-CN.md to 2026-07-05 measured-truth English rewrite`

**Labels:** `good first issue`, `docs`, `translation`

**Body:**

### What

`README.zh-CN.md` carries a warning at the top:

> ⚠️ 本文对应旧版 README；英文版已于 2026-07-05 重写为实测口径，中文版待同步。

The English README was rewritten on 2026-07-05 to a measured-truth style: honest numbers, no hype claims, explicit "cannot claim" language. The Chinese README needs to match.

### What changed in the English rewrite

Key changes in the 2026-07-05 English README (verified by reading both files):

1. The tagline changed from "你的 agent 不只是记得。它在学你怎么想。" (aspirational) to a factual description of what the system is (corrections ledger + measurement instrument)
2. The "Measured, not promised" section was added with a concrete numbers table (35.3% capture recall, 0/4 transfer, 363ms p95 latency)
3. The "Why this is different" section now cites specific benchmarks (LongMemEval, LoCoMo) with the confirmed gap stated plainly
4. The Automaticity Principle section explaining why only 5 tools ship by default
5. Removal of aspirational badges (FSRS-lite decay, precision KPI) that appeared in the old Chinese README but not the current English one

### Acceptance criteria

- [ ] `README.zh-CN.md` matches the structure and content of the current `README.md` (2026-07-05 rewrite)
- [ ] All numbers in the Chinese README match the English table exactly — no translation drift on metrics
- [ ] "Cannot claim" language is preserved in the Chinese version — do not soften it
- [ ] The warning banner at the top of `README.zh-CN.md` is removed once the sync is complete
- [ ] A native or near-native Chinese speaker reviews the translation before PR (request in the PR description if needed)

### Non-goals

- Improving or expanding beyond what the English README says — sync only, no additions
- Translating the `README.full.md` (that is a separate, lower-priority task)
- Changing the English README as part of this PR
