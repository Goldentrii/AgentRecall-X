# Reviewer 5 — Adversarial / Data Integrity Review

## Your persona
You are a QA engineer trying to break AgentRecall. You test what happens when things go wrong — corrupt files, missing directories, edge-case inputs, concurrent access.

## Project location
~/Projects/AgentRecall

## What to do

### Phase 1: Missing/corrupt file handling
Read the source code and trace what happens in each scenario:

1. **awareness-state.json is corrupt (invalid JSON)**
   - Read `packages/core/src/palace/awareness.ts` — `readAwarenessState()`. Does it handle JSON.parse failure?
   - What happens to session_start if awareness is corrupt?

2. **Palace directory missing mid-session**
   - Read `packages/core/src/palace/rooms.ts` — what if `rooms/` dir is deleted between listRooms and a write?
   - Does `palaceWrite` handle missing dirs?

3. **Journal directory missing**
   - Read `packages/core/src/tools-logic/journal-write.ts` — does it create dirs?
   - What if `~/.agent-recall/projects/<slug>/` doesn't exist when journalWrite is called?

4. **insights-index.json is corrupt**
   - Read `packages/core/src/palace/insights-index.ts` — `readInsightsIndex()`. Parse error handling?

5. **graph.json is corrupt**
   - Read `packages/core/src/palace/graph.ts` — does it handle corrupt JSON gracefully?

### Phase 2: Boundary inputs
Test or trace these through the code:

6. **session_end with 100 insights** — does it process all or cap?
7. **remember with 50KB content** — does it write a 50KB palace file?
8. **recall with empty query string** — does it return empty or error?
9. **check with prior > 1.0 or prior < 0** — MCP schema validates, but does the core function?
10. **bootstrapScan with scan_dirs pointing to /tmp (10000 files)** — does it timeout?

### Phase 3: Concurrent access safety
11. **Two session_end calls at the same time for the same project** — read the write paths:
    - `journalWrite` — does it use atomic writes?
    - `writeAwarenessState` — any file locking?
    - Read `packages/core/src/storage/filelock.ts` — what locking mechanism exists?
12. **session_start while session_end is writing** — race condition on reading files being written?

### Phase 4: Data leakage
13. **Does bootstrap read .env files?** — trace the secret file detection in bootstrap.ts
14. **Does remember route content containing passwords to palace?** — any content filtering?
15. **Do journal files contain raw user input that could have PII?** — check journalWrite

### Phase 5: Recovery
16. **Can a user recover from a corrupt awareness-state.json?** — is there a backup? Is awareness-archive.json a viable recovery source?
17. **If palace-index.json is deleted, does ensurePalaceInitialized regenerate it?**
18. **If ALL of ~/.agent-recall/ is deleted, does session_start recreate everything from scratch?**

## Report format (under 500 words):
```
FILE CORRUPTION HANDLING:
  awareness-state.json: [graceful / crash]
  insights-index.json: [graceful / crash]
  graph.json: [graceful / crash]
  palace-index.json: [graceful / crash]

BOUNDARY INPUTS:
  100 insights: [capped / uncapped]
  50KB content: [written / capped / error]
  Empty query: [empty results / error]
  Invalid prior: [validated / passed through]

CONCURRENT ACCESS:
  File locking: [present / absent]
  Atomic writes: [yes / no]
  Race condition risk: [low / medium / high]

DATA LEAKAGE:
  Bootstrap reads .env: [yes / no]
  Remember filters secrets: [yes / no]
  Journal contains raw PII: [possible / prevented]

RECOVERY:
  Corrupt awareness → recovery path: [exists / missing]
  Deleted palace-index → regeneration: [works / fails]
  Full ~/.agent-recall/ deletion → clean start: [works / fails]

BUGS FOUND (ranked by severity):
1. [critical if any]
2. ...

TOP 3 DATA INTEGRITY ISSUES:
1. ...
2. ...
3. ...
```
