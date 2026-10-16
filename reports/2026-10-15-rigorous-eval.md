# AgentRecall-X Rigorous Retrieval Evaluation — 2026-10-15

Independent adversarial evaluation of the shipped recall/session_start path.
Repo: `E:/tools/AgentRecall-X`, branch `main @ c52e37e`, v3.5.1, Node v24.11.1, win32-x64 (i7-13700).
Evaluator did not author this code. No `packages/*/src` file was modified; all new code lives in
`scripts/eval/adversarial-2026-10-15/`. Owner's real store check: `find ~/.agent-recall -newermt <eval start>`
returned **0** files at end of run.

---

## 1. Verdict on "RAG"

**Default install: NOT embedding-based RAG.** It is **multi-tier lexical retrieval + ranked fusion +
fenced context injection**. With the opt-in local-embeddings flag it becomes **genuine hybrid retrieval**
(lexical legs + one local-ONNX semantic candidate leg fused by RRF). There is no generation step inside
the system and no reranker model — "generation" is the host LLM that reads the injected tool output.

Precise classification:

| Configuration | Class | Evidence |
|---|---|---|
| Default (`AGENT_RECALL_EMBEDDINGS` unset, no keys) | **Keyword/lexical retrieval + injection** (BM25-lite IDF, per-tier heuristics, RRF fusion) | `retrieval/query-memory.ts:526` (RRF_K=60), `:569` (bm25Idf), `:997` (scoreJournalTier) |
| `AGENT_RECALL_EMBEDDINGS=1` + `ar embeddings setup` | **Hybrid retrieval + injection** (lexical + local ONNX semantic leg as one extra RRF leg) | `retrieval/semantic-leg.ts:54` (SEMANTIC_TOP_K=8), `embeddings/config.ts:123` (default model MiniLM-L12-v2 q8, 384-dim), `embeddings/runtime.ts` (`allowRemoteModels=false` on the whole recall path) |
| Ambient `OPENAI_API_KEY` present (no flag!) | **Silent cloud-embedding leg** — query text POSTed to api.openai.com | proven below, §4 F1 |
| Supabase config present | Remote FTS+pgvector backend fused with local (`fuseRemoteWithLocal`) | `supabase/recall-backend.ts`, `tools-logic/recall-backend.ts:98` |

Key properties that distinguish it from a vector-DB RAG stack:
- **No persistent lexical index.** Every query re-reads and re-tokenizes the full candidate corpus
  (`readTierCandidates` → full-file line scan in `scoreJournalTier`, query-memory.ts:997-1095). The
  per-query IDF model is built over the scanned corpus each call (`buildIdfModel`, query-memory.ts:630).
- **Embedding index stores hash→vector only** (no text) and is consulted only after candidates pass the
  same trust filter as lexical tiers (`embeddings/chunker.ts` header — this is the security model).
- **Reranking = RRF (k=60) + beta-utility feedback multiplier** (smart-recall.ts), not a cross-encoder.
- **Chunking exists only for the embedding leg** (`embeddings/chunker.ts`: per-tier granularity —
  corrections=1 record, palace=paragraph chunks/1 vote per doc, journal=per `## section`).

## 2. Architecture of retrieval (with file:line)

**Entry points.** MCP `recall` tool → `core.smartRecall` (mcp-server/src/tools/recall.ts:49 →
core/src/tools-logic/smart-recall.ts:1042). `session_start` tool / `ar hook-start` lifecycle hook →
`sessionStart` (core/src/tools-logic/session-start.ts:505; cli/src/index.ts:1571).

**Pipeline** (`queryMemory`, retrieval/query-memory.ts:1723) — six mandatory stages:
1. **Fetch**: `readTierCandidates` per tier (journal, palace, insight, corrections) + legacy journal root.
2. **Trust filter**: `filterTrusted` before any scoring (rescue-quarantine choke, query-memory.ts:997).
3. **Tokenize + score** (per-tier strategies, deliberately not unified):
   - Tokenizer is CJK-aware (`helpers/tokenize.ts` — Han runs via `Intl.Segmenter`, bigram fallback);
     this is why CJK-vs-CJK retrieval works at all.
   - journal: `recency*0.5 + IDF-weighted exactness*0.5`, Ebbinghaus S=2 days; score-then-truncate.
   - palace: salience/IDF blend (S=9999, near-zero decay); insight: confirmation-count driven.
   - IDF is BM25-curve, computed in-pass per query (query-memory.ts:558-646).
