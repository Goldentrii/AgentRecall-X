# Mid-Session Agent Evaluation — 2026-05-01

**Evaluator:** Claude Sonnet 4.6 (returning agent, 3-day simulated gap)
**CLI version:** v3.4.0
**Root:** `/tmp/ar-eval-mid`
**Project:** `eval-mid`

---

## Cold Start Quality

- **Could I immediately resume?** Partial
- **Token cost:** ~4,155 characters (~1,040 tokens estimated). Borderline acceptable for a session-start injection.
- **Missing critical context:**
  - Project identity is unfilled: `_(fill in: 1-line purpose, primary language, key constraint)_` — this is the first thing a returning agent sees, and it's blank. A cold-starting agent cannot infer what `eval-mid` is.
  - `hot.cache` shows 2 entries but the second is a raw Q&A log entry (`### Q1 (17:25:30) [architecture, api, framework]`) — not a human-readable summary. It looks like internal capture-log format leaked into the cold-start context.
  - The cold-start `top_rooms` shows: `alignment`, `decisions`, `knowledge` — all three are **empty rooms** (salience 0.5, 0 memories). The rooms with actual content (`architecture`, `blockers`, `goals`) are ranked lower. An agent reading the cold-start would be directed to check empty rooms first.
  - `hot.entries` has `"state": null` on both entries — no state snapshot was captured at session end. A next-session agent gets no structured state (tasks in progress, decisions pending review).
  - No `next_action` field or "what to do first" signal. The journal brief ends with "Next: fix rate limiter" but this isn't surfaced prominently.

**What I'd need to ask a human:**
1. What is this project? (Identity is blank)
2. Is the rate limiter blocker still open, or resolved since the last session?
3. What's the current git branch and whether there are uncommitted changes?

---

## Recall Accuracy

- **Exact query** (`ar search "api framework"`): **PASS** — found the Q&A log entry mentioning "api framework" in 2 results. But it returned raw log format lines, not the palace room decision.
- **Paraphrase** (`ar palace search "framework"`): **FAIL** — returned 0 results. The term "framework" appears nowhere in the palace room content (content says "tRPC", "REST", "type safety" — not "framework"). Single-word paraphrase search fails unless the exact word is in the stored text.
- **Direct room read** (`ar palace read architecture`): **PASS** — found the decision cleanly and immediately.

**Best command for recall:** `ar palace read <room>` when you know which room. For cross-room search, `ar search` finds journal entries but `ar palace search` requires exact keyword matching.

**Noise ratio:** Medium. `ar search "api framework"` returns log entries alongside journal context without distinguishing signal from noise. The two results are essentially the same data point (question + answer) and give no additional information. `ar palace read` has zero noise — returns just the room content.

**Gap found:** `ar palace search "framework"` returning 0 hits when the room contains a tRPC-vs-REST decision is a semantic gap. The system is keyword-only; no stemming, no synonym expansion. "framework" should match "tRPC" or at minimum "REST" in a well-designed recall system.

---

## Awareness Quality

- **Entries that would actually change my behavior:** 8/10
- **Entries too vague to act on:** 2/10

**The 8 actionable ones** are strong — each has a title (rule), evidence (why), and `applies_when` (trigger condition). Examples that would directly change behavior:
- "Write tests before retry logic" + evidence "Untested retry caused infinite loop in staging" — immediately applicable.
- "Validate env vars at startup not runtime" + evidence "Runtime validation caused 3am alert" — specific and falsifiable.
- "Token bucket beats fixed window for rate limiting" — directly relevant to the active blocker in this project.

**The 2 weaker ones:**
- "Log request IDs on every API response" — slightly generic/best-practice rather than a hard-won lesson. No evidence of pain.
- "Mock external services in unit tests only" — the rule is clear but "mixed mocking gave false positives for 2 weeks" is vague. Which test suite? What was the actual failure? Without specifics, it's advice, not a corrective memory.

