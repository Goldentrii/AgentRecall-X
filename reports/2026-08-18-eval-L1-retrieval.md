# AgentRecall v3.4.43 — Layer 1 Evaluation: Retrieval Quality

plywood SOP `c36ba121` · Sonnet eval worker · measured against `/tmp/ar-eval-snapshot` (frozen copy of real `~/.agent-recall`) via the shipped CLI (`node ~/Projects/AgentRecall/packages/cli/dist/index.js`, `AGENT_RECALL_ROOT=/tmp/ar-eval-snapshot HOME=/tmp/ar-eval-snapshot`). No MCP tools from this session were used to grade the mechanism.

Product promise under test: *"user does nothing, agent stops repeating mistakes."* L1 asks only: **if it's stored, can the agent find it back?**

## 0. Methodology note — a contamination bug found before scoring even started

The first few queries were run with the ambient shell environment untouched. Two env vars — `AGENT_RECALL_SUPABASE_KEY` and `AGENT_RECALL_EMBEDDING_KEY` — are set globally in this machine's shell profile. The snapshot's own `config.json` (copied verbatim from the real store) contains `"supabase_url": "https://fjdtuyflvgylrllujpnc.supabase.co"` with `sync_enabled: true`. Combining the two, `ar recall`/`ar insight` **silently reached the real production Supabase project** for any query that returned within the 2.5s remote budget — not the offline snapshot at all. This was caught because one result (`Phase 0001 — Corrections-store maturity follow-through`) came back with `## What was hard\n(in progress)`, while the live snapshot file on disk has that section fully written and `status: closed`. The remote copy was stale relative to the local snapshot.

**Fix applied for all subsequent measurements:** every CLI invocation unsets `AGENT_RECALL_SUPABASE_KEY`/`AGENT_RECALL_EMBEDDING_KEY`/`OPENAI_API_KEY`/`VOYAGE_API_KEY`, forcing `readSupabaseConfig()` to fail closed and the CLI onto the pure local `LocalRecallBackend` (verified: no `degraded` field, no network dependency, fully reproducible). All scores below are **local-only**. This methodology bug is itself Finding #1 (see §4) — it means the shipped CLI's default behavior is *not* deterministic or snapshot-isolated, and any eval (or any agent session on a machine with these env vars set) can silently mix live remote state into what looks like a clean local read.

## 1. Golden set (pre-registered, verbatim)

