# Glama

State 2026-11-14 (fetched `glama.ai/mcp/servers/Goldentrii/AgentRecall-X`): listed as "AgentRecall" by Goldentrii, categories Knowledge & Memory and Autonomous Agents, hosting "Local", 5 tools, TDQS 3.9/5 (scored 2026-09-13), MIT, **not claimed** (a Claim option is shown). The hosted-option text on the page still shows the old host <!-- OLD-HOST --> because it is scraped from an older README.

## Do

1. Open the listing, sign in with GitHub as Goldentrii, press Claim. (The claim URL itself returned 404 when fetched; use the button on the page. Flow UNVERIFIED.)
2. `glama.json` in the repo root is valid against `https://glama.ai/mcp/schemas/server.json` (fetched: only `maintainers`, required, array of GitHub usernames). It lists `Goldentrii`. No change was needed.
3. After claiming, trigger a re-sync so the hosted-endpoint text refreshes to https://agentrecallx.com/mcp. If Glama offers a hosted-connector claim, the 2026-11-13 plan expected a token at `/.well-known/glama.json`; that path is 404 on the site today and no such requirement was found in anything fetched (UNVERIFIED), so do not build it until Glama asks.

## Why it matters

Row 11 (awesome-remote-mcp-servers) requires a Glama connector listing and the badge.
