# Agent-Memory Market Teardown — Competitive Landscape for AgentRecall as a Team Product

**Date:** 2026-10-15
**Author:** Market/competitive researcher (sub-agent)
**Subject:** Can AgentRecall become a *team* product — distributed, synced memory across members/agents — and where is the defensible wedge?
**Method:** Novada research/extract/search + live GitHub API star counts (2026-10-15). Every external claim is cited. Funding figures that could not be re-verified in this pass are flagged `⚠ unverified`.

---

## 0. TL;DR (the adversarial version)

- **The "memory for agents" category is crowded and funded.** Mem0 (67k stars, ~$24M raised), Cognee (32k, $7.5M seed), Graphiti/Zep (32k), Supermemory (31k), Letta (25k). AgentRecall-X is at **371 stars** — two orders of magnitude behind on distribution. [stars: gh API 2026-10-15; funding: [1]]
- **"Team memory" is already being sold, right now, by funded players.** Supermemory ships **team seats** on a $19 plan; Zep sells **governed multi-seat enterprise** (SOC 2 Type II, HIPAA, VPC, 1-yr audit logs); GitHub Copilot ships **repo-scoped shared memory for free** inside the product. [[2]](pricing), [[3]](pricing), [[4]](copilot)
- **AgentRecall's entire team thesis is still unbuilt.** It is single-user, local `~/.agent-recall/` markdown with an *optional* Supabase mirror. There is no multi-writer sync, no ACL, no conflict resolution, no shared-scope model today. The competitors already have these.
- **The honest wedge is NOT "team memory" generically** — that is getting commoditized. It is the **intersection nobody else occupies: a governed *corrections/rules ledger* + *behavior-change measurement* + *zero-egress / git-backed / self-host*.** Reframe from "another memory DB" to **"governance & guardrail layer for agent fleets you can audit and keep on-prem."**
- **Biggest risk to the pivot:** the moment AgentRecall builds real team sync, its markdown-on-disk model has to become a hosted/replicated service — i.e. it starts competing with Mem0/Zep **on their turf, with 2 orders of magnitude less funding and mindshare.** The defensibility has to come from governance + compliance, not storage.

---

## 1. Comparison matrix

Stars are live GitHub counts (gh API, 2026-10-15). "Team sync" = does a shipped, first-class multi-user/shared-memory model exist today.

