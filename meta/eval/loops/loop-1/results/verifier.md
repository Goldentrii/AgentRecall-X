# Loop 1 Verifier Results

Tested: 2026-05-01
CLI: `node ~/Projects/AgentRecall/packages/cli/dist/index.js`
Cold env: `/tmp/ar-eval-loop1-cold`
Mid env: `/tmp/ar-eval-loop1-mid`

| Bug | Test | Status | Evidence |
|-----|------|--------|---------|
| B1a | --- in content preserved | PASS | Read back shows `---\nname: test-project\ntype: project\n---\nThis is the actual content after frontmatter` in Memories section |
| B1b | --topic value not in content | PASS | README body has no "quarterly-goal"; topic file content is `My actual goal` only |
| B2  | latest returns newest file | PASS | `read --date latest` returns `"Second entry — newest content"` (not first) |
| B3  | rooms shows correct count | PASS | `rooms` output: `Architecture (2 entries, salience 0.39)` |
| B4  | salience ranks content rooms higher | PASS | `walk` top_rooms: architecture first at 0.385; all empty rooms at 0.000 |
| B5  | cold-start shows room entries | PASS | cold-start `recent_entries` contains `"Missing .env.local — cannot run dev server"` |
| B6  | cold-start shows P0 corrections | PASS | cold-start `p0_corrections` contains `"Never deploy on Fridays — rollback is impossible over weekend"` |
| B7a | search without palace has _note | PASS | `{"palace_searched": false, "_note": "Palace rooms were not searched. Add --include-palace (CLI) or include_palace: true (MCP recall) to search palace content."}` |
| B7b | search with palace has palace_searched:true | PASS | `{"palace_searched": true}` with results from architecture room |

**All 9 test cases: PASS**

## Evidence excerpts

### B1a — --- preserved
```json
"content": "...## Memories\n\n### 2026-05-01 — medium\n\n---\nname: test-project\ntype: project\n---\nThis is the actual content after frontmatter\n..."
```

### B1b — --topic value not in README body
README body: `_(entries will appear below as the agent writes to this room)_` — no "quarterly-goal" present.
Topic file content: `My actual goal` — clean, no flag leakage.

### B2 — latest returns newest
```json
{"content": "...Second entry — newest content\n", "date": "2026-05-01", "project": "b2test"}
```
Two files existed: `2026-05-01.md` (first) and `2026-05-01-639c98.md` (second). Latest correctly returned the second.

### B3 — correct entry count
```
Architecture (2 entries, salience 0.39)
```

### B4 — salience ranking correct
```json
"top_rooms": ["architecture", "alignment", "blockers", "decisions", "goals"]
"Architecture" salience: 0.385
"Alignment" salience: 0, "Blockers" salience: 0, "Decisions" salience: 0
```

### B5 — cold-start surfaces room content
```json
"recent_entries": ["### 2026-05-01 — medium\n\nMissing .env.local — cannot run dev server\n\n_(entries will appear below...)"]
```

### B6 — P0 corrections injected
```json
"p0_corrections": [{"rule": "Never deploy on Fridays — rollback is impossible over weekend", "context": "Never deploy on Fridays — rollback is impossible over weekend"}]
```

### B7a — palace_searched: false + _note
```json
{"results": [], "palace_searched": false, "_note": "Palace rooms were not searched. Add --include-palace (CLI) or include_palace: true (MCP recall) to search palace content."}
```

### B7b — palace_searched: true
```json
{"results": [...], "palace_searched": true}
```

## New issues discovered

None. No regressions or unexpected behavior observed during testing.

## Loop 2 candidates

No outstanding issues from the baseline eval were observed during this run. All 7 bugs (B1-B7) across 9 test cases confirmed fixed. No issues require Loop 2 from this set.
