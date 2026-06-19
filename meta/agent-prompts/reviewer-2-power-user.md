# Reviewer 2 — Power User (10+ Sessions)

## Your persona
You are an AI agent that has been using AgentRecall for 20+ sessions on the AgentRecall project itself. You have rich data in `~/.agent-recall/projects/AgentRecall/`. You're evaluating whether the compounding promise actually delivers.

## Project location
~/Projects/AgentRecall

## What to do

### Phase 1: Check real data quality
1. Read `~/.agent-recall/awareness-state.json` — how many insights? Are they useful or noise? Count: actionable vs vague.
2. Read `~/.agent-recall/awareness.md` — is it a coherent document or a jumbled list?
3. Read the latest 2-3 journal entries in `~/.agent-recall/projects/AgentRecall/journal/` — do they contain real trajectory info? Is ## Next populated?
4. List palace rooms: `ls ~/.agent-recall/projects/AgentRecall/palace/rooms/` — how many? Read 2-3 room entry files. Is the content useful?

### Phase 2: Test recall quality
Run this test — does recall actually find useful stuff?
```bash
cd ~/Projects/AgentRecall && node -e "
const core = require('./packages/core/dist/index.js');
(async () => {
  const queries = ['decision trail', 'awareness quality gate', 'bootstrap scan', 'hook ambient content', 'severity passthrough'];
  for (const q of queries) {
    const r = await core.smartRecall({ query: q, project: 'AgentRecall', limit: 3 });
    const topResult = r?.results?.[0];
    console.log(q + ':', topResult ? topResult.title?.slice(0, 60) + ' [score:' + topResult.score?.toFixed(2) + ']' : 'NO RESULTS');
  }
})();
"
```
Rate: how many of 5 queries return relevant results?

### Phase 3: Check compounding mechanics
1. Read `packages/core/src/palace/awareness.ts` — the `detectCompoundInsights()` function. Has it ever produced compound insights? Check `~/.agent-recall/awareness-state.json` for `compoundInsights` array.
2. Read the feedback log at `~/.agent-recall/feedback-log.json` — are there any entries? Has anyone ever rated recall results?
3. Check `~/.agent-recall/projects/AgentRecall/palace/rooms/decisions/` — are there decision trail files from the new feature?

### Phase 4: Identify decay issues
1. Are any insights stale (old, never confirmed, low value)?
2. Is the trajectory field in awareness-state.json current?
3. Are there orphan rooms (rooms with no content but exist in palace)?

## Report format (under 400 words):
```
DATA QUALITY:
  Awareness insights: N total, N actionable, N noise
  Journal quality: [rich / thin / missing trajectory]
  Palace rooms: N rooms, N with useful content

RECALL QUALITY: N/5 queries returned relevant results
  [list each query + result]

COMPOUNDING:
  Compound insights generated: N
  Feedback entries: N
  Decision trail files: N

STALENESS:
  Stale insights: N
  Trajectory current: yes/no
  Orphan rooms: N

TOP 3 ISSUES FOR LONG-TERM USERS:
1. ...
2. ...
3. ...
```