| Product | GitHub stars | Architecture | Storage | Team / multi-user model | Deploy | MCP | Pricing floor | Measures behaviour change? |
|---|---|---|---|---|---|---|---|---|
| **Mem0** (`mem0ai/mem0`) | **67,237** | Hybrid: vector + graph (Neo4j) + key-value; LLM extraction | Pluggable vector store (Qdrant/Chroma/pgvector/Weaviate) + graph | user / session / agent scopes; multi-tenant by default. No review/approval of memories | Cloud + OSS self-host | Yes (OpenMemory MCP) | Free → $19 → $249/mo | No (retrieval only: LoCoMo) |
| **Zep / Graphiti** (`getzep/graphiti`) | **31,796** (graphiti) / 4,960 (zep) | Temporal knowledge **graph** (bi-temporal) | Graph DB (Neo4j/FalkorDB) | Enterprise: projects, governance, **Custom MCP Server seats**, SOC2/HIPAA, 1-yr audit logs | Cloud **or your VPC** | Yes | $125/mo Flex → Enterprise custom | Partial (LongMemEval, temporal) |
| **Letta** (`letta-ai/letta`, ex-MemGPT) | **25,156** | **Agent self-manages** memory (OS-style context paging) | Postgres; agent state server | Hosted platform, API keys; agent-scoped | Cloud API + OSS self-host | Yes | API usage-based | No (self-edit elegance, not measured) |
| **Supermemory** (`supermemoryai/supermemory`) | **31,238** | Vector + context engine; "runs fully locally" | Own engine | **3 team seats on Pro**, unlimited end users; credit-based | Cloud + local | Yes (Universal Memory MCP) | Free → $19 → $100/mo | No (187ms recall, token savings) |
| **Cognee** (`topoteretes/cognee`) | **32,359** | **Graph-RAG** (vector + knowledge graph), small models | Graph + vector | Managed cloud (beta); OSS | Cloud beta + OSS self-host | Yes | OSS; usage-based cloud | No (relationship recall) |
| **LangMem** (`langchain-ai/langmem`) | **1,705** | Short-term + long-term semantic; LangGraph-native | LangGraph store | **Namespace multi-tenancy** | Via LangSmith | Through LangGraph | LangSmith tiers | No |
| **Basic Memory** (`basicmachines-co/basic-memory`) | **4,232** | Local markdown knowledge graph (Obsidian-style) | **Local markdown** | Single-user; sync = your files | Local-first | Yes | OSS / free | No |
| **ByteRover / Cipher** (`campfirein/cipher`) | **4,954** | Portable memory layer for **coding agents** (CLI `brv`) | Local + cloud | Team/cloud sync (ByteRover platform) | Local + cloud | Yes (MCP-native) | Freemium | No |
| **mcp-memory-service** (`doobidoo/...`) | **2,018** | Compression/retrieval MCP | SQLite/vector | Single-user | Local | Yes | OSS | No |
| **GitHub Copilot memory** (native) | n/a (product) | Scoped memories tied to **code references**, validated before reuse, auto-expire | GitHub-hosted | **Repo-scoped, shared across coding + review** | Cloud (GitHub) | n/a | Bundled in Copilot | Validation, not heed-rate |
| **Claude Code** (CLAUDE.md / AGENTS.md) | n/a (product) | Flat instruction files loaded at session start; Anthropic memory tool (API) | Files in repo | **Team sync = git + PR review** (only one with real human approval of shared memory) | Local / repo | n/a (is the host) | Bundled | No |
| **AgentRecall-X** (`Goldentrii/AgentRecall-X`) | **371** | 5-layer cognitive model; RRF fusion; optional local embeddings; **corrections ledger + `check` gate** | **Local markdown**; optional Supabase mirror | **None shipped** (single-user today) | Local-first; optional Supabase | Yes (5 tools) | OSS / MIT | **Yes — heed rate + Wilson CI (unique)** |

> Note: `getzep/zep` repo (4,960) is the older product; **Graphiti (31,796) is the live engine** and the number to quote for Zep's traction. [[1]](state-blog)

---

## 2. Per-product notes

### Mem0 — the default, the one to beat on distribution
- **Architecture:** hybrid. Memories stored as embeddings in a pluggable vector store (Qdrant, Chroma, pgvector, Weaviate) with metadata; a **Neo4j graph layer** added for relationship queries. LLM decides what to extract/update ("system-managed extraction"). [[5]](devto), [[6]](maidul)
- **Team/sync:** "multi-user / multi-tenant **by default**", memory addressed at **user, session, and agent** levels. This is per-user scoping, *not* a shared, conflict-resolved team store with review — but it's the closest thing to a tenancy model shipping at scale. [[6]](maidul), [[7]](graham)
- **A known weakness (from source-reading):** Mem0 increments a `mentions` counter on every graph node/edge that is **written but never read back or used in retrieval scoring** — "good infrastructure, not yet connected." Also: "creates a node for every entity → millions of nodes after moderate usage, graph queries slow to a crawl." [[1]](state-blog), [[8]](reddit-graph)
- **Pricing:** Hobby Free (10k add / 1k retrieval), Starter **$19/mo** (50k/5k), Pro **$249/mo** (500k/50k, unlimited projects, graph memory, "Dream" consolidation), Enterprise custom (compliance, SLAs). [[2]](mem0-pricing)
- **Traction/funding:** ~**67k stars**; **$24M raised** per the most-cited 2026 teardown (a Tracxn profile calling it "unfunded" is stale/wrong). [[1]](state-blog)
- **Benchmark credibility:** Mem0's headline numbers are on **LoCoMo**, widely regarded as saturated/weak; cost claim ~7k tokens/query is their own published figure. Retrieval-only — no behaviour measurement.

