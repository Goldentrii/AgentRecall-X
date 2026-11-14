# mcp.so

State 2026-11-14: not listed (fetched the server search for agent-recall: no match; a guessed server URL returned 404).

Method: https://mcp.so/submit. Fields seen: Repository URL (required), Name, project type (MCP Server, Remote Server, MCP Client, AI Product). The page shows one tier: a $39 one-time fee that publishes without review and adds a verified badge. No free tier is visible today; the 2026-11-13 plan assumed a free reviewed tier, which I could not confirm. Paying is the owner's call; do not pay on my behalf.

## Values

- Type: Remote Server (a second entry as MCP Server for the npm package is optional)
- Repository URL: https://github.com/Goldentrii/AgentRecall-X
- Name: AgentRecall
- Remote endpoint: https://agentrecallx.com/mcp
- Short description: Closes the Intelligent Distance: a correction you give one agent reaches every connected agent.
- Config snippet: `claude mcp add --scope user --transport http agent-recall https://agentrecallx.com/mcp`

## After

The listing gets its own page with copy-ready configs for Claude, Cursor and VS Code. Check that the endpoint and description are the new ones.
