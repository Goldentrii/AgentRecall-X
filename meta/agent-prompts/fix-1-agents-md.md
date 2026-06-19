# Fix Agent 1 — Update AGENTS.md: 6 → 10 tools

## File: ~/Projects/AgentRecall/AGENTS.md
Read it first, then update.

## Problem
AGENTS.md says "6 MCP tools" but 10 tools are registered. Missing: project_board, project_status, bootstrap_scan, bootstrap_import. Non-Claude-Code agents (Codex, Cursor, Windsurf) rely on this file and currently can't discover 4 tools.

## What to fix
1. Update the tool count from 6 to 10 wherever it appears
2. Add the 4 missing tools to the trigger-phrase table (follow existing format)
3. Add a bootstrap section explaining when/how to use bootstrap_scan + bootstrap_import
4. Verify the MCP→CLI translation table includes the new tools:
   - bootstrap_scan → ar bootstrap
   - bootstrap_import → ar bootstrap --import
   - project_board → ar projects (partial)
   - project_status → (no CLI equivalent — note it)

## Do NOT
- Rewrite existing content
- Change the file structure
- Touch any other file

## Verification
Read the final file and confirm: 10 tools listed, all 4 new tools have trigger phrases, MCP→CLI table is complete.

## Report: lines changed, tools added, build not needed (markdown only)