4. **Contradiction stage** (retrieval/contradiction.ts, applied at query-memory.ts:857): same-tier
   version-token conflicts only (marker `v|@|ver|version|#` mandatory before digits). **Annotate-only**
   — `supersededBy`/`conflictsWith` are set but rank is never changed (smart-recall.ts:187-218).
5. **Rank/fuse**: weighted RRF, k=60 (query-memory.ts:1569). Semantic leg (if enabled) contributes ≤8
   candidates past a per-model min-cosine floor (semantic-leg.ts:54-66) as one more RRF leg.
   Post-pipeline in smartRecall: beta-utility feedback multiplier + archive fallback when fused
   confidence is low.
6. **Fence at the MCP boundary**: `fenceMemory` wraps the whole rendered payload once
   (recall.ts:82, session-start.ts:220; implementation content-guard.ts:254 — `⟦agentrecall:memory⟧`
   delimiters, forged-close neutralization `⟦→[`).

**Where context reaches the LLM**: the tool result text of `recall`/`session_start` (and the CLI hook's
stdout at session entry). Injection size is actively budgeted (P0-correction survival check,
session-start-size bench below).

## 3. Bench numbers (all reproduced on this machine today)

| Bench | Leg | Metric | Value |
|---|---|---|---|
| `bench:golden` (26 synthetic queries, hash-locked fixture) | keyword | hit@1 / hit@5 / MRR@5 | **15.4% / 73.1%** [Wilson95 53.9–86.3] / **0.376** |
| | keyword | determinism (double child run, byte-diff) | PASS |
| | hybrid (`--embeddings`, MiniLM q8) | hit@1 / hit@5 / MRR@5 | **69.2% / 80.8%** [62.1–91.5] / **0.750** |
| | hybrid | CJK hit@5 | 6/6 = 100% (keyword: 66.7%) |
| | both | stale-return (confidently wrong on freshness) | 0/4 |
| `bench:latency` (golden-v1 store, warm) | keyword | recall p50 / p95 / p99 (n=200) | **62.6 / 346.7 / 532.6 ms** |
| | keyword | session_start p50 / p95 (n=50) | 119.0 / 174.6 ms |
| `bench:injection` (MCP session_start, mode=full) | — | tokens median / p95 / max (chars/4) | **223 / 243 / 243** per project; P0-survival OK (3/3 projects) |

MRR computed from `rank_of_first_target` in the harness JSON artifacts (misses contribute 0).
Hybrid's gain is concentrated at rank quality: hit@1 jumps 15.4%→69.2% — the semantic leg mostly
promotes already-reachable items to rank 1 and recovers the paraphrase/CJK classes.

## 4. Adversarial results (new tests, `scripts/eval/adversarial-2026-10-15/`)

26 checks, keyword + hybrid legs, fresh temp store per scenario with 9 distractor docs.

