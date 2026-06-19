# AgentRecall Eval — Agent 3: Migration (From Another Memory System)

## Your Role

You are an AI agent who has been using Claude's built-in AutoMemory for 3 months. You have a rich memory base stored in `~/.claude/projects/`. You're evaluating AgentRecall as a potential upgrade — specifically its `bootstrap_scan` and `bootstrap_import` tools.

**Your job:** Test the migration path from scratch. Does AgentRecall make it easy to transfer existing memory? What gets lost? What arrives correctly? Would you trust it enough to make it your primary memory system?

## Isolated Test Environment

```
AGENT_RECALL_ROOT=/tmp/ar-eval-migration
```

Pre-created mock AutoMemory files are at:
```
~/Projects/AgentRecall/eval/seeds/migration/
```

These simulate a real Claude AutoMemory setup with:
- User profile memory
- 2 project memories (novada-mcp, agentrecall)
- Feedback and correction memories
- A CLAUDE.md with conventions

CLI binary (v3.4.0):
```
node ~/Projects/AgentRecall/packages/cli/dist/index.js
```

Alias:
```bash
alias ar="AGENT_RECALL_ROOT=/tmp/ar-eval-migration node ~/Projects/AgentRecall/packages/cli/dist/index.js"
```

## Tasks (do all of these, in order)

### Task 1: Run bootstrap scan
```bash
ar bootstrap --root /tmp/ar-eval-migration
```

Or simulate what `bootstrap_scan` MCP tool would do by reading the seed files:
```bash
ls ~/Projects/AgentRecall/eval/seeds/migration/
cat ~/Projects/AgentRecall/eval/seeds/migration/user-profile.md
cat ~/Projects/AgentRecall/eval/seeds/migration/project-novada-mcp.md
cat ~/Projects/AgentRecall/eval/seeds/migration/project-agentrecall.md
cat ~/Projects/AgentRecall/eval/seeds/migration/CLAUDE.md
```

Report:
- Does the scan discover the right things?
- What would it miss?
- How long did the scan take?

### Task 2: Run bootstrap import
```bash
ar bootstrap --import --root /tmp/ar-eval-migration
```

If this fails or isn't available, manually import the seed files:
- Read each seed file
- Write the contents into AgentRecall using `ar palace write` or `ar capture`
- Document where each type of memory should go

Report:
- What was imported automatically vs. what required manual intervention?
- What got lost in translation (existed in AutoMemory but couldn't map to AgentRecall)?
- What was the token cost of the import process?

### Task 3: Verify import quality
After import, test whether the memory actually made it:

```bash
ar palace walk --depth active --root /tmp/ar-eval-migration --project novada-mcp
ar search "api framework" --root /tmp/ar-eval-migration --project novada-mcp
ar awareness read --root /tmp/ar-eval-migration
```

- Is the imported context usable for a real work session?
- Or does it look like raw dumped text that an agent can't act on?
- What information survived the migration cleanly?
- What was mangled, truncated, or lost?

### Task 4: Compare AutoMemory vs AgentRecall structure
Read the original seed files again, then read the AgentRecall output.

For each type of memory:
| Memory type | AutoMemory format | AgentRecall equivalent | Info preserved? |
|-------------|-------------------|----------------------|-----------------|
| User profile | user/*.md | awareness? palace? | % |
| Project feedback | feedback_*.md | palace/alignment? | % |
| Project corrections | correction entries | alignment-log.json? | % |
| CLAUDE.md conventions | flat markdown | palace/architecture? | % |

### Task 5: First session after migration
Pretend the migration just completed. Start a fresh work session:

```bash
ar cold-start --root /tmp/ar-eval-migration --project novada-mcp
```

- Would you know what to work on next?
- Are the priorities from the old memory system preserved?
- Is anything better in AgentRecall vs. AutoMemory format?
- Is anything worse?

### Task 6: The trust question
Would you switch from AutoMemory to AgentRecall as your primary memory system?
- What would need to change for you to say yes?
- What does AgentRecall do better?
- What does AutoMemory do better?
- What's the single biggest blocker to migration?

## Output

Write your complete evaluation to:
**`~/Projects/AgentRecall/eval/results/migration-agent.md`**

```markdown
# Migration Agent Evaluation — 2026-05-01

## Bootstrap Scan
- What was discovered: [list]
- What was missed: [list]
- Scan quality: [1-5]

## Import Quality
| Memory type | Auto-imported? | Quality | Lost? |
|-------------|---------------|---------|-------|

- Manual steps required: [list]
- Token cost of import: ~X tokens

## Information Preservation
- Survived cleanly: [list]
- Mangled/truncated: [list]
- Completely lost: [list]

## AutoMemory vs AgentRecall
| Dimension | AutoMemory | AgentRecall | Winner |
|-----------|------------|-------------|--------|
| Structure | | | |
| Searchability | | | |
| Agent readability | | | |
| Human readability | | | |
| Cold start quality | | | |

## First-Session Experience Post-Migration
- Knew what to work on? [yes/no]
- Context quality: [1-5]
- Missing: [list]

## Top Issues (ranked by impact)
1. [specific, actionable]
2. ...

## Would you migrate?
[yes/no/partial — and exactly what would need to change]

## One-line verdict
[Is the migration path good enough for real users to switch?]
```
