# Cline MCP marketplace

State 2026-11-14: not listed (searched `cline/mcp-marketplace` issues for agent-recall: none ours). Rules from the repo README: open a new issue with the submission template; give the GitHub repo URL, a 400x400 PNG logo, a reason; confirm you tested that Cline can set the server up from the README or `llms-install.md`. Review looks at community adoption, developer credibility, project maturity, security; "a couple of days".

## Do first (by hand, I cannot run Cline here)

Install via `llms-install.md` in a clean Cline, option A (hosted) and option B (local), and confirm `session_start` returns. The issue template asks you to confirm you watched Cline succeed.

## Submit

URL: https://github.com/cline/mcp-marketplace/issues/new?template=mcp-server-submission.yml (template name UNVERIFIED; use "New issue" on that repo and pick the server submission template).

- GitHub Repo URL: https://github.com/Goldentrii/AgentRecall-X
- Logo: upload `assets/brand/icon-400.png` (400x400 PNG)
- Reason for addition: A correction you make to one agent is remembered by every agent you use, and measured. It narrows the Intelligent Distance between a person and their agents. Hosted (free, GitHub sign-in, `https://agentrecallx.com/mcp`) or local and offline (`npx -y agent-recall-mcp`), 5 tools, MIT. Install steps for Cline are in `llms-install.md` at the repo root.
- Tested with Cline: tick only after your own run.

## After

Cline team replies on the issue; approved servers go live shortly after. The repo is public with 377 stars, MIT, active (pushed today), which fits their adoption and maturity criteria.
