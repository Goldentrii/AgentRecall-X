# AgentRecall Session Report — 2026-04-24 to 2026-04-26

> Orchestrator: Opus 4.6 | Sub-agents: Sonnet 4.6 | Duration: ~2 days

---

## Executive Summary

This session transformed AgentRecall from a functional but rough v3.3.23 into a polished, documented, and feature-complete v3.3.28. Over 8 orchestrator loops and ~50 sub-agents, we shipped 3 new features, fixed 19 bugs, closed 10 documentation gaps, and ran a 5-perspective quality review that found and resolved all P0/P1 issues.

**Version progression:** npm 3.3.23 → 3.3.26 → 3.3.27 → 3.3.28

---

## What Shipped

### New Features (3)

| Feature | What it does | Files | Impact |
|---------|-------------|-------|--------|
| **Decision Trail** | `check` tool tracks prior → evidence → posterior → outcome. Palace persistence in `decisions/` room. Calibration warnings in `watch_for` after 3+ decisions. | check.ts, alignment-patterns.ts, session-start.ts, types.ts, mcp check.ts | Bayesian-inspired metacognition — agents learn whether their confidence is calibrated |
| **Bootstrap** | `bootstrapScan()` discovers git repos + Claude memory + CLAUDE.md across the machine. `bootstrapImport()` selectively imports into AR. CLI + MCP + slash command. | bootstrap.ts (720 lines), cli index.ts, mcp bootstrap.ts, mcp index.ts, /arbootstrap command | Solves cold-start problem — new users see populated /arstatus instead of empty board |
| **Compound Lesson Rule** | Every reviewer agent must output exactly 3 reusable lessons. Lessons feed into `session_end(insights: [...])`. | ORCHESTRATOR-PROTOCOL.md | Every loop makes the next loop smarter. Reviews without lessons are wasted learning. |

### Bug Fixes (19)

| # | Bug | Root Cause | Fix |
|---|-----|-----------|-----|
| 1 | `listAllProjects()` missing smart-named journals | Regex only matched `YYYY-MM-DD.md`, not `YYYY-MM-DD--arsave--NL--slug.md` | `isJournalFile()` helper with prefix match |
| 2 | Project singleton cache returning stale slug | Module-level `_cachedProject` never cleared | Removed cache entirely |
| 3 | Room topics showing noise keywords ("2026", "agentrecall") | Extracted from raw file content | Use `meta.description` instead |
| 4 | Awareness truncated mid-section | Cut at line 200 regardless of section boundaries | Walk back up to 20 lines to find `##` boundary |
| 5 | `ar saveall --dry-run` wrote data | `saved.push(proj)` inside dry-run branch | Removed push, added `(dry run)` footer |
| 6 | Recall dominated by false-positive architecture entry | No IDF weighting, tag bonus too high | Added IDF normalization (0.70 × IDF + 0.30 × raw), reduced tag bonus 0.30→0.10 |
| 7 | `ar recall` CLI command missing | No case statement for "recall" | Added as alias above "insight" |
| 8 | `ar insight --project` not scoping | Delegated to unscoped function | Added project-scoped `smartRecall` delegation |
| 9 | `core.remember` undefined | Export name was `smartRemember` | Added `export { smartRemember as remember }` alias |
| 10 | Test fixture pollution in awareness | "Test insight 0" with 20× confirmations | Cleaned data + added quality gate |
| 11 | `severity` hardcoded "important" in session_start | `Insight` interface lacked `severity` field; cast always returned undefined | Added `severity?` to Insight interface, stored on write |
| 12 | `from_project` showing entry-type strings | `addIndexedInsight` merge branch didn't merge `projects[]` | Added project merging + date-suffix fallback stripping |
| 13 | Resurrect path could create duplicate insights | No dedup check before `topInsights.push` | Added `topInsights.some(i => i.id === resurrected.id)` guard |
| 14 | Resurrect path exceeded 15-item cap | No demote-lowest after push | Added cap enforcement after resurrection |
| 15 | Double confirmation bump on resurrect | Both `resurrectFromArchive` and `addInsight` incremented | Removed the addInsight increment |
| 16 | `decision_id` returned when no trail was written | Generated on every check call | Moved inside `if (outcome)` block |
| 17 | `recallInsights()` called without project slug | 3rd arg omitted in session-start.ts | Passed `slug` — enables 20%/10% project correlation boost |
| 18 | `empty_state` never fired | Condition used global signals instead of project-scoped | Changed to project-scoped: no resume + no journals + no corrections |
| 19 | Corrupt palace-index.json never repaired | `existsSync=true` skipped regeneration | Added JSON parse check; delete + regenerate on corrupt |

