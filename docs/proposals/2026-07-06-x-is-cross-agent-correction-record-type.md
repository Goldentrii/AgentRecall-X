# X = Cross-Agent First — Correction Record Type as Spec First-Class

**Status:** DECIDED (direction) — Tongwu accepted 2026-07-06. Schema details below are DRAFT constraints for the Stage 0 working session, not implemented.
**Date:** 2026-07-06
**Supersedes nothing; extends:** `2026-07-02-schema-infrastructure.md` (topology + staging unchanged), `2026-07-02-field-design-options.md`.
**Research basis:** `~/Projects/xrecall/research/2026-07-06-what-is-x-三方向调研.md` (3-agent parallel sweep).

## 1. The decision

**X = cross-AGENT now, cross-DEVICE later.**

> xrecall is the open interchange format for **correction-first agent memory**, plus the benchmark (HeedBench / Repeat-Mistake Rate) that measures whether memory actually changes behavior. The household/embodied thesis stays as the manifesto's long-term WHY — it is not the 12-month pitch.

Rationale (from research, all three verified):
- No public benchmark measures cross-session behavioral change (LoCoMo/LongMemEval/BEAM/EverMemBench/MemoryArena/CloneMem all measure retrieval fidelity).
- No published schema has a `correction` record type. Letta `.af` serializes an agent, not a user; Mem0 scopes are API conventions; PAM (arXiv:2605.11032) is fact-storage, no correction semantics, no adoption.
- The portability window is ~6 months: Anthropic's ChatGPT→Claude memory import (Mar 2026, "mobile number portability" framing) shows platforms circling; a proprietary fiat format would close the gap.
- Embodied/household hardware will not adopt any spec within 12 months (factory-first humanoids, no vendor memory APIs, Matter has zero user-context layer). Leading with it = FIPA trap.

Consumer second-brain / X-platform social recall: **rejected** (3/10 — platform encirclement, Rewind→Meta precedent, X API hostility, moat non-transfer).

## 2. Schema consequence: `correction` is a first-class record type

The 2026-07-02 field design treated assertion metadata (`confidence`, `decay_class`, `provenance`, `superseded_by`) as generic frontmatter. This decision adds one constraint: **the correction record class is the spec's flagship, not an afterthought.** It is the one record type no other format has, and the one HeedBench consumes.

Draft field set (Stage 0 working session to finalize; names provisional):

```yaml
# frontmatter on a correction record
record_class: correction
schema_version: 1
severity: P0|P1|P2            # rankCorrections severity dominance is a spec
                              #   guarantee, not an implementation detail
confidence: high|medium|low   # reuse discrete scale (types.ts:145); floats banned
triggered_by:                 # what the agent did that drew the correction
  excerpt: <string>           # minimal quote/paraphrase of the offending behavior
  context: <string|null>      # task/tool context at trigger time
recurrence_count: <int>       # times the same class of mistake recurred AFTER storage
heed:                         # per-exposure ledger, append-only
  default: unknown            # NEVER default to heeded (C3 decision 2026-07-03 —
                              #   evidence-grounded verdicts only; the 96.9%
                              #   instrument-optimism bug is a spec-level lesson)
  last_verdict: heeded|violated|unknown
  last_verdict_at: <iso8601|null>
  evidence: <string|null>     # what grounded the last verdict
provenance:
  source_agent: <string>      # which agent/host captured it (cross-agent key field)
  observed|told: ...          # per 2026-07-02 design
superseded_by: <id|null>      # already live at corrections.ts:70 — spec formalizes it
active: <bool>
```

Invariants (additions to §4 of schema-infrastructure):
- Heed history is **append-only**; a verdict is never rewritten, only appended.
- `heed.default = unknown` is normative. An implementation that defaults to `heeded` is non-conformant (this is what makes RMR honest across implementations).
- `recurrence_count` increments only on evidence-grounded recurrence detection, never on keyword match alone.
- Supersession chains: append-only, acyclic (unchanged from 2026-07-02).
- **Body-neutrality rule (A+C decision, 2026-07-06):** the format must contain no coding-agent-specific semantics. Field names, enum values, spec prose, examples, and conformance fixtures are all body-neutral — a household robot or phone assistant must be able to emit/consume a conformant correction record without any field feeling borrowed from software development. Concretely: `provenance.source_agent` generalizes to any agent identity (the 2026-07-02 `source_device` design already points this way — unify the two names in the field working session); fixtures must include at least one non-coding example (e.g. a navigation or household-preference correction); anything coding-specific (tool names, file paths, build semantics) lives in the record BODY (free-form markdown), never in spec-level frontmatter fields. Enforced as a conformance-suite check, not just prose: fixture lint rejects coding-jargon enum values in frontmatter. This one rule is what keeps direction A (cross-device/embodied) permanently compatible at zero ongoing cost.

## 3. HeedBench positioning constraint

- HeedBench (name provisional) consumes conformant correction records → emits RMR. The benchmark and the format ship as one story: *format defines the ledger; benchmark reads the ledger.*
- **HARD GATE: no solo public launch.** Secure a named co-publisher first — primary target Letta (they publicly dispute retrieval benchmarks; letta/letta#3115 asked for exactly a behavioral-coherence metric and was closed stale). Fallback: academic lab or enterprise design partner. Outreach draft: `~/Projects/xrecall/outreach/2026-07-06-letta-heedbench-draft.md` — **sending is owner-gated.**
- Until a partner commits, HeedBench artifacts stay in-repo (offline tier from B2 phase) — WHY loud, HOW quiet still applies.

## 4. What does NOT change

- Staging (Stage 0 `packages/schema` → Stage 1 subtree split → Stage 2 promotion) — unchanged.
- Moat split (format open, retrieval intelligence stays in AgentRecall) — unchanged.
- REDLINE gates (repo creation, npm publish, outreach sending) — unchanged.
- Manifesto household narrative — kept as long-term WHY; X-definition paragraph updated to "cross-agent first" in both EN/ZH (2026-07-06).

## 5. Risk register (accepted with eyes open)

1. Mem0 fast-follow on `correction` type (weekend PR for a $24M team) → counter: our moat is the *measurement* + capture pipeline, not the field names; ship reference implementation + honest baselines they can't fake quickly.
2. Platform fiat format within ~6 months → counter: move Stage 0 now; being first-with-runtime is the only defense.
3. Frontier models internalize self-correction → counter: cross-session + cross-agent ledger remains out of any single context window by construction.
