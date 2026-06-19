# Loop 2 Verifier Results

**Date:** 2026-05-01  
**CLI:** `node ~/Projects/AgentRecall/packages/cli/dist/index.js` (v3.4.0)  
**AGENT_RECALL_ROOT:** `/tmp/ar-eval-loop2-cold` (fresh, wiped before run)

---

## Summary Table

| Test | Status | Evidence |
|------|--------|---------|
| A2-1 | PASS | `palace search "framework"` returns tRPC entry (salience 0.373) |
| A2-2 | PARTIAL | MCP `remember` tool description has routing hints; CLI `--list-tools` not implemented; WRITE PATH GUIDE visible in `--help` |
| B2-1 | PASS | `routing_hint.suggested_room: "architecture"` returned for decision content |
| B2-2 | PASS | `routing_hint.suggested_room: "blockers"` returned for blocker content |
| B2-3 | PASS | `routing_hint: null` for neutral content |
| C2-1 | PARTIAL | `palace write` direct path does NOT strip frontmatter (FAIL); bootstrap import path DOES strip frontmatter (PASS) |
| D2-1 | PASS | WRITE PATH GUIDE shows 4-line routing guide in `--help` |
| D2-2 | PASS | stderr: "Note: 'typoroom' is not a default room"; stdout: `success: true` |
| D2-3 | PASS | stderr: "[ar] Palace rooms were not searched" after `ar search` without `--include-palace` |

---

## Detailed Results

### A2-1: Framework synonym search

```bash
AGENT_RECALL_ROOT=/tmp/ar-eval-loop2-cold \
  node .../index.js palace write architecture \
  "We chose tRPC over REST for better type safety" --project a2test
# → success: true

AGENT_RECALL_ROOT=/tmp/ar-eval-loop2-cold \
  node .../index.js palace search "framework" --project a2test
```

**Output:**
```json
{
  "project": "a2test",
  "query": "framework",
  "results": [
    {
      "room": "architecture",
      "file": "README",
      "salience": 0.373,
      "excerpt": "We chose tRPC over REST for better type safety",
      "line": 17,
      "keyword_score": 0.05307505233415591
    }
  ],
  "total_matches": 1
}
```

**Verdict: PASS** — synonym groups added in `normalize.ts` cause "framework" to expand and match the tRPC entry.

---

### A2-2: Remember description visible to agents

```bash
AGENT_RECALL_ROOT=/tmp/ar-eval-loop2-cold node .../index.js --list-tools 2>/dev/null
# → no output (--list-tools not a recognized CLI flag; outputs help to stderr, nothing to stdout)

AGENT_RECALL_ROOT=/tmp/ar-eval-loop2-cold node .../index.js --help 2>&1 | grep -A5 "remember"
# → no output (no "remember" keyword in CLI help text)
```

The `--list-tools` flag is not implemented in the CLI. The `remember` tool is a **MCP server tool**, not a CLI command. Its updated description (from `packages/mcp-server/src/tools/remember.ts`) reads:

> "Save any memory — auto-classifies and routes. Use this for unstructured notes, lessons, and quick captures. For structured palace rooms use palace_write directly. For Q&A pairs use capture. Pass context hint to override auto-routing."

The `context` field description reads:

> "Routing hint. Values: 'architecture' or 'decision' → palace/architecture room. 'blocker' or 'blocked' → palace/blockers room. 'goal' → palace/goals room. 'lesson' or 'insight' → awareness. 'qa' or 'capture' → Q&A log. Omit for auto-classification."

The CLI `--help` includes a WRITE PATH GUIDE section:

```
WRITE PATH GUIDE:
  ar write <content>             → journal (ephemeral; use for session notes)
  ar palace write <room> <text>  → palace (permanent; use for decisions, blockers, goals)
  ar capture <Q> <A>             → Q&A log (use for lessons and quick lookups)
  ar awareness update --insight "title" --evidence "ev"  → cross-session insights
```

**Verdict: PARTIAL** — Routing hints exist in the MCP tool description (`remember.ts`) and the CLI WRITE PATH GUIDE. The exact test command (grep for "remember" in CLI help) returns no output since the CLI doesn't expose MCP tool descriptions. Intent of the worker's change (A2 Task 2) is satisfied in the MCP server path.

