# Official MCP Registry (registry.modelcontextprotocol.io)

State 2026-11-14 (fetched `/v0/servers?search=agent-recall`): `io.github.Goldentrii/agent-recall` v3.5.2 is latest, repo `AgentRecall-X`, remote `streamable-http` at the old host `recall.aiakada.com/mcp` <!-- OLD-HOST -->. An older 3.4.31 entry is marked not latest. Needs a new version to point at `agentrecallx.com`.

## Before you publish (blocker)

`packages/mcp-server/server.json` pins npm package version 3.5.3. npm still has 3.5.2. The registry checks the npm package, so publish to npm first (release step, needs your explicit yes), then publish here. Do not edit `server.json` down to 3.5.2: the drift test requires it to equal `package.json`.

## Values (already in `packages/mcp-server/server.json`, schema `2025-12-11`)

- name: `io.github.Goldentrii/agent-recall` (must equal `mcpName` in package.json: checked by test)
- description (max 100 chars, rule from the registry quickstart): "Correction-first memory for AI agents. Run it locally or connect any MCP agent to the hosted server."
- remotes: `streamable-http` `https://agentrecallx.com/mcp`

Optional, your call: the description above says "memory"; a description that names the product idea is "A correction made to one agent is remembered by every agent, and measured." (74 chars). If you change it, edit `server.json` and run the existing drift test.

## Command

```
cd packages/mcp-server
mcp-publisher login github        # device code, you authorise in the browser
mcp-publisher publish
```

The binary and token files are git-ignored. Verify: `https://registry.modelcontextprotocol.io/v0/servers?search=agent-recall` shows 3.5.3 as `isLatest` and the new URL.

## After

PulseMCP says it picks up new entries from this registry automatically once its submissions reopen. Windsurf/Devin Local documents custom registries following this schema. GitHub MCP Registry and VS Code gallery: relationship not documented in the pages fetched (UNVERIFIED); re-check them after publishing.
