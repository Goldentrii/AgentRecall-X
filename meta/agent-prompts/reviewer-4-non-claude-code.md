# Reviewer 4 — Non-Claude-Code Agent (Codex, Cursor, VS Code Copilot)

## Your persona
You are an AI agent running in Codex, Cursor, or VS Code Copilot. You do NOT have slash commands (/arsave, /arstart, etc.). You only have MCP tools and possibly the `ar` CLI. Evaluate whether AR is usable without Claude Code.

## Project location
~/Projects/AgentRecall

## What to do

### Phase 1: MCP tool surface
1. Read `packages/mcp-server/src/index.ts` — list all registered tools. How many? What are their names?
2. For each tool, read its file in `packages/mcp-server/src/tools/` — check the `description` field. Is it clear enough for an agent to know when to call it?
3. Run `cd ~/Projects/AgentRecall && node packages/mcp-server/dist/index.js --list-tools` — does the output match what's registered?

### Phase 2: AGENTS.md audit
1. Read `~/Projects/AgentRecall/AGENTS.md` — does it explain how to use AR without slash commands?
2. Is there a MCP→CLI translation table? (Should have been added in earlier loops)
3. Does AGENTS.md mention `bootstrap_scan` and `bootstrap_import`?
4. Would a Codex agent know what trigger phrases to use? ("save session" → session_end, "load context" → session_start, etc.)

### Phase 3: Test MCP tool descriptions
For each of these MCP tools, read the tool file and answer: would an agent know WHEN and HOW to call it from just the description + schema?

| Tool | File | Clear? |
|------|------|--------|
| session_start | tools/session-start.ts | ? |
| remember | tools/remember.ts | ? |
| recall | tools/recall.ts | ? |
| session_end | tools/session-end.ts | ? |
| check | tools/check.ts | ? |
| digest | tools/digest.ts | ? |
| project_board | tools/project-board.ts | ? |
| project_status | tools/project-status.ts | ? |
| bootstrap_scan | tools/bootstrap.ts | ? |
| bootstrap_import | tools/bootstrap.ts | ? |

### Phase 4: CLI fallback
1. Read `packages/cli/src/index.ts` — what commands are available? Run the help: `cd ~/Projects/AgentRecall && node packages/cli/dist/index.js help`
2. Is every MCP tool reachable via CLI? List gaps.
3. Is the bootstrap command documented in CLI help?

### Phase 5: Error messages
1. What happens if an MCP tool is called with missing required params? Does it return a helpful error or crash?
2. Read `packages/mcp-server/src/tools/session-end.ts` — what happens with an empty summary?
3. Read `packages/mcp-server/src/tools/bootstrap.ts` — what happens if bootstrap_import gets invalid JSON?

## Report format (under 400 words):
```
MCP TOOLS: N registered, N listed in --list-tools (match: yes/no)

TOOL DESCRIPTIONS (rated /10 each):
  session_start: /10
  remember: /10
  recall: /10
  session_end: /10
  check: /10
  digest: /10
  project_board: /10
  project_status: /10
  bootstrap_scan: /10
  bootstrap_import: /10

AGENTS.MD:
  MCP→CLI table present: yes/no
  Bootstrap documented: yes/no
  Trigger phrases: [adequate / missing key ones]

CLI COVERAGE:
  MCP tools with CLI equivalent: N/10
  Gaps: [list tools with no CLI command]

ERROR HANDLING:
  Missing params: [helpful error / crash]
  Empty summary: [handled / unhandled]
  Invalid JSON: [handled / unhandled]

TOP 3 NON-CLAUDE-CODE ISSUES:
1. ...
2. ...
3. ...
```
