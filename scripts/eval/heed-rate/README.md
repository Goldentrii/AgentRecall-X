# S0 heed-rate evaluation — metric definitions

S0 in the evaluation standard (`reports/agentrecall-evaluation-standard-2026-09-11.md`)
says: **memory must change agent behavior** — "a system with perfect retrieval that
agents ignore scores zero", metric `heed_rate = heeded/(heeded+recurred)`.

That single number conflates two different failures. Following the operationalization
in `reports/2026-09-12-retrieval-fusion-research.md` §4 (PrefEval, arXiv:2502.09597,
is the academic prior; IFEval, arXiv:2311.07911, is the verification template), this
directory splits S0 into **three numbers**:

| # | Number | Question it answers | Measured by |
|---|--------|--------------------|-------------|
| 1 | **retrieval-hit** | was the governing rule in the agent's context at all? | golden-query eval (`scripts/eval/golden-queries/`, fix #0) — NOT re-measured here |
| 2 | **heed-given-hit** | given the rule WAS in context, did behavior comply? | this directory (both tools) |
| 3 | **end-to-end heed** | did memory change behavior overall? | product of 1 × 2 |

The separation is the point: PrefEval shows heed-given-hit ≪ 1.0 even for frontier
models with perfect retrieval, so an end-to-end number alone mis-attributes heeding
failures to retrieval (and vice versa).

## Tool 1 — `retrospective.mjs` (offline, mines what already happened)

```
TMP=$(mktemp -d) && cp -cR ~/.agent-recall "$TMP/store"   # clones-only policy
node scripts/eval/heed-rate/retrospective.mjs --store "$TMP/store" --json out.json --evidence
```

Read-only miner of the store's correction records + `_outcomes.jsonl` ledgers.
For every live (non-retracted) correction with ≥1 recorded surfacing
(`kind:"retrieved"`), it classifies all subsequent events into evidence
classes (see `lib.mjs` `classifyEvent`) and scores them under **two SYMMETRIC
evidence tiers**, reported as a range (fix round 2026-09-12 — the original
asymmetric design excluded evidence-free positives but trusted heuristic
negatives; independent review proved the self-report recurrence channel
over-counts via session_end marker fan-out):

- **ADJUDICATED tier** — evidence-cited verdicts, BOTH directions:
  heed = `heeded` with `dream-audit:` verbatim evidence (C3b nightly audit) or
  check-action trigger evidence (C3 path; zero instances exist to date);
  violation = `recurred` with `dream-audit:` verbatim evidence.
- **LOOSE tier** — heuristic channels included, BOTH directions:
  heed additionally counts pre-C3 `default-heeded` (absence-of-evidence
  credit); violation additionally counts session-summary self-report markers
  (fan-out-contaminated). At event level the loose rate IS the shipped KPI
  formula `heeded/(heeded+recurred)`.
- `not_violated` stays outside both tiers (its own design contract);
  `unknown`/`not_triggered` carry no signal.

Reported:
- **heed-given-surfaced per tier, correction-level and event-level** —
  `mixed` (heed and violation on different days) counts against the numerator.
- **KPI numerator decomposition** — what share of the shipped formula's
  heeded count is default-heeded bookkeeping.
- **absence-of-evidence share** — the fraction of surfaced corrections with
  no adjudicated evidence at all. This is the honest denominator problem.
- **C3b cross-check** — dream-audit verdicts per audited day (reproduces the
  2026-09-10 "1 heeded / 9 verdicts" finding from the dreaming research).
- Per-correction **evidence trail** (`--evidence` / `--json`) for review,
  labeling each verdict's tier.

### What the retrospective does and does not prove

Proves (to the extent the ledgers are trustworthy):
- The C3b dream-audit heed/recur verdicts cite verbatim transcript/journal
  evidence — the strongest signal available without new instrumentation.
- Violations: a `recurred` event is positive evidence the rule was broken
  after it was surfaced.

Does NOT prove:
- **Silence ≠ heed.** Most surfaced corrections have no adjudicated evidence
  either way. Sessions where the rule bound but nothing was recorded are
  invisible.