### Quality Improvements (7)

| Improvement | What changed |
|-------------|-------------|
| Awareness quality gate | Rejects titles < 3 words, test fixture patterns, missing/short evidence |
| `resurrectFromArchive` wired | Archived insights come back to life instead of creating duplicates |
| `isRoomStale` dedup | Staleness logic in 1 place (rooms.ts), not 3 |
| Hook-ambient inline content | Pushes actual excerpt, not just `[palace] title` pointers |
| Trajectory scoped to project | `session_end` prefixes trajectory with project slug |
| `project_status` in --list-tools | Was registered but invisible to Codex agents |
| Palace definition in SKILL.md | First-time agents now know what "palace", "salience", "rooms" mean |

### Documentation Updates

| Doc | Changes |
|-----|---------|
| **SKILL.md** | v3.3.28, 10 tools (was 6), bootstrap_scan/import documented, session_start fields complete (resume, corrections, severity), session_end quality_warnings field, check decision trail fields, palace definition, store breakdown, best practices #9 + #10 |
| **AGENTS.md** | 10 tools (was 6), 4 new trigger phrases, MCP→CLI table for all 10 tools |
| **ORCHESTRATOR-PROTOCOL.md** | Compound lesson rule, decision trail spec, handoff checklist updated |
| **UPDATE-LOG.md** | v3.3.26 and v3.3.27 entries added |

---

## Orchestrator Loop Summary

| Loop | Theme | Agents | Key Result |
|------|-------|--------|------------|
| 1 | Bug discovery | 5 test agents | Found 8 bugs across all packages |
| 2 | Core fixes | 5 fix agents | isJournalFile, no cache, room topics, awareness truncation |
| 3 | Search quality + CLI | 5 fix agents | IDF weighting, recall alias, dry-run fix, project scoping |
| 4 | Deep audit | 5 test agents | Test pollution, source attribution, AGENTS.md gaps, awareness quality |
| 5 | Final verification + cleanup | 5 agents | Cleaned awareness, verified 6/6 fixes, fixed attribution, 7.8/10 score |
| 6 | Ambient + quality gate + dedup | 3 impl + 1 reviewer | Hook-ambient inline, awareness write guard, resurrectFromArchive, isRoomStale |
| 7 | Decision trail | 4 impl + 1 reviewer | check tool enhancement, decisions room, calibration warnings |
| 8a | Bootstrap core | 3 competing + 1 reviewer | Gamma won (layered scan + selective import), 720 lines |
| 8b | Bootstrap wiring | 3 impl + 1 reviewer | CLI + MCP + SKILL.md, /arbootstrap command |
| 9 | 5-perspective review | 5 reviewers + 4 cross-reviewers | Found 14 issues, fixed 7 P0/P1 across 2 fix loops |

**Total sub-agents spawned: ~50**
**Total test cases run: 26+ (all passing)**

---

## Metrics

