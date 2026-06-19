# Cold Agent Evaluation — 2026-05-01

**Evaluator:** Fresh agent, no prior AgentRecall experience  
**Version:** v3.4.0  
**Test root:** /tmp/ar-eval-cold  
**CLI binary:** node ~/Projects/AgentRecall/packages/cli/dist/index.js

---

## Tool Surface Assessment

### What was clear

- `session_start` — name and MCP description are unambiguous. "Load project context for a new session" is correct.
- `session_end` — clear purpose, the description explains what it writes (journal, awareness, palace).
- `bootstrap_scan` / `bootstrap_import` — the two-step workflow is clear from the names alone. Scan-then-import is an obvious pattern.
- `recall` — "Search all memory stores, return ranked results" is clean and accurate.
- `project_board` — description explicitly tells you to run it first. That instruction-in-description is the right pattern.

### What was ambiguous

**`remember` vs `palace write` vs `capture`**

This is the most critical ambiguity. An agent sees:
- MCP `remember` — "Save a memory. Auto-classifies and routes to the right store"
- CLI `palace write <room> <content>` — explicit room targeting
- CLI `capture <question> <answer>` — Q&A format, unclear what store it writes to

There is no description anywhere explaining the relationship between these three. An agent using MCP `remember` with context hint "architecture" might expect it routes to the palace architecture room — but whether it actually does is invisible. An agent using CLI `palace write` is bypassing auto-classification entirely. An agent using `capture` doesn't know it writes to a separate `2026-05-01-log.md` file, not the journal. Three write paths, zero documentation of when to use which.

**`check` tool**

The MCP description is "Record understanding, get predictive warnings from past corrections." The full schema reveals it also handles full Bayesian decision trails (prior/posterior/evidence/outcome). These are two completely different use cases crammed into one tool. A new agent reading the short description would never discover the decision trail capability. The `decision_id` parameter implies stateful multi-call workflows, but nothing in the description signals this.

**`digest` tool**

The one-line description says "Context cache — store/recall/read/invalidate pre-computed analysis results." The word "digest" is a domain-specific term that maps to nothing in common agent vocabulary. "Context cache" is clearer, but the tool name `digest` would not lead an agent to this tool by intuition. An agent trying to cache analysis results would likely reach for `remember` first.

**`palace walk --depth`**

The depth options `identity|active|relevant|full` are not defined anywhere in the help output. An agent has to guess what "identity" vs "active" vs "relevant" means. The output sizes are radically different (identity = 1 line, full = ~100 lines) but there's no hint of this in the help.

**`project_status` vs `session_start`**

Both appear to provide project context. The distinction — `project_status` is for orientation, `session_start` loads the working context — is only visible in the extended MCP descriptions, not from the names.

### Ordering issues

MCP tool list order: `project_board`, `project_status`, `session_start`, `remember`, `recall`, `session_end`, `check`, `digest`, `bootstrap_scan`, `bootstrap_import`

Issues:
1. `bootstrap_scan` / `bootstrap_import` appear at the end but should conceptually appear first for a truly new install. A new agent scrolling the tool list reaches the write/recall tools before understanding they need to bootstrap.
2. `check` appears between `session_end` and `digest` — it's a mid-session tool, not an end-of-session tool. This position implies it belongs near the end of a session workflow when it actually belongs right after `session_start`.
3. `digest` is buried at position 8 of 10. If an agent is about to do expensive analysis, they should check digest BEFORE doing work. Its position suggests it's an afterthought.

### Missing tools (from a new agent's perspective)

- No `palace_read` in MCP tool list. An agent who writes to a palace room has no MCP tool to read it back. `recall` is the workaround, but the palace room structure is invisible.
- No `project_create` — `session_start` silently creates a project if it doesn't exist. This is not stated anywhere.
- No tool to list available palace rooms — an agent doesn't know what rooms exist without running CLI `ar rooms` or `ar palace walk --depth full`.

---

## Workflow Experience (step by step)

### Step 1: cold-start (first session, empty project) — Expected vs Actual

**Expected:** Orientation output telling me what the project is, what I should do next, any pending items.

**Actual:**
```json
{
  "project": "eval-cold",
  "palace_context": {
    "identity": "---\nproject: eval-cold\ncreated: 2026-05-01...\n# eval-cold\n> _(fill in: 1-line purpose, primary language, key constraint)_",
    "awareness_summary": null,
    "top_rooms": [alignment, architecture, blockers],
    "insight_count": 0
  },
  "cache": { "hot": {"count": 0, "entries": []}, "warm": {"count": 0}, "cold": {"count": 0} },
  "total_entries": 0
}
```

