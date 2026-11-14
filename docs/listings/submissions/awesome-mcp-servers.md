# punkpeye/awesome-mcp-servers (and awesome-remote-mcp-servers)

## A. awesome-mcp-servers: fix the stale entry (ready)

State 2026-11-14 (fetched README.md raw, line 2957, section Knowledge & Memory): listed under the old name `Goldentrii/AgentRecall` with the old `AgentRecall-MCP` Glama badge. wong2/awesome-mcp-servers and appcypher/awesome-mcp-servers: 0 matches.

Rules (CONTRIBUTING.md fetched): fork, branch, edit README.md in the existing format, alphabetical within the category, one line per server, PR with a clear title. Agents can add the three robot emoji to the PR title for fast merge; that is the owner's choice.

Replace the existing `Goldentrii/AgentRecall` line with:

```
- [Goldentrii/AgentRecall-X](https://github.com/Goldentrii/AgentRecall-X) [![Goldentrii/AgentRecall-X MCP server](https://glama.ai/mcp/servers/Goldentrii/AgentRecall-X/badges/score.svg)](https://glama.ai/mcp/servers/Goldentrii/AgentRecall-X) 📇 ☁️ 🏠 🍎 🪟 🐧 - Narrows the Intelligent Distance between you and your agents: a correction made to one agent is remembered by every agent, and measured. Hosted (free, GitHub sign-in) or local.
```

Keep it in the same position unless alphabetical order changes (the name sorts the same as before). PR title: `Update AgentRecall entry (renamed repo, hosted option)`.

## B. awesome-remote-mcp-servers (not ready)

Format: name/homepage link, endpoint in backticks, Glama connector badge, auth marker (OAuth is the key emoji with the lock), description up to 120 chars. Rules: star the repo first; CI checks endpoint health, auth type and badge. Blocked on Glama row (the entry must be a Glama connector). Draft line, to finish once the badge URL is known:

- Entry: [AgentRecall](https://agentrecallx.com), endpoint https://agentrecallx.com/mcp, then the Glama connector badge, then the OAuth marker, then: A correction made to one agent is remembered by every agent, and measured.

Description length: 74 chars (limit 120). Not verified against their CI.
