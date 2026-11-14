# Install AgentRecall (instructions for Cline)

AgentRecall narrows the Intelligent Distance between a person and their agents: a correction made to one agent is remembered by every agent and measured. It is an MCP server with 5 tools: `session_start`, `session_end`, `remember`, `recall`, `check`.

Pick ONE option. Do not install both: they would hold two separate memories.

## Option A: hosted (recommended, free, no local install)

Needs a GitHub account. The first connection opens a browser sign-in (OAuth 2.1).

Add to `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "agent-recall": {
      "url": "https://agentrecallx.com/mcp",
      "type": "streamableHttp",
      "disabled": false
    }
  }
}
```

Then complete the sign-in when Cline asks. Memory is private per user and stored in the EU.

## Option B: local, offline (stdio)

Needs Node.js 18 or newer. Nothing leaves the machine; memory is plain markdown in `~/.agent-recall/`.

```json
{
  "mcpServers": {
    "agent-recall": {
      "command": "npx",
      "args": ["-y", "agent-recall-mcp"],
      "disabled": false
    }
  }
}
```

No API key or environment variable is required.

## Verify

Ask the agent: "Call session_start for this project and show me what it returns." A successful call returns the project state and any HARD RULES; a new project returns an empty state, not an error.

## How to use it

- At the start of a session call `session_start`.
- When the human corrects you, call `check` with `human_correction: { rule, why, applies_when }`.
- Before an irreversible action (push, deploy, delete) call `check` with `action_description`.
- Saving a fact means calling `remember`; saying "noted" does not save anything.
- Before you stop, call `session_end` with a summary.

Docs: https://agentrecallx.com/connect.md . Privacy policy: https://github.com/Goldentrii/AgentRecall-X/blob/main/PRIVACY.md