### Zep / Graphiti — the enterprise/governance leader
- **Architecture:** memory as a **bi-temporal knowledge graph**. Edges carry four datetimes: `valid_at` / `invalid_at` (when a fact was true in the world) and `created_at` / `expired_at` (when the system learned/retired it). Contradictions set `invalid_at` instead of deleting — enabling "what did we know about X at time T." This is **real, verified in the source**, not marketing. [[1]](state-blog)
- **Team/governance:** the strongest shipped governance story. Enterprise adds **SOC 2 Type II, HIPAA BAA, 1-year audit + API logs, unlimited projects, Custom Memory MCP Server seats, deploy to your VPC.** [[3]](zep-pricing)
- **Pricing:** Flex **$125/mo** (50k credits, then $25/10k), Enterprise custom. Credit-based. [[3]](zep-pricing)
- **Benchmark credibility:** Graphiti scores **~15 points higher on LongMemEval** than general-purpose alternatives, runs async ingest. LongMemEval is a more credible benchmark than LoCoMo; the temporal angle is genuinely differentiated. [[9]](scored)

### Letta (ex-MemGPT) — agent self-management
- **Architecture:** OS-inspired virtual context management; the **agent itself** moves info between in-context and long-term store and rewrites its own working memory/persona. Most flexible for self-improving behaviour; depends on agent discipline. [[3]](letta-note), [[6]](maidul)
- **Deploy:** RESTful API at `api.letta.com` + Python/TS SDKs; OSS self-host. Agent-scoped state, not a team-shared-memory product. [[10]](letta-docs)
- **Traction/funding:** ~**25k stars**. Prior reporting: **$10M seed led by Felicis (2024), ~$70M valuation** — `⚠ unverified` in this pass (not re-fetched).

### Supermemory — "memory API for the AI era", already has team seats
- **Architecture:** vector + context engine, claims it "can run fully locally"; 100B+ tokens/mo processed, **187ms median recall**. [[11]](supermemory-pricing)
- **Team/sync:** Pro ($19/mo) includes **3 team seats, unlimited end users**; credit-based, "only unique content is billed." Max $100/mo. This is a shipped (if shallow) team model. [[11]](supermemory-pricing)
- **MCP:** "Universal Memory MCP makes your memories available to every single LLM." [[12]](supermemory-mcp)
- **Funding:** `⚠ unverified` here — reported seed (Susa Ventures / others) not confirmed in this pass.

### Cognee — graph-native
- **Architecture:** merges vector search with a **knowledge graph** (Graph-RAG); deterministic relationship retrieval ("User A works for Company B which uses Product C") where pure vector fails. More setup complexity. Uses small models, "free." [[9]](scored), [[13]](cognee-gh)
- **Funding:** **$7.5M seed**, ~32k stars. [[1]](state-blog)

### LangMem — for LangGraph shops
- Separates short-term working memory from long-term semantic; **namespace-based multi-tenancy**; native to LangGraph checkpointing. Small footprint (1,705 stars) — it's a feature of the LangChain ecosystem, not a standalone contender. [[9]](scored)

### Basic Memory — the closest philosophical cousin
- **Local markdown knowledge graph** (Obsidian-style), "AI conversations that actually remember," MCP-native. **4,232 stars.** Single-user; "sync" is literally your own file sync. This is the nearest neighbour to AgentRecall's local-markdown bet — and it has **~11× the stars** but still no team model. Signals that local-markdown memory resonates, but nobody has turned it into a *team* product yet. [[14]](basic-memory-gh)

### ByteRover / Cipher — the coding-agent-specific competitor to watch
- Rebranded `campfirein/cipher` → **ByteRover CLI (`brv`)**, explicitly "the portable memory layer for **autonomous coding agents**." MCP-native, works across Claude Code / Codex / Cursor. **4,954 stars.** The ByteRover cloud platform adds team sync. This is the most direct "team memory for coding agents" competitor by *positioning*, and it's still sub-5k stars — the coding-agent sub-segment has **no dominant winner yet.** [[15]](cipher-gh)

