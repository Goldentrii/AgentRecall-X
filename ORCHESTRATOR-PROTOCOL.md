# Orchestrator Protocol — Multi-Agent Work Loop
> Formalized 2026-04-24 from live novada-mcp + AgentRecall sessions.
> Updated 2026-06-22 — folded in the 14-loop autonomous run + the cross-surface-adapter design workflows (model routing, the workflow phases, convergence checks, never-self-review, eval-first, verify-not-guess, honesty gates).
> Drag this file into any new session to resume the pattern.

---

## What This Is

A repeatable protocol for running an Opus orchestrator + parallel Sonnet sub-agents to ship improvements to a codebase without losing quality or context. Validated on AgentRecall `feature/agent-feedback-improvements` (4 agents, 1 reviewer, 1 bug caught and fixed before merge).

**Model routing — fixed rule:**
| Role | Model | Reason |
|------|-------|--------|
| Orchestrator (you) | Opus (latest, 4.8) | Conflict analysis, agent briefing, synthesis, decisions — holds the context + the brain |
| Implementation sub-agents | Sonnet 4.6 | Coding, reading, testing — high volume, cost-controlled |
| Reviewer / verifier | Sonnet 4.6 (`code-reviewer` subagent type) | Independent read, catches what implementation agents miss |
| Optional cross-implementation | Codex (via `codex` skill / `codex:codex-rescue`) | An independent second coder when convergence (pattern B) is worth the cost |

Do NOT use Opus for routine sub-agents. Use Haiku only for pure read-only exploration. The orchestrator stays Opus and does NOT code by hand when a worker can — it briefs, converges, verifies, and lands.

---

## The Five-Step Loop

```
1. SCOUT     → map the codebase, find file ownership
2. PLAN      → assign agents, detect conflicts before dispatch
3. DISPATCH  → run implementation agents in parallel
4. REVIEW    → fresh reviewer agent, independent
5. FIX+SHIP  → apply fixes, build, commit, report to human
```

---

## Step 1 — Scout (do this yourself, or dispatch a Haiku scout)

Before writing any agent prompt, read the key files. You need:
- Which file contains which function (file → responsibility map)
- Which files each planned change will touch
- Any pre-existing unstaged changes (run `git diff --stat HEAD`)
- Current branch state (`git log --oneline -5`)

**Minimum reads before dispatching:**
- The main logic file for each planned change
- The registration/index file (how tools are wired up)
- One existing tool as a pattern example

Do this yourself to protect your context. If the codebase is large, dispatch a Haiku scout:
> "Read these directories. Return: which file does what, which functions are key touchpoints, which files are likely to be touched by [list of planned changes]. Under 300 words."

---

## Step 2 — Plan (conflict matrix)

Before dispatching, map: **agent → files it will touch**.

If two agents share a file → **merge them into one agent** or run them sequentially. Never let two parallel agents write to the same file. This is the most common failure mode.

```
Example conflict matrix:
Agent 1: project-status.ts (NEW), index.ts         → no conflict
Agent 2: session-start.ts, session-start MCP tool  → owns session-start.ts
Agent 3: rooms.ts, consolidate.ts                  → no conflict
Agent 4: session-end.ts, session-end MCP tool      → no conflict
```

Mark the "owner" agent for each contested file. Only the owner agent touches it.

---

## Step 3 — Dispatch (parallel)

Use `Agent()` tool with `subagent_type` unset (defaults to Sonnet). Pass `isolation: "worktree"` to keep agents from stomping each other during execution.

**The single most important rule: write prompts as if briefing a smart colleague who just walked in with zero context.**

### How to write a good agent prompt

A good prompt has exactly these sections, in this order:

```markdown
## 1. Role + Scope
One sentence: what you are, what you are NOT doing.
"You are implementing X. Do NOT touch Y — another agent owns that."

## 2. Context (codebase orientation)
- Project location
- The 2-3 files most relevant to this task
- The pattern to follow (e.g. "follow the same pattern as tools/session-start.ts")
- Any pre-existing changes the agent must not revert

## 3. What to build (precise spec)
- Function signatures with types
- Interface definitions
- Exact logic (not "handle edge cases" — name the edge cases)
- Where to register / export

## 4. What NOT to do
- Which files to leave alone
- Which patterns to avoid
- No npm publish, no git push, no commits unless told

## 5. Verification
Exact command to run. What passing looks like.
"Run: cd ~/Projects/X && npm run build 2>&1 | tail -10
Pass = zero TypeScript errors."

## 6. Report back (structured)
Tell the agent exactly what format to use:
- Files created/modified (paths)
- Build: PASS / FAIL
- Specific thing to confirm (e.g. "confirm quality_warnings is empty when no insights provided")
```

