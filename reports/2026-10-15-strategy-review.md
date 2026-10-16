# Independent Review — 2026-10-15 Product Strategy

**Reviewer:** independent adversarial reviewer (did not author the strategy or any of its three inputs).
**Scope:** `2026-10-15-product-strategy.md` verified against `2026-10-15-rigorous-eval.md`, `2026-10-15-hosted-mcp-architecture.md`, `2026-10-15-market-teardown.md`, and the repo (`main @ c52e37e`, read-only). No files outside this review were edited.
**Rev 2 (same day):** the architecture report was REWRITTEN after my first pass — it now argues team sync = server-authoritative backend + local cache/outbox (PR #42) and rejects CRDT, directly contesting the strategy's "git-first, hosted deferred" call. Section "Adjudication" below rules on it; findings F8–F9 are new facts the rewrite surfaced.

## Verdict: **APPROVE-WITH-CHANGES**

The three structural calls — per-team isolation (no shared pool), governance positioning, git-first team sync with hosted deferred — are sound, evidence-backed, and consistent with the house security rules. But the strategy (v1) shipped its sellable artifact (the team dashboard) on a data path that its own git-sync model cannot feed, priced a forkable OSS artifact with no enforcement story, and contained two factual slips. **Strategy v2 (same day) applied F1–F6 faithfully** — measurement sync via per-member NDJSON event files, scrub-before-commit, EU aggregation-only dashboards, a demand exit criterion, parallel Phase 1/2, first-run download instead of a 145 MB bundle, and the v3.4.15 fix. Remaining: the adjudication below, F7 nits, and new findings F8–F9.

---

## Adjudication: git-first vs PR #42 server-authoritative-first vs hybrid

The rewritten architecture report argues team sync should be the #42 model (server-authoritative backend + local cache/outbox, `ar2_grants` ACL with `can_approve`, candidate→confirm gate, revision history, 7-layer poisoning defense) and rejects CRDT. This contests the strategy's "git-first, hosted deferred." Ruling, criterion by criterion:

**1. Time-to-first-team — git wins decisively.** Git path: a repo, a directory convention, a PR — a design partner sees value in days, using a review motion (PR approval) the target buyers already perform daily. #42 path to the same milestone: rebase a conflicted PR (see F8) + wire 5 tools (P3, unstarted) + first-ever run on real Postgres + re-run the P2 security findings (which initially FAILed on unredacted secrets and cross-project write) + net-new Streamable-HTTP transport + MCP OAuth 2.1 + adversarial RLS fuzzing that the arch doc itself requires before any external team. Calibration: the SME program's own first validation run produced 1/47 — the "~1 wk Phase 0" estimate has no track record behind it.

**2. Poisoning safety — design edge #42, proven-enforcement edge git; git is sufficient for v1.** #42's defenses are finer-grained (authority recompute, candidate-by-default, existence-hiding, grant-revocation terminal at outbox replay) but are unit-tested against PGlite only — never enforced on the real engine. Git's gate is GitHub/GitLab branch protection + required review + CODEOWNERS: coarser (anyone with repo read sees all team rules — acceptable, since these are by definition workspace-visibility rules), but battle-tested at a scale no fresh RLS deployment can claim, and the strategy's authority rule (only merged rules become blocking; agent-inferred stays advisory) reproduces candidate→confirm semantics. **Condition:** Phase 2 onboarding MUST require branch protection + required human review on the ledger paths — an agent with direct push access otherwise bypasses "PR = approval gate" entirely, which is exactly the poisoning hole the gate exists to close. This is currently missing from the strategy.

**3. Zero-egress moat — git wins outright.** The ledger lives in the team's own git hosting (including self-hosted GitLab/Gitea); EU residency is wherever their git is. #42 moves team memory to a Supabase project — BYOC softens this but complicates onboarding and weakens the "nothing leaves your infrastructure" pitch that is the stated differentiator.

**4. #42's real readiness (verified today, facts neither report states):** `gh pr view 42` → OPEN, non-draft, **`mergeable: CONFLICTING`** against main, last updated **2026-09-27 — 18 days stale** while main advanced through 3.5.0 → 3.5.1 (A11–A14). Plus the known: 1/47 acceptance (PASS 1 / BLOCKED 17 / NOT_RUN 29), P3 unwired, PGlite-only. Betting the first team milestone on this foundation is sequencing GTM behind an infra bet — the infra-over-revenue pattern.

**5. The arch doc's own logic does not refute git — it never engaged it.** Its option space is server-authoritative vs CRDT vs pure-hosted; git+PR is absent, despite the market report identifying it as the only shipped human-review gate for shared agent memory (Claude Code row, market §2–3). And its anti-CRDT argument — semantic conflicts need "a single arbiter + explicit supersession + human review" — *describes git+PR exactly*: one authoritative main branch, explicit file-level supersession, human-arbitrated merge. Git IS a server-authoritative model; the server is the repo host and the arbiter is a human reviewer. The real disagreement is only *which* authoritative server ships first, and that is a time-to-market question (criterion 1), not an architecture question.

**Ruling: HYBRID, weighted git-first — which is what strategy v2 now encodes, and I endorse it.** Git for Phase 2 design partners; ratify #42's server-authoritative + outbox model as the Phase 3 scale path; adopt #42's semantic contract (authority ladder, candidate→confirm statuses, visibility values) as the git file schema now so Phase 3 is an import, not a rewrite (strategy v2 Phase 3 bullet 3 already says this). Two conditions to add:
- **Rebase PR #42 over main now** (bounded, no feature work, no real-DB spend): it is CONFLICTING today and the conflict cost grows monotonically with every main commit. Letting the scale-path asset rot while deferring it is a false economy.
- **Branch protection as a hard onboarding requirement** (criterion 2 above).

**Honest flip triggers** (when #42-first would have been right): design partners without a shareable git home (multi-repo sprawl, no appetite for a dedicated memory repo); need for sub-minute rule propagation or per-member read ACLs on rules; partners explicitly preferring a hosted pilot. If ≥2 of the 3 design partners hit these, flip to the #42 path early — the contract-compatible file schema makes that cheap.

---

## Fact-check summary

Every number I could trace, traced. Verified against inputs and/or code:

| Claim (strategy) | Status | Evidence |
|---|---|---|
| keyword 15.4/73.1, hybrid 69.2/80.8, MRR, paraphrase/zh↔en = 0% default | ✓ | eval §3, §4 T1–T3 |
| 10k entries → p50 1.04 s, no persistent index | ✓ | eval §4 scale (1,045 ms) |
| Ambient `OPENAI_API_KEY` silently selects cloud embedding leg | ✓ code | `packages/core/src/vector/local-vector-backend.ts:17` (`available() = !!process.env.OPENAI_API_KEY`); selection comment `packages/core/src/tools-logic/recall-backend.ts:124` |
| Cloud scrub = 12 prefix patterns | ✓ code | `packages/core/src/storage/content-guard.ts` — counted exactly 12 entries (AKIA, ghp_, gho_, ghs_, github_pat_, ghr_, sk-, xoxb-, xoxp-, npm_, _authToken, PEM) |
| stdio only, zero auth | ✓ code | `packages/mcp-server/src/index.ts:215` (`StdioServerTransport`), `:120` ("All data stays local") |
| PR #42 unmerged, 1/47 acceptance, never real Postgres | ✓ | `origin/feat/shared-memory-evolution:reports/shared-memory-evolution/2026-09-27-r1/FINAL-REPORT.md` — "All 47 cases: PASS 1 (A02), BLOCKED 17, NOT_RUN 29, FAIL 0"; PR #42 open on GitHub |
| 3.5.1 tagged, unpublished; npm login = `tw260` | ✓ | tags `v3.5.0`/`v3.5.1` exist; `npm view agent-recall-mcp` → version 3.4.51, maintainer `tw260 <tong.wu@novada.com>`; FINAL-REPORT: `npm whoami` → ENEEDAUTH |
| Issue #26 (npx start failure) + PRs #17 #15 #25 #21 #28, #27 for #4 | ✓ | all exist and open on Goldentrii/AgentRecall-X; #27 "update repository links" does address #4 "fix stale GitHub links" |
| Market figures (stars, Supermemory $19 seats, pricing) | ✓ | market §1, §4 (note: "Zep 32k" is really Graphiti 31,796 — the market report itself says to quote it that way, acceptable) |
| smithery.yaml service-role config exists (to be walled off) | ✓ code | `smithery.yaml:16` |
| ORT-only bundle ~145 MB, 511 MB manual setup, fence nonce, scrub items | ✓ | eval §6.4, §7 items 1/5/7 |

---

## Findings (ranked)

> **Status note (rev 2):** F1–F6 were applied in strategy v2 and the applied edits are faithful to the findings (verified by re-read). They remain below as the record of what changed and why. F7 is partially unapplied; F8–F9 are new.

### F1 — HIGH (product design): the dashboard's data path contradicts the git-sync rationale *(APPLIED in v2 — per-member append-only NDJSON on a dedicated `events` branch, daily batch, rules-only degradation, hosted ingest named as the Phase 3 alternative)*
Strategy §3 Phase 2 sells "Team dashboard (static HTML from the repo, CI-generated): rules, heed rate with Wilson CI per rule, violations/week" and sets exit criterion "n ≥ 30 events per team." But heed/violation **events** are generated on each teammate's machine at session time. For repo CI to compute team-wide heed rate, those events must land in the repo — and events are exactly the high-churn data the strategy's own risk section (§4) says "stays per-user local" because git sync is only acceptable "for rules (low write rate)." As written, the sellable artifact cannot be computed from the repo alone. This is solvable (per-user append-only ndjson event files committed batched/daily, rebase-free paths; or a minimal ingest endpoint — which quietly reintroduces a hosted component), but the strategy must name the mechanism, because it is the revenue-bearing feature.
**Edit:** add to Phase 2 an explicit "measurement sync" design bullet (per-user append-only event files, batch cadence, conflict-free path layout) and reconcile risk §4's "high-churn stays local" with the dashboard's needs.

### F2 — HIGH (commercial): "~€/seat/mo for dashboard + policy features" has no enforcement story
The entire Phase 2 stack is OSS markdown + git + CI-generated static HTML. Nothing in that stack can meter or gate a seat. A team can fork the dashboard generator and pay nothing. Competitors monetize because the hosted service *is* the gate (Supermemory, Zep, Mem0 — market §4). The strategy prices a thing it cannot fence.
**Edit:** either (a) state what is actually proprietary/licensed (e.g., dashboard generator under BSL/commercial license, or hosted dashboard aggregation as the paid part — which partially merges with F1's ingest endpoint), or (b) re-state Phase 2 pricing as a hypothesis to be answered by design partners, not a plan line. Related: Phase 2's exit criterion is measurability (n ≥ 30), not demand. Add a willingness-to-pay criterion (≥1 design partner signs a paid pilot/LOI) before any Phase 3 investment — the original arch report's own caveat ("whitespace ≠ demand") had no teeth in the plan, and the arch REWRITE dropped that caveat entirely (see F9). *(APPLIED in v2 — demand exit criterion "≥1 of 3 teams commits to a paid pilot or LOI, else stay OSS" + Phase 3 pricing reframed around the non-forkable surface.)*

### F3 — MEDIUM (security/privacy): team ledger in git = secrets and PII in immutable history *(APPLIED in v2 — fail-closed pre-commit scrub + allowlist validation on team-scope params)*
Phase 0 hardens `scrubForCloud`/`scrubForExport` on the **Supabase** path only. Phase 2 then has agents writing correction files (rule/why/evidence) onto branches of a **shared git repo**. A "why" field quoting a leaked key or customer data enters git history permanently (history rewrite across a team is impractical). The current scrubber is 12 prefix patterns (T10b FAIL: `VAR=value`, emails, IBANs all survive).
**Edit:** Phase 2 must require fail-closed scrub-before-commit on every file written to the team scope (same bar as the Supabase export path), plus the `sanitizeProject`-grade allowlist on the new `team` scope path components (house rule: every MCP param untrusted — `paths.ts:89,231` discipline carried forward).

### F4 — MEDIUM (EU wedge irony): per-rule violation dashboards are employee-monitoring territory in the EU *(APPLIED in v2 — aggregate-only by default, per-member view opt-in, BetrVG §87(1)6 named)*
The chosen buyer is "regulated/EU coding teams" (§4) and the owner is in Germany. A dashboard showing "violations/week" per rule, computed from events attributable to individual teammates' agents, is plausibly Leistungs-/Verhaltenskontrolle — triggering works-council co-determination (BetrVG §87) and GDPR Art. 88 employee-data issues at exactly the customers the strategy targets. Nobody flagged this in any input.
**Edit:** add a risk line + design constraint: dashboard aggregates at team/rule level by default, no per-person drill-down without explicit opt-in; make that a selling point (privacy-preserving by construction), not an afterthought.

### F5 — MEDIUM (sequencing): Phase 1 need not gate Phase 2, and decision 4 is overstated *(APPLIED in v2 — Phase 1 marked parallel-with-Phase-2; first-run guided download chosen over the 145 MB bundle, citing #26)*
Decision 4: "A team product whose recall fails every paraphrase is not sellable." But the product being sold (decision 2) is governance: corrections are **always loaded at session_start** (arch §1, `storage/corrections.ts`) — the blocking gate and heed measurement do not depend on lexical hit@1 at all. Paraphrase recall quality matters for demo credibility, not for the governance mechanism. Serializing Phase 1 → Phase 2 delays design-partner contact by 1–2 weeks for no structural reason.
**Edit:** run Phase 1 and Phase 2 in parallel (different skill sets anyway: retrieval eng vs product/sync), and soften decision 4 to "fix before public marketing," not "before team v1 work starts." Also note the interaction the plan misses: issue #26 is an **npx start failure at 3.4.21**, and Phase 1 proposes adding a ~145 MB ORT bundle to the default install — bundling makes npx-based distribution strictly worse. The first-run guided download alternative avoids that; the plan should pick it or justify the bundle against #26.

### F6 — LOW (factual): "since v3.4.20" is wrong — the ambient-key backend shipped in v3.4.15 *(APPLIED in v2 — now cites v3.4.15, commit dac4f4c, local-vector-backend.ts:17)*
`local-vector-backend.ts` (containing `available() = !!OPENAI_API_KEY`) was added in commit `dac4f4c` "feat: v3.4.15 — contradiction detection, local vector search…". The eval never stated a version; the strategy added one and got it wrong.
**Edit:** §1 Privacy row: v3.4.20 → v3.4.15.

### F7 — LOW (precision nits) *(still UNAPPLIED in v2)*
- §1 Market row: "Copilot memory is free" → "bundled in paid Copilot" (market: "free inside Copilot" — it still requires a Copilot subscription; the commoditization argument survives either way).
- Phase 2: "`valid_from/invalid_at` (Graphiti pattern)" — Graphiti's fields are `valid_at`/`invalid_at` (market §2 Zep). Rename or drop the attribution.
- §1 Market row: "Zep 32k" should say "Graphiti 31.8k (Zep's engine; zep repo itself is 5k)" to be audit-proof.
- Phase 2 PR-review gate: add the rubber-stamp failure mode — if every rule needs a PR, teams will auto-approve; mitigation is already implied (only merged rules become *blocking*; advisory rules flow freely) but should be stated as the designed pressure valve.

### F8 — MEDIUM (new, verified): PR #42 is merge-CONFLICTING and 18 days stale — stated by neither report
`gh pr view 42` (2026-10-15): state OPEN, non-draft, **`mergeable: CONFLICTING`** against `main`, `updatedAt 2026-09-27` — main has since moved through 3.5.0 → 3.5.1 (A11–A14 CI hardening). Both the strategy ("becomes Phase 3") and the rewritten arch report ("already designed and built") treat #42 as a parked-but-ready asset; it is parked and **rotting**. Every main commit raises the eventual rebase cost of the designated scale path.
**Edit:** add to Phase 0 or 1 a bounded task: rebase `feat/shared-memory-evolution` over main (no feature work, no real-DB spend), and note #42's CONFLICTING state in §1 of the strategy. Owner decision 1 should ratify the hybrid explicitly: "git-first for design partners; #42 server-authoritative as the scale path, kept rebased."

### F9 — LOW→MEDIUM (consistency drift): the arch rewrite broke the strategy's citations and silently dropped its own demand caveat
The strategy cites "arch §0" for decision 1 (shared-pool rejection) and "arch §1.8" for the Team row. The REWRITTEN arch has neither: §0 is now the sync-model headline, §1.8 does not exist, and the entire shared-pool-(A)-vs-per-tenant-(B) argument — the cited evidence for decision 1 — was deleted in the rewrite (its substance survives only implicitly via §2's workspace boundary and §7). The rewrite also dropped the old report's "whitespace ≠ demand — validate that buyers actually want a blocking gate" caveat, i.e., the architecture doc lost its only adversarial-commercial sentence precisely while escalating its architectural confidence. The strategy v2 demand gate (Phase 2 exit b) now carries that burden alone.
**Edit:** (a) strategy: re-point decision 1's citation to market §3 + arch §2/§7, and the Team row to arch §0/§9; (b) arch: restore a one-paragraph shared-pool rejection (it is the answer to the owner's original "大家都可以用一个数据库" framing — deleting it invites the question to be re-asked) and restore the demand caveat. House rule applies: update one place → update ALL; a strategy citing sections that no longer exist is a trap for the next agent.

---

## Steelman: hosted-first instead of git-first — and why it still loses

The strongest case for hosted-first: (1) it is the only architecture that natively solves F1 (event aggregation) and F2 (billing surface) — every monetizing competitor is hosted; (2) onboarding is one OAuth click vs. "create a memory repo, wire CI, teach agents to pull" — real friction for design-partner acquisition; (3) rules propagate instantly, not on next pull; (4) non-git buyers (PM/ops teams running agents) are excluded by git-first.

Why git-first is still right for v1: the target ICP is explicitly coding teams on Claude Code/Cursor — 100% git-native, and the host tool itself has already validated git+PR as the *only* shipped human-review gate for shared agent memory (market §2, Claude Code row; §3 "review/approval" pattern). Hosted-first means betting GTM on PR #42 — 1/47 acceptance, never run on real Postgres (FINAL-REPORT), merge-CONFLICTING and 18 days stale (F8) — plus net-new transport/auth/tenancy/GDPR surface (arch §9), head-to-head with incumbents holding 2 orders of magnitude more distribution (market §0), while discarding the zero-egress moat that is the stated differentiator. The non-git buyer is a segment to lose on purpose at this stage. **The call stands — provided F1/F2 are answered, because they are the two places where "hosted" sneaks back in through the side door; better to design that door now than discover it mid-Phase-2.** (The fuller criterion-by-criterion ruling against the rewritten arch report's server-authoritative-first position is in the "Adjudication" section above.)

On "sell governance, not memory": directionally supported — Zep monetizes governance attributes (SOC2, audit logs, VPC seats at $125+/mo), CB Insights flags agent-security as a funded theme, and Copilot/Supermemory commoditize plain memory (market §§2–4). But there is zero direct evidence anyone pays for a *blocking gate + heed-rate dashboard* specifically; that is precisely what the 3 design partners must establish — hence F2's demand exit criterion.

## House-rule compliance check
- Never `service_role` on request path: respected (Phase 3 explicitly removes it from the hosting path; smithery legacy walled off). ✓
- No shared cross-tenant pool: decision 1 rejects it outright. ✓
- Every MCP param untrusted: not violated, but the new `team` scope needs the explicit sanitization requirement (F3). 
- REDLINE: publish/version-bump correctly gated on owner approval (§5). ✓

## Bottom line
Approve the three structural decisions; strategy v2 has already applied F1–F6. **On the contested call, the ruling is: hybrid, weighted git-first** — git for Phase 2 design partners (time-to-first-team, zero-egress, proven review enforcement), PR #42's server-authoritative model ratified as the Phase 3 scale path with the git file schema mapped onto its contract so migration is an import. Before owner sign-off, the strategy still needs: branch-protection as a hard Phase 2 onboarding requirement (Adjudication condition 2), a bounded "rebase #42 now" task + CONFLICTING-state disclosure (F8), citation repair after the arch rewrite plus restoring the arch doc's shared-pool rejection and demand caveat (F9), and the F7 nits.
