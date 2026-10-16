# AgentRecall → Team Product: Strategy Synthesis (2026-10-15)

Inputs (read these for evidence):
- `2026-10-15-rigorous-eval.md` — retrieval eval, 26 adversarial checks, 4 findings
- `2026-10-15-hosted-mcp-architecture.md` — current state, gap to hosted multi-tenant, PR #42
- `2026-10-15-market-teardown.md` — 10 competitors, pricing, team-sync patterns, white space

## 1. Where AgentRecall actually is

| Dimension | Fact | Source |
|---|---|---|
| Retrieval | Default = lexical (BM25-lite + decay/salience, RRF k=60). Embeddings opt-in (511 MB manual). Not "RAG" by default. | eval §1–2 |
| Quality | keyword hit@1 15.4% / hit@5 73.1%; hybrid 69.2% / 80.8%. Paraphrase & zh↔en = 0% on default install. | eval §3–4 |
| Scale | 10k entries → p50 1.04 s (no persistent lexical index) | eval §4 |
| Privacy | Ambient `OPENAI_API_KEY` silently sends query text to OpenAI (`local-vector-backend.ts:17` / `recall-backend.ts:124`, since v3.4.15 commit dac4f4c). Cloud scrub = 12 prefix patterns. | eval §5 |
| Network | stdio only, zero auth, single-user single-machine | arch §1 |
| Team | Nothing built. PR #42 has RLS multi-tenant schema, unmerged, **mergeable: CONFLICTING (stale since 2026-09-27)**, 1/47 acceptance, never on real Postgres | arch §2, review F8 |
| Market | 371 stars vs Mem0 67k / Cognee 32k / Zep 32k / Supermemory 31k. Supermemory sells team seats at $19; Copilot memory is free | market §1, §4 |
| Unique | Corrections ledger + `check` blocking gate + heed-rate measurement (Wilson CI). No competitor has these. | market §5 |

## 2. Decisions (orchestrator recommendation)