**Token discipline in prompts:**
- Include file paths, not file contents. The agent will read the file.
- Include function signatures, not implementations. The agent will write the implementation.
- If you paste code, paste only the interface / skeleton, not the full example.
- Every line in the prompt should be load-bearing. Cut anything the agent can figure out from reading the code.

**Prompt length guide:**
- Simple file change (1-2 functions): ~200 words
- New tool (new file + registration): ~400 words
- Complex multi-file feature: ~600 words max

If your prompt exceeds 600 words, you are probably writing the implementation for the agent. Stop. Write the interface and let the agent do the implementation.

---

## Step 4 — Review

After all implementation agents complete, dispatch **one reviewer agent** using `subagent_type: "code-reviewer"`.

The reviewer prompt must:
1. List every file that was changed
2. List specific edge cases to check (you write these — you know the domain)
3. Ask for a structured output:
   ```
   ## Summary: PASS / NEEDS FIXES / FAIL
   ## Per-feature: Rating + Bugs + Missing edge cases
   ## Issues requiring fix before merge (numbered, HIGH only)
   ## Minor issues (numbered, LOW)
   ## What worked well (3-5 bullets)
   ## Compound lessons (exactly 3)
   ```

The reviewer works best when given specific questions. "Is this correct?" produces vague output. "Does `touchRoom()` handle `_room.json` missing?" produces a precise answer.

### Compound rule — mandatory knowledge extraction

Every reviewer MUST output exactly 3 reusable lessons at the end of their review. This is not optional — it is a required output field, like `Summary` or `Issues`.

Each lesson must be:
```
- title: <imperative rule, ≥3 words>
  evidence: <what happened in THIS review that proves it>
  applies_when: [keyword1, keyword2, keyword3]
```

**What qualifies as a lesson:**
- A pattern that will recur in future work (not a one-off fix)
- A mistake that could have been prevented by a rule
- An approach that worked well and should be repeated

