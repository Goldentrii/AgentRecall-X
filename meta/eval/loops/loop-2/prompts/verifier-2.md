# Loop 2 Verifier

## Role
Behavioral tester. Run targeted commands against the rebuilt CLI. Report PASS/FAIL per test with actual output.

## Environment

```bash
CLI=node ~/Projects/AgentRecall/packages/cli/dist/index.js
COLD_ROOT=/tmp/ar-eval-loop2-cold
```

Setup: `rm -rf /tmp/ar-eval-loop2-cold && mkdir -p /tmp/ar-eval-loop2-cold`

## Tests

### A2-1: Framework synonym search
```bash
AGENT_RECALL_ROOT=/tmp/ar-eval-loop2-cold $CLI palace write architecture "We chose tRPC over REST for better type safety" --project a2test
AGENT_RECALL_ROOT=/tmp/ar-eval-loop2-cold $CLI palace search "framework" --project a2test
```
Expected: Result set includes the tRPC entry. FAIL if 0 results.

### A2-2: Remember description visible to agents
```bash
$CLI --list-tools 2>/dev/null || AGENT_RECALL_ROOT=/tmp/ar-eval-loop2-cold $CLI --help | grep -A5 "remember"
```
Check if routing hints appear in description.

### B2-1: Auto-routing advisory for decisions
```bash
AGENT_RECALL_ROOT=/tmp/ar-eval-loop2-cold $CLI write "We decided to use GraphQL instead of REST for better type safety" --project b2test
```
Expected: Output includes `routing_hint` with `suggested_room: "architecture"` or similar.

### B2-2: Auto-routing advisory for blockers
```bash
AGENT_RECALL_ROOT=/tmp/ar-eval-loop2-cold $CLI write "Missing .env.local file, cannot run dev server" --project b2test
```
Expected: Output includes `routing_hint` with `suggested_room: "blockers"`.

### B2-3: No false routing hint for neutral content
```bash
AGENT_RECALL_ROOT=/tmp/ar-eval-loop2-cold $CLI write "Today I worked on the dashboard feature" --project b2test
```
Expected: `routing_hint` is null or absent.

### C2-1: Bootstrap import strips frontmatter
```bash
# Create a seed file with frontmatter
mkdir -p /tmp/ar-eval-loop2-cold/seed
cat > /tmp/ar-eval-loop2-cold/seed/test.md << 'EOF'
---
name: test-feedback
type: feedback
---
Never deploy on Fridays because rollbacks are impossible over the weekend.
EOF

# Read the seed and write to palace — frontmatter should be stripped
content=$(cat /tmp/ar-eval-loop2-cold/seed/test.md)
AGENT_RECALL_ROOT=/tmp/ar-eval-loop2-cold $CLI palace write alignment "$content" --project c2test

# Check the stored content — should NOT include "name: test-feedback" or "type: feedback"
AGENT_RECALL_ROOT=/tmp/ar-eval-loop2-cold $CLI palace read alignment --project c2test
```
Expected: Stored content contains "Never deploy on Fridays" but NOT "name: test-feedback".

### D2-1: Help text has write path guide
```bash
AGENT_RECALL_ROOT=/tmp/ar-eval-loop2-cold $CLI --help | grep -A10 "WRITE PATH"
```
Expected: Shows the 4-line routing guide.

### D2-2: Palace write warns on unknown slug
```bash
AGENT_RECALL_ROOT=/tmp/ar-eval-loop2-cold $CLI palace write typoroom "some content" --project d2test 2>&1
```
Expected: stderr contains "Note: 'typoroom' is not a default room" but write still succeeds (check success:true in stdout).

### D2-3: Search note printed to stderr
```bash
AGENT_RECALL_ROOT=/tmp/ar-eval-loop2-cold $CLI palace write architecture "PostgreSQL chosen" --project d2test
AGENT_RECALL_ROOT=/tmp/ar-eval-loop2-cold $CLI search "postgres" --project d2test 2>&1
```
Expected: stderr contains "[ar] Palace rooms were not searched"

## Output

Write to `~/Projects/AgentRecall/eval/loops/loop-2/results/verifier-2.md`

Table format:
| Test | Status | Evidence |
|------|--------|---------|