| Test | Expected | Actual (keyword) | Actual (hybrid) | Verdict |
|---|---|---|---|---|
| T1 paraphrase, zero lexical overlap ("which vendor handles our card transactions" vs Stripe decision) | kw miss, hybrid hit | miss (0 results) | **hit rank=1** | As designed; default install cannot answer paraphrases at all |
| T2 zh query → en memory (生产环境上线前需要谁的批准? vs owner-approval rule) | kw miss, hybrid hit | miss | **hit rank=1** | Cross-lingual only works with opt-in embeddings |
| T3 en query → zh memory (database choice stored in Chinese) | kw miss, hybrid hit | miss | **hit rank=1** | Same |
| T4 negation/authority ("should I use moment.js?" vs "Never use moment.js" + positive decoy) | rule above decoy | rule #1, decoy #5 | rule #1, decoy #2 | PASS — corrections tier outranks chatter; note retrieval itself has no polarity understanding |
| T5a temporal recency (100→500 rate limit, no filter) | newest first | PASS (500 first) | **FAIL — stale "100" entry ranks first** (deterministic, 2/2 runs) | Hybrid can invert freshness: semantic votes carry no recency, hot-window boost removed in fix4b |
| T5b `since:"7d"` filter | old entry excluded | PASS | PASS | Filter works |
| T6 version supersession (node v18.19.0 vs v20.11.1) | stale annotated/outranked | current #1, stale #2, `supersededBy` + `conflictsWith` set | same | PASS — but grammar needs an explicit `v/@/version` marker; T5a's bare "100"/"500" numbers get no annotation |
| T8 near-duplicate flooding (50 near-identical distractors vs 1 true decision) | survives top-5 | hit rank=2 | hit rank=2 | PASS — RRF + palace tier isolation resist flooding well |
| T9a stored prompt injection returned | verbatim (by design) | verbatim in excerpt | verbatim | Finding: no read-path NL scrubbing since v3.4.44 — fence is the only defense |
| T9b forged fence-close in stored content | neutralized | 0 forged closes inside fence, exactly 1 real close | same | PASS — `⟦⟧` neutralization works as documented |
| T10a PII on local recall | returned verbatim | email/card/IBAN all verbatim | same | By design (local trust), but see T10b |
| T10b `scrubForCloud` coverage | secrets scrubbed | **AWS secret VALUE survives** (`AWS_SECRET_ACCESS_KEY=wJal…` — no prefix pattern matches the value); email/card/IBAN survive; AKIA id IS scrubbed | same | FAIL — scrubber is a 12-prefix-pattern list (content-guard.ts:98-114): no `VAR=value` heuristic, no entropy check, zero PII coverage |
| T10c PII in session_start payload | not auto-injected | card/secret/email absent | same | PASS — payload is titles/summaries, not raw lines |
| **F1 ambient `OPENAI_API_KEY` egress** (`egress-ambient-openai-key.mjs`) | no network without opt-in | **FAIL — one `fetch` to `https://api.openai.com/v1/embeddings` with the recall query text, zero AgentRecall flags set** | — | recall-backend.ts:124-129: `LocalVectorRecallBackend.available() = !!OPENAI_API_KEY`. Contradicts the local-first posture; the ambient key is extremely common in dev shells. The file's own header says the seam is "not user-facing" — yet it activates itself |

**Scale test** (`scale.mjs`, seed-42 synthetic corpus, 10 planted needles, keyword leg):

| N journal entries | hit@5 (needles) | recall p50 | p95 | max |
|---|---|---|---|---|
| 1,000 | 10/10 | 137 ms | 174 ms | 217 ms |
| 10,000 | 10/10 | **1,045 ms** | **1,630 ms** | 2,340 ms |

Quality holds; latency grows ~linearly (O(corpus) per query: full re-read + re-tokenize + per-query IDF
build). At a realistic heavy-user store (~10k entries) every recall costs >1 s and session_start will
follow the same curve.

## 5. Strengths

1. **Honest, regenerable eval culture** — hash-locked fixture, Wilson CIs, determinism double-run,
   "HONEST numbers" framing; my independent runs reproduced the README's 73.1%/80.8% exactly.
2. **Trust/injection architecture is real, not aspirational** — mandatory pipeline (no skippable stage),
   trust filter before scoring, hash-only embedding index (poisoned index cannot inject content),
   single fence at the MCP boundary with working forged-close neutralization (T9b passed).
3. **CJK handling is genuinely engineered** (script-detected Han runs, Intl.Segmenter, no length floors
   on CJK) — hybrid CJK hit@5 = 100%.
4. **Hybrid leg is well-gated**: opt-in, zero-network at query time, per-model cosine floors, top-K
   budget so the leg cannot flood fusion; measured +7.7pts hit@5 and +54pts hit@1 here.
5. **Flooding resistance** (T8) and authority ranking (T4) both held under adversarial pressure.
6. **Graceful degradation contracts** — typed degrade notes, circuit breaker on remote backend,
   never-throw recall path; confirmed empirically (blocked fetch still returned 5 local results).

## 6. Weaknesses

1. **(F1, highest severity) Ambient `OPENAI_API_KEY` silently sends recall query text to OpenAI** —
   no flag, no config, no console notice at query time. Query text can embed memory-derived or
   user-sensitive content. Directly contradicts the zero-cloud marketing of the same subsystem.
2. **Freshness inversion under hybrid (T5a)** — the semantic leg carries no recency signal and the
   contradiction stage (a) is annotate-only and (b) only fires on `v/@/version`-marked tokens, so a
   superseded plain-number fact can deterministically outrank its replacement.