| Metric | Before (v3.3.23) | After (v3.3.28) |
|--------|-------------------|------------------|
| MCP tools registered | 8 | 10 |
| MCP tools documented | 6 | 10 |
| AGENTS.md tools listed | 6 | 10 |
| --list-tools output | 7 | 10 |
| Bugs found + fixed | 0 | 19 |
| Quality improvements | 0 | 7 |
| Awareness quality gate | None | 3-word min, test fixture rejection, evidence required |
| Decision trail | Not exists | Full prior/posterior/evidence/outcome + calibration |
| Bootstrap | Not exists | Scan 28 projects in 141ms + selective import |
| empty_state guidance | Not exists | Fires for new projects with bootstrap suggestion |
| palace-index corruption | Silent failure | Auto-detected and regenerated |
| Trajectory scoping | Global (any project overwrites) | Project-prefixed |
| Cross-project boost | Disabled (slug not passed) | Enabled (20%/10% correlation) |

---

## What's Still Open

### Structural (no code fix — needs design work)

| Issue | Why it's structural |
|-------|-------------------|
| Recall scores 0.02-0.06 (near-zero) | Keyword-only ceiling. Needs semantic/vector layer (v3.4) |
| Feedback loop one-sided (all positive) | Agents never send negative feedback. UX/prompt issue, not code |
| insights-index projects[] empty for legacy entries | 142/143 entries have no projects[]. Needs backfill migration |

### P2 (tracked, low urgency)

| Issue | Risk | Notes |
|-------|------|-------|
| journalWrite not atomic | Concurrent session_end can corrupt | Low probability in single-agent usage |
| writeAwarenessArchive not atomic | Same | Same |
| No PII filtering in remember | Credentials stored in plaintext | Design decision — advisory warning possible |
| Decisions room not created for existing projects | Created on next `check` with outcome | Self-healing |

---

## Agent Prompts Archive

All sub-agent prompts saved at `/Users/tongwu/Projects/AgentRecall/agent-prompts/`:

```
agent-prompts/
  bootstrap-agent-alpha.md        — scan-only design (competing)
  bootstrap-agent-beta.md         — auto-import design (competing)
  bootstrap-agent-gamma.md        — layered design (selected + built)
  bootstrap-cli-agent.md          — CLI wiring
  bootstrap-mcp-agent.md          — MCP tools wiring
  bootstrap-skill-agent.md        — SKILL.md documentation
  fix-1-agents-md.md              — AGENTS.md 6→10 tools
  fix-2-list-tools.md             — --list-tools add project_status
  fix-3-session-start.md          — recallInsights slug + empty_state
  fix-4-palace-definition.md      — SKILL.md palace definition
  review-round-perspectives.md    — 5-perspective review overview
  reviewer-1-first-time-agent.md  — first-time agent experience
  reviewer-2-power-user.md        — power user compounding check
  reviewer-3-multi-project.md     — multi-project orchestrator
  reviewer-4-non-claude-code.md   — non-Claude-Code compatibility
  reviewer-5-adversarial.md       — adversarial data integrity
```

---

## Orchestrator Protocol

This session validated and improved the multi-agent work pattern documented in `ORCHESTRATOR-PROTOCOL.md`:

- **Model routing**: Opus orchestrator + Sonnet sub-agents (confirmed effective)
- **Conflict matrix**: Zero file collisions across 50+ agent dispatches
- **Compound lesson rule**: Added — every reviewer outputs 3 reusable lessons
- **Cross-review pattern**: Fix agents → cross-reviewer agents → fix corrections (validated this loop)
- **Prompt archival**: All prompts saved locally for retrieval and reuse

The protocol file is at `/Users/tongwu/Projects/AgentRecall/ORCHESTRATOR-PROTOCOL.md` and a copy at `~/Downloads/ORCHESTRATOR-PROTOCOL.md`.

---

## Next Session Recommendations

1. **Collect real-world data** — Use AR on 2-3 real projects for 1 week before adding features
2. **Semantic recall layer** (v3.4) — The keyword-only ceiling is the biggest quality blocker
3. **Phase 2.5 intelligent file naming** — Journal naming system is designed but not built
4. **npm publish v3.3.29** — When ready, bump and publish (all code is on main, build passes)

---

*Generated 2026-04-26 by Opus 4.6 orchestrator after 8 loops, ~50 sub-agents.*
