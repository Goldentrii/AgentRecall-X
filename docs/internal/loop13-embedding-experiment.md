# Loop 13 — Learned semantic representation: experiment & verdict

**Question (the "next bet" from the 11-loop run):** Is AgentRecall's prediction
ceiling the **instrument** (bag-of-tokens can't see "same intent, different words")
or the **data** (the corpus is intent-sparse)? Four prior measurements (L3 0/13,
L9 0/25, L10 untestable, L11 ~9%) pointed at data — but all used lexical matchers,
so none could rule out an instrument artifact. This loop tests the strongest
available local instrument.

**Constraint:** zero-key, zero-cloud (the operator's #1 principle). So: a **local**
sentence-embedding model — `Xenova/all-MiniLM-L6-v2` (384-dim) via
`@huggingface/transformers` (pure WASM, no native binary, no API key). Model is
fetched once (~23 MB) then runs fully offline.

## Method — eval-first, no production wiring

The bet was tested **before** committing any dependency. The only repo change is a
reusable A/B hook: `scripts/eval/predict-loo.mjs` now accepts `opts.matchFn`, so any
matcher can be driven through the **identical** LOO harness (same corpus, same
`predictable` set, same HIT judgment on recorded fields — only the *fire* decision
swaps). Default behavior is byte-identical (pinned by `predict-loo-eval.test.mjs`).

Three probes, all on the real corpus (`~/.agent-recall`, N=83 corrections, 13
predictable):

1. **Same-harness sweep** — embedding-cosine matcher vs lexical baselines, threshold 0.20–0.70.
2. **Full-text nearest-neighbor** — does C's top-cosine prior happen to be a true sibling?
3. **Adversarial paraphrase** — 8 hand-crafted same-intent pairs reworded to share ~0 tokens; does the embedding bridge what lexical must miss?

## Results

### Probe 1 — same-harness LOO (the non-circular comparison)
| matcher | recall | FP |
|---|---|---|
| keyword (L3 baseline) | 0/13 | 0% |
| local-semantic (L5 baseline) | **2/13** | 0% |
| embedding (MiniLM), best @ thr 0.25 | **1/13** | 0% |
| embedding @ thr ≥ 0.30 | 0/13 | 0% |

Embedding did **not** beat the zero-dependency lexical matcher.

### Probe 2 — full-text NN  ⚠️ CIRCULAR, reported for completeness only
embedding 4/13 (31%) · lexical 13/13 (100%) · random 3.1/13 (24%). The skeptic
correctly flagged this as **trivially circular**: `predictable` cases are *selected*
for having a high-token-overlap prior, so lexical NN winning is guaranteed by
construction. **Not** evidence for either side.

### Probe 3 — adversarial paraphrase (the decisive non-circular test)
8 same-intent pairs reworded to 0 shared tokens. Embedding "bridged" (cos > 0.45) only
**2/8**. Genuine paraphrases scored 0.11–0.50 (mostly 0.2–0.45); unrelated control ~0.05.
The model separates related from unrelated, but **weakly** on this terse-imperative
domain text — it misses most paraphrases even when they exist by construction.

### Skeptic's Probe A — natural semantic-only pairs
Across the corpus, **zero** pairs with high embedding-cosine AND zero token overlap
(matches at lower thresholds were artifacts: `<task-notification>`, "Yes"/"No",
truncated numerics). The corpus has no natural "same intent, different words" gap.

## Verdict (skeptic-corrected — overclaims removed)

- **No demonstrable benefit.** At N=13 no quantitative direction is statistically
  reliable (Wilson 95% CIs overlap heavily); the honest claim is "the learned
  representation does not *demonstrably* outperform lexical," **not** "it is worse."
- **Both legs are weak, non-circularly:** the corpus lacks natural paraphrase pairs
  (Probe A), *and* the small local model only weakly captures crafted ones (Probe 3).
- **Mechanism (skeptic):** on this multi-project corpus the embedding picks up
  **project-domain co-occurrence** as similarity (two unrelated rules in the same
  project score high) — a false-positive source lexical matching avoids. A larger
  corpus may worsen this, not fix it.
- **5th independent confirmation** that the ceiling is **data density**, now
  established with a learned instrument and a non-circular adversarial test.

## Decision

**Do NOT add the embedding dependency.** It earns no recall on this corpus, adds
project-co-occurrence false positives, and would move AgentRecall off "featherweight,
zero-key, local-markdown." Keep the zero-dependency lexical matcher (`semantic-match.ts`).

**Caveat (both directions):** a larger model (e.g. all-mpnet-base-v2) would bridge more
paraphrases — but it's a heavier dependency, and the *data* ceiling (Probe A) stands
regardless. If a future corpus is more paraphrastic, or another user's correction style
is more varied, re-run via the `matchFn` hook with a bigger model. The scoreboard is in
place; the bet simply does not pay off on this data today.

## Reproduce

```bash
mkdir embed-probe && cd embed-probe
npm init -y && npm pkg set type=module
npm i @huggingface/transformers@4
# then run the three probe scripts (embed-loo.mjs / embed-nn.mjs / embed-adversarial.mjs),
# each importing runLooEval from ../scripts/eval/predict-loo.mjs and the MiniLM pipeline.
```
The `matchFn` injection point in `predict-loo.mjs` is the supported way to A/B any new
matcher against the honest LOO baselines (keyword 0/13, local-semantic 2/13).
