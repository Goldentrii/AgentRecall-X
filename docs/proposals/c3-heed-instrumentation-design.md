# C3: Heed Instrumentation Design

**Status:** IMPLEMENTING  
**Generated:** 2026-07-03  
**Worker:** Loop C3 (heed instrumentation — the program's critical path)

---

## Problem Statement

M1 baseline proved the outcome instrument is near-blind:

- **96.9% heed_rate** (32 events: 31 heeded / 1 recurred) is an instrument-optimistic
  artifact, not a measurement. The default session-end outcome path is "heeded" — it fires
  for every correction retrieved today unless the session summary happens to contain ≥2
  recurrence-marker words. This is a **default-heeded bias**: the instrument generates
  positive verdicts when no evidence exists.
- **Wilson CI [61.1%, 100.0%]** — 39 points wide at n=32. Too wide to act on.
- **"recurred" fired ONCE** across 94 corrections. The recurrence detector requires ≥2
  marker words in the session summary AND same-day retrieval — a two-condition AND that
  is rarely satisfied in normal prose.
- **RMR cannot be measured** until verdicts are trustworthy.

**Exit bar:** ≥80% of injected corrections get an evidence-grounded verdict within the
session or by next dream. Default-heeded bias eliminated.

---

## Verdict Taxonomy

Four verdicts, mutually exclusive per correction×session:

| Verdict | Meaning | Evidence requirement |
|---|---|---|
| `heeded` | Correction was triggered AND the agent complied | Positive evidence: check/check-action consult OR summary + no violation |
| `recurred` | Correction was triggered AND the agent violated it | Positive evidence: recurrence markers in summary with prior trigger evidence |
| `not_triggered` | Correction was NOT triggered this session | Positive evidence: correction was not retrieved + no topical overlap detected |
| `unknown` | **NEW DEFAULT** — no positive evidence for any verdict | Absence of evidence (replaces default-heeded) |

### Semantic Break from Pre-C3

**This reverses the pre-C3 default.** Before C3, a retrieved-today correction with no
recurrence markers received `heeded`. After C3, it receives `unknown` unless positive
trigger-and-comply evidence exists.

Effect on historical comparability: all pre-C3 `heeded` events where evidence is the
absence of recurrence markers were instrument-generated, not evidence-grounded. The
`_outcomes.jsonl` audit trail carries an `evidence` string that identifies these:
pre-C3 heeded events have `evidence` matching the pattern
`"no recurrence evidence … (default-heeded"`. Post-C3 events carry substantive evidence.

The `rmr-report.mjs` artifact will carry:
```json
{
  "c3_semantic_boundary": "2026-07-03",
  "c3_note": "Pre-C3 heed_yes counts include instrument-generated heeded events (default-heeded bias). Post-C3 heed_yes requires positive trigger evidence. The boundary date separates these two regimes."
}
```

---

## Trigger-Detection Sources (Strongest First)

### Source (a): Real check/check-action tool invocations

**Strength: AUTHORITATIVE**

When an agent calls `checkAction()` or `check()` with a description that overlaps a
correction, the matching corrections list is returned. Each matched correction was
consulted before the agent acted. That IS a triggered event — the strongest evidence.

Implementation: `checkAction()` already records `retrieved` outcomes per matched
correction. We add a new outcome kind `triggered` that fires immediately when
`checkAction()` returns matches. This is the positive-trigger evidence that the session-end
heeded/recurred classification needs.

### Source (b): Session-end summary analysis (WEAK signal)

**Strength: WEAK — never sole grounds for `recurred` or `heeded`; demoted to `unknown`
when it is the only evidence**

The current marker-word heuristic (≥2 recurrence words AND same-day retrieval → recurred;
otherwise → heeded) is replaced by:

- Recurrence markers + prior trigger evidence → `recurred` (evidence: "recurrence markers
  in summary, correction was triggered")
- Recurrence markers WITHOUT prior trigger evidence → `unknown` (we saw the marker but
  cannot attribute it to this specific correction without trigger proof)
- No recurrence markers → `unknown` (absence of evidence ≠ heeded)

The marker set is WIDENED slightly to catch more explicit violations (see implementation),
but widening alone cannot produce a `heeded` verdict — that requires trigger evidence.

**Meta-content guard (IMPLEMENTED — `hasGenuineRecurrenceMarker` in session-end.ts):**
this project's own session summaries routinely discuss the measurement system itself
("the recurred count violated our baseline expectations") — eval-report prose, not a
violation admission. A recurrence marker therefore only counts when its CONTAINING
SENTENCE (decimal-safe `splitSentences`) carries none of the eval-vocabulary anchors:
RMR, heed_rate, baseline, _outcomes, recurrence_count, verdict_coverage, instrument,
predict-loo, benchmark (prefix-matched, so instrumented/benchmarking are covered).
Sentence granularity keeps recall: a genuine admission ("I pushed without asking
again.") still fires even when a different sentence in the same summary mentions
baselines. The topical-overlap second gate is unchanged and still required.

**Temporal scope (aligned to implementation):** trigger evidence is same-CALENDAR-DAY,
not same-session — `readOutcomesForToday` buckets by local-TZ day, so a `triggered`
event from an earlier session today counts as trigger evidence at this session's end.
This is deliberate: sessions within a day share working context, and the outcomes
ledger's dedup unit is correction×day everywhere else (1/day guards, heed ledger), so
day granularity is the consistent join key.

### Source (c): Retrieval + topical-overlap heuristic

**Strength: WEAK supplementary — produces `triggered-unknown` substate**

When a correction was retrieved today (last_retrieved date matches) AND the session
summary contains ≥2 of the correction's cluster tokens (content words ≥4 chars from the
rule), the correction was likely topically relevant. This is NOT enough for heeded/recurred,
but it is enough to say "triggered" (the correction was relevant to work done).

State: `triggered-unknown` — the correction was triggered but we cannot determine
heeded/recurred without stronger evidence. This prevents the correction from counting as
`not_triggered` in coverage metrics while keeping it out of the heeded/recurred numerators.

---

## New Outcome Kinds

Extending `CorrectionOutcome.kind` (backward-compatible):

```typescript
kind: "retrieved" | "heeded" | "recurred" | "predicted" | "predict_hit"
    | "triggered"         // NEW: correction consulted via check/check-action
    | "not_triggered"     // NEW: confirmed not relevant this session
    | "unknown"           // NEW: no positive evidence (replaces default-heeded)
```

**Backward-compatibility contract:**
- Old readers (rmr-report.mjs, activity-feed.ts) that only read
  `"retrieved" | "heeded" | "recurred"` will silently skip the new kinds. They MUST NOT
  crash — confirmed by reading their parsers (they filter by `kind` with an explicit set;
  unknown kinds are skipped, not errored).
- `heed_rate = heeded/(heeded+recurred)` is UNCHANGED — same formula, new kinds are
  excluded from both numerator and denominator.
- NEW metric: `verdict_coverage` — CANONICAL definition (identical in
  `getCorrectionKPIs` and rmr-report's `buildVerdictLedger`; a cross-consistency
  test asserts they agree):
  - `injected` = CURRENT correction records with `retrieved_count > 0`
  - `covered` = injected ids whose outcome kinds include heeded | recurred | not_triggered
  - `verdict_coverage = covered / injected` — per-id membership, bounded [0,1];
    orphan outcome ids (record deleted) are dropped and can never inflate the numerator.

---

## Metrics Contract for Consumers

### Unchanged

```
heed_rate = heeded / (heeded + recurred)
```
Same formula. Now measures correctly because `heeded` requires positive evidence.

### New

```
triggered_rate   = (heeded + recurred + unknown-triggered) / injected
verdict_coverage = covered / injected            # CANONICAL — see below
```

Where (canonical, mirrored in getCorrectionKPIs + rmr-report buildVerdictLedger):
- `injected` = CURRENT correction records with `retrieved_count > 0`
- `covered` = injected ids whose outcome kinds include heeded | recurred | not_triggered
  (per-id membership, NOT per-verdict counting — an id with both heeded and recurred
  counts once; bounded [0,1] by construction)
- orphan outcome ids (jsonl events whose record no longer exists) are dropped from the
  numerator — they can never inflate coverage
- `unknown-triggered` = corrections with a `triggered` outcome but no heeded/recurred
- `not_triggered` = corrections with a `not_triggered` outcome (confirmed irrelevant)

---

## `_outcomes.jsonl` Event Shape Extension

All new kinds are appended to `_outcomes.jsonl` with the same schema as existing events:

```json
{
  "correction_id": "...",
  "project": "...",
  "kind": "triggered" | "not_triggered" | "unknown",
  "at": "ISO-8601",
  "evidence": "free-text description of what triggered the classification"
}
```

**Old readers MUST NOT crash:** Both `rmr-report.mjs` and `activity-feed.ts` parse
`_outcomes.jsonl` by reading each line, parsing JSON, then checking `evt.kind`. The check
is either a `Set.has()` or a strict `!== "heeded" && !== "recurred"` guard — unknown kind
values fall through without error. Verified in:
- `rmr-report.mjs` lines 163–180: reads all kinds into an array, then `buildHeedLedger`
  filters `evt.kind !== "heeded" && evt.kind !== "recurred"` — new kinds are simply skipped
- `activity-feed.ts` line 192: `if (kind !== "retrieved" && kind !== "heeded" && kind !== "recurred") continue;`

---

## Session-End Heed Loop Redesign

The current loop in `session-end.ts` (lines 248–331) is replaced with this logic:

```
for c in corrections retrieved today (last_retrieved date == today):
  firedToday = readOutcomesForToday(slug).get(c.id)

  // Skip if a real outcome already exists (heeded/recurred from check-action)
  IF firedToday.has("heeded") OR firedToday.has("recurred"):
    // predict_hit logic unchanged
    CONTINUE

  // Determine trigger evidence
  hasTriggerEvidence = firedToday.has("triggered")

  // Check for topical overlap (weak supplementary source)
  ruleWords = extractContentWords(c.rule)  // ≥4 chars, unique
  matchCount = ruleWords.filter(w => summaryLower.includes(w)).count
  hasTopicalOverlap = matchCount >= 2

  // Determine recurrence
  hasRecurrenceMarker = RECURRENCE_PATTERN.test(summary)
  violated = hasRecurrenceMarker AND (hasTriggerEvidence OR hasTopicalOverlap)

  IF violated:
    recordOutcome(kind="recurred", evidence="recurrence markers + trigger/topical evidence")
  ELSE IF hasTriggerEvidence:
    // Triggered via check-action but no recurrence → heeded
    recordOutcome(kind="heeded", evidence="consulted via check-action, no recurrence")
  ELSE IF hasTopicalOverlap:
    // Topically relevant but no trigger evidence → triggered-unknown
    // Record as "unknown" — we cannot determine heeded/recurred
    recordOutcome(kind="unknown", evidence="topical overlap detected but no check-action trigger")
  ELSE:
    // Retrieved today but not relevant to session content → unknown
    recordOutcome(kind="unknown", evidence="retrieved but no topical or trigger evidence in session")
```

**Key change:** `"heeded"` now requires at least one of:
1. Prior `triggered` event (from check-action), OR
2. `hasTriggerEvidence` — explicit trigger source

This eliminates the default-heeded bias. The outcome distribution will shift from
~97% heeded to mostly `unknown` until check-action wiring accumulates data.

---

## check-action `triggered` Event

`checkAction()` already appends `retrieved` outcomes per matched correction. We add:

After matching, for each correction in `topCorrections` (the returned matches), record a
`triggered` outcome. This fires when the agent actually consults check-action with a
description that overlaps the correction — the authoritative trigger signal.

This is the "positive trigger evidence" that session-end's heeded classification requires.

---

## `not_triggered` Classification

For `not_triggered`, positive evidence requires:
- The correction was NOT retrieved today (no `retrieved` outcome for today), AND
- The session is over (session-end is running), AND
- The correction was active and relevant to this project

This is produced at session-end for corrections that were NOT retrieved today. It covers
the denominator: we know this correction had no opportunity to be triggered.

---

## Dream Fallback (Text Specification — No Code)

A nightly-dream prompt addendum for auditing yesterday's transcripts:

```
AUDIT_PROMPT_ADDENDUM = """
For each active correction in the project:

1. Search the transcript for any agent action, decision, or plan that the correction
   would apply to (use the correction's rule text + tags as search terms).

2. If the correction topic appears in the transcript:
   a. Did the agent consult check-action with a related description? → TRIGGERED
   b. Did the agent violate the correction? → RECURRED (evidence: quote the violation)
   c. Did the agent comply without being explicitly reminded? → HEEDED (evidence: describe compliance)
   d. Unclear → TRIGGERED_UNKNOWN

3. If the correction topic does NOT appear in the transcript:
   → NOT_TRIGGERED (evidence: "correction topic not found in yesterday's transcript")

For each classification, call recordOutcome() with:
  - correction_id, project, kind, at (yesterday's date), evidence (quoted or described)

Only record if no outcome already exists for this correction on that date.
"""
```

This addendum is appended to the dream agent's system prompt. It runs after the normal
consolidation pass. A correction missed by the in-session path (no check-action call) can
be caught here. The `at` timestamp uses yesterday's date so cross-day dedup works.

---

## Verdict Coverage Metric

`verdict_coverage = (heeded + recurred + not_triggered) / retrieved_this_window`

Where `retrieved_this_window` is the number of corrections that received at least one
`retrieved` outcome in the measurement window (usually 30 days).

`unknown` verdicts count AGAINST coverage (they are in the denominator but not the
numerator). `triggered` events without heeded/recurred contribute to `triggered_rate` but
not to `verdict_coverage`.

**Exit bar:** ≥80% verdict_coverage over a synthetic session replay exercising all 4
verdicts. In real-world corpus, coverage will start near 0% (pre-C3 evidence is absent)
and improve as check-action calls accumulate.

---

## Historical Comparability

Pre-C3 heed data is instrument-biased:
- All pre-C3 `heeded` events with `evidence` containing `"default-heeded"` are
  instrument-generated, not evidence-grounded.
- Post-C3 `heeded` events require positive trigger evidence.
- The boundary date `2026-07-03` separates the two regimes.

In `rmr-report.mjs`, side-by-side output:
```
  PRE-C3 heed_rate (instrument-biased, evidence absent)  96.9%  n=32
  POST-C3 heed_rate (evidence-grounded, same corpus)     X.X%   n=N
  verdict_coverage (evidence-grounded, C3 sessions only) Y.Y%   n=M
```

The report carries `c3_semantic_boundary` and `c3_note` fields in the artifact.

---

## Implementation Order

1. Extend `CorrectionOutcome.kind` type in `corrections.ts`
2. Add `triggered` recording in `check-action.ts`
3. Redesign the session-end heed loop in `session-end.ts`
4. Add `verdict_coverage`, `triggered_rate`, `unknown_count` to `CorrectionKPI`
5. Update `rmr-report.mjs` to consume new verdict classes and emit old-vs-new comparison
6. Tests: verdict default flip, each trigger source, coverage computation, old-reader compat
7. Synthetic session replay validating ≥80% coverage bar
