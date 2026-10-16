# Correctness Review — fix/3.5.2-freshness + perf/lexical-index

- Reviewer: independent code reviewer (authored none of the code under review)
- Date: 2026-10-16 · Base: main @ f8938dd · Platform verified: win32 (Node v24.11.1); Linux not run locally — nothing platform-gated found; CI ubuntu lane should confirm
- Branches: fix/3.5.2-freshness @ 45f30b9 (E:/tools/AR-wt-fresh) · perf/lexical-index @ 345cd3c (E:/tools/AR-wt-index)
- All tests/benches run under throwaway AGENT_RECALL_HOME / AGENT_CRAFT_HOME / AGENT_RECALL_ROOT; ~/.agent-recall untouched. Branches read-only; merge test done in a scratch worktree, removed after.

## Verdicts

| Branch | Verdict | CRITICAL | HIGH | MEDIUM | LOW |
|---|---|---|---|---|---|
| fix/3.5.2-freshness | APPROVE (merge; MEDIUM-1 recommended as fast-follow) | 0 | 0 | 1 | 3 |
| perf/lexical-index | APPROVE (merge; MEDIUM-2 recommended as follow-up) | 0 | 0 | 1 | 3 |

Test evidence: freshness full core suite 1908 pass / 0 fail / 1 skip. Index full core suite 1910 pass / 0 fail / 1 skip. Both built clean with the repo tsc.

---

## Branch 1 — fix/3.5.2-freshness

Mechanism reviewed: extractRateFactTokens + second grammarConflict branch (packages/core/src/retrieval/contradiction.ts:282-440), post-fusion applySupersessionCap (packages/core/src/retrieval/query-memory.ts:1725-1748, applied at :1960 before the final sort), new suite packages/core/test/freshness-supersession.test.mjs, E1 flip in packages/core/test/query-memory-pipeline.test.mjs.

### [MEDIUM-1] Generic-frequency rate frames false-positive across topics
File: packages/core/src/retrieval/contradiction.ts:425 (extractRateFactTokens)
Repro (run against the branch dist):

    detectContradictions([
      { text: "ran 5 times per day", date: "2026-01-01" },
      { text: "retried 3 times per day", date: "2026-02-01" },
    ]).supersededBy  // => Map { 0 => 1 } — cross-topic supersession

time-per-day / time-per-week etc. are the single most common "N unit per unit" frame in ordinary prose and carry near-zero topical signal — this is W5a HIGH-2 (one-word generic key) recurring in two-word form for exactly one unit family. The doc block names the right residual-risk class ("records per day") but underestimates frequency for "times".
Blast radius is genuinely bounded (both items returned + annotated; worst case one adjacent-rank swap via the 0.98 cap), hence MEDIUM not HIGH.
Fix: reject the generic frequency unit in the extractor — first unit == "time" (post-normalize) yields no token. Genuine rate-limit facts use the resource noun; "N times per day" is almost always narrative. One-line change + one PART A case.

### [LOW-1] -es plurals break key normalization (recall miss only)
File: packages/core/src/retrieval/contradiction.ts:376 (normalizeRateUnit)
"10 buses per hour" gives key buse-per-hour; "5 bus per hour" gives bus-per-hour (verified) — conflict missed. Same for boxes/batches/addresses. Precision unaffected; acceptable under the precision-over-recall brief.

### [LOW-2] Cap silently defeated when the superseder fused copy carries a different id
File: packages/core/src/retrieval/query-memory.ts:1735 (byId lookup miss → skip)
Two real paths: (a) superseder filtered out by since; (b) cross-tier duplicate — fuseCanonical (:1628) keeps the FIRST rrfMap entry per fusionIdentity, so if the superseder canonical survivor is another tier copy (different id), or the stale annotated copy loses dedup to an unannotated twin, the cap (and in case (b) even the annotation) is lost. Fail-safe direction only — degrades to pre-3.5.2 annotate-only. Optional fix: fall back to resolving the superseder via fusionIdentity. At minimum add one test — the skip path has no direct coverage.

### [LOW-3] Design tradeoff: history questions lose rank 1
A query explicitly about the OLD value ("why was the limit 100 req/min?") has its correct (stale, higher-exactness) answer force-ranked below the superseder; with limit:1 it is hidden entirely. Inherent to the fix goal; callers should surface supersededBy in rendering so the demotion is visible.

