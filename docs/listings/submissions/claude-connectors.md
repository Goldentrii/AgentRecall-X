# Claude connectors directory

Source of rules: `claude.com/docs/connectors/building/submission` and `.../review-criteria`, fetched 2026-11-14. Portal: https://claude.ai/directory/manage, choose "Submit new", then "MCP connector". Any paid Claude plan can submit. Anthropic scans automatically and by default lists a Community connector; a human "Verified" review may follow and then asks by email for test access. Escalations: mcp-review@anthropic.com.

Status of what we meet: HTTPS remote (yes), OAuth (yes, redirect allowlist includes `https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback`), every tool has `title` + hints (yes, `tool-annotations.test.mjs`), privacy policy (GitHub PRIVACY.md; a site page does not exist yet), documentation (https://agentrecallx.com/connect.md), support contact (NOT yet: see BLOCKERS.md), icon (`assets/brand/icon-400.png` / `icon-512.png`).

## Portal fields

Step 1 Connection: `https://agentrecallx.com/mcp`

Step 3 Listing:
- Name (max 100): AgentRecall
- One-liner (max 200): AgentRecall narrows the Intelligent Distance between you and your AI agents: a correction made to one agent is remembered by every agent you use, and measured. Free hosted server, GitHub sign-in.
- Description (max 2000): paste `description` from `../fields.json` (1246 chars).
- Categories (1 to 5): Productivity, Developer tools, AI agents. UNVERIFIED: the portal's category list was not visible without signing in; pick the closest names.
- Documentation URL: https://agentrecallx.com/connect.md
- Privacy policy URL: https://github.com/Goldentrii/AgentRecall-X/blob/main/PRIVACY.md
- Support contact: see BLOCKERS.md (proposal: a `/support` page, or the email in PRIVACY.md)
- Icon: `assets/brand/icon-512.png`
- URL slug (permanent once published): `agentrecall`

Step 4 Use cases: a person uses several AI agents; corrections they give one agent are saved once and reach all of them at the start of the next session; risky actions are checked against past corrections. Needs before connecting: a GitHub account, no plan, no API key. Reads and writes data (writes only what the agent saves at the user's request).

Step 5 Company: Tong Wu, https://agentrecallx.com, contact email as in PRIVACY.md.

Step 6 Authentication: required; OAuth 2.0 (2.1 with PKCE and dynamic client registration; GitHub sign-in).

Step 7 Data handling: own first-party API; no personal health data; no sponsored content.

Step 8 Test and launch: confirm you ran every tool in MCP Inspector and as a custom connector in Claude (do this first: Settings, Connectors, Add custom connector, URL above). No credentials go in the portal.

Step 9 Compliance: seven acknowledgments. Read the one on conversation data collection with care: AgentRecall stores only what the agent saves on request; it does not read Claude's memory or chat history (the review criteria forbid that). Say it exactly so in the listing description (already in it).

## Example prompts (for the listing and your own test)

1. Connect AgentRecall, then load my project context with session_start and tell me my current HARD RULES.
2. I just told you not to force-push to main. Record that as a correction so every agent I use follows it.
3. Remember that this project deploys from the release branch only.
4. Before you push this branch, check the action against the corrections I have made.
5. Recall what we decided last week about the database migration, then save today's progress with session_end.

## After

Status and reviewer feedback appear in the portal. Likely review risk: all tools are write tools (none is read-only), see BLOCKERS.md.
