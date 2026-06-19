# Loop 1 Verifier — Post-Fix Evaluation

## Role
You are a verifier agent. You run targeted tests against the rebuilt AgentRecall CLI to confirm each bug is fixed. You are NOT a code reviewer — you test behavior, not code.

## Environment

```bash
CLI=~/Projects/AgentRecall/packages/cli/dist/index.js
COLD=/tmp/ar-eval-loop1-cold
MID=/tmp/ar-eval-loop1-mid
```

Aliases:
```bash
alias arc="AGENT_RECALL_ROOT=$COLD node $CLI"
alias arm="AGENT_RECALL_ROOT=$MID node $CLI"
```

## Setup

First, set up fresh test environments:
```bash
rm -rf /tmp/ar-eval-loop1-cold /tmp/ar-eval-loop1-mid
mkdir -p /tmp/ar-eval-loop1-cold /tmp/ar-eval-loop1-mid
```

## Test B1: CLI positional parser

```bash
# Test 1a: content with --- should not lose the --- lines
arc palace write architecture "---
name: test-project
type: project
---
This is the actual content after frontmatter" --project b1test

# Expected: content stored includes "---" lines AND "This is the actual content"
# Verify by reading back:
arc palace read architecture --project b1test
```

```bash
# Test 1b: --topic value should NOT appear in stored content
arc palace write goals "My actual goal" --topic quarterly-goal --project b1test

# Read back the README to check no "quarterly-goal" in body:
arc palace read goals --project b1test
# Expected: content is "My actual goal" not "My actual goal quarterly-goal"

# Read the topic file directly:
arc palace read goals --topic quarterly-goal --project b1test
# Expected: file exists with "My actual goal" content
```

## Test B2: `ar read --date latest`

```bash
# Set up: write two entries on the same "date" (simulate with fast writes)
arm write "First entry — old content" --project b2test
sleep 1
arm write "Second entry — newest content" --project b2test

# Read latest — should return SECOND entry
arm read --date latest --project b2test
# Expected output contains "Second entry — newest content"
# FAIL if it returns "First entry — old content"
```

## Test B3: `ar rooms` entry count

```bash
# Write to a room
arc palace write architecture "PostgreSQL chosen for JSON support" --project b3test
arc palace write architecture "Auth uses RS256 JWT" --project b3test

# Check rooms shows 2 entries (not 0)
arc rooms --project b3test
# Expected: "Architecture (2 entries, salience X.XX)"
# FAIL if shows "Architecture (0 entries, ...)"
```

## Test B4: Salience inversion

```bash
# Create fresh project — write to one room only
arc palace write architecture "Decision: use TypeScript" --project b4test
arc palace write architecture "Decision: use Postgres" --project b4test

# Walk — architecture should appear in top rooms, empty rooms should not outrank it
arc palace walk --depth active --project b4test
# Expected: architecture room is listed. Empty rooms (goals, blockers, etc.) should NOT appear above it with salience 0.5
# FAIL: if alignment/decisions/knowledge appear with salience 0.5 and architecture is missing or ranked lower
```

## Test B5: Cold-start surfaces room content

```bash
# Write to blockers room
arc palace write blockers "Missing .env.local — cannot run dev server" --project b5test

# Run cold-start
arc cold-start --project b5test
# Expected: output includes "recent_entries" with the blocker content
# FAIL if "Missing .env.local" does not appear anywhere in cold-start output
```

## Test B6: Cold-start injects P0 corrections

```bash
# Record a correction
arm correct --goal "deploy to production" --correction "Never deploy on Fridays — rollback is impossible over weekend" --project b6test 2>/dev/null || true

# Run cold-start
arm cold-start --project b6test
# Expected: output includes "p0_corrections" with the rule about Friday deploys
# FAIL if p0_corrections is missing or empty
```

## Test B7: Search palace notice

```bash
# Search without --include-palace
arc search "architecture" --project b7test
# Expected: result has "palace_searched": false and "_note" field
# FAIL if no _note or palace_searched field

# Search WITH --include-palace
arc search "architecture" --include-palace --project b7test
# Expected: result has "palace_searched": true, no _note
```

## Output

Write your result to:
`~/Projects/AgentRecall/eval/loops/loop-1/results/verifier.md`

Format:
```markdown
# Loop 1 Verifier Results

| Bug | Test | Status | Evidence |
|-----|------|--------|---------|
| B1a | --- in content preserved | PASS/FAIL | [actual output excerpt] |
| B1b | --topic value not in content | PASS/FAIL | [actual output excerpt] |
| B2  | latest returns newest file | PASS/FAIL | [actual output excerpt] |
| B3  | rooms shows correct count | PASS/FAIL | [actual output excerpt] |
| B4  | salience ranks content rooms higher | PASS/FAIL | [actual output excerpt] |
| B5  | cold-start shows room entries | PASS/FAIL | [actual output excerpt] |
| B6  | cold-start shows P0 corrections | PASS/FAIL | [actual output excerpt] |
| B7a | search without palace has _note | PASS/FAIL | [actual output excerpt] |
| B7b | search with palace has palace_searched:true | PASS/FAIL | [actual output excerpt] |

## New issues discovered
[Any new bugs or regressions found during testing]

## Loop 2 candidates
[Issues from baseline eval that were NOT fixed in Loop 1 and are still present]
```