**Problems:**
- The identity contains a raw template placeholder `_(fill in: 1-line purpose, primary language, key constraint)_`. This is shown verbatim to the agent with no instruction to fill it in. There is no `agent_instruction` or `next_action` field telling the agent what to do.
- `awareness_summary: null` — meaningless to a new agent. Should be omitted when null.
- `cache.warm.count: 0` and `cache.cold.count: 0` are noise with no value. An agent can't use count-only data.
- `total_entries: 0` — fine, but shows no guidance.
- The output is a raw JSON dump. No prose. No "what to do next." A new agent receiving this has to interpret what `palace_context.top_rooms` means and why it lists rooms that don't have content yet.

**Missing:** An `agent_instruction` field: "Project is new. Fill in `identity.md` with project purpose. Then use `remember` or `palace write` to capture decisions."

### Step 2: palace write architecture — Expected vs Actual

**Expected:** Confirmation the content was saved to the architecture room.

**Actual:**
```json
{
  "success": true,
  "room": "architecture",
  "topic": "README",
  "project": "eval-cold",
  "importance": "medium",
  "fan_out": {"updated_rooms": [], "new_edges": 0},
  "file_path": "/tmp/ar-eval-cold/projects/eval-cold/palace/rooms/architecture/README.md"
}
```

**Problems:**
- `topic: "README"` is an internal detail (the file is `README.md`). Not meaningful to an agent.
- `fan_out: {"updated_rooms": [], "new_edges": 0}` — exposed implementation detail. An agent doesn't know what "fan_out" means and gets no value from seeing it.
- `importance: "medium"` — fine, confirms the default was applied.
- No `agent_instruction` for next steps.

**What worked:** The path is shown, which allows verification. `success: true` is clean.

### Step 3: capture Q&A — Expected vs Actual

**Expected:** Content saved as a Q&A entry somewhere searchable.

**Actual:**
```json
{
  "success": true,
  "entry_number": 1,
  "palace": null,
  "auto_tags": ["general", "database", "postgresql"]
}
```

**Problems:**
- `palace: null` — what does this mean? Did it try to route to palace and fail? Or is this the "no palace routing" signal? A new agent cannot tell.
- No file path shown. After writing to palace I could see WHERE the data went. After `capture`, I cannot.
- `auto_tags` is useful — shows the system understood the content. This is good.
- The capture command writes to `journal/2026-05-01-log.md`, a DIFFERENT file from the journal entry created by `ar write`. This means the project has two separate journal files for one day. The agent is never told this. When the agent later calls `ar search`, it searches both files — so data appears — but the structural split is invisible and could cause confusion in other scenarios.

### Step 4: palace write blockers — Expected vs Actual

Same output format as Step 2. Same issues. No new findings.

### Step 5: search "database" — Expected vs Actual

**Expected:** Find the Q&A entry about PostgreSQL.

**Actual:**
```json
{
  "results": [
    {"date": "2026-05-01", "section": "top", "excerpt": "### Q1 (17:26:15) [general, database, postgresql]", "line": 10},
    {"date": "2026-05-01", "section": "top", "excerpt": "**Q:** What database?", "line": 12}
  ]
}
```

**Problems:**
- Found the question but NOT the answer. The answer "PostgreSQL — chosen for JSON support, not MySQL" is on line 14, two lines below the match. The excerpt window doesn't extend far enough to include the answer in either result.
- The blocker "Missing .env.local — cannot run local dev server" is NOT found. It lives in the palace blockers room. `ar search` by default does NOT search palace. The flag `--include-palace` must be added explicitly. This is not mentioned in any output or result. An agent searching for a blocker would silently miss it.
- `section: "top"` is an internal section identifier with no meaning to an agent.
- No `result_id` field in CLI output (unlike MCP `recall` which returns IDs for feedback). So CLI search results cannot be rated.

### Step 6: write session summary — Expected vs Actual

**Expected:** Session saved, confirmation.

**Actual:**
```json
{
  "success": true,
  "date": "2026-05-01",
  "file": "/tmp/ar-eval-cold/projects/eval-cold/journal/2026-05-01.md",
  "palace": null
}
```

`palace: null` appears again. Same ambiguity as Step 3. Otherwise clean.

---

## Recall Quality

### Exact match: search "postgres"

**Result:** PASS — found the Q&A answer line "PostgreSQL — chosen for JSON support, not MySQL" plus the Q1 header and the session summary. The answer is in the result set.

**Caveat:** The answer excerpt shows the full answer text, but search for "database" (the broader term) failed to surface the answer. Postgres-exact works; semantic breadth fails.

### Paraphrase: search "database choice"

**Result:** PARTIAL FAIL — found "### Q1 (17:26:15) [general, database, postgresql]" and "**Q:** What database?" but NOT the answer "PostgreSQL — chosen for JSON support, not MySQL" and NOT the palace architecture room entry.

