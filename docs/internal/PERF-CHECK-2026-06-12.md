# AgentRecall Performance Check — 2026-06-12

Method: measured against the live corpus (44 projects, 221 journals, 561 palace files,
81 corrections, 200 insights) with ground-truth queries written by the evaluating agent
itself over weeks of real use, plus a first-person agent-experience audit. v3.4.22.

## Scorecard
| Dimension | Score |
|---|---|
| Storage & consistency | 8.5/10 |
| Orientation (session_start) | 8/10 (1,888 tok / 1.3s full · 139 tok / 1ms lite) |
| Retrieval precision | 4/10 (keyword 2/3, paraphrase 0/3) |
| Retrieval latency | 2/10 (~10.5s/recall — unbounded network fetch in hot path) |
| Self-improvement loop | 3/10 (0 outcome events ever; funnel 99% dead at confirmation=1) |
| Agent-first UX | 6/10 (push channels used; pull channels 0 organic calls) |
| Trust & honesty | 9/10 |
| **Weighted overall** | **~5.5/10** |

## Key measurements
- Learning loop: 0 `_outcomes.jsonl` files; 0 of 81 corrections ever marked retrieved.
- Insight funnel: 200 insights AT cap; 198 at confirmation=1; 1 promotion ever.
- Retrieval: 10.5s uniform latency (OpenAI embedding fetch without timeout + Supabase RPC).
- Shipped-but-unused: pipeline (0 phases), skills (0), check_action (0 organic), Hopfield/FSRS (unwired).
- register_rule: 7 hits, honored every time — only v3.4.21 feature with a closed loop.
- Correction store contains regex-captured conversation noise in the always-loaded channel.

## The Automaticity Law (core insight)
For agents, only memory that arrives unasked gets used. Push channels (session_start,
corrections, rules, hooks) show repeated behavior-changing usage. Pull channels
(check_action, skills, pipeline, memory_query) show zero organic calls — including from
the agent that built them. Corollary: wire before write — never ship a primitive without
its automatic trigger.

## Roadmap (by ROI)
P0-A bound recall latency (2s timeout + local fallback race + circuit breaker)
P0-B close outcome loop automatically (retrieved on surface; heeded/recurred at session_end)
P0-C correction hygiene (retract path + capture-quality gate + triage of existing 81)
P1-D unjam insight funnel (similarity-confirmation; eviction prefers old count-1)
P1-E pull→push conversions; demote zero-usage tools behind --full
P1-F ambient hook precision floor (silence > noise)
P2   local semantic embeddings (MiniLM) → fixes paraphrase blindness; then wire Hopfield