### GitHub Copilot memory — the incumbent threat
- GitHub shipped an **agentic memory system**: scoped memories **linked to real code references**, **validated before reuse**, **repository-specific**, **shared across Copilot experiences (coding + review)**, **auto-expiring** to avoid stale context. This is free inside Copilot and is the single biggest commoditization threat to "shared memory for coding teams." [[4]](copilot)

### Claude Code / Anthropic — the host, and the only one with human review of shared memory
- `CLAUDE.md` / `AGENTS.md` are flat files loaded at session start; team "sync" is **git + pull-request review** — meaning shared memory passes through normal code review before it's trusted. The Anthropic **memory tool** (API) adds programmatic memory for API builders. No managed, ranked, decaying team store — which is exactly the gap third-party memory tools fill. [[16]](claude-docs)

---

## 3. How the best ones solve "team sync" (the patterns)

| Capability | Who does it well | Pattern |
|---|---|---|
| **Scopes (user/project/org)** | Mem0 (user/session/agent), LangMem (namespaces), Zep (projects) | Namespace/tenant keys on every record |
| **Conflict / supersession** | **Graphiti/Zep** (bi-temporal: contradiction → `invalid_at`, nothing deleted) | Time-versioned edges; append-only truth history |
| **Provenance** | Graphiti (`episodes` list per edge), Copilot (memory ↔ code reference) | Every fact links back to its source event/commit |
| **Review / approval of shared memory** | **Claude Code (git + PR)** is the only real human gate; Copilot does *machine* validation-before-reuse | Treat shared memory as a reviewed artifact, not an auto-write |
| **Poisoning protection** | Weak across the board; Copilot "validates before reusing," Zep audit logs | Validation gate + audit trail; still an open problem industry-wide |
| **PII / GDPR / EU hosting** | Zep (SOC2 II, HIPAA, VPC, 1-yr logs) leads; most are US-cloud only | Deploy-in-VPC + compliance certs; or local-first zero-egress |

**Key read:** nobody combines **(a) human-reviewed shared memory, (b) conflict/supersession, and (c) self-host/zero-egress** in one product. Zep has (b)+(c-ish via VPC) but is heavy graph infra and US-cloud default. Claude Code has (a) but no ranking/decay/measurement. **That triple is open.**

Industry context: the security of agent memory is becoming a funded theme — CB Insights flags "startups building the **security layer for AI agents**," and a widely shared post claims **"48% of AI agents lack security controls"** around memory provenance. Memory *poisoning* (an attacker writing a malicious "rule" that a fleet then obeys) is the sharpest unsolved risk — and it maps directly onto AgentRecall's corrections-ledger threat model. [[17]](cbinsights), [[18]](security)

---

## 4. Pricing table (self-serve floors, as of 2026-10-15)

| Product | Free tier | Entry paid | Team/scale tier | Team seats included? |
|---|---|---|---|---|
| Mem0 | Yes (10k add/1k retr) | $19/mo Starter | $249/mo Pro (unlimited projects) | No explicit seats |
| Supermemory | Yes | **$19/mo Pro** | $100/mo Max | **Yes — 3 seats on Pro** |
| Zep | Trial | **$125/mo Flex** | Enterprise custom (SOC2/HIPAA/VPC) | Custom MCP seats (enterprise) |
| Cognee | OSS | usage-based cloud (beta) | Enterprise | — |
| Letta | OSS | API usage-based | — | — |
| LangMem | OSS | LangSmith tiers | LangSmith | Via LangSmith |
| Copilot memory | Bundled | In Copilot sub | Enterprise Copilot | Org-wide |
| AgentRecall-X | **MIT / free** | — (no paid tier) | — (none) | — |

Sources: [[2]](mem0-pricing), [[11]](supermemory-pricing), [[3]](zep-pricing), [[9]](scored).

