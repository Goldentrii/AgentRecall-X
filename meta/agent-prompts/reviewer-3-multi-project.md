# Reviewer 3 — Multi-Project Orchestrator

## Your persona
You manage 5+ projects simultaneously. You need AR to keep context separate, surface cross-project insights, and let you switch fast.

## Project location
~/Projects/AgentRecall

## What to do

### Phase 1: Check project isolation
1. List all projects: `ls ~/.agent-recall/projects/` — how many exist?
2. Pick 2 different projects. Read their `palace/identity.md` files — are they distinct or generic stubs?
3. Check corrections: do corrections from project A leak into project B's session_start? Read `packages/core/src/tools-logic/session-start.ts` — how are corrections loaded (line ~140)?
4. Check alignment-log: are alignment logs per-project? Read `packages/core/src/storage/paths.ts` for the path.

### Phase 2: Test cross-project features
1. Read `packages/core/src/palace/insights-index.ts` — how does `recallInsights()` work cross-project? Does it correctly match insights from other projects?
2. Check `~/.agent-recall/insights-index.json` — how many entries? Do they have `projects` arrays populated?
3. Read session-start.ts `cross_project` section (around line 103-110) — does `from_project` show real project slugs?

### Phase 3: Test project switching
1. Does session_start handle rapid project switching? (call with project A, then immediately project B)
2. Read `packages/core/src/storage/project.ts` — `detectProject()`. No caching (confirmed removed). But does it correctly handle being called from different cwd?
3. What happens if two agents call session_start for different projects simultaneously? Read the code for any shared mutable state.

### Phase 4: Test bootstrap for multi-project users
1. Read `packages/core/src/tools-logic/bootstrap.ts` — how does it handle a user with 20+ existing AR projects?
2. Does `already_in_ar` correctly skip existing projects?
3. What's the scan performance? Check the test results from earlier (should be <200ms).

### Phase 5: Check /arstatus accuracy
1. Read `~/.claude/commands/arstatus.md` — the /arstatus skill
2. Does it scan ALL project directories correctly?
3. Read `packages/core/src/storage/project.ts` — `listAllProjects()`. Does it count smart-named journals? (Fixed earlier — verify)

## Report format (under 400 words):
```
PROJECT ISOLATION:
  Projects found: N
  Identity quality: [distinct / generic stubs]
  Corrections scoped: yes/no
  Alignment logs scoped: yes/no

CROSS-PROJECT:
  Insights index entries: N
  projects[] populated: yes/no/partial
  from_project accuracy: [slugs / entry-type strings / mixed]

PROJECT SWITCHING:
  Shared mutable state: [none found / found at ...]
  detectProject caching: [none / still cached]

BOOTSTRAP:
  already_in_ar detection: [works / broken]
  Scan time for 20+ projects: Nms

/ARSTATUS:
  Lists all projects: yes/no
  Smart-named journals counted: yes/no

TOP 3 MULTI-PROJECT ISSUES:
1. ...
2. ...
3. ...
```
