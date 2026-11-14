# Cursor marketplace

State 2026-11-14: not listed. Rules from `cursor.com/docs/plugins` and `cursor.com/docs/reference/plugins` (fetched today): plugin = repo with `.cursor-plugin/plugin.json` (only `name` required) and `mcp.json`; submit at https://cursor.com/marketplace/publish; every plugin is manually reviewed, must be open source, and each update is reviewed.

## In the repo

- `.cursor-plugin/plugin.json`: name `agent-recall`, version, author, homepage, repository, license, keywords, logo `assets/brand/icon-512.png` (relative path).
- `mcp.json`: one server, `agent-recall`, `url` `https://agentrecallx.com/mcp`. Cursor signs in with OAuth on first use. The local stdio option is documented in the README, not in this file, because two entries would create two separate memories.

Checklist from the plugin reference, state:
- valid manifest: yes. name kebab-case unique: yes (uniqueness in the marketplace UNVERIFIED).
- description explains purpose: yes. logo committed, relative path: yes.
- `README.md` documents usage: yes (repo README).
- all paths relative, no `..`: yes (checked by the drift test).
- tested locally: NOT done. Do it: copy the repo to `~/.cursor/plugins/local/agent-recall`, reload Cursor, confirm the server shows under Customize and `session_start` works.
- Not applicable: rules/skills/commands (none shipped).

## Submit

1. Merge this branch to main (the plugin and icon must be on the default branch).
2. Open https://cursor.com/marketplace/publish and give the repo URL https://github.com/Goldentrii/AgentRecall-X. Field names of that form were not visible without signing in (UNVERIFIED); use:
   - Name: AgentRecall
   - Description (200): AgentRecall narrows the Intelligent Distance between you and your AI agents: a correction made to one agent is remembered by every agent you use, and measured. Free hosted server, GitHub sign-in.

## After

Manual review; no timeline published. The repo is a monorepo whose root is the plugin: no `marketplace.json` is needed because it holds one plugin.
