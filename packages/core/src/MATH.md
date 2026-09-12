# MATH.md — the mathematics actually in AgentRecall

> A **spec doc**, not code. It names every mathematical mechanism that exists in
> the codebase today, gives the real formula + inputs, and labels each one
> **GROUNDED** (validated against data, or a direct restatement of a cited result)
> or **ASPIRATIONAL / HAND-TUNED** (plausible shape, constants picked by feel,
> not fit to recall outcomes).
>
> The point of this file is honesty. Where a constant is hand-picked we say so.
> Where a claim outruns the math we have, we say that too — loudly, in §4.

Label key:

| Label | Meaning |
|-------|---------|
| **GROUNDED** | Either a direct restatement of a published result, or a constant/threshold tuned against the real corpus with a reported metric. |
| **HAND-TUNED** | The functional form is principled; the numeric constants were chosen by intuition and have **not** been fit to recall/forget outcomes. |
| **ASPIRATIONAL** | The *claim* about what the mechanism achieves is not yet backed by the math present. |

---

## (a) FSRS-lite — `palace/fsrs.ts`

A 2-component (Stability, Retrievability) simplification of FSRS-6 / SuperMemo.
We never run real review sessions, so the full 3-component (S, D, R) model is
dropped — there is no Difficulty term.

### Formulas (exactly as implemented)

```
Retrievability:   R = exp( -age_days / S )                 // score()
  age_days        = max(0, now - last_confirmed) / 86_400_000 ms
  S               = max(0.001, stability)                  // guard against /0

Reinforce (recall hit / confirmation):
  S'              = S · (1 + STABILITY_GROWTH)             // = S · 1.3
  last_confirmed' = now
  confirmations'  = confirmations + 1

Penalize (explicit "wrong/unhelpful"):
  S'              = max(1, S · 0.5)                        // halve, floor 1 day
  last_confirmed  = unchanged (age keeps accruing)

Initial state:    S₀ = DEFAULT_INITIAL_STABILITY = 7 days
```

### Constants and status buckets

| Symbol | Value | Role |
|--------|-------|------|
| `DEFAULT_INITIAL_STABILITY` | `7` days | a new fact "feels fresh" ~1 week |
| `STABILITY_GROWTH` | `0.3` | each confirmation grows S by 30% |
| `ARCHIVE_THRESHOLD` | `0.3` | R below → `archive_candidate` |
| `HOT_THRESHOLD` | `0.85` | R above → `hot` |
| penalize factor | `0.5` | halves S on a negative signal |
| `bucket()` | R≥0.85 hot · ≥0.6 warm · ≥0.3 cool · else archive_candidate | |

### Inputs

`FsrsState { stability:number, last_confirmed:ISO, confirmations:number }`,
plus the current time. Pure functions; the caller persists the returned state.

### Honest label: **HAND-TUNED**

The *form* — exponential forgetting `R = e^(-t/S)` with stability that grows on
successful recall — is the genuine FSRS / Ebbinghaus shape and is defensible.
**The constants are not.** `S₀ = 7`, the flat `+30%` growth per confirmation, the
`0.5` penalty, and the `0.85 / 0.6 / 0.3` bucket cut-points were **chosen by feel,
not fit to any recall data.** Real FSRS derives its growth/decay parameters by
fitting ~19 weights to large review-history datasets (millions of (recall,
elapsed) pairs); AgentRecall does no such fit. In particular:

- The `+30%` growth is **uniform** — real FSRS makes the stability increase
  depend on current R and D (you learn *less* from reviewing something you'd
  certainly have recalled anyway). We ignore that.
- We have **no validation** that `R < 0.3` actually correlates with "this fact is
  no longer useful," because we never observe the counterfactual recall.
- Reinforcement is **additive only** (no decay on neglect beyond the passive R
  drop), so S ratchets upward and can overstate confidence on a fact that was
  confirmed many times long ago.

