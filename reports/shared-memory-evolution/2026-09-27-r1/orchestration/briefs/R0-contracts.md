```text
ROLE: Independent contract reviewer (not the author); read-only; you attack, you do not rewrite the design
CONTEXT: Worktree E:/Users/tong/Documents/New project/arx-sme (branch feat/shared-memory-evolution, commit fb687fb). Inputs: E:/Users/tong/Documents/New project/arx-sme/reports/shared-memory-evolution/2026-09-27-r1/adr/contracts.md, packages/core/src/repository/contract.ts, docs/plans/shared-memory-evolution/{PLAN.md,ACCEPTANCE.json}, grounding E:/Users/tong/Documents/New project/arx-sme/reports/shared-memory-evolution/2026-09-27-r1/orchestration/ground/G1-root-sdk.md G2-cloud.md G3-surface.md; baseline source in packages/core/src
OUTPUT TO: E:/Users/tong/Documents/New project/arx-sme/reports/shared-memory-evolution/2026-09-27-r1/reviews/contracts-review.md

PRECONDITIONS:
ASSERT_INVARIANT: DO NOT edit any file other than the review output  # checked before every mutating step
ASSERT_INVARIANT: DO NOT run npm install  # checked before every mutating step

CHALLENGE: If any step below looks wrong, conflicts with the goal, or rests on a false assumption, say so BEFORE executing it. Disagreement is not failure ¡ª a compiled brief can encode a mistake, and you are expected to catch it. State the conflict and the step number, then await direction.

©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤©¤
OBJECTIVE: Adversarially review the P0 shared-memory contract (ADR-001 contracts.md + packages/core/src/repository/contract.ts) against PLAN.md sections 3-6 and 9 and ACCEPTANCE.json cases A02-A29: find every place where the contract cannot satisfy a required acceptance case, lets identity/authority be forged, allows silent last-write-wins, leaks across owner/project, loses committed writes, or breaks backward compatibility; also attack the AsyncLocalStorage context design and the cloud change-cursor design; output PASS / NEEDS_FIXES / FAIL with numbered blocking items each carrying a required_fix

LENSES (3-5 entry points ¡ª pick ones that actually fit this goal; drop unused):
- correctness ¡ª does the code do what it claims? where are the silent failures?
- failure modes ¡ª what breaks under load, partial input, concurrent access?
- blast radius ¡ª if this is wrong, who else is affected? what's the worst case?
- root cause vs symptom ¡ª keep digging until the cause explains all observations

PROCESS:
- Start with the lens you have the highest signal on; don't try them in order.
- When you find something, immediately ask "what would refute this?" ¡ª don't just confirm.
- Pull at least one piece of *primary* evidence (code, log line, repro) per finding.
- If you exhaust your lenses with no finding, that itself is a finding ¡ª REPORT it.

SELF_REVIEW (answer all three before reporting):
- Did I distinguish symptom from root cause, or am I describing what I saw?
- Did I check the failure mode I dismissed earliest? (you usually dismissed it too fast)
- Have I left any goal-specific verification question unanswered?

REPORT (write to E:/Users/tong/Documents/New project/arx-sme/reports/shared-memory-evolution/2026-09-27-r1/reviews/contracts-review.md):
- findings: list of {title, evidence, severity, confidence}
- root_cause: one sentence, or 'unknown ¡ª see findings'
- recommended_next_step: one concrete action
- ruled_out: what you investigated and dropped, with one-line reason each

ESCALATION: If you hit a dead end, surface what you ruled out and ask for the next hypothesis.

SUCCESS_WHEN: REPORT contains at least one finding with primary evidence cited (file + line OR log line + timestamp), OR an explicit 'no issue found' conclusion with the same rigor (every lens checked, evidence per ruled-out branch).

```
