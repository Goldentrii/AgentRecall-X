# Fix Agent 2 — Add project_status to --list-tools

## File: ~/Projects/AgentRecall/packages/mcp-server/src/index.ts
Read it first.

## Problem
`project_status` is registered as an MCP tool (line ~91) but is missing from the `--list-tools` output array (around line 76-87). A Codex agent running `--list-tools` to discover available tools will never see it.

## What to fix
Add project_status to the --list-tools array, right after project_board:
```typescript
{ name: "project_status", description: "Quick project health check — trajectory, blockers, room freshness" },
```

Also verify the count: the array should have 10 entries matching the 10 registered tools.

## Do NOT
- Touch any other file
- Change tool registration order
- Modify descriptions of existing tools

## Verification
```bash
cd ~/Projects/AgentRecall && npm run build 2>&1 | tail -3
node packages/mcp-server/dist/index.js --list-tools | wc -l
```
Build should pass, --list-tools should show 10 tools.

## Report: line added, build PASS/FAIL, --list-tools count