### Brief questions answered
- Too narrow (only rate frames)? Yes, deliberately — "default port is 8080" vs "...3000" still has no grammar, and that is the right call for this branch: generalizing without an anchor re-opens the STEP-4b removed classes. Proposed follow-up that keeps the discipline: an ALLOWLISTED scalar-fact branch — closed noun vocabulary (port, timeout, ttl, limit, quota, threshold, retries, retention) + mandatory copula/assignment (is, =, :, set to, raised to, changed to) + number + optional unit, key = optional-modifier + noun (two-token key like the rate frame). The closed vocabulary IS the marker, exactly as v/@/version is for semver and "per" is for rates. Ship behind its own adversarial fixture battery (ports vs PIDs vs years; "timeout 30" vs "30 timeouts").
- Cycles in supersededBy: impossible. Edges are created per-tier only; direction is the (date, order) lexicographic comparison (contradiction.ts:442-455), a transitive total preorder whose ties never produce an edge — the graph is a DAG. Defense in depth: the fixed-point loop is bounded by pass < fused.length anyway, so even a hypothetical cycle terminates (scores only ever lowered).
- Equal dates / timezone: equal-day → tie → no supersededBy → the cap structurally cannot fire (tested, B3/C2). All producing tiers emit date-ONLY strings (journal filename prefix; palace datePattern; the archive fallback label is unparseable → NaN → tie), parsed uniformly as UTC midnight — no timezone asymmetry today. If a tier ever emits datetimes, same-day-different-time pairs would start resolving; future note, not a current defect.
- Superseder not in result list: silent skip, fail-safe (LOW-2).
- E1 flip justified? Yes. E1 was the pinning test for exactly the behavior this branch deliberately changes; keeping the old assertion would contradict the shipped change. The per-tier annotate-only invariant E1 co-proved is still independently pinned: E2/E3/E8-E13 untouched (verified in diff), applyContradictionStage itself unmodified, and C2 proves the ambiguous-tie no-cap case. The flip is documented at describe-block level with full lineage.
- Error path traced: garbage/missing dates → Date.parse NaN → resolveDirection falls to order → tie → annotation without direction, no cap (B3 + C2), plus the missing-superseder skip at query-memory.ts:1736.

---

## Branch 2 — perf/lexical-index

Mechanism reviewed: packages/core/src/retrieval/lexical-index.ts (new, 493 lines), scoreJournalTier fast path + buildIdfModel split (packages/core/src/retrieval/query-memory.ts:1024-1196), rawArchiveOnly (packages/core/src/retrieval/candidates.ts:238-254, 403-436), suite packages/core/test/lexical-index.test.mjs.

### Equivalence claim — verified meaningful
The brute path IS the oracle (scoring never re-implemented in tests): randomized corpora x 3 seeds with CJK lines, rescue-quarantined files, rollup archive incl. no-date YYYY-Wnn.md week files, capture files, name-excluded index.md and _reserved.md; query shapes include CJK, zero-hit, and stopword-only; every comparison is deepStrictEqual on the full stripped result, repeated on the warm snapshot cache. Invalidation (external edit/delete/create), process restart, corrupt/truncated/wrong-schema index, poisoned trust bit, archive/no-archive alternation, and parallel queries are each pinned back to brute. The substring-run equivalence argument is sound: every query term is whitespace-free, so whole-content includes ⟺ some whitespace-run contains it (checked deriveTerms against the lineMatchesQuery/buildIdfModel predicates); enumeration order is inherited from the same listJournalFiles + identical archive filter/sort, and collectJournalLineHits is the extracted-verbatim shared scanner — stable-sort ties therefore match by construction.

### [MEDIUM-2] Unbounded in-process memory growth on long-lived servers
File: packages/core/src/retrieval/lexical-index.ts:157 (contents cache), :162 (states map)
The contents cache asymptotically holds the full journal corpus text in RAM per project (header documents "roughly one copy" — accurate per project), postings/vocab/memos add more, and the states map never evicts a project — a long-lived MCP server touching many projects accumulates all of them. 10k docs is tens of MB (fine, measured); multi-project x large stores has no cap. Fix (follow-up, not blocking): byte-capped LRU on contents + project eviction on states.
Related scale boundary: the per-query stat sweep (:357, :364) is O(n) and the persisted index is parsed whole at cold start — fine at the measured 10k (p50 1044 → 190 ms, 5.5x; scripts/eval/adversarial-2026-10-15/results-scale.json + scripts/eval/baselines/latency-2026-10-16.json regenerated on-branch); 100k is UNTESTED and the index JSON would reach hundreds of MB — keep public claims at 10k.