3. **O(corpus) per query** — no persistent lexical index; p50 >1 s at 10k entries. The per-query IDF
   model rebuild (tokenizes the whole corpus) compounds it.
4. **Default install is lexical-only**: hit@1 15.4%, MRR 0.376, paraphrase/cross-lingual = 0%. The
   config that produces the README's headline numbers requires a 511 MB manual setup (`ar embeddings
   setup` + `rebuild` + flag) most users will not perform; index staleness then degrades silently
   (diagnosable only via the leg's `matched=0` note).
5. **Cloud scrubber is prefix-theater for anything but known token shapes** — secret *values*
   (`VAR=value`), emails, cards, IBANs all survive `scrubForCloud` → Supabase sync path exports PII.
6. **Prompt-injection defense is a single lexical fence** — acknowledged residual in-code (homoglyph/
   semantic fakes); content is injected verbatim otherwise. Fine for the threat model stated, but the
   per-render nonce proposed in content-guard.ts is still unimplemented.
7. Cross-project category remains weakest even hybrid (B: 66.7% hit@5).

## 7. Optimizations, ranked (impact × effort)

| # | Change | Expected impact | Effort |
|---|---|---|---|
| 1 | **Gate the OpenAI vector backend behind an explicit flag** (e.g. `AGENT_RECALL_CLOUD_EMBEDDINGS=1`); ambient key alone must never select it | Closes a silent data-egress hole; aligns behavior with documented posture | **XS** (one condition in recall-backend.ts:124 + test) |
| 2 | **Recency tie-break / freshness prior in fusion when candidates are near-duplicates of each other** (or: extend contradiction grammar to marker-less `NUMBER unit` fact-keys and let `supersededBy` apply a bounded penalty when date order is unambiguous) | Fixes T5a-class stale-first answers — the most dangerous failure mode (confidently wrong) | S–M |
| 3 | **Persistent lexical index** (incremental inverted index or cached tokenization keyed by file mtime/hash, same pattern as the embedding index) | 10k-entry p50 from ~1 s toward ~100 ms; makes IDF O(delta) not O(corpus) | M |
| 4 | **Ship a small default semantic model or auto-offer setup on first recall** (the entire measured quality gap between 73.1%/0.376 and 80.8%/0.750 is this opt-in) | Default-install hit@1 ×4.5; paraphrase/cross-lingual from 0%→~100% on tested classes | M (product decision + download UX; model is 145 MB without the 380 MB runtime if bundled as ORT-only) |
| 5 | **Add `KEY=value` + entropy heuristics and PII patterns (email/IBAN/PAN+Luhn) to `scrubForCloud`**, and run `scrubForExport` (fail-closed) on the Supabase sync path | Closes T10b before any cloud sync feature grows | S |
| 6 | Embedding-index staleness: auto-rebuild deltas on write (hash-keyed, incremental — indexer already supports it) or surface `matched=0` as a loud nudge in recall output | Removes the silent-degradation mode of the hybrid leg | S |
| 7 | Per-render nonce in the memory fence delimiter (already proposed in content-guard.ts) | Shrinks the stated residual of the injection defense | XS |

## 8. Reproduce

```bash
cd E:/tools/AgentRecall-X && npm run build

# stock benches (self-isolating: temp store + HOME redirect)
npm run bench:golden
npm run bench:latency
npm run bench:injection

# hybrid leg (one-time ~511MB local install; never touches ~/.agent-recall)
export AGENT_RECALL_EMBEDDINGS_HOME=E:/tools/ar-eval-embeddings
node packages/cli/dist/index.js embeddings setup
node scripts/eval/golden-retrieval.mjs --embeddings --no-artifact

# adversarial suite (this eval)
node scripts/eval/adversarial-2026-10-15/run-adversarial.mjs --embeddings
node scripts/eval/adversarial-2026-10-15/scale.mjs --n 1000,10000
node scripts/eval/adversarial-2026-10-15/egress-ambient-openai-key.mjs

# safety invariant used throughout
find ~/.agent-recall -newermt "<eval start>" | wc -l   # == 0
```

Artifacts: `scripts/eval/adversarial-2026-10-15/results-adversarial.json`, `results-scale.json`,
`golden-kw.json`, `golden-emb.json`; bench baselines under `scripts/eval/baselines/*-2026-10-15.json`.