The search split matches on individual terms. "database" hits; "choice" hits nothing. The answer line doesn't contain the word "database" — it says "PostgreSQL — chosen for JSON support, not MySQL." So a paraphrase query that doesn't contain the exact stored keywords returns the header/question but not the useful answer.

This is a fundamental limitation: the search is keyword-based, not semantic. For semantic search, a Supabase vector setup is required (noted in `ar setup supabase`). But a new agent has no idea this limitation exists from the tool descriptions.

### Palace walk --depth active

**Result:** NOT USEFUL for cold-start orientation.

Output:
```
## Active Rooms
- Architecture (salience: 0.435) — Technical decisions, patterns, tech stack
- Decisions (salience: 0.422) — Decision trails...
- Alignment (salience: 0.41) — Frequently misunderstood areas...
- Goals (salience: 0.41) — Active goals...
- Knowledge (salience: 0.41) — Learned lessons by category
```

**Critical bug: Blockers room is excluded from `--depth active` despite containing the only active blocker.** The blockers room has lower salience (0.39) than the five empty default rooms (0.41+) because salience is driven by access count, not by content presence. An empty room that was scaffolded but never written to ranks higher than a room with real content that was written to once. A cold-starting agent using `palace walk --depth active` would not see "Missing .env.local — cannot run local dev server" and would not know to resolve this before starting work.

Active rooms shows only names and descriptions — not the actual content of the entries. So even for rooms that ARE included (like Architecture), the agent sees "Technical decisions, patterns, tech stack" not "We chose PostgreSQL over MySQL for its JSON support." The tool reports the room exists but withholds the content.

---

## Cold Start Assessment

### Token cost

Second `cold-start` output (after data was written): ~373 tokens (measured at ~1491 chars / 4).

### Information density: LOW

Of the ~373 tokens:
- ~60 tokens: identity template (empty, shows placeholder text)
- ~80 tokens: top_rooms list (3 rooms, names + descriptions — no actual content)
- ~60 tokens: cache.hot entries (2 entries — these are actually useful)
- ~30 tokens: cache warm/cold counts (zero-value metadata)
- ~50 tokens: structural JSON overhead (braces, keys)
- ~90 tokens: insight_count: 0, awareness_summary: null, total_entries: 2 (mostly noise)

The two hot cache entries are the only genuinely useful data for resuming work. The rest is structural overhead or empty fields.

### What was missing

1. **Active blockers are not surfaced.** "Missing .env.local" was written to the blockers palace room. It does not appear in cold-start output. A resuming agent would not know about it.
2. **Palace room content is not included.** Cold-start shows room names/descriptions but not entries. The PostgreSQL architecture decision is invisible.
3. **No "next action" field.** What should the agent do first? The output has no `agent_instruction`, no `trajectory`, no `recommended_next_step`.
4. **Identity is a raw template.** The placeholder `_(fill in: ...)_` should trigger an instruction to the agent to populate it, not just pass it silently.
5. **The trajectory from `session_end` is not surfaced here.** If an agent called `session_end` with a `trajectory` field, that trajectory should appear in cold-start. It does not. (In this test we used `ar write` not `session_end`, but the omission stands structurally.)

---

## Top Issues (ranked by impact)

1. **Blockers room silently excluded from `palace walk --depth active` when it has the lowest salience.** The salience algorithm punishes new rooms with few accesses. A room scaffolded but written to once has lower salience than an empty room that was accessed during project init. This means the most critical current state (blockers) is the most likely to be dropped from cold-start context. Fix: either guarantee the blockers room always appears in active depth, or rank by `(salience × has_content)` instead of salience alone.

2. **`ar search` does not search palace by default, with no indication of this in results.** When a search returns empty or partial results, there is no message saying "palace was not searched — add --include-palace." An agent looking for a blocker they wrote with `palace write` will get empty results and falsely conclude the data doesn't exist. Fix: either search palace by default, or add a footer in results: "Palace not searched. Run with --include-palace to include palace rooms."

3. **Four different search commands with different scopes, zero guidance on which to use.** `ar search`, `ar search --include-palace`, `ar palace search`, `ar insight` all search different subsets. The MCP `recall` tool searches all stores. A new agent must run all four to get full coverage. Fix: consolidate or add a "search all" alias. At minimum, add a note to each command's output about what it did NOT search.

4. **`remember` vs `palace write` vs `capture` distinction is undocumented.** These are three write paths with different routing logic, different output files, and different retrieval behaviors. The `remember` MCP tool's `context` hint is the only routing signal, but the routing logic is opaque. An agent who uses `palace write architecture` explicitly gets different behavior from `remember` with context "architecture." Fix: in the MCP `remember` description, list: "For structured palace rooms use context='room:architecture'. For Q&A lessons use context='qa'. For session notes use context='session'."