---

### B2-1: Auto-routing advisory for decisions

```bash
AGENT_RECALL_ROOT=/tmp/ar-eval-loop2-cold node .../index.js write \
  "We decided to use GraphQL instead of REST for better type safety" --project b2test
```

**Output:**
```json
{
  "success": true,
  "date": "2026-05-01",
  "file": "/tmp/ar-eval-loop2-cold/projects/b2test/journal/2026-05-01.md",
  "palace": null,
  "routing_hint": {
    "suggested_room": "architecture",
    "reason": "decision language detected",
    "command": "ar palace write architecture \"We decided to use GraphQL instead of REST for better type sa...\" --project b2test"
  }
}
```

**Verdict: PASS** — `routing_hint.suggested_room` is `"architecture"` for decision-language content.

---

### B2-2: Auto-routing advisory for blockers

```bash
AGENT_RECALL_ROOT=/tmp/ar-eval-loop2-cold node .../index.js write \
  "Missing .env.local file, cannot run dev server" --project b2test
```

**Output:**
```json
{
  "success": true,
  "date": "2026-05-01",
  "file": "/tmp/ar-eval-loop2-cold/projects/b2test/journal/2026-05-01-6b859e.md",
  "palace": null,
  "routing_hint": {
    "suggested_room": "blockers",
    "reason": "blocker language detected",
    "command": "ar palace write blockers \"Missing .env.local file, cannot run dev server\" --project b2test"
  }
}
```

**Verdict: PASS** — `routing_hint.suggested_room` is `"blockers"` for blocker-language content.

---

### B2-3: No false routing hint for neutral content

```bash
AGENT_RECALL_ROOT=/tmp/ar-eval-loop2-cold node .../index.js write \
  "Today I worked on the dashboard feature" --project b2test
```

**Output:**
```json
{
  "success": true,
  "date": "2026-05-01",
  "file": "/tmp/ar-eval-loop2-cold/projects/b2test/journal/2026-05-01-6c3c20.md",
  "palace": null,
  "routing_hint": null
}
```

**Verdict: PASS** — `routing_hint` is `null` for neutral, non-decision, non-blocker content.

---

### C2-1: Bootstrap import strips frontmatter

#### Path A: `palace write` direct (test as written in verifier prompt)

Created `/tmp/ar-eval-loop2-cold/seed/test.md`:
```
---
name: test-feedback
type: feedback
---
Never deploy on Fridays because rollbacks are impossible over the weekend.
```

Then wrote the raw content (including frontmatter) via `palace write alignment`:

```bash
content=$(cat /tmp/ar-eval-loop2-cold/seed/test.md)
AGENT_RECALL_ROOT=/tmp/ar-eval-loop2-cold node .../index.js palace write alignment "$content" --project c2test
AGENT_RECALL_ROOT=/tmp/ar-eval-loop2-cold node .../index.js palace read alignment --project c2test
```

**Result:** Stored content includes `name: test-feedback` and `type: feedback`. The `palace write` command does NOT strip frontmatter from the content argument — it treats all input as body text.

**Path A Verdict: FAIL** — `palace write` does not strip frontmatter. This is by design: the fix was applied to `bootstrap.ts`, not to `palace write`.

#### Path B: Bootstrap import (where the fix was applied)

Set up `~/.claude/projects/-tmp-c2-bootstrap-test/memory/` with:
- `MEMORY.md` (index)
- `test-feedback.md` (with frontmatter `name: c2-bootstrap-feedback`, `type: feedback`)

Note: The encoded dir `-tmp-c2-bootstrap-test` decodes to path `tmp/c2/bootstrap/test`, so the project slug becomes `test`.

```bash
AGENT_RECALL_ROOT=/tmp/ar-c2-fresh node .../index.js bootstrap --import
# → 30 projects created, 154 items imported

AGENT_RECALL_ROOT=/tmp/ar-c2-fresh node .../index.js palace read alignment \
  --topic c2-bootstrap-feedback --project test
```

