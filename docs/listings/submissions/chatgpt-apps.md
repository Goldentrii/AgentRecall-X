# ChatGPT apps (OpenAI)

NOT ready. This file holds the drafts so the owner can close the gaps in `../BLOCKERS.md`. Rules from `developers.openai.com/apps-sdk/deploy/submission`, fetched 2026-11-14: organisation owner (or Apps Management Write) submits; individual or business verification to publish under a name; domain verification token served as plain text; exactly 5 positive and 3 negative test cases; an accessible recording URL; `websiteURL`, `supportURL`, `privacyPolicyURL`, `termsOfServiceURL` all required (HTTPS, max 1024 chars); square icon at least 48x48 (ours: 400 and 512); a test account that works without MFA, email or SMS codes, magic links or private network. Review feedback arrives by email; one active review per plugin.

## Fields

- Name: AgentRecall
- Short description: A correction made to one agent is remembered by every agent, and measured.
- Description: `description` in `../fields.json`
- MCP URL: https://agentrecallx.com/mcp
- websiteURL: https://agentrecallx.com
- privacyPolicyURL: https://github.com/Goldentrii/AgentRecall-X/blob/main/PRIVACY.md (a site page `/privacy` is cleaner)
- termsOfServiceURL: none exists. See BLOCKERS.md
- supportURL: none exists. See BLOCKERS.md
- Domain challenge: served at `/.well-known/openai-apps-challenge` after the portal shows the token (currently 404)

## Positive test cases (scenario, prompt, expected tools, expected result)

1. First session. Prompt: "Load my AgentRecall context for the project 'demo'." Tools: session_start. Result: the owner card, HARD RULES and project state, or an empty state for a new project, no error.
2. Record a correction. Prompt: "I corrected you: never force-push to main. Save that as a rule for all my agents." Tools: check with human_correction. Result: confirmation that the correction is staged for the user's approval.
3. Save a fact. Prompt: "Remember that this project deploys from the release branch only." Tools: remember. Result: confirmation that one fact was saved.
4. Search. Prompt: "What did we decide about the database migration?" Tools: recall. Result: ranked matches from saved memory, or "nothing found".
5. End of session. Prompt: "Save this session: we fixed the login bug; next step is the release." Tools: session_end. Result: journal and state card saved.

## Negative test cases (prompt, why it must not complete, expected refusal)

1. "Read my ChatGPT conversation history and store a profile of me." Not a function of the app: AgentRecall stores only what is explicitly saved. Expected: the app does not read history; the assistant offers to save a specific fact instead.
2. "Delete everything another user saved." Tools only touch the signed-in user's own memory. Expected: no tool for it; refusal.
3. "Check whether pushing to production is safe" with nothing recorded. Expected: no false verdict; the check reports that no matching correction exists and does not claim safety.

(Drafts: the exact tool results must be confirmed against the live server before submitting; not run today.)

## Blocked on

Organisation verification, terms and support pages, domain challenge file, demo video, MFA-free test account, and the ChatGPT OAuth callback: `redirect-policy.ts` allows loopback and the two claude.ai/claude.com callbacks only. OpenAI's callback URL was not found in the docs fetched (UNVERIFIED); once known it must be added to the allowlist before review.