**What does NOT qualify:**
- "Fixed a bug" (not reusable — what's the RULE that prevents the bug?)
- Project-specific facts ("we use PostgreSQL") — that's palace, not a lesson
- Vague advice ("write better tests") — must be specific and actionable

**After the review completes**, the orchestrator feeds these 3 lessons into AgentRecall:
```
session_end({
  insights: reviewer.compound_lessons.map(l => ({
    title: l.title,
    evidence: l.evidence,
    applies_when: l.applies_when,
    severity: "important"
  })),
  ...
})
```

This is the compound engine: every loop makes the next loop smarter. Reviews that don't produce lessons are wasted learning.

---

## Step 5 — Fix + Ship

For each HIGH issue from the reviewer:
- If it's a 1-line fix: fix it yourself (faster than dispatching an agent)
- If it's a 5+ line fix: dispatch a targeted micro-agent with the exact line, exact fix, nothing else
- Re-run build after every fix

Commit pattern:
```bash
git add <specific files>
git commit -m "feat: [feature name] — [one line summary]

Agent 1 — [what it did]
Agent 2 — [what it did]
...
Reviewer fix — [what was caught and fixed]"
```

Report to human before any push. Human decides: merge to main + push, or more iteration.

---

## Evolved Patterns (validated 2026-06 across the 14-loop run + the cross-surface adapter)

The 5-step loop is the baseline. These were earned on real work and are now part of the protocol.

### A. Workflow phases for non-trivial design — ground → design → adversarial-verify → converge
For anything with design latitude (a new subsystem, a cross-cutting change), don't jump to dispatch. Run a structured workflow:
1. **GROUND** (parallel read-only agents): verify what ALREADY exists against the live code, per pillar. Never rebuild what's there.
2. **DESIGN** (diverse lenses → synthesis): N independent designs from different angles, then synthesize the best.
3. **ADVERSARIAL-VERIFY** (skeptics, one per dimension): each attacks the design and must produce a `required_fix`; default to "concern/blocker" when uncertain.
4. **CONVERGE**: fold every required_fix into one verified spec; surface unresolved blockers as explicit human decisions.
Output = a spec grounded in real `file:line`, not a guess. (On the adapter this caught 2 spec errors + 2 false read-only claims that would have shipped broken.)

### B. Different-sequence convergence — a robustness check
Run the same task from two DIFFERENT starting orders (e.g. one worker contract-first, one carrier-first). Converge on the same design → treat as settled (high confidence). Diverge → the divergence is the signal; inspect it. Validated on adapter P0: opposite sequences agreed on the architecture AND independently surfaced the same grounding correction.

### C. Never-self-review is LOAD-BEARING, not hygiene
The author's first draft skews optimistic — measured repeatedly: across the run the round-table caught the orchestrator's OWN errors 6+ times (dead code, a bug-masking test, overclaimed numbers, circular reasoning, two false read-only claims). NONE were self-caught. Always implement with one agent and verify with a DIFFERENT fresh-eyes agent that actually runs the tests/evals. The objective test gate + an independent reviewer save the work — not the author's restraint.

### D. Eval-first + falsifiable measurement
Before claiming an improvement helps, build a measurement that CAN come back negative, and run it on real data. Honest negatives (0/13, "no benefit", "untestable") are valid, valuable results — they prevent wrong bets (a declined ~25 MB embedding dependency). A reusable harness (LOO / paraphrase / convergence) outlives any one feature — it's the scoreboard the next idea must beat.

### E. Verify, never guess — ground every claim against the live tree
Every load-bearing claim (a file path, an API shape, "this is already gated") gets checked against the actual code/SDK before it's acted on. The adapter spec said `instructions` goes in the McpServer constructor — grounding found it's constructor ARG 2 (arg 1 silently drops it). Guessing ships a no-op.

### F. Honesty gates (anti-overclaim)
- A tool must NOT claim `readOnlyHint` if ANY branch writes (caught on both `check` and `recall`).
- A capability matrix must not badge "AUTO" on a host that physically can't auto-fire — split detection vs persistence; mark best-effort honestly.
- Name things for what they verifiably ARE, not aspiration ("compounding memory", not "self-evolving").

---

## Agent Templates

### Implementation agent (standard)
```
subagent_type: (omit — defaults to general-purpose = Sonnet)
isolation: "worktree"
prompt: [use the 6-section structure above]
```

### Reviewer agent
```
subagent_type: "code-reviewer"
prompt: [list changed files, specific edge cases to check, structured output format]

MANDATORY: End your review with exactly 3 compound lessons.
Each lesson = { title (imperative rule), evidence (from THIS review), applies_when (2-4 keywords) }.
These feed into the project's memory system. A review without lessons is wasted learning.
```

### Scout agent (Haiku, read-only)
```
model: "haiku"
prompt: "Read [directories]. Return: file → responsibility map. Which files will [list of planned changes] touch? Under 300 words."
```

### Micro-fix agent (post-review)
```
subagent_type: (omit)
prompt: "Fix ONE issue. File: X. Line: Y. Current code: [paste]. Fix: [paste]. Run build. Confirm pass."
```

---

## Current AgentRecall State (as of 2026-06-22)

**Version:** v3.4.32 (local + npm). **Tests:** 518 across 4 packages, all green.

**Branches:**
- `main` — released line. v3.4.32 = "Memory→Understanding" (two-tier lossless archive + confidence bridge + predict-the-correction).
- `opt/autonomous-loops` — the 14-loop autonomous optimization run (Loops 1–14): honesty fixes, login-free safety-consolidation, the LOO predict-eval harness, real-time recognition, local semantic matcher, MATH.md + store-doctor/store-repair, capture-gate v4, the Mirror, intent-convergence + cross-project evals, and the local-embedding experiment (declined). 33 commits, NOT pushed. Full record: `docs/internal/OPTIMIZATION-LOOPS.html`.
- `feat/cross-surface-adapter` — the cross-surface ADAPTER (current work). **P0 landed:** MCP server-level `instructions` carrier (arg 2) + tool-description timing tags (3 synced surfaces) + honesty-gated annotations + drift/handshake test. Spec: `docs/internal/cross-surface-adapter-spec.md`. NOT pushed.

### The one earned conclusion (5× confirmed)
AgentRecall is a genuinely good MEMORY system; its "understanding"/prediction limit is **DATA density, not the algorithm** — confirmed five independent ways (LOO 0/13 · Mirror 0/25 · intent-convergence untestable · cross-project ~9% · local embeddings no-benefit). The lever is better/more **capture**, not a fancier matcher. Do NOT re-propose a learned-embedding rewrite without new data (`docs/internal/loop13-embedding-experiment.md`).

### Open work
- Cross-surface ADAPTER P1–P5 (two-lane capture · surface-agnostic status board · Tier-A Stop-time agent-trigger · `brief` + transfer failsafe with read-side security guards · `HOST-TIERS.md`). Operator P0 hosts: OpenClaw + Codex.
- 3 live store-doctor findings were fixed on the live store in Loop 12; keep `ar doctor`/`ar repair` in the maintenance loop.

### Key architecture decisions (do not reverse)

- **5-tool MCP surface:** `session_start`, `remember`, `recall`, `session_end`, `check`. Legacy tools exist but aren't default-registered.
- **RRF scoring** for recall (Reciprocal Rank Fusion across journal + palace + insights).
- **Palace rooms are Obsidian-compatible** — YAML frontmatter + `[[wikilinks]]`. Do not change the file format.
- **Advisory-only quality gates** — warnings never block saves; human/agent is always in control.
- **Two capture lanes** — explicit-trigger (liberal, writes the LOCAL raw archive) vs passive-capture (gated by `isLikelyRealCorrection` v4). Do NOT weaken the v4 gate (Loops 7/8/14).
- **Privacy = opt-in cloud.** No Supabase config → ZERO cloud egress (`config.ts` returns null); personal tier needs `sync_personal:true`. Generous saving stays LOCAL by design.
- **Naming (P0):** `<domain>-<verb>.ts`; build-modules pair file↔export (`prior-builder↔buildPriors`). `pipeline_*` is the project-narrative-phase domain — do NOT overload "pipeline" (the cross-surface layer is the **adapter**).
- **`/arsave` not `/agsave`** — `ar` is the command namespace. Slash commands are a Claude Code convenience, NOT the universal interface — other hosts drive the same MCP core (the adapter formalizes this; never tell a Codex agent to run `/arstatus`).

---

## Handoff Checklist for the Next Agent

Before starting work on AgentRecall, do this in order:

- [ ] Read `ORCHESTRATOR-PROTOCOL.md` (this file) — you are here
- [ ] Run `cd ~/Projects/AgentRecall && git log --oneline -5` — confirm branch state
- [ ] Run `npm run build` — confirm clean build
- [ ] Call `session_start({ project: "AgentRecall" })` via MCP — load current context
- [ ] Read `docs/internal/OPTIMIZATION-LOOPS.html` (the 14-loop run) + `cross-surface-adapter-spec.md` if touching the adapter
- [ ] Decide which branch you're on: released `main`, the `opt/autonomous-loops` line, or `feat/cross-surface-adapter`
- [ ] Pick the next item from "Open work" above
- [ ] Run the 5-step loop AND the Evolved Patterns (workflow phases for design, convergence check, never-self-review, eval-first, verify-not-guess)

---

## What This Pattern Solves

| Old problem | How the protocol solves it |
|-------------|---------------------------|
| Agent gets lost mid-session | `session_start` resume block + `project_status` tool |
| Two agents corrupt same file | Pre-flight conflict matrix — merge agents before dispatch |
| Reviewer misses bugs | Independent fresh agent with specific edge case questions |
| Orchestrator burns context reading files | Scout agent + briefing maps passed to implementation agents |
| Vague insights that don't help future agents | Quality gate warns on shallow titles + missing evidence |
| No audit trail of what each agent did | Per-agent commit messages with agent attribution |

---

*This protocol was formalized from a live session. It will improve over time — update this file when you discover a better pattern.*