---

## 5. White space AgentRecall could own

Ranked by defensibility, not size.

1. **Governed corrections/rules ledger for agent *fleets* (the real wedge).** No competitor treats a human correction as a first-class, severity-tagged, retractable, outcome-tracked rule. Mem0/Zep store corrections as "another memory row." AgentRecall's `check` gate ("verdict: blocked") + `register_rule` is closer to **policy/guardrails** than to memory. Reframe the product as *"shared guardrails + memory for your agent fleet — enforce 'never deploy without approval' across every agent, and prove it stuck."* This sidesteps the crowded "memory DB" fight.
2. **Behaviour-change measurement as the team dashboard.** Heed rate + Wilson interval is **unique** — nobody else measures whether a correction actually changed what a fresh agent does. For a *team*, this becomes a compliance/quality metric: "our agents violated owner rules 3× this week, down from 11×." That is a sellable artifact to an eng manager; "we recall facts well" is not.
3. **Zero-egress / local-first / git-backed for regulated & EU teams.** Zep offers VPC+SOC2 but it's a hosted graph service; AgentRecall is **markdown on disk, nothing leaves the machine**, with a Supabase mirror as opt-in. For fintech/health/gov/EU teams that cannot ship code context to a US SaaS, "your corrections live in your git repo, auditable, no egress" is a credible, hard-to-copy position. Pair it with the **git-as-sync** model Claude Code already validated (team sync via PR review).
4. **Coding-agent-native, not chatbot-personalization.** Mem0/Zep/Letta optimize for *end-user personalization* in apps. The coding-agent-specific field (ByteRover, agentmemory, Basic Memory, codemem) is **all sub-5k stars with no dominant winner.** AgentRecall is already coding-agent-native (Claude Code hooks, skill, `/arstart` loop). This sub-segment is genuinely open.

**The one-line positioning I'd test:**
> *"Git-backed, zero-egress governance & memory for teams of coding agents — correct an agent once, every teammate's agents obey it next session, and you get a dashboard proving they did."*

---

## 6. Risks (be honest)

- **Distribution gap is brutal.** 371 vs 67k/32k/32k/31k/25k stars. Mindshare, integrations, and "default choice" inertia all favour incumbents. Catching up on stars is not a plan; owning a *narrow* buyer (regulated coding teams) is.
- **"Team memory" is being taken now.** Supermemory sells seats today; Copilot ships it free; Zep owns governed enterprise. If the pivot is "generic team memory," AgentRecall is late and underfunded.
- **The team architecture doesn't exist yet** — and building it forces the hard choice: markdown-on-disk cannot do multi-writer sync + ACL + conflict resolution without becoming a hosted/replicated service, at which point you're fighting Mem0/Zep on storage, where they're years and dollars ahead. Keep the differentiator in **governance + measurement + zero-egress**, let storage stay boring (git / Supabase).
- **AgentRecall's own numbers undercut the pitch today.** Self-measured: **35.3%** correction capture, **0/3** heed events, **0/4** offline transfer — honest, but a buyer hears "the thing you measure barely works." The README frames this as a *density* problem (32 corrections across 19 projects is too sparse). A **team** deployment is actually the fix (more agents → denser corpus → measurable heed) — lead with that, or the honesty backfires.
- **Memory poisoning becomes a *team* attack surface.** The instant corrections are shared and auto-obeyed across a fleet, one poisoned rule propagates to everyone. This is a risk *and* a selling point: AgentRecall's owner-gated rule edits + scrubbed egress + trust/scope/fence stages are a real answer — but only if hardened and marketed as such before a competitor does.
- **Funding asymmetry.** Competitors carry $7.5M–$24M+ (Mem0 $24M, Cognee $7.5M, Letta ~$10M⚠, plus adjacent team-context player **Interloom $16.5M seed** led by DN Capital). AgentRecall is solo/OSS. Win on focus and trust, not on breadth.

---

## 7. Sources

