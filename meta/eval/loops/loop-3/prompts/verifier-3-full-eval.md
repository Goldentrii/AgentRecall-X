# Loop 3 Verifier — Full Re-Evaluation

## Role
You run a comprehensive re-evaluation of the AgentRecall v3.4.0 system after all 3 loops of fixes. You will test the same core scenarios as the baseline agents, but faster — you know what to look for.

## CLI
```
node ~/Projects/AgentRecall/packages/cli/dist/index.js
```

## Test environments
```bash
rm -rf /tmp/ar-eval-loop3-cold /tmp/ar-eval-loop3-mid /tmp/ar-eval-loop3-migration
mkdir -p /tmp/ar-eval-loop3-cold /tmp/ar-eval-loop3-mid /tmp/ar-eval-loop3-migration
```

## Scenario A: Cold agent (new project experience)

```bash
CLI_COLD="AGENT_RECALL_ROOT=/tmp/ar-eval-loop3-cold node ~/Projects/AgentRecall/packages/cli/dist/index.js"

# 1. Cold-start on empty project
$CLI_COLD cold-start --project fresh

# 2. Write decision → check routing hint
$CLI_COLD write "We chose PostgreSQL over MySQL for JSON support and JSONB indexing" --project fresh
# Expected: routing_hint suggests architecture

# 3. Write blocker → check routing hint  
$CLI_COLD write "Blocked: missing .env.local, cannot run local dev server" --project fresh
# Expected: routing_hint suggests blockers

# 4. Write to palace architecture
$CLI_COLD palace write architecture "We chose PostgreSQL over MySQL for JSON support" --project fresh

# 5. Write to palace blockers
$CLI_COLD palace write blockers "Missing .env.local — cannot run dev server" --project fresh

# 6. Search WITHOUT --include-palace → should warn
$CLI_COLD search "postgres" --project fresh 2>&1
# Expected: stderr warning about palace not searched

# 7. Search WITH --include-palace → finds the content
$CLI_COLD search "postgres" --include-palace --project fresh
# Expected: finds PostgreSQL entry

# 8. Palace walk active → blockers should appear (not empty rooms)
$CLI_COLD palace walk --depth active --project fresh
# Expected: architecture + blockers appear, salience > 0

# 9. Cold-start AFTER writing → should show recent_entries
$CLI_COLD cold-start --project fresh
# Expected: recent_entries in top rooms contain the PostgreSQL/blocker entries

# 10. ar rooms → should show correct entry count
$CLI_COLD rooms --project fresh
# Expected: Architecture shows 1+ entries, Blockers shows 1+ entries
```

## Scenario B: Migration agent (AutoMemory → AgentRecall)

```bash
CLI_MIG="AGENT_RECALL_ROOT=/tmp/ar-eval-loop3-migration node ~/Projects/AgentRecall/packages/cli/dist/index.js"

# Test frontmatter stripping in palace write
$CLI_MIG palace write alignment "---
name: feedback-no-version-inflation
type: feedback
---
Never bump version numbers unless explicitly asked. Non-negotiable." --project migtest

# Read back — should NOT show YAML frontmatter headers
$CLI_MIG palace read alignment --project migtest
# Expected: "Never bump version numbers..." without "---" blocks or "name:/type:" lines

# Test framework synonym (Loop 2 fix)
$CLI_MIG palace write architecture "We chose tRPC instead of REST for type safety" --project migtest
$CLI_MIG palace search "framework" --project migtest
# Expected: finds the tRPC entry
```

## Scenario C: Mid-session agent (returning to existing project)

```bash
CLI_MID="AGENT_RECALL_ROOT=/tmp/ar-eval-loop3-mid node ~/Projects/AgentRecall/packages/cli/dist/index.js"

# Set up: pre-populate with decisions and a blocker
$CLI_MID palace write architecture "API uses tRPC v10 with Zod schema validation" --project resumetest
$CLI_MID palace write blockers "Rate limiter breaks under concurrent requests — needs token bucket" --project resumetest
$CLI_MID write "Session 1: chose tRPC, hit rate limiter issue. Next: fix rate limiter." --project resumetest

# Now simulate returning after gap
$CLI_MID cold-start --project resumetest
# Key checks:
# 1. top_rooms shows architecture + blockers (not empty rooms)
# 2. recent_entries shows the tRPC and rate limiter entries
# 3. No blank identity template

# Record a correction
$CLI_MID correct --goal "deploy feature" --correction "Always run linter before commit — CI fails otherwise" --project resumetest 2>/dev/null || true

# Cold-start again — correction should appear in p0_corrections
$CLI_MID cold-start --project resumetest
# Expected: p0_corrections contains the linter rule

# Latest read-back test
$CLI_MID write "Session 2: fixed rate limiter using token bucket. Next: performance testing." --project resumetest
$CLI_MID read --date latest --project resumetest
# Expected: returns "Session 2" content, not "Session 1"
```

## Scoring rubric

For each check, rate PASS / FAIL / PARTIAL.

Compare against baseline evaluation scores:
- Baseline cold agent: "write paths work, read paths fragmented, cold-start is raw data dump"
- Baseline mid agent: "partial resume, could not resume from cold-start alone"
- Baseline migration: "not safe for real users — silent data loss, cold-start doesn't restore context"

Expected improvements after 3 loops:
- Blockers should surface in cold-start and palace walk
- routing_hint guides agents to the right write path
- No frontmatter data loss
- Corrections injected in cold-start
- Search warns about palace exclusion
- Framework/tRPC searchable via "framework" query

## Output
Write to `~/Projects/AgentRecall/eval/loops/loop-3/results/verifier-3.md`

Include:
- Pass/fail table for all checks
- Delta from baseline: "what would a returning agent notice as different?"
- Remaining gaps: what's still broken?
- Recommendation: ready to ship v3.4.0 or needs another loop?