1. **Reject "one shared database everyone uses."** Per-team isolation only. A shared pool turns one poisoned correction ("deploy without approval is fine") into a fleet-wide bypass of every customer's safety gate. No competitor does it (market §3; arch §7 poisoning, §11.5 — PR #42's visibility ceiling is `workspace`, no cross-tenant tier, arch §3).
2. **Do not sell "team memory."** It is commoditising (Supermemory $19 w/ seats, Copilot free). Sell **governance**: *"Correct an agent once — every teammate's agents obey next session — and a dashboard proves it."* Memory/recall is the substrate, not the product. (market §5)
3. **Team sync v1 = git, not a hosted DB.** Resolves the conflict between the two reports:
   - Hosted multi-tenant = weeks of work (#42 + HTTP + OAuth + RLS validation + GDPR) and puts us head-to-head with Mem0/Zep on storage.
   - Git-backed shared ledger reuses today's markdown store, keeps the zero-egress moat, and gives **human review of shared rules for free (PR = approval gate)** — the poisoning answer the market report says nobody combines with supersession + self-host.
   - Hosted (Supabase EU, PR #42) becomes Phase 3, built only if design partners ask for "no git".
4. **Fix the default-install quality gap before marketing anything.** A team product whose recall fails every paraphrase is not sellable.

## 3. Phased plan

### Phase 0 — Ship & harden (this week)
- Publish **3.5.1** as tagged (blocked: npm login must be the `tw260` maintainer account).
- **3.5.2 hardening** (needs version-bump approval):
  - [XS] Gate OpenAI vector backend behind explicit `AGENT_RECALL_CLOUD_EMBEDDINGS=1`; ambient key never selects it. + egress regression test (eval script `egress-ambient-openai-key.mjs` becomes a CI test).
  - [S] `scrubForCloud`: `KEY=value` + entropy secrets, email, IBAN, PAN+Luhn; run fail-closed `scrubForExport` on Supabase sync.
  - [XS] Per-render nonce in memory fence.
  - [S–M] Freshness: recency prior in fusion for near-duplicate candidates / marker-less `NUMBER unit` supersession.
- Close issue #26 (npx start failure) + merge triaged community PRs (#17 #15 #25 #21 #28, #27 for #4).

### Phase 1 — Default-install quality (1–2 wk, runs IN PARALLEL with Phase 2 — corrections load at session_start regardless of hit@1)
- Persistent incremental lexical index (10k p50 1 s → ~100 ms target).
- Default semantic leg: **first-run guided download** (not bundled in the npm tarball — a 145 MB package worsens npx start issue #26); target default hit@1 ≥ 60%, paraphrase/zh↔en ≥ 80% on golden + adversarial sets.
- Golden set → CI regression gate (hit@5, MRR, p95, injection tokens).

### Phase 2 — Team v1: git-backed governance (2–3 wk)
- `team` scope in addition to user/project: a team ledger directory living in a shared git repo (e.g. `.agent-recall/team/` in the code repo or a dedicated memory repo).
- Flow: agent/human proposes correction → written as a file on a branch → **PR review = approval** → merged rules pulled at `session_start` by every teammate's agent → `check` enforces.
- Provenance = commit/author; supersession = bi-temporal `valid_from/invalid_at` fields (Graphiti pattern), nothing deleted.
- Authority rule: only human-approved (merged) team rules may become blocking constraints; agent-inferred items stay advisory/quarantined.
- **Branch protection + required review on the team-ledger path is a hard onboarding requirement** (review rev 2): `agent-recall team init` verifies it via the git host API and refuses to activate blocking rules if direct push to `main` is possible — otherwise the PR gate is bypassable.
- **Measurement sync (review F1):** heed/violation events are per-machine and high-churn, so they do NOT go through PR review. Each member's agent appends to its own conflict-free path `team/events/<member-id>/<YYYY-MM-DD>.ndjson` (append-only NDJSON, already the core log format), committed in a daily batch to a dedicated `events` branch — no rebase conflicts because no two writers share a file. Event payload = rule id + outcome + timestamp only (no prompt/code text). If a team refuses event commits, the dashboard degrades to rules-only. (A hosted ingest endpoint is the Phase 3 alternative — named here so it doesn't sneak in unplanned.)
- **Team dashboard** (static HTML, CI-generated from `main` rules + `events` branch): rules, heed rate with Wilson CI **per rule, aggregated across members — never per person** (review F4: per-employee violation tracking = employee monitoring under BetrVG §87(1)6 / GDPR Art. 88; German buyers would need works-council sign-off). Per-member view off by default.
- **Scrub-before-commit (review F3):** fail-closed pre-commit hook runs `scrubForExport` + the 3.5.2 secret/PII patterns on every team-ledger file; git history is permanent, so rejection must happen before commit. New `team` scope / member-id params get allowlist validation (`sanitizeProject` discipline) before touching paths.
- Validate with **3 design-partner teams**. Exit criteria: (a) density — n ≥ 30 heed events per team; (b) **demand (review F2) — ≥ 1 of 3 teams commits to a paid pilot or LOI**. If (b) fails, do not build Phase 3; stay OSS.

### Flip triggers to #42-first (review rev 2)
Switch the team path to PR #42 server-authoritative sync if **≥ 2 of 3** design partners hit any of: no shareable git home for the ledger; need sub-minute rule propagation; need per-member read ACLs; explicitly prefer hosted.

### Phase 3 — Hosted, only if pulled by partners
- Keep #42 alive meanwhile: one bounded task in Phase 0 — rebase `feat/shared-memory-evolution` onto main and get its tests green, **no feature work**.
- Land PR #42 on a real EU Supabase project; Streamable-HTTP MCP + OAuth 2.1; connect as end-user JWT, **never `service_role`** (remove it from `smithery.yaml` hosting path); per-team RLS; GDPR export/delete; quotas.
- Pricing (hypothesis, unvalidated — review F2): the git+static-HTML stack is forkable, so it is NOT the paid surface. Paid surface = what can't be forked cheaply: hosted dashboard + event ingest, org-wide policy enforcement/audit log, EU-hosted or BYOC deployment, support/SLA. Free = OSS local + git team mode.
- PR #42 (server-authoritative + local outbox, `ar2_grants` can_approve, candidate→confirm gate) is the **scale path** for Phase 3, not discarded; the git `team/` layout should map 1:1 onto `ar2_records.visibility` so migration is an import, not a rewrite.

## 4. Risks
- Distribution gap (2 orders of magnitude). Mitigation: narrow buyer (regulated/EU coding teams), not star-chasing.
- Copilot/Claude Code ship "good enough" native memory. Mitigation: governance + measurement is orthogonal to host memory; integrate with CLAUDE.md rather than fight it.
- Own heed numbers are weak today; must reach credible n before pitching.
- Git sync has merge conflicts and latency (rules propagate on pull, not instantly). Acceptable for rules (low write rate); not for high-churn episodic memory — that stays per-user local.

## 5. Owner decisions needed

_Reviewed: `2026-10-15-strategy-review.md` (rev 2) APPROVE-WITH-CHANGES; F1–F9 applied. Adjudication vs rewritten arch report: hybrid, weighted git-first — the disagreement is which authoritative server ships first (git host vs Supabase), not architecture. Caveat: white space ≠ demand; Phase 2 demand criterion is the test._

1. Confirm: per-team isolation, governance positioning, git-first team sync (hosted deferred).
2. npm: log in as `tw260`, then approve publish 3.5.1.
3. Approve 3.5.2 hardening scope (version bump requires explicit yes).
4. Design partners: who are the 3 teams? (Novada eng?)