1. "The State of Agent Memory (2026)," Viren Mohindra — stars + funding ($31.5M / 120k stars; Mem0 $24M, Cognee $7.5M seed), Graphiti bi-temporal source-read, Mem0 mentions-counter dead code. https://blog.virenmohindra.me/p/the-state-of-agent-memory-2026
2. Mem0 pricing (Hobby/Starter $19/Pro $249/Enterprise). https://mem0.ai/pricing
3. Zep pricing (Flex $125/mo; Enterprise SOC2 II/HIPAA/VPC/1-yr logs/Custom MCP seats). https://www.getzep.com/pricing
4. GitHub Copilot agentic memory (scoped, code-linked, validated, repo-specific, shared coding+review, auto-expire). https://www.linkedin.com/posts/joao-salvadoo_big-shift-for-developers-using-github-activity-7430271183369048064-gdJl
5. "Mem0 vs Zep vs LangChain vs Letta" (pluggable vector stores + Neo4j graph; bi-temporal). https://dev.to/mukesh_13/mem0-vs-zep-vs-langchain-memory-vs-letta-which-one-actually-remembers-2j47
6. "Agent Memory in 2026: Mem0 vs Zep vs Letta vs LangMem," Maidul Haque (multi-tenant by default; Zep = graph w/ time; Letta self-improving). https://maidul-haque.vercel.app/blog/agent-memory-architectures-2026/
7. "10 AI Memory Tools for Developers," Graham Waters (Mem0 user/session/agent levels). https://grahamwaters.medium.com/10-ai-memory-tools-for-developers-compared-by-what-they-do-9499292f95de
8. r/LangChain "Open-source graph memory that's not Mem0 or Zep" (Mem0 node explosion). https://www.reddit.com/r/LangChain/comments/1sb7lty/opensource_graph_memory_thats_not_mem0_or_zep/
9. "Best AI Agent Memory Tools 2026: 7 Picks Ranked," scored.tools (Zep LongMemEval +15; Cognee graph-RAG; pricing/positioning). https://scored.tools/blog/best-ai-agent-memory-tools-2026/
10. Letta Cloud / SDK docs (REST api.letta.com). https://docs.letta.com/guides/cloud/overview
11. Supermemory pricing (Pro $19, 3 team seats; Max $100; 187ms recall). https://supermemory.ai/pricing
12. supermemory-mcp (Universal Memory MCP). https://github.com/supermemoryai/supermemory-mcp
13. Cognee repo (open-source AI memory platform, small models). https://github.com/topoteretes/cognee
14. Basic Memory repo (local markdown knowledge graph). https://github.com/basicmachines-co/basic-memory
15. ByteRover CLI / Cipher repo (portable memory for coding agents). https://github.com/campfirein/cipher
16. Claude Code memory docs (CLAUDE.md / AGENTS.md). https://code.claude.com/docs/en/memory
17. CB Insights — "startups building the security layer for AI agents." https://www.cbinsights.com/research/newsletter-september-24/
18. "48% of AI Agents Lack Security…Zep, Mem0, Letta" (provenance/poisoning). https://www.linkedin.com/pulse/48-ai-agents-have-security-controls-can-zep-mem0-letta-nantha-kumar-l-c7owc
19. Yahoo Finance — Interloom $16.5M seed led by DN Capital (enterprise context graphs for agents). https://finance.yahoo.com/sectors/technology/articles/everyone-agrees-ai-finally-memory-165701408.html

**GitHub star counts:** live `gh api repos/<repo>` on 2026-10-15 — mem0 67,237 · graphiti 31,796 · zep 4,960 · letta 25,156 · supermemory 31,238 · cognee 32,359 · basic-memory 4,232 · langmem 1,705 · cipher 4,954 · mcp-memory-service 2,018 · AgentRecall-X 371.

`⚠ unverified` in this pass: Letta $10M seed/$70M valuation (2024 prior reporting); Supermemory seed amount; Zep seed amount. State as "reported, not re-verified" if used externally.
