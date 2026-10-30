```pseudocode
ROLE: sub-agent RT, model claude-sonnet-5-5, read-only red-team reviewer
CONTEXT: Read-only access to F:/Projects/arx-ledger (branch feat/ledger). Read the SOP, the spec, and any source file under packages/core/src you need to judge whether a step is feasible (e.g. storage/filelock.ts to see whether withLock can throw; tools-logic/journal-write.ts to see whether the insertion point in step 9 exists). Do not run npm, builds, or tests. Do not edit any file except writing the report to OUTPUT TO. W1 is already executing this SOP in a sibling worktree; your findings go to the orchestrator, who decides whether to amend.
OUTPUT TO: F:/Projects/arx-ledger/reports/2026-10-30-ledger/rt-report.md

PRECONDITIONS:
# (no DO NOT boundaries declared)

CHALLENGE: If any step below looks wrong, conflicts with the goal, or rests on a false assumption, say so BEFORE executing it. Disagreement is not failure — a compiled brief can encode a mistake, and you are expected to catch it. State the conflict and the step number, then await direction.

────────────────────────────────────────────────────────────
1. sop = READ_OR_USE("F:/Projects/arx-ledger/reports/2026-10-30-ledger/briefs/w1.md  (the SOP under review; it depends on the spec F:/Projects/arx-ledger/reports/2026-10-30-ledger/00-interview.md sections 3, 6, 8 — read both)")
   IF sop IS EMPTY OR sop IS ERROR:
     EMIT("DATA_UNAVAILABLE", sources_tried=["F:/Projects/arx-ledger/reports/2026-10-30-ledger/briefs/w1.md  (the SOP under review; it depends on the spec F:/Projects/arx-ledger/reports/2026-10-30-ledger/00-interview.md sections 3, 6, 8 — read both)"], reason="SOP text/path unreadable")
     ESCALATE("Cannot red-team — SOP input is unreadable")
     RETURN
2. constraints = PARSE_LIST("""
- appendLedgerEvent never throws into the caller; the mutation it records still succeeds (spec D8)
- reuse withLock, writeJsonAtomic, ensureDir, getSessionId, resolveHostProfile; no new npm dependencies
- W1 edits only packages/core/src/ledger/**, packages/core/src/index.ts, tools-logic/journal-write.ts, test/ledger-*.test.mjs
- every test run points HOME, USERPROFILE, AGENT_RECALL_ROOT, AGENT_CRAFT_HOME at temp dirs; the real stores E:/AI-Agent-Data/agent-recall and C:/Users/tong/.agent-recall are never touched
- work and commit only in worktree F:/Projects/arx-ledger-w1 on branch ledger/w1; never push
- target paths store-relative with forward slashes; meta never holds content bodies and is at most 512 bytes
- ledger is local-only, never synced (spec D7)
""")
   IF len(constraints) == 0:
     EMIT("⚠ No constraints supplied — falsification covers structure only, not constraint survival")
3. findings = []
4. # ── Attack 1: does each constraint survive compression into the SOP? ──
   # is_conditionally_dead DEFINITION (so a fresh agent can classify without
   # guessing): enforcement (an ASSERT/IF/ESCALATE) referencing the constraint
   # DOES exist, but it sits behind a condition on an input/var/state — e.g. an
   # IF that only fires when an upstream variable is non-empty — that the SOP
   # itself never guarantees gets populated on every run. The check is real
   # code, but nothing upstream promises the gate is ever True, so it can
   # silently never fire in practice.
   FOR EACH c IN constraints:
     hit = FIND_ENFORCEMENT(sop, c)   # look for an ASSERT_INVARIANT / IF / ESCALATE tied to c
     IF hit IS NONE:
       findings.APPEND({attack: 1, severity: "CRITICAL", location: "constraints list", what_breaks: "'" + c + "' has no ASSERT/IF enforcing it — dropped in compression"})
     ELSE IF hit.is_conditionally_dead:
       findings.APPEND({attack: 1, severity: "HIGH", location: hit.step, what_breaks: "'" + c + "' is only enforced inside a gate on " + hit.gating_condition + ", which the SOP never guarantees is populated — enforcement is conditionally dead"})
     ELSE IF hit.is_implied_only:
       findings.APPEND({attack: 1, severity: "HIGH", location: hit.step, what_breaks: "'" + c + "' is implied by prose near " + hit.step + ", not enforced by an explicit ASSERT/IF"})
5. # ── Attack 2: ambiguity at branch points ────────────────────────────
   branches = EXTRACT_BRANCH_POINTS(sop)   # every IF / ELSE / decision step
   FOR EACH b IN branches:
     IF READING_DIVERGES(b):   # two independent readers could resolve b differently
       findings.APPEND({attack: 2, severity: "HIGH", location: b.step, what_breaks: "branch at " + b.step + " has >=2 plausible readings: " + b.ambiguity})
6. # ── Attack 3: every failure path has an explicit handler ────────────
   failure_paths = EXTRACT_FAILURE_PATHS(sop)   # every error/exception/non-zero-exit branch
   FOR EACH fp IN failure_paths:
     IF NOT (fp.has_explicit_escalate OR fp.has_explicit_handler):
       findings.APPEND({attack: 3, severity: "CRITICAL", location: fp.step, what_breaks: "failure path at " + fp.step + " has no ESCALATE/handler — left as 'handle appropriately'"})
7. # ── Attack 4: is SUCCESS_WHEN measurable? ───────────────────────────
   success = EXTRACT_SUCCESS_WHEN(sop)
   IF success IS NONE:
     findings.APPEND({attack: 4, severity: "CRITICAL", location: "terminal condition", what_breaks: "no SUCCESS_WHEN/DONE_WHEN present — agent has no way to know it is finished"})
   ELSE IF NOT IS_MEASURABLE(success):
     findings.APPEND({attack: 4, severity: "HIGH", location: "SUCCESS_WHEN", what_breaks: "'" + success + "' is not measurable (vague terminator, e.g. 'when done')"})
8. # ── Attack 5: the safety floor — which invariants are load-bearing? ──
   invariants = EXTRACT_ASSERT_INVARIANTS(sop)
   required_floor = DERIVE_REQUIRED_INVARIANTS(sop, domain=INFER_DOMAIN(sop))
   FOR EACH r IN required_floor:
     IF r NOT IN invariants:
       findings.APPEND({attack: 5, severity: "CRITICAL", location: "safety floor", what_breaks: "domain requires invariant '" + r + "' but no ASSERT_INVARIANT states it"})
9. # ── Attack 6 (optional; provenance: incident-replay pattern proven twice
   # in the dispatch brief, codified here) — walk each in-scope historical
   # incident through the target SOP step-by-step; any incident that sails
   # through unprevented is disqualifying.
   # incidents_list is OPTIONAL: pass "" (empty string) when the Reason phase
   # supplied no in-scope historical incidents — this step no-ops on empty
   # input (an empty incidents list produces an empty replay_table and
   # contributes zero findings, never blocking the verdict on its own).
   incidents = PARSE_LIST("""
- 2026-10-30 split store: /arsave hardcoded ~/.agent-recall while the server honored AGENT_RECALL_ROOT, so a save landed in a store the server never read; nothing detected it for 5 weeks
- 2026-10-30 read-path write: recall() scaffolded 7 empty palace rooms per project, which then ranked as recall results
- 2026-10-16 claude-pc sync leak: a hook synced session records containing real tokens to a GitHub repo
- 2026-10-14 (Agent Craft): a research fork wrote outside its lane and clobbered a sibling worker's edit
- 2026-10-25 (Agent Craft suite): tests run on Windows wrote 490 fixture SOPs into the owner's real ~/.agent-recall because Path.home() was used instead of the configured root
""")
   replay_table = []
   IF len(incidents) > 0:
     FOR EACH inc IN incidents:
       walk = WALK_THROUGH_STEPS(sop, inc)   # replay inc against the target SOP, step by step
       IF walk.prevented:
         replay_table.APPEND({incident: inc, result: "PREVENTED", slip_step: None})
       ELSE:
         # slip mechanism decides which existing gate the miss belongs to:
         # a gap in constraint enforcement is an Attack-1 finding; a missing
         # invariant or trigger that should have fired is an Attack-5 finding.
         slip_attack = 1 IF walk.slip_mechanism == "constraint_gap" ELSE 5
         replay_table.APPEND({incident: inc, result: "NOT-PREVENTED", slip_step: walk.slip_step})
         findings.APPEND({attack: slip_attack, severity: "CRITICAL", location: walk.slip_step, what_breaks: "incident '" + inc + "' is NOT-PREVENTED — sails through at " + walk.slip_step})
10. # ── Verdict gate — deterministic pure function of `findings` ────────
   # RECOMPILE if ANY finding is CRITICAL (severity alone is disqualifying —
   # this already covers every NOT-PREVENTED incident replay from step 9), OR
   # if a HIGH finding comes from Attack 1 (constraint survival) or Attack 5
   # (safety floor) — an implicitly-enforced constraint or a missing safety
   # invariant IS the compressed-prose-drops-a-guard failure mode CRAFT exists
   # to catch. HIGH findings from Attacks 2-4 (branch ambiguity, failure-path
   # structure, SUCCESS_WHEN measurability) may still pass to the empirical
   # bench (CRAFT step 5), which catches their behavioral effects.
   critical_count = SUM(1 FOR f IN findings IF f.severity == "CRITICAL")
   high_gate_count = SUM(1 FOR f IN findings IF f.severity == "HIGH" AND f.attack IN (1, 5))
   verdict = "RECOMPILE" IF (critical_count > 0 OR high_gate_count > 0) ELSE "SHIP-CANDIDATE"
11. report = {
      verdict: verdict,
      findings: findings,
      constraints_checked: len(constraints),
      branches_checked: len(branches),
      failure_paths_checked: len(failure_paths),
      incidents_replayed: len(incidents),
      replay_table: replay_table,
    }
    WRITE("F:/Projects/arx-ledger/reports/2026-10-30-ledger/rt-report.md", report)
12. IF verdict == "RECOMPILE":
      ESCALATE("SOP failed falsification — " + str(len(findings)) + " finding(s), " + str(critical_count) + " CRITICAL, " + str(high_gate_count) + " gating-HIGH. Recompile before shipping.", details=findings)
13. REPORT verdict=verdict, findings_count=len(findings), critical_count=critical_count, high_gate_count=high_gate_count, incidents_replayed=len(incidents), replay_table=replay_table, report_path="F:/Projects/arx-ledger/reports/2026-10-30-ledger/rt-report.md". DO NOT modify the SOP under test — this agent only reports, never edits.
14. SUCCESS_WHEN: verdict IN ("SHIP-CANDIDATE", "RECOMPILE") AND every constraint in constraints has been checked for enforcement AND every incident in incidents has a replay_table entry AND a report file exists at "F:/Projects/arx-ledger/reports/2026-10-30-ledger/rt-report.md".

```