- **Self-reported recurrence mis-counts in BOTH directions.** It under-counts
  (markers require the agent to admit the violation in its own summary) AND
  over-counts (session_end fans one summary's marker onto every correction
  with ≥2-3 topical content words — review-verified on primary evidence).
  That is why it is loose-tier only.
- **`retrieved` ≠ read.** Surfacing means the rule was injected into context,
  not that the model attended to it.
- **Retractions are not violations here.** Every `retracted_at` in this store
  carries a noise-triage `retract_reason` ("capture noise") — the record was
  never a real rule. They are excluded, not counted as violations.
- **Orphaned ledger events** (record file quarantined/deleted) are excluded;
  verified 2026-09-12 (worker + independent reviewer) that no orphan carries
  adjudicated-tier evidence.

## Tool 2 — `run-heed-eval.mjs` + `probes.json` (forward, controlled)

```
node scripts/eval/heed-rate/run-heed-eval.mjs --dry-run          # validate, no network
ANTHROPIC_API_KEY=... node scripts/eval/heed-rate/run-heed-eval.mjs --out results.json
```

10 probes × 2 arms on `claude-haiku-4-5-20251001`, hard-capped at
`max_requests` total API calls, temperature 0:

- **with-memory arm** — the task prompt with a synthetic P0 rule injected as
  the product renders the P0 BLOCK (`🚨 P0 rules — follow strictly:` block,
  byte-faithful including the 80-char rule slice; `packages/cli/src/index.ts`).
  The outer framing ("Context from session memory:") is eval-specific — the
  product embeds the block among Project/continuity/insight lines, which a
  single-probe arm cannot reproduce. Retrieval is forced to 1.0 by
  construction, isolating the heeding step: pass-rate here **is
  heed-given-hit**.
- **without-memory arm** — the identical task with no memory block (system
  prompt byte-identical). Pass-rate is the model's **prior**; the per-probe
  delta is the **memory effect**.

Compliance is scored by **IFEval-style verifiable predicates** (regex on a
response whose format the task pins down) — no LLM judge anywhere, so there is
no judge≠executor independence problem and runs are deterministic to score.

Probe rules are drawn from real correction **classes** in the owner's store
(version-discipline, push-approval, subagent model pinning, decision-menu
format, naming, canonical-repo, self-review, CJK output, artifact
preservation, scope fidelity) but every `memory_rule` text is **synthetic** —
this file is committed; private rule text is forbidden and schema-enforced
(`provenance` must declare synthetic).

### What the forward harness does and does not prove

Proves:
- Whether the exact production injection format changes a small model's
  behavior on verifiable single-turn tasks, with a controlled baseline.

Does NOT prove:
- Heeding over long contexts / many turns (PrefEval: adherence collapses by
  ~10 turns — this harness is single-turn by design, so it measures the
  *ceiling*, not the working-session reality).
- Heeding by the owner's actual harness/model mix (heed rate is partly a
  property of the consuming harness — research report §open-question 3).
- Anything about retrieval — the rule is force-injected.

## How S0 maps

`S0 heed_rate = heeded/(heeded+recurred)` from the standard maps to:
- **retrospective ADJUDICATED event-level rate** — the same formula restricted
  to evidence-cited events in both directions (what the standard *meant*),
- **retrospective LOOSE event-level rate** — the same formula as shipped KPIs
  compute it today (numerator contaminated by pre-C3 default-heeded credit,
  denominator by self-report marker fan-out; reported for continuity),
- **forward heed-given-hit** — the controlled, denominators-known version the
  retrospective can never give you (no absence-of-evidence class).

Recurrence half-life (the S0 companion metric) is NOT implemented here: with
11 recurred events store-wide the estimator would be noise. Revisit when the
C3b audit has run at full coverage for a few weeks.

## Tests

```
node --test scripts/eval/heed-rate/heed-rate.test.mjs
```

Covers probe schema validation, predicate evaluation, arm construction, and
retrospective classification/aggregation mechanics — deliberately not model
behavior.