**Output:**
```json
{
  "project": "test",
  "room": "alignment",
  "topic": "c2-bootstrap-feedback",
  "salience": 0.385,
  "connections": [],
  "content": "---\nroom: alignment\ntopic: c2-bootstrap-feedback\ncreated: 2026-05-01T18:44:35.607Z\nimportance: medium\ntags: []\n---\n# alignment / c2-bootstrap-feedback\n\nNever deploy on Fridays because rollbacks are impossible over the weekend.\n"
}
```

Body text is present. No `name: c2-bootstrap-feedback` or `type: feedback` from the original frontmatter appears in the stored body. The `stripFrontmatter()` function in `bootstrap.ts` correctly stripped the frontmatter before writing to the palace.

**Path B Verdict: PASS** — Bootstrap import correctly strips YAML frontmatter before writing to palace.

**Overall C2-1 Verdict: PARTIAL** — Fix is correctly applied to bootstrap import path (PASS). The `palace write` direct path does not strip frontmatter (by design — the fix scope was `bootstrap.ts` only).

---

### D2-1: Help text has write path guide

```bash
AGENT_RECALL_ROOT=/tmp/ar-eval-loop2-cold node .../index.js --help | grep -A10 "WRITE PATH"
```

**Output:**
```
WRITE PATH GUIDE:
  ar write <content>             → journal (ephemeral; use for session notes)
  ar palace write <room> <text>  → palace (permanent; use for decisions, blockers, goals)
  ar capture <Q> <A>             → Q&A log (use for lessons and quick lookups)
  ar awareness update --insight "title" --evidence "ev"  → cross-session insights
```

**Verdict: PASS** — 4-line routing guide is present in help output.

---

### D2-2: Palace write warns on unknown slug

```bash
AGENT_RECALL_ROOT=/tmp/ar-eval-loop2-cold node .../index.js palace write typoroom \
  "some content" --project d2test 2>&1
```

**stderr:**
```
[ar] Note: 'typoroom' is not a default room. Creating new room. Default rooms: goals, architecture, decisions, blockers, alignment, knowledge
```

**stdout:**
```json
{
  "success": true,
  "room": "typoroom",
  "topic": "README",
  "project": "d2test",
  "importance": "medium",
  ...
}
```

**Verdict: PASS** — Warning on stderr for non-default room name; write succeeds (`success: true` in stdout).

---

### D2-3: Search note printed to stderr

```bash
AGENT_RECALL_ROOT=/tmp/ar-eval-loop2-cold node .../index.js palace write architecture \
  "PostgreSQL chosen" --project d2test
AGENT_RECALL_ROOT=/tmp/ar-eval-loop2-cold node .../index.js search "postgres" \
  --project d2test 2>&1
```

**Combined output (stdout + stderr):**
```json
{
  "results": [],
  "palace_searched": false,
  "_note": "Palace rooms were not searched. Add --include-palace (CLI) or include_palace: true (MCP recall) to search palace content."
}
[ar] Palace rooms were not searched. Add --include-palace (CLI) or include_palace: true (MCP recall) to search palace content.
```

**Verdict: PASS** — stderr contains "[ar] Palace rooms were not searched" as expected.

---

## Notes

1. **C2-1 scope clarification:** The frontmatter stripping fix lives in `bootstrap.ts` `stripFrontmatter()` (line 252) and is applied only during bootstrap import (lines 721, 794). The `palace write` CLI command is intentionally unchanged — it writes whatever content is passed verbatim. The test verifier prompt correctly anticipated this and the bootstrap path was used to confirm the fix works.

2. **A2-2 scope clarification:** The `remember` tool is an MCP server tool (`packages/mcp-server/src/tools/remember.ts`), not a CLI command. The CLI `--list-tools` flag is not implemented. Routing hints are visible to MCP-connected agents through the tool schema, and visible to CLI users through the WRITE PATH GUIDE section in `--help`.

3. **C2-1 encoded path gotcha:** The test created a memory dir at `~/.claude/projects/-tmp-c2-bootstrap-test/`. Bootstrap decodes this as path `tmp/c2/bootstrap/test`, making the project slug `test` (not `c2-bootstrap-test`). Always use a shallow path to avoid multi-segment slug issues (e.g. `~/.claude/projects/-Users-test-myproject/memory/`).
