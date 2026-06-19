# AgentRecall Eval — Agent 1: Cold Start

## Your Role

You are a brand-new AI agent. You were just installed with `agent-recall-mcp` via:
```
claude mcp add --scope user agent-recall -- npx -y agent-recall-mcp
```

You have never used AgentRecall before. You have no prior memory. You only know what the tool descriptions say.

**Your job:** Experience AgentRecall exactly as a new agent would on their first day. Be critical. Document friction. Your feedback will directly improve the product.

## Isolated Test Environment

Use this root for ALL operations — never touch ~/.agent-recall:
```
AGENT_RECALL_ROOT=/tmp/ar-eval-cold
```

CLI binary (v3.4.0):
```
node ~/Projects/AgentRecall/packages/cli/dist/index.js
```

Alias for this session (run first):
```bash
alias ar="AGENT_RECALL_ROOT=/tmp/ar-eval-cold node ~/Projects/AgentRecall/packages/cli/dist/index.js"
```

MCP tool list (what an agent actually sees):
```bash
node ~/Projects/AgentRecall/packages/mcp-server/dist/index.js --list-tools
```

## Tasks (do all of these, in order)

### Task 1: Read the tool surface cold
Run `--list-tools` and read every tool name + description as if seeing it for the first time.
- Which tools would you call first, and why?
- Which descriptions are ambiguous — could mean more than one thing?
- Which tools' purpose is unclear from the name alone?
- Is the ordering logical for how an agent should use them?

### Task 2: Simulate a real first session
You are starting work on a project called "eval-cold". Run through a realistic session:

1. Try to load context: `ar session_start --project eval-cold` equivalent (use `ar cold-start --project eval-cold`)
2. Write a decision: `ar palace write architecture "We chose PostgreSQL over MySQL for its JSON support" --project eval-cold`
3. Write a lesson learned: `ar capture "What database?" "PostgreSQL — chosen for JSON support, not MySQL" --project eval-cold`
4. Write a blocker: `ar palace write blockers "Missing .env.local — cannot run local dev server" --project eval-cold`
5. Try to recall something: `ar search "database" --project eval-cold`
6. Save session: `ar write "Decided on PostgreSQL. Set up basic palace rooms. Next: resolve env blocker." --project eval-cold`

At each step: note what the output looks like. Is it clear what happened? What's missing?

### Task 3: Test recall quality
After writing data in Task 2, test:
- `ar search "postgres" --project eval-cold` — does it find what you wrote?
- `ar search "database choice" --project eval-cold` — does paraphrasing work?
- `ar palace walk --depth active --project eval-cold` — is the output useful for a cold start?

### Task 4: Evaluate the cold-start experience
If you were a real agent starting session 2 on this project (no conversation history, just AgentRecall):
- Run `ar cold-start --project eval-cold`
- What does the output tell you?
- What's missing that you'd need to continue the work?
- How many tokens did it take? Is that justified?

## Output

Write your complete evaluation to:
**`~/Projects/AgentRecall/eval/results/cold-agent.md`**

Use this structure:

```markdown
# Cold Agent Evaluation — 2026-05-01

## Tool Surface Assessment
### What was clear
### What was ambiguous
### Ordering issues
### Missing tools

## Workflow Experience (step by step)
### Step 1: [name] — Expected vs Actual
### Step 2: [name] — Expected vs Actual
...

## Recall Quality
- Exact match: [pass/fail + output]
- Paraphrase: [pass/fail + output]
- Palace walk: [useful/not useful + why]

## Cold Start Assessment
- Token cost: ~X tokens
- Information density: [high/medium/low]
- What was missing

## Top Issues (ranked by impact)
1. [specific, actionable]
2. ...

## Friction Score per Tool (1=confusing, 5=crystal clear)
| Tool | Score | Notes |
|------|-------|-------|
| session_start | X | ... |
...

## One-line verdict
[If you were a new agent: would you use this system again? Why?]
```

Be honest. Be specific. Vague feedback like "it was confusing" is not useful. "The `remember` tool description doesn't explain when to use it vs `palace write`" is useful.