5. **`cold-start` output does not include palace room content, only room names.** After writing an architecture decision and a blocker, a second cold-start returns zero substantive memory about either. Only the `cache.hot.entries` (journal Q&A) surface. An agent resuming work after a week would know "architecture room exists" but not "PostgreSQL was chosen for JSON support." Fix: include the top N entries (by recency or salience) from the highest-salience rooms in cold-start output.

6. **`check` tool's Bayesian decision trail capability is invisible from its description.** The short description "Record understanding, get predictive warnings from past corrections" describes only half the tool. The `prior`, `posterior`, `evidence`, `outcome`, `decision_id` parameters form a completely separate workflow. A new agent will use `check` only for the simple goal-recording case and never discover the decision calibration feature. Fix: split into two tools (`check` for understanding verification, `decision_trail` for Bayesian tracking) or rewrite description: "Record what you think the human wants AND optionally track decisions with Bayesian evidence chains."

7. **`ar rooms` diagnostic command reports 0 entries for all rooms despite rooms containing written content.** Both architecture and blockers rooms had entries written to them. `ar rooms` showed "0 entries" for all 6 rooms. This makes the diagnostic useless for verifying writes succeeded. Fix: count actual memory entries from the README.md file content, not from whatever index is currently being read.

8. **`palace write` silently creates any room slug, including typos.** `ar palace write nonexistent "content"` succeeded without error or warning, creating a permanent `nonexistent/` room directory. An agent who types `blocers` instead of `blockers` gets a new room instead of an error. Fix: validate room slug against the known room list and require `--force` to create new rooms.

9. **Cold-start JSON output has no `agent_instruction` field.** Agents need structured guidance on what to do next, not raw data to interpret. The output contains structural data but no interpretation layer. Fix: add `agent_instruction: "New project — fill identity.md. Call session_start or palace walk --depth full to see all context."` when the project is new, and `agent_instruction: "Active project — review trajectory and blockers before continuing"` when returning.

10. **`palace_status` MCP tool is missing from the MCP tool list.** There is no MCP tool to read individual palace rooms. An agent who wrote to a palace room via MCP `remember` has no way to verify or read back that specific room without using the CLI. The `recall` tool searches across rooms but doesn't provide direct room reads.

---

## Friction Score per Tool (1=confusing, 5=crystal clear)

| Tool | Score | Notes |
|------|-------|-------|
| session_start (MCP) | 4 | Clear description. Missing: clarify it creates the project silently if new. |
| session_end (MCP) | 4 | Good description, includes what it writes. Required `summary` is clear. |
| remember (MCP) | 2 | "Auto-routes to right store" — but which stores? When? The `context` hint system is undocumented. |
| recall (MCP) | 4 | Solid. Feedback loop via `feedback` param is a nice touch. Missing: note it won't return palace full content, only excerpts. |
| check (MCP) | 2 | Dual-purpose tool. Bayesian trail is invisible from description. New agents use 20% of its capability. |
| digest (MCP) | 3 | The multi-action design (store/recall/read/invalidate) is clear from the schema. Name "digest" is non-intuitive. |
| project_board (MCP) | 5 | Best description in the set. "Run this first" instruction is exactly right. |
| project_status (MCP) | 4 | Clear. Useful distinction from session_start is explained. |
| bootstrap_scan (MCP) | 5 | Accurate, "read-only" is correctly emphasized. |
| bootstrap_import (MCP) | 4 | Requires scan output as JSON string — slightly awkward but described correctly. |
| cold-start (CLI) | 2 | JSON output with no agent guidance. Output format assumes agent knows what to do with it. |
| palace write (CLI) | 3 | Works. Silent room creation on typo is dangerous. `fan_out` in response is noise. |
| palace walk (CLI) | 2 | Depth options undefined in help. Active depth cuts off the most important room (blockers). |
| palace search (CLI) | 3 | Works for exact/partial keywords. Empty result for "database" when "PostgreSQL" exists is confusing. |
| capture (CLI) | 2 | `palace: null` in response is unexplained. Separate log file is invisible. |
| search (CLI) | 2 | Default excludes palace without notice. Paraphrase fails silently. |
| ar rooms (CLI) | 1 | Reports 0 entries for rooms with content. Actively misleading. |
| ar write (CLI) | 4 | Simple, works. `palace: null` in response is unexplained but otherwise clean. |

---

## One-line verdict

The write paths work but the read paths are fragmented, the cold-start output is a raw data dump with no agent instruction, and the most critical room (blockers) is silently cut from context due to a salience algorithm that punishes freshly-written rooms — I would write to it once and then stop trusting it to surface what I stored.
