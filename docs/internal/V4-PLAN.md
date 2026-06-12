# V4 Plan — "Memory as Environment" (2026-06-12)

## Thesis
Stop making memory something the agent USES; make it something the agent LIVES INSIDE.
Grounded in the Automaticity Law (PERF-CHECK-2026-06-12): push channels changed agent
behavior for weeks; pull tools had 0 organic calls. Therefore: two explicit verbs only
(inhale=session_start, exhale=session_end); everything else fires at MOMENTS via hooks.

## North-star metric (every workstream must move it or wait)
ALIGNMENT = correction precision (heeded/retrieved) × insight confirmation rate.
Baseline 2026-06-12: precision data just born (6/6 on AgentRecall); confirmation rate
~1% (198/200 insights stuck at count-1). Target after v4: confirmation rate >20%,
precision tracked on every project, one-line score surfaced everywhere.

## Standing rules for all workers
- Plywood briefs: Role / FILES YOU OWN / FORBIDDEN / SOP pseudocode / 4-pt done-checklist.
- Workers NEVER run npm build (orchestrator builds centrally). Sonnet for workers.
- Fresh-eyes code-reviewer after every sprint (never self-review). Verifier replays
  exact failure sequences. Everything local; publish only on user approval.
- Wire before write: no primitive ships without its automatic trigger.

---
## Sprint 0 — Debt (orchestrator, before anything)
S0.1 Fresh-eyes review of commits b61541b + 53554df (deferred 06-12; MUST run first).
S0.2 Fix any P0/HIGH findings. Extend benchmark/consistency.mjs if gaps found.

---
## Sprint 1 — The Loop (3 parallel workers, file-disjoint)

### WS-2 "Confirm-first session_end" (funnel unjam) — Worker α
OWNS: tools-logic/session-end.ts, palace/insights-index.ts, palace/awareness.ts
FORBIDDEN: corrections.ts, session-start.ts, mcp-server, cli
SOP:
  on session_end(insights[]):
    for each incoming insight:
      match = bestSimilar(existing index+awareness, normalizedTokenOverlap >= 0.6 on title)
      if match → confirm it (confirmed_count++, lastConfirmed=now, merge applies_when)
      else → add (current behavior)
    eviction at 200-cap: evict oldest count-1 first; NEVER evict count>=2 to admit count-1
  return field: { confirmed: n, added: m } in SessionEndResult (additive)
ACCEPT: saving near-duplicate insight twice → 1 entry at count=2 (new benchmark/funnel.mjs);
        cap-eviction test: count-3 insight survives a flood of count-1 entries.

### WS-6 "Triage classifier v2 + bulk clean" — Worker β
OWNS: storage/corrections.ts (isLikelyRealCorrection only), scripts/correction-triage.mjs
FORBIDDEN: session-*.ts, everything else
SOP:
  classify on RULE FIELD ONLY (never rule+context — 06-12 false-positive lesson)
  add preference allowance: /\b(user (wants|prefers|likes)|偏好|喜欢)\b/i passes gate
  add length-context override: rule>=40 chars with concrete noun phrases passes
  re-run dry-run; orchestrator spot-checks 10 verdicts incl. known-real rules
  ("beige/warm palette", "one version bump per release" must be OK) before --apply
ACCEPT: known-real rules pass; "No, that's wrong"/"Yes, you are right" flagged noise.

### WS-4 "North-star surface" — Worker γ
OWNS: tools-logic/session-start.ts (one block), tools-logic/dashboard-export.ts,
      mcp-server/src/tools/session-start.ts (render line)
FORBIDDEN: session-end.ts, corrections.ts logic (read-only via getCorrectionKPIs)
SOP:
  compute alignment line at session_start: precision = getCorrectionKPIs(slug).precision
  render at TOP of formatTerse when retrieved>0: "🎯 Alignment: 86% corrections heeded (n=14)"
  add { alignment } to dashboard.json project snapshot
ACCEPT: line renders with real data; absent when no outcome data (no fake claims).

Sprint-1 gate: central build → benchmark/consistency.mjs 10/10 + new funnel.mjs →
fresh-eyes review → fix → local commit.

---
## Sprint 2 — The Environment (2 parallel + 1 sequential)

### WS-1 "Tool-surface collapse" — Worker δ
OWNS: packages/mcp-server/src/index.ts, README.md, SKILL.md
SOP: default registration = session_start, session_end, remember, recall, check (5 tools).
  Move behind --full: memory_query, check_action, register_rule, pipeline_* (5),
  skill_* (3), dashboard_export, session_end_reflect, project_board/status, digest, bootstrap.
  README/SKILL.md: document the two-verb model + --full list.
ACCEPT: default `--list-tools` shows 5; --full shows all; no tool deleted.

### WS-3 "Moments, not tools (hook wiring)" — Worker ε
OWNS: packages/cli/src/index.ts (hook-ambient + new hook-pretool cmd) — NOTE ~/.claude
  settings.json edits are done BY ORCHESTRATOR (different repo), worker only ships CLI.
SOP:
  hook-ambient: apply min_overlap>=2 + recency floor; print NOTHING below threshold.
  new `ar hook-pretool`: stdin = tool call JSON; if command matches
  /\b(npm publish|git push|rm -rf|deploy|DROP TABLE)\b/ → run checkAction(), print warning
  (exit 0 always — advisory, never blocking).
ACCEPT: noise queries print nothing; `npm publish` input surfaces the no-push rule.
ORCHESTRATOR AFTER: add PreToolUse hook entry in ~/.claude/settings.json + commit there.

### WS-5 "Auto-handoff artifact" — Worker ζ (AFTER α lands; touches session-end.ts)
OWNS: tools-logic/session-end.ts (append step), helpers/handoff.ts (new)
SOP: at successful session_end, write projects/<slug>/handoff.md (<=500 tokens):
  intention, binding prefs (P0 corrections), active blockers, top-3 insights, trajectory.
  Atomic write. No new MCP tool (Automaticity Law). `ar handoff <slug>` prints it (cli later).
ACCEPT: file exists after save, <=500 tokens, regenerated each save.

Sprint-2 gate: same as Sprint 1 (build → suites → fresh-eyes → commit).

---
## Sprint 3 — Verify + Log + Gate
- Re-run full perf-check measurements; update PERF-CHECK doc with before/after scorecard.
- UPDATE-LOG.md entry "v4 / Memory as Environment" with per-WS traceback.
- arsave. Version: propose v3.5.0 on publish (feature-level, user decides; no inflation
  beyond patch without explicit approval).
- Offer fable re-test.

## Explicitly OUT (until north-star moves)
Local semantic embeddings (P2-4), Hopfield/FSRS wiring, war-room dashboard integration,
epistemic typing, MCP resources. All queued behind measurable loop compounding.