### [LOW-4] (size, mtimeNs) staleness window — real but ns-exact
Same-size edit + identical mtimeNs → stale content served (hits, excerpts, trust bit). Empirical probe on NTFS: even fs.utimesSync restoring the original timestamp missed by 800 ns → invalidation correctly fired, indexed === brute. Exploiting it needs utimensat-precision restoration (ext4) plus byte-identical length; and the trust boundary is unaffected (read-time isRescueSourcedContent recheck on actual bytes — poisoned-index test passes). Documented in the module header as an accepted class shared with embeddings/index-store. No action required.

### [LOW-5] rawArchiveOnly without includeRawArchive returns an empty read
File: packages/core/src/retrieval/candidates.ts:254
Subset-only flag (verified: can never ADD surface; the raw half is untouched), pinned byte-identical to filter-the-full-read by test. But rawArchiveOnly:true alone yields zero candidates — a caller footgun the doc comment implies but does not state. The single caller (queryArchiveFallback, query-memory.ts:2056) passes both. Does rawArchiveOnly change any result? No — deep-equal pinned, and the only consumer already filtered to journal-archive-raw.

### [LOW-6] Minor test gaps
No equivalence query exercising since, none exercising perSectionDedupe on the indexed path (both are shared post-hit code — low risk); the documented IDF divergence (file deleted between stat and read stays in corpus-n) is untested — acceptable as a mid-query-mutation-only window.

### Concurrency / crash safety — OK
Loader body is synchronous up to the single await on persistEntries; interleaved refreshes can at worst install a staler snapshot, which the next query detects via the sameScan fingerprint (lexical-index.ts:304) and rebuilds — self-healing, no corruption (parallel-queries test agrees with brute). Persists serialize under withLock with tmp+rename (writeJsonAtomic, fs-utils.ts:161 — pre-existing primitive with the win32 EPERM retry); readers are lock-free and corruption-tolerant (garbage/truncated/wrong-schema all tested). Persist failure swallowed by design — cache only. Error paths traced: missing index → rebuild; vanished file mid-scan → entry dropped, brute-like skip; any unexpected throw → null → brute fallback (plus the caller belt-and-braces try/catch).

### Security — OK
Index path goes through projectSubPath (sanitize + assertInsideRoot). The cached trust bit is an optimization only; surfacing requires passing the read-time rescue choke on actual bytes (poisoned-index test). A poisoned index can perturb IDF weights or hide trusted docs — an attacker already inside the root could edit the journal itself; no new privilege (same residual class as embeddings/index-store, correctly documented).

---

## Merge-conflict report (four branches onto main @ f8938dd)

Pairwise git merge-tree --write-tree --merge-base=main across fix/3.5.2-freshness, perf/lexical-index, fix/3.5.2-egress-gate (3e3835e), fix/3.5.2-scrub-pii (24db6fe): all 6 pairs CLEAN — including the hot files (freshness+index both edit query-memory.ts + index.ts; egress+scrub both edit content-guard.ts; egress+freshness both edit query-memory-pipeline.test.mjs) — the hunks do not overlap.

Sequential 4-way merge in a scratch worktree (freshness → index → egress → scrub): zero conflicts, tsc clean, core suite 1997 pass / 0 fail / 1 skip. No semantic conflict between the supersession cap and the async indexed scoreJournalTier (the cap is post-fusion and tier-agnostic; TIER_SCORERS was already Promise-typed).

ONE FLAKY INTERACTION (owner: fix/3.5.2-scrub-pii, not the two reviewed branches): packages/core/test/content-guard-hardening.test.mjs, suite "regex safety: no catastrophic backtracking", test "email local-part bait (no domain) (98 KB) scrubs in < 50 ms" — failed 3/3 in a follow-up loop on the merged tree (174-206 ms observed) while passing standalone (~71 ms incl. setup) and passing the scrub-alone full suite (1961/0). It asserts a wall-clock threshold inside the parallel node test runner; the CPU-heavy lexical-index test files raise contention past the 50 ms budget. Any CI lane combining these branches will flake. Fix in scrub: measure an isolated best-of-N hrtime iteration, or assert sub-quadratic growth vs input size instead of an absolute ms bound.

Scratch worktree, node_modules junction, and review/merge-scratch branch removed after the run; branch worktrees untouched except built dist output.