Treat the numbers as **policy knobs**, not measured quantities. They are safe
because the only action they drive is *surfacing an archive candidate in a
dashboard* — never deletion (see the module's "We do NOT auto-delete" note).

---

## (b) RRF / fusion — `tools-logic/smart-recall.ts` (+ `confidence.ts`, `palace/hopfield.ts`)

### Reciprocal Rank Fusion (the actual default merge)

Three sources (palace, journal, insight) each rank their own candidates by an
internal score, then RRF merges **by rank position**, never by raw cross-source
score:

```
RRF_score(doc) = Σ_sources  1 / (k + rank_i(doc))        // applyRRF()
  k = RRF_K = 60                                          // const in smart-recall.ts
  rank_i(doc) = 1-based position of doc in source i's ranked list
```

A rank-1 item contributes `1/(60+1) = 0.01639` per source it tops. Best case an
item topping all 3 lists ≈ `0.0492`; the practical local max used by the
confidence rescaler is `RRF_LOCAL_MAX = 0.12`.

**Per-source internal scores feeding the ranks** (these are the hand-weighted
parts):

```
palace.internalScore  = keyScore·0.90 + salience·0.10       (salience floored at 0.4;
                        fix4 S4 2026-09-11 — was 0.65/0.35, rebalanced so query
                        relevance dominates and salience acts at tiebreaker scale)
journal.internalScore = recency·0.50  + exactness·0.50      (recency = Ebbinghaus, below)
insight.internalScore = relevance·0.40 + exactness·0.35 + confirmation·0.25
                        confirmation = min(1, log2(confirmed+1)/3)
corrections.internalScore = exactness·0.70 + severityBoost·0.15 + proofBoost·0.15
                        (fix4 S1 2026-09-11; severityBoost: p0→1.0 p1→0.5;
                        proofBoost = min(1, log2(proof_count+1)/3); no time decay)
```

**Post-RRF adjustments** (applied after the merge):

```
Hot-window recency boost — REMOVED from default ranking (fix4b 2026-09-12,
  PRODUCT-BEHAVIOR CHANGE): the old boost multiplied fused scores
  ×3.0/×2.0/×1.3 for items dated <6h/<24h/<72h. On the default pipeline
  there is now NO post-fusion freshness signal: fused scores are never
  freshness-multiplied and exact ties resolve freshness-blind by the fix4
  authority/insertion order (corrections first). NOTE the journal tier's
  INTERNAL recency×0.5 Ebbinghaus blend (above) is a per-tier scoring
  input, not a post-fusion boost — unchanged by fix4b.
  LEGACY ESCAPE HATCH: `freshnessBias: true` (queryMemory/smartRecall
  input, default OFF) re-enables the old multiplicative boost verbatim —
  all defects included (date-only strings bucket by wall-clock time-of-day;
  palace regex-scraped excerpt dates trusted as timestamps; recent items
  vault whole relevance bands). Kept for exactly one audited caller: the
  CLI ambient-injection hook, whose `score ≥ 0.03` floor was calibrated
  against boosted magnitudes (a lone tier-rank-1 match is 1/61 ≈ 0.0164
  raw and only clears 0.03 via the ×2/×3 windows). No default surface
  sets it.
Beta feedback multiplier (per item, shared across backends):
  E[Beta] = (pos+1)/(pos+neg+2)        // Laplace-smoothed
  multiplier = E[Beta] · 2             // neutral 0.5 → ×1.0
  (since fix4b this is the ONLY post-RRF score mutation on default paths)
Graph-walk expansion (fix4 S2 2026-09-11): 1-hop linked rooms are now
  `alsoLinked` METADATA on the top result — no synthetic result rows, no
  score (the old form minted stub rows at top.score · 0.6)
```

Why the boost had to go (fix4 Escalation §1 + fix4b, measured): RRF
compresses adjacent-rank score differences to ~1.6% (`1/(60+r)` vs
`1/(61+r)`), so ANY multiplier > ~1.02 vaulted an off-topic-but-recent item
over every un-boosted on-topic result — in a store written to daily, every
query's top-5 filled with the last 72h of diary sections regardless of
relevance. Golden-query eval (twin-clone control protocol, 2026-09-12):
55.0% top-5 hit-rate with the boost, 75.0% neutralized. A gentler
within-tie-band freshness tie-break (the fix4b brief's primary design D1)
was implemented and measured first: 65.0% — post one-doc-one-vote,
cross-tier EXACT ties at 1/(60+r) are the common case, and hotness-over-
authority handed those bands to <72h diary lines over the owner's own
captured rules. Neutralization shipped per the brief's fallback clause;
the freshness *feature* ("what did we just do") survives only on the
opted-in ambient surface.

### Source-specific Ebbinghaus decay

```
R(t) = exp( -t / S )                                       // ebbinghaus()
  S_journal   = 2     days   (episodic, decays fast)
  S_knowledge = 180   days
  S_palace    = 9999  days   (semantic, ~no decay)
```

### Beta utility (feedback)

```
E[Beta(α,β)] = α/(α+β),  α = pos+1, β = neg+1              // betaUtility()
```

### Calibrated confidence — `confidence.ts`

Each backend's native score is rescaled onto a shared 0..1 axis then binned:

```
norm = score / RRF_LOCAL_MAX (=0.12)     for "rrf-local"
     = score / RRF_SUPABASE_MAX (=0.049) for "rrf-supabase"
     = score                              for "cosine" (already 0..1)
label: ≥0.66 high · ≥0.40 medium · ≥0.20 low · else weak     // CONFIDENCE_FLOOR
```

The bridge gate reads the **scoring-time** `calibrated` value, *not* the
post-boost score, on purpose (the ×≤2 Beta multiplier — since fix4b the only
post-RRF score mutation — would otherwise fool the gate; see Risk #8 in
`confidence.ts`).

### Inputs

Free-text query + project; per-source candidate lists; an on-disk
`feedback-log.json` of `{query,id,title,useful,date}` rows (last 1000 kept).

### Honest label

- **RRF itself: GROUNDED.** `RRF_score = Σ 1/(k+rank)`, `k=60` is the exact
  formula and the empirically-validated default from Cormack, Clarke & Buettcher
  (2009), the same constant Elasticsearch / Azure AI Search ship. Using rank
  fusion to avoid combining incomparable raw scores is the correct, principled
  fix for the old linear-fusion bug documented in the module header.
- **Beta utility: GROUNDED** in form — `(pos+1)/(pos+neg+2)` is the textbook
  Laplace-smoothed Bayesian mean of a Beta-Bernoulli posterior. (The `×2`
  rescale is a presentation choice, not statistics.)
- **Ebbinghaus decay: GROUNDED form, HAND-TUNED constants.** `R=e^(-t/S)` is the
  cited forgetting curve. The per-source `S` values (`2 / 180 / 9999`) are
  **assigned by category intuition, not fit** to AgentRecall recall outcomes.
- **The per-source internal weights** (`0.90/0.10`, `0.50/0.50`,
  `0.40/0.35/0.25`, `0.70/0.15/0.15`), the **salience floor 0.4**, and the
  **confidence divisors 0.12 / 0.049**:
  all **HAND-TUNED**. They are reasonable and internally documented, but none is
  fit to a labeled relevance set. The divisors are explicitly called "tunable
  constants — NOT trusted gates" in `confidence.ts`.
- **Hot-window removal: GROUNDED** — the only constant-change in this file
  backed by a controlled measurement (golden-query eval, twin clones, same
  pass: control 55.0% hit-rate with the boost, 75.0% neutralized, D1
  tie-break variant 65.0%; fix4 Escalation §1 + fix4b report 2026-09-12).
  The `freshnessBias` legacy path keeps the old **HAND-TUNED ×3/×2/×1.3 and
  6/24/72h window edges** verbatim — labels unchanged there.

### Hopfield: present as a primitive, **NOT wired into the default recall path**

`palace/hopfield.ts` implements modern Hopfield retrieval
(Ramsauer et al. 2020):

```
ξ_new   = Xᵀ · softmax(β · X · ξ)
weights = softmax(β · ⟨x_i, ξ⟩)
energy  = -1/β · log Σ_i exp(β·⟨x_i,ξ⟩) + ½‖ξ‖²
β (DEFAULT_BETA) = 8.0,  steps = 1
```

The **math is GROUNDED** (correct restatement of the paper, numerically-stable
softmax, L2-normalization, finite-vector guards). **But it is a pure scoring
primitive that nothing on the default recall path calls.** `smartRecall()` →
`localRecallSearch()` does palace+journal+insight RRF only; there is no call to
`hopfieldRecall`/`hopfieldRerank` in the live retrieval flow. This is consistent
with the Loop-1 README correction: **do not describe Hopfield as part of how
recall ranks today.** It is available for an opt-in re-rank pass that is not
enabled by default.

---

## (c) Set-cosine semantic match — `helpers/semantic-match.ts`

The local, zero-key, zero-network similarity added in Loop 5.

### Formula

```
setCosine(A,B) = |A ∩ B| / sqrt(|A| · |B|)                 // binary-term set cosine
                 ( = 0 if either set empty )

semanticSimilarity(situation, blindSpotText) =
    max( setCosine( expandConcepts(stem(tok(sit))),  expandConcepts(stem(tok(bs))) ),
         setCosine( charTrigrams(stem(tok(sit))),    charTrigrams(stem(tok(bs))) ) )
```

Pipeline per side: `tokenize → light Porter-ish stem → concept-expand`. The
char-trigram leg pads each token as `"  tok "` and takes all length-3 windows.

### What `expandConcepts` does (the "concept space")

A **hand-written** map of 13 synonym groups (publish/ship/release…,
name/rename…, secret/key/token…, etc.). Every stem in a group is replaced by a
single shared token `__concept_g`, so "publish package npm" and "ship release
registry" collapse onto the same dimension and the cosine sees a real shared
term. `CONCEPT_OF` is built once at module load from `SYNONYM_GROUPS`.

### Inputs

Two free-text strings. Pure, deterministic, O(tokens). The threshold that turns
the score into a fire/no-fire decision lives in `blind-spots.ts`:
`BLIND_SPOT_SEMANTIC_THRESHOLD = 0.20`.

### Honest label: **set-cosine over binary term vectors — a LEXICAL/HEURISTIC metric, NOT a learned one**

State it plainly: this is **`|A∩B|/sqrt(|A||B|)` on binary indicator vectors of
discrete terms** (stems, concept-ids, or char-trigrams). There are **no
embeddings, no learned weights, no vector space fit to data.** "Semantic" here
means *"we hand-mapped a few dozen domain synonyms onto shared symbols and then
did exact set overlap."* The concept groups are curated by a human from the
AgentRecall correction corpus; widening or narrowing them directly moves recall
and false-positive rate.

- The **threshold 0.20 is GROUNDED**: tuned on the real `~/.agent-recall` corpus
  via `scripts/eval/predict-loo.mjs --both`. It is the highest-recall point that
  still holds **0% false positives** (2/13 recall vs the keyword baseline's
  0/13; the controlled paraphrase instrument fires 100% vs 0% for keywords).
- The **metric and concept map are HAND-TUNED.** They are fuzzy-lexical with a
  thin synonym bridge — genuinely better than raw token overlap on paraphrases,
  but it is **not meaning**, and the prior commit message ("fuzzy-lexical, not
  meaning") is the honest framing to keep.

---

## (d) THE BIG HONEST QUESTION

> *"Redundancy over time reconstructs intent."* Is there a real mathematical
> model behind this, or is it aspirational?

### Answer: **ASPIRATIONAL.** Today the claim is not backed by the math present.

What actually runs when corrections accumulate (`helpers/blind-spots.ts` →
`storage/blind-spots-store.ts` → `tools-logic/predict-correction.ts`):

1. **`deriveBlindSpots()` — greedy keyword-overlap clustering.** Each correction
   is cleaned, ~4 keywords are extracted, signals are sorted (P0 first, then
   recurrence, then keyword richness), and a greedy single-pass clustering joins
   a signal to a seed when they **share ≥2 keywords (≥1 if either is P0).** A
   cluster's `evidence_count` is just **how many corrections fell into it** —
   a frequency count. Trigger keywords are the terms shared by ≥2 cluster
   members.
2. **FSRS reinforcement** (§a) layered on top = exponential decay + additive
   confirmation growth.
3. **Set-cosine matching** (§c) decides whether a new situation fires a blind
   spot.

So the entire stack reduces to: **frequency-counting (clustering) + exponential
decay (FSRS) + binary set-cosine (matching).** Concretely, what is **absent**:

- **No posterior.** There is no `P(intent | corrections)` anywhere. `evidence_count`
  is a tally, not a distribution; nothing represents uncertainty over intent.
- **No information-theoretic accumulation.** Nothing measures how much each new
  correction *reduces uncertainty*. Redundant corrections inflate a count; they
  do not shrink a variance or add bits to a posterior.
- **No generative model of intent.** There is no latent variable that
  corrections are modeled as noisy observations *of*. "Reconstructs intent" has
  no object to reconstruct — there is only a cluster label (the seed's cleaned
  rule string).

Calling the current system "reconstructs intent" overstates it. **It detects
recurring keyword clusters and warns when a new situation lexically/conceptually
resembles one.** That is useful, and honest as "recurring-tendency detection."
It is **not** intent reconstruction. Do not paper over this gap.

### Sketch of a REAL model (explicit hook for freestyle Loop 10)

A model that would *earn* the phrase "redundancy reconstructs intent":

- **Latent intent vector** `θ ∈ ℝ^d` (the user's true preference on some axis,
  e.g. "always get explicit approval before publishing"). Unobserved.
- **Each correction is a noisy sample** of `θ`:
  `x_i = θ + ε_i`, `ε_i ~ N(0, σ²I)` (or, for a discrete stance, `x_i` a noisy
  bit/category from a Bernoulli/categorical whose parameter is a function of θ).
- **Bayesian update.** With a Gaussian prior `θ ~ N(μ₀, τ²I)`, the posterior
  after `N` corrections has mean a precision-weighted average and **variance
  that shrinks as 1/N**:

  ```
  Var[θ | x_{1..N}] = ( 1/τ² + N/σ² )⁻¹   →  O(σ²/N)
  ```

  *That* is "redundancy reconstructs intent": each redundant-but-consistent
  correction adds precision, so the estimate `μ_N` converges to `θ` and its
  uncertainty falls measurably.

- **Information-theoretic version.** Track the posterior entropy
  `H(θ | x_{1..N})`; a correction's value is its **information gain**
  `H(θ|x_{<N}) − H(θ|x_{≤N}) > 0`. Conflicting corrections raise entropy
  (intent is genuinely contested); redundant consistent ones lower it.

- **A measurable eval — "intent SNR rises with redundancy."** Define
  `SNR_N = ‖μ_N‖² / tr(Var[θ|x_{1..N}])` (signal energy over posterior
  variance). The falsifiable claim becomes: **`SNR_N` increases monotonically in
  N for a self-consistent correction stream, and *fails to rise* (or the entropy
  stays high) when corrections conflict.** Held-out test: after N corrections,
  predict the (N+1)-th held-out correction's stance; accuracy should climb with
  N if intent is actually being estimated, and a calibration curve should show
  the posterior's confidence tracking real hit-rate. That is the concrete
  instrument Loop 10 can build against — replacing the frequency tally with a
  shrinking-variance estimator and proving the SNR/accuracy curve rises.

Until that exists, the honest one-liner for §d is:

> **Present math: clustering + decay + set-cosine. Claimed behavior (intent
> reconstruction): aspirational.**
