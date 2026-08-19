# AgentRecall v3.4.43 — Evaluation Scorecard (2026-08-18)

Orchestrator: Fable 5. 6 parallel eval agents (L0-L3 + red-team + fresh-agent UX), plywood SOP c36ba121, against a 62M read-only snapshot of the real production store. Two load-bearing CRITICALs (scrub-class, CJK-tokenizer-class) independently verified by the orchestrator in shipped source. Grades assigned by orchestrator.

## Grades

| Layer | Grade | One-line |
|---|---|---|
| L0 Mechanism health | **C+** | Plumbing works NOW (capture/dedup/dual-stack verified) but `ar doctor` RED + `ar hygiene` YELLOW on real corpus, unremediated; 11 "rescue" cards are 100% noise |
| L1 Retrieval | **D** | hit@5 26.9%, **CJK 0%**, pipeline-tier never scanned, staleness returns superseded values — the "find it back" core is broken |
| L2 Injection economics | **C** | Token cost fine (~250 median); median project **~80% noise** — global blocks masquerade as project-specific; CJK budget +126% |
| L3 RMR (core claim) | **D** | Own telemetry: **12.6% heed rate** (62/491); 2/2 classes tested twice post-fix recurred (100% non-convergence) |
| Red team (safety) | **D** | 3 CRITICALs, all triggerable by ordinary use: content-scrub gap, spoofed-WM-file rescue injection, cwd-allowlist annexation |
| Fresh-agent UX | **C+** | `resurrect` genuinely good; capped by global-scope bleed + unsafe cwd resolver |

## Unifying diagnosis
**AgentRecall is now excellent at STORING and weak at SURFACING-THE-RIGHT-THING-SAFELY.** Write/capture/crash-proof/dedup (the last 3 waves' work) is genuinely solid. Everything above the plumbing — retrieval relevance, injection scoping, heed, and content safety — is weak-to-broken. The product promise ("do nothing → stop repeating mistakes") is not substantiated by its own dogfood data today.

**Root cause is the product's own signature failure: class-not-instance.** Three independent instances, all "fixed one consumer, didn't generalize", verified in source:
1. **Scrub**: `scrubForCloud` applied only before `syncToSupabase`; local `fs.writeFileSync` writes raw in journal-write / palace-write / awareness / digest / insights-index, and handoff.ts scrubs nothing. WM tier (3.4.42) was the ONE fixed member. Threat model shifted (local now cross-session-injected + pasted via handoff) but scrub stayed cloud-only.
2. **CJK tokenizer**: `split(/\s+/)` whitespace-only across all recall/search paths → unspaced Chinese never matches. `check-action.ts` was made CJK-aware (Intl.Segmenter) in 3.4.39 but the fix never reached recall/search.
3. **(precedent, credit)**: the `--root` bypass WAS generalized in the followups wave (12 sites) — proof the team CAN do class-level when it's the explicit goal.

**Causal chain**: L1 CJK-blindness + L2 80% noise → the "right correction never surfaces project-scoped, in the user's language" → a large share of L3's 12.6% low-heed is NOT disobedience, it's non-surfacing. Fix retrieval/injection and heed rises without touching the agent.

## Hard message to owner
The last 3 waves (continuity, WM, Train C) all hardened the write path — which the very first incident already proved was the half that WORKED (Claude Code's raw transcript out-performed AR precisely because AR's *surfacing* failed). Three waves of polish went into the strong half. The eval says: **stop building capture, start building retrieval + relevance + content-safety.**

## Ranked fix backlog (each = a wave)
- **P0-a Scrub the class**: scrub before every LOCAL write (or a local-scrub variant), incl. handoff.ts. Content-safety CRITICAL. [red-team, verified]
- **P0-b CJK retrieval**: port check-action's Intl.Segmenter tokenizer into palace-search/journal-search/smart-recall. Unblocks the owner's own primary language + lifts heed. [L1, verified]
- **P1-a Resolver/rescue safety**: cwd-allowlist must require a project root; orphan-rescue must not trust spoofable dropped WM files; cap the sweep. [red-team CRITICAL 2/3, UX]
- **P1-b Injection relevance**: scope or omit the 3 global blocks (continuity/insights/room-topics) so the median project isn't 80% noise. [L2]
- **P2-a Retrieval coverage**: scan `palace/pipeline/` in palaceSearch; wire supersession/staleness into recall so corrected facts stop returning stale. [L1, red-team]
- **P2-b Store remediation**: close `ar doctor` RED (14 ledger divergences, 8 stalled consolidations) + `ar hygiene` YELLOW (224 stray counters, 180 test fixtures from the --root bug) — owner-gated deletes; add an auto-remediation loop, not just detection.
- **P3 Long tail**: P0-cap-of-5 (AgentRecall has 9 active), `watch_for` reads wrong store, CJK budget in corrections_total/insights_total, stale reused journal titles.

## Meta-finding (process risk)
Three eval workers independently discovered the "isolated" snapshot silently reconnects to the REAL production Supabase (ambient `AGENT_RECALL_SUPABASE_KEY` + copied `config.json`), one returning stale remote content. Same class as the --root test-pollution bug: env creds override the intended sandbox. Anyone running tests/evals with those vars set is touching prod.
