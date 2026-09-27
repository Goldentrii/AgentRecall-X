# Paid evaluation budget estimate (P0) — NOT APPROVED, NOT SPENT

Prices: Anthropic first-party list rates per MTok, from bundled claude-api skill (cached 2026-06-24):
claude-sonnet-5 $2 in / $10 out / ~$0.20 cache-read; claude-haiku-4-5 $1 / $5; claude-opus-5-5 $4 / $20 / $0.20 cache-read.
Caveat: this machine authenticates via ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL (a proxy/gateway). Billing may
differ from list price, and PLAN 10.3 requires trustworthy per-run `usage`; if the gateway does not return
usage, A44 cost gate is INCONCLUSIVE by rule.

## Per-run model (agent coding task, Sonnet 5 executor)
| scenario | turns | avg ctx | cached share | output | $/run |
|---|---|---|---|---|---|
| low | 12 | 20k | 85% | 5k | ~0.15 |
| central | 30 | 40k | 85% | 15k | ~0.71 |
| high | 60 | 80k | 70% | 40k | ~2.50 |

## Run counts (PLAN §10)
| block | runs | central $ | range $ |
|---|---|---|---|
| dev/power pilot (variance → freeze N) | 300 | 210 | 45–750 |
| C training/accumulation phase (train split) | 450 | 320 | 70–1,125 |
| candidate validation (≈20 candidates × (≥10 targeted + ≥30 held-out)) | 800 | 570 | 120–2,000 |
| FINAL A/B/C: 150 clusters × 3 groups × 3 reps | 1,350 | 960 | 200–3,375 |
| blind LLM judging (non-executable oracle parts, ≥200 injection pairs) | ~1,550 | 80 | 30–250 |
| A38 host lifecycle (2 hosts × 40 sessions) | 80 | 60 | 15–200 |
| **total** | ~4,500 | **≈ 2,200** | **≈ 480 – 7,700** |

## Non-token costs (larger than tokens, must be owned by someone)
- Authoring ≥150 independent held-out task clusters (≥3 categories, ≥60 recurrence-opportunity tasks) with
  **executable oracles**, plus train/dev splits: realistically several person-days; must be done by an
  evaluator who is NOT the implementer (PLAN 7.2, A39).
- Hosted Supabase isolated project (free tier likely sufficient for 10k-record fixtures; perf gate A31 needs a
  fixed plan/region → may need paid Pro, ~$25/mo) — requires owner to create or authorize.
- Second real device/VM for A30/A38 (H2 without H1 files).

## Recommendation
Do not start any paid batch until: (1) engineering P1–P6 cases are green on the integrated commit (otherwise the
experiment measures bugs), (2) the held-out task set exists and is frozen by an independent evaluator,
(3) owner approves a hard cap (suggest $2,500 with stop at 80%).