Ground truth for every item was independently verified by reading the source file directly (`Read`/`grep`) before querying. All queries run via `ar recall <query> --project <slug> --limit 5` (the CLI path that mirrors the MCP `recall` tool — `packages/cli/src/index.ts:458-478` routes to `core.smartRecall()` when a project is resolvable, exactly like `recall.ts`'s `project` default `"auto"`).

| # | Category | Project scope | Query | Ground truth (file) |
|---|---|---|---|---|
| A1 | known decision | agentrecall | "why did we ship 3.4.41 instead of 3.5.0" | `palace/rooms/decisions/minor-proposed-v350.md` + `journal/2026-08-04` |
| A2 | known decision | agentrecall | "does working memory scrub secrets before persisting user text" | `palace/rooms/decision/scrub-must-capture.md` |
| A3 | known decision | agentrecall | "Train C three probes dual-stack gatekeeping results" | `journal/2026-08-13--card--6c9644e8...md` |
| A4 | known decision | agentrecall | "one version bump per release not per phase" | `corrections/2026-05-20-one-version-bump-per-release-not-per-pha.json` |
| A5 | known decision | agentrecall | "novada mcp page redesign wizard recall gap known issue" | `palace/rooms/decision/novada-mcp-page.md` |
| A6 | known decision | agentrecall | "arstatus canonical python script fixes non-determinism" | `palace/rooms/health-baseline-2026-05-09.md` |
| A7 | known decision | agentrecall | "C6 version magnitude class recurred twice after re-abstraction" | `journal/2026-08-13` + `pareto-loop/journal/2026-08-12` |
| A8 | known decision | agentrecall | "corrections store maturity phase what was hard how solved synthesis" | `palace/pipeline/0001-Corrections-store-maturity-follow-through.md` |
| A9 | known decision | agentrecall | "hosted MCP canonical auth form token not path readme outlier" | `awareness.md` (8x-confirmed insight) |
| A10 | known decision | agentrecall | "REDLINE never push or publish without explicit owner approval how many times confirmed" | `awareness.md` (10x) + `palace/rooms/predictions/README.md` |
| B1 | cross-project | prismma-ai | "can I push to production without asking the owner first" | global CRITICAL insight (10x confirmed, `_global`) |
| B2 | cross-project | novada-proxy | "is novada-mcp the correct name or should I use novada-search" | `AgentRecall/palace/rooms/alignment/Product-naming-canonical-map.md` |
| B3 | cross-project | novada-mcp | "should parallel workers self-review or need independent reviewers" | global insight (331x confirmed) |
| B4 | cross-project | pareto-loop | "Codex vs Claude A/B test which model wins bulk rename vs content quality" | `AgentRecall/palace/rooms/alignment/Codex-vs-Claude-model-routing---A-B-tested.md` |
| B5 | cross-project | tchin-talk | "autonomous overnight agents should use cli not mcp claude subscription auth" | global CRYSTALLIZED insight (9x) |
| B6 | cross-project | novada-web | "human preference dont change anything focus on novada" | global insight (32x confirmed) |
| C1 | freshness | agentrecall | "what version number did the continuity wave actually ship as" | true=**3.4.41**; superseded trap=**3.5.0** ("proposed") |
| C2 | freshness | agentrecall | "what is the current canonical GitHub repo name for AgentRecall" | true=**AgentRecall-X** (renamed 2026-07-17); trap=AgentRecall-MCP/AgentRecall |
| C3 | freshness | agentrecall | "is the corrections store maturity phase still open or closed" | true=**closed** (2026-08-04); trap="(in progress)"/open |
| C4 | freshness | agentrecall | "how many times has the one version bump per release correction recurred" | true (narrative, 2026-08-12 reflection)=**2**; trap (the correction's own stored `recurrence_count` field)=**0** |
| D1 | CJK | agentrecall | "为什么发布3.4.41而不是3.5.0" | = A1, in Chinese |
| D2 | CJK | agentrecall | "工作记忆崩溃密钥泄漏修复" | = A2, in Chinese (target content is English) |
| D3 | CJK | agentrecall | "TrainC双栈守门探针结果" | = A3, in Chinese (target content is CJK) |
| D4 | CJK | agentrecall | "C6版本量级复发两次" | = C4/A7, in Chinese (target content is CJK) |
| D5 | CJK | agentrecall | "版本号连续性owner决定patch" | = A1, alt Chinese phrasing (target content is CJK) |
| D6 | CJK | agentrecall | "一次发布只提一个版本号不要按阶段" | = A4, in Chinese (target content is English-only) |

## 2. Scored results

Verdict is adversarial: a topically-similar-but-wrong-fact result (e.g. an older, unrelated version-bump precedent) is scored **MISS**, not a soft hit. A result only counts **HIT** if I independently re-verified its cited excerpt actually states the claim.

| # | Top hit (rank, source) | Verdict | Note |
|---|---|---|---|
| A1 | #1 `predictions/README` (unrelated push-gate item); #2 `goals/evolution` (wrong release, v3.4.22) | **MISS** | The actual reasoning (`minor-proposed-v350.md`) never appears in top-5. Plain lexical `ar search "3.4.41 3.5.0"` *does* surface the right journal line, just not ranked in the top of that list either — the fused `recall()` ranking is worse than raw keyword search here. |
| A2 | #3 `journal/2026-08-04` — quotes the actual sk- key / content-guard leak | **HIT** | Verified: matches `scrub-must-capture.md`'s underlying incident. |
| A3 | #5 `journal/2026-08-13` — "双栈守门(CLAUDECODE env...)" | **HIT** | Correct, but only just inside top-5. |
| A4 | #1 `predictions/README` — literal quote of the correction rule | **HIT** | Clean, rank 1. |
| A5 | #2 (forensics quote) and #4 `decision/novada-mcp-page` (exact doc) | **HIT** | Strong — the exact target doc surfaced. |
| A6 | none of top-5 mention arstatus/python | **MISS** | Root cause confirmed structural: `health-baseline-2026-05-09.md` sits as a loose file directly in `palace/rooms/`, not inside a `rooms/<slug>/` subdirectory — `palaceSearch()` only iterates room subdirectories (`packages/core/src/tools-logic/palace-search.ts:91-95`), so this file is permanently invisible to it. Lexical `ar search` on the same query does surface a *different*, redundant record of the same fact in `goals/evolution.md` — the system survives by luck of duplication, not by reaching the actual file. |
| A7 | #5 mentions "second recurrence" of the version delta, not the C6-classified "twice" claim | **MISS** | Adjacent but not the specific claim tested. |
| A8 | #1/#3 topically near, no "what was hard"/"how solved" content | **MISS** | Root cause: `palace/pipeline/0001-...md` lives in `palace/pipeline/`, a sibling of `palace/rooms/` — structurally never scanned by `palaceSearch()`. This is a permanent blind spot for the entire "narrative pipeline" memory tier, not just this one doc. |
| A9 | none relevant | **MISS** | The 8x-confirmed insight exists in the global insights-index but didn't rank; its `relevance` (tag-overlap) score apparently dominates its raw title-keyword `exactness`, diluting a good keyword match. |
| A10 | #1 `predictions/README` — literal REDLINE-gate quote | **HIT** | Rank 1, but the source states "5x confirmed" where `awareness.md` elsewhere says "10x confirmed" — a minor cross-record count inconsistency, not disqualifying. |
| B1 | none of top-5 relevant to push/publish approval | **MISS** | The single most safety-critical global insight (10x confirmed CRITICAL) did not crack top-5 from a different project's context. |
| B2 | none relevant | **MISS (expected by architecture)** | `Product-naming-canonical-map.md` is project-scoped under AgentRecall's palace; `palaceSearch`/`journalSearch` are strictly project-scoped (only the `insight` bucket is global), and this fact was never promoted to a global insight — despite its own text explicitly being about a *cross-project* naming-drift problem. |
| B3 | #5 (insight) exact title match | **HIT** | Global insight correctly reached from a different project. |
| B4 | none relevant | **MISS (expected by architecture)** | Same siloing as B2 — `Codex-vs-Claude-model-routing.md` never promoted globally. |
| B5 | none relevant (generic insight at #5 is the *wrong* one) | **MISS** | Global CRYSTALLIZED insight (9x) exists but didn't surface. |
| B6 | #5 (insight) exact title match | **HIT** | Global insight correctly reached from a different project. |
| C1 | #1 states "propose 3.5.0" (the rejected value); nothing states 3.4.41 | **MISS — confident stale-return** | Top-ranked result presents the superseded value as if it were the answer, with no corrective signal elsewhere in top-5. |
| C2 | none mention AgentRecall-X or the rename | **MISS (no answer)** | Neither the current nor the old value surfaced — total absence, not a wrong-but-confident answer. |
| C3 | none state open/closed | **MISS (no answer)** | Same root cause as A8 (pipeline/ dir invisible) — the only doc with the `status: closed` field is unreachable. |
| C4 | none state a recurrence count | **MISS (no answer)** | Neither the stale `recurrence_count: 0` field nor the correct narrative "twice" surfaced. |
| D1 | irrelevant "weak" insight only, 0 palace/journal candidates | **MISS** | `candidates_by_source: {palace:0, journal:0}` |
| D2 | **zero results** | **MISS** | `total_searched: 0` |
| D3 | irrelevant "weak" insights only, 0 palace/journal candidates | **MISS** | Same pattern as D1 |
| D4 | **zero results** | **MISS** | `total_searched: 0` |
| D5 | irrelevant "weak" insights only, 0 palace/journal candidates | **MISS** | Same pattern as D1 |
| D6 | **zero results** | **MISS** | `total_searched: 0` |

## 3. The four metrics

- **hit@5 (overall):** 7/26 = **26.9%**
  - ASCII-only (A+B+C, 20 queries): 7/20 = **35%**
  - CJK (D, 6 queries): 0/6 = **0%**
- **Provenance correctness (among the 7 counted hits):** 7/7 = **100%** — I found zero cases where a result I'd have naively called a "hit" turned out, on re-reading its cited source, to not actually contain the claim. (I *did* find several near-miss items that looked plausible but were scored MISS precisely because they failed this check — e.g. A1's rank-1 `predictions/README`, A7's `supersession.ts` item, C1's "propose 3.5.0" — these are the adversarial catches that justify the low hit@5 rather than inflating it.)
- **Stale-return rate (Category C):** 1/4 = **25%** returned a superseded value *confidently* (C1). The other 3/4 (C2–C4) returned no on-topic answer at all rather than a wrong one — a different failure mode (silence vs. confident-wrong) worth keeping separate. If you count "did NOT deliver the correct current value" as the bar, Category C is 4/4 = **100%** failure.
- **CJK vs ASCII hit@5:** **0% vs 35%** — CJK is not merely weaker, it's structurally broken for natural-language queries.

## 4. Root cause: why CJK queries fail (confirmed, not guessed)

All six CJK queries returned `candidates_by_source: {palace: 0, journal: 0}` — not low-ranked, literally zero pre-fusion candidates. I isolated the cause with a control query: a **short compound CJK term alone**, `双栈守门` ("dual-stack gatekeeping"), correctly returned 3 provenance-verified hits (rank 1–3, `ar recall` and `ar search` both). The difference: `palaceSearch`/`journalSearch`/RRF query-word extraction all tokenize on `split(/\s+/)` (ASCII whitespace only — `packages/core/src/tools-logic/palace-search.ts:64`, mirrored in `smart-recall.ts`). Chinese is written with no spaces between words, so:
- A short, already-atomic CJK compound term becomes one token that also happens to appear as an exact contiguous substring in the corpus → matches.
- Any real Chinese *sentence* ("为什么发布3.4.41而不是3.5.0") becomes **one indivisible mega-token** that must appear byte-for-byte somewhere to match — which never happens for a paraphrased question.

I confirmed this isn't fixable by the querying agent just adding spaces either: manually spacing `"一次发布 只提 一个版本号 不要 按阶段"` still returned zero candidates, because that specific target fact (`corrections/2026-05-20-...json`) is stored in **English only** — a second, independent failure mode (no cross-language bridge in the local keyword path at all). D2 and D6 stack both bugs; D1/D3/D5 hit the tokenization bug alone (their target content is genuinely CJK, but sentence-length).

Given the owner's profile is explicitly bilingual (CN/EN) and roughly half the corpus sampled here is Chinese-language journal/decision text, this is a systemic gap, not an edge case.

## 5. Three worst retrieval failures (with root cause)

1. **Live-remote contamination of an "isolated" eval snapshot** (methodology + product risk, §0). Ambient `AGENT_RECALL_SUPABASE_KEY`/`AGENT_RECALL_EMBEDDING_KEY` env vars plus a copied `config.json` silently reconnect any snapshot/test store to the real production Supabase project whenever the remote responds inside the 2.5s budget (`recall-backend.ts`), with no signal to the caller besides the *absence* of a `degraded` flag. In the one case I caught it, the remote copy was demonstrably staler than the local file it was supposed to represent. This means recall results for the real product are not guaranteed to reflect the local `~/.agent-recall` at all, and are not reproducible run-to-run.

2. **CJK natural-language queries: 0% hit@5, root-caused to whitespace-only tokenization** (§4). Not a ranking weakness — a hard floor. Any Chinese-language question phrased the way a human actually writes Chinese (no spaces) returns either literally nothing or irrelevant filler from the insight-source fallback (which appears to substitute *something* rather than an honest empty result when keyword matching yields zero, e.g. D1/D3/D5 returning "macOS jetsam OOM-kills" and "Vox crash recovery" insights for version-bump queries — a false-hit generator dressed as a real answer).

3. **`palace/pipeline/` (the narrative "what was hard / how solved / synthesis" tier) is structurally invisible to `palaceSearch()`** (A8, C3). `palaceSearch()` only iterates `palace/rooms/<slug>/` subdirectories (`palace-search.ts:91-95`); `pipeline/` is a sibling directory, never scanned. Since this is exactly the tier meant to answer "what did we learn / what was hard about X," and it's entirely absent from local recall, any freshness question resolvable only from a closed pipeline phase (C3: is this phase closed?) structurally cannot be answered — not "ranked low," but never even a candidate. The same class of bug orphaned `health-baseline-2026-05-09.md` (A6) for the unrelated reason that it's a loose file sitting directly in `rooms/` rather than inside a room subdirectory.

## 6. Proposed grade: **DEGRADED**

Not FATAL (ASCII single-project recall of well-anchored facts works about half the time, and every result I counted as a hit was provenance-correct on adversarial re-check — no hallucinated citations observed). Not CLEAN — three separate systemic, structural bugs (not noisy edge cases) each block an entire class of query: cross-project safety-critical insight surfacing failed in the one test that mattered most (B1, push/publish gate); freshness questions were answered wrong-and-confident once and silent-and-absent three times, never right; and CJK natural-language recall is at a genuine 0%, not merely underperforming ASCII.

This directly substantiates the owner's suspicion that L1 is the weakest layer, and gives the specific, falsifiable mechanism behind the "written-but-unretrievable" continuity-wave incident: it isn't one bug, it's the pattern — content that is real and correctly written to disk becomes unreachable because of a directory-scanning boundary (`pipeline/` vs `rooms/`), a tokenizer boundary (ASCII whitespace), or a scoping boundary (project-local vs global) that the storage layer doesn't reconcile with what a querying agent actually asks.

## Honest limitations of this eval

- I did not test `ar digest`, `ar palace walk`, or `ar mirror` as retrieval channels — only `ar recall`/`ar insight` (primary) and `ar search --include-palace` (lexical cross-check).
- Category B's "expected MISS by architecture" items (B2, B4) are scored as failures against the *user's intent* (cross-project naming/reviewing discipline), not against the system's own documented design (which is honestly project-scoped by default) — this is a design-adequacy judgment call, flagged as such rather than hidden.
- I did not have a second independent grader; all HIT/MISS calls were made by re-reading the cited source file myself. This is Layer 1 self-grading against ground truth I also compiled — a second pass by a different agent against the same golden set would be the natural falsification check.

---

SOP_ID: c36ba121
FEEDBACK_HINTS: outcome=success edited=clean escalated=smooth