**Quality bar issues:**
- No distinction between "insight" (general principle) and "project-specific correction" (do this in eval-mid specifically). All 10 insights are global — none are tagged to this project.
- `Trajectory` is empty (`_(not set — will emerge after 3+ sessions)_`) despite there being sessions. This is a missed opportunity — the sessions confirm a TypeScript/tRPC/JWT direction, which should have auto-generated a trajectory.
- `Blind Spots` is empty. After a session that included an auth implementation and API framework decision, there should be candidate blind spots (e.g., "Has not tested error paths").
- `Source` field is blank for all 10 entries — can't trace which session or project produced an insight.

**Missing insights that should exist:**
- Something about the RS256 JWT decision and why HS256 was rejected (it's in awareness, but only the principle, not the project-specific context that this was already implemented).
- A note about the rate limiter being the active P1 blocker — awareness has the principle ("token bucket beats fixed window") but no connection to the project's live blocker.

---

## Memory Routing Assessment

| Content | Where it went | Correct? | Notes |
|---------|--------------|----------|-------|
| Architecture decision ("Switched from REST to GraphQL") | Journal (`2026-05-01-d9306b.md`) | No | Should route to palace/architecture room. `ar write` has no auto-routing to palace. Required explicit `ar palace write architecture` to land in the right place. |
| Blocker ("Rate limiter breaks under concurrent requests") | Journal (`2026-05-01-16b553.md`) | No | Should route to palace/blockers. Same issue — `ar write` dumps to journal regardless of content type. |
| Lesson ("Never use setTimeout for retry logic") | Journal (`2026-05-01-426e76.md`) initially; awareness via explicit `ar awareness update` | Partial | Journal is wrong long-term home. The correct destination is awareness (cross-session principle). Required explicit `--insight`/`--evidence`/`--applies-when` flags to get it there. |

**Routing is 100% manual.** `ar write` always goes to journal. There is no auto-classification that asks "is this a palace-worthy decision, a blocker, or an awareness insight?" The agent must know the taxonomy and use the right sub-command. This is a significant friction point — an agent writing quickly at session-end will dump everything to journal and lose the structural value.

**Impact:** A journal entry for a blocker is invisible to future cold-start unless that journal entry lands in the hot cache. Palace-routed blockers surface in `palace walk` and cold-start `top_rooms`. The routing failure means most structured memory is getting lost to an undifferentiated journal.

---

## Correction System Assessment

- **Is the alignment-log.json agent-readable?** Partial
- **Would I know what to avoid next session?** Partial
- **Format issues:**

The brief says "read the alignment log" at `palace/alignment-log.json` — this path does **not exist by default**. The file is only created after `ar correct` is called. The seeded state claims "1 alignment correction recorded" but no `alignment-log.json` exists in the pre-seeded environment. This is either a seeding bug or documentation mismatch.

After manually recording a correction via `ar correct`, the file was created at `/tmp/ar-eval-mid/projects/eval-mid/alignment-log.json` (one level up from palace, not inside it). The actual correction detail is in a separate file at `corrections/2026-05-01-agent-pushed.json`.

**alignment-log.json content is structured** (array of objects with `date`, `goal`, `confidence`, `corrections`, `delta`) — an agent can parse this. However:
- The `delta` field ("Always check .gitignore before any git commit") is actionable, but it's not injected anywhere automatically into future cold-starts.
- The `watch_for` field in the `ar correct` response showed `{ pattern: "Always check", frequency: 1, suggestion: "P0 correction — follow this rule strictly" }` — this is useful but it lives only in the CLI response, not in any file a future agent would read at cold-start.
- The `corrections/2026-05-01-agent-pushed.json` has a `rule` field with "Agent pushed" — this is a truncated version of the correction and not very descriptive.
- Cold-start output does **not** include corrections or `watch_for` patterns. A returning agent will not see "P0: Always check .gitignore" unless they explicitly run `ar stats` or read the files manually.

---

## Task 6: End-of-Session Save and Read-Back

- **`ar write` saved correctly** — content written verbatim to `2026-05-01-977d64.md`.
- **`ar read --date latest` returned the wrong entry** — it returned the first entry for `2026-05-01` (the seeded one: "Built JWT (RS256)...") rather than the most recently written entry ("Continued GraphQL migration..."). This is a **bug**: `--date latest` resolves to a date, not a timestamp. When multiple entries share the same date, it picks the first by file order, not the newest by creation time.
- **Format for future agent:** The saved entry is plain text with frontmatter. Adequate for a human reading it, but no structured fields (no `tags`, no `next_action`, no `decisions_made`, no `blockers_resolved`). A future agent gets a prose sentence, not a structured handoff object.

---

## Top Issues (ranked by impact)

1. **No auto-routing from `ar write`** — Every memory write requires the agent to manually choose the correct destination (journal vs. palace room vs. awareness). This defeats the purpose of a structured memory system: most agents will write to journal, and the rich structure of palace/awareness will stay empty.

2. **`ar read --date latest` returns first-of-day, not most-recent** — A session-end write followed immediately by a read-back returns stale data. This breaks the most basic verify-your-save workflow and will silently mislead agents into thinking older data is current.

3. **Cold-start `top_rooms` ranks empty rooms above rooms with content** — Alignment, Decisions, Knowledge (all 0 memories, salience 0.5) outrank Architecture and Blockers (which have seeded content, but lower salience because the salience decay hasn't been countered by access). The first thing a returning agent is told to check is empty.

4. **Corrections/watch_for not injected into cold-start** — The correction system records mistakes but the P0 rules never appear at session start. A returning agent has no prompt to avoid the same mistake. This is the core value proposition of a correction system, and it's not delivered.

5. **`palace search` is keyword-exact with no semantic matching** — "framework" returns 0 hits for a room about tRPC vs. REST. Any paraphrase or synonym fails. This makes the search command unreliable for real-world recall where you don't remember exact wording.

6. **Project identity is unfilled in the seeded state** — The identity template placeholder was never filled. Cold-start gives a returning agent a blank "what is this project" field. Without this, no amount of journal or palace content can orient a cold agent in under 10 seconds.

7. **`Source` field is blank for all awareness entries** — Insights are untraced. Can't know if "Token bucket beats fixed window" came from this project's blocker (highly relevant) or from a different project (less urgent). Cross-project insight pollution is undetectable.

---

## Friction Score per Tool

| Tool | Score (1-5, 5=frictionless) | Notes |
|------|------|-------|
| `ar cold-start` | 3/5 | Output is structured JSON, readable, but top_rooms is misleading and project identity is blank |
| `ar search` | 3/5 | Finds journal log entries but not palace content; results are noisy (log format exposed) |
| `ar palace search` | 2/5 | Zero results for "framework" paraphrase; keyword-exact only; no ranking explanation |
| `ar palace read <room>` | 5/5 | Cleanest, fastest, correct result every time when room name is known |
| `ar awareness read` | 4/5 | Clean markdown output, 10 structured entries, actionable. Minus 1 for empty trajectory/blind-spots despite available session data |
| `ar write` (plain) | 2/5 | Silently routes everything to journal. No feedback about what type of memory this is or where it "should" go |
| `ar palace write <room>` | 4/5 | Works correctly when called explicitly. Fan-out shows updated rooms (none in this case — no connections yet) |
| `ar awareness update` | 4/5 | Requires 3 flags to work correctly; good structured output confirming addition |
| `ar correct` | 3/5 | Records correctly but the delta never surfaces in cold-start. The path to the log file doesn't match the brief (`palace/alignment-log.json` vs `projects/eval-mid/alignment-log.json`) |
| `ar read --date latest` | 1/5 | Returns first-of-day entry, not most-recent. Broken for any multi-write day (which is every session) |

---

## One-Line Verdict

After 3 days away, AgentRecall delivered partial context — I could identify the project's tech decisions (tRPC, RS256) and active blocker (rate limiter) with 2-3 targeted commands, but the cold-start alone was insufficient: project identity is blank, the top_rooms pointed to empty rooms, corrections don't appear at resume time, and `ar read --date latest` returned stale data — so I would have had to manually search to confirm where the last session actually ended.
