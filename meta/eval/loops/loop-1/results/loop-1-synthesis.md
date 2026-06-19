# Loop 1 Synthesis — 2026-05-01

**Status:** COMPLETE — all 7 bugs fixed, all 9 verifier tests PASS

---

## What was fixed

| Bug | Fix | Verifier |
|-----|-----|---------|
| B1a | CLI positional parser: `---` no longer filtered as flag | PASS |
| B1b | CLI positional parser: `--topic` value no longer appended to content | PASS |
| B2  | `ar read --date latest` → mtime-based selection, returns newest file | PASS |
| B3  | `ar rooms` counts README entries (not just topic files) | PASS |
| B4  | Salience: new rooms start at 0.0; writes bump salience via `recordAccess` | PASS |
| B5  | Cold-start: `top_rooms` now includes `recent_entries` (last 3 per room) | PASS |
| B6  | Cold-start: `p0_corrections` injected from corrections store | PASS |
| B7  | `ar search`: adds `palace_searched` field + `_note` when palace excluded | PASS |

**Reviewer caught one re-fix:** B1's `if (arg.startsWith("--"))` still dropped `---`. Changed to `/^--[a-z]/.test(arg)`.

---

## Remaining issues from baseline eval (not addressed in Loop 1)

These are now Loop 2 candidates, organized by goal:

### Goal 2: Structure and naming system

| Issue | Source | Priority |
|-------|--------|---------|
| `remember` vs `palace write` vs `capture` — zero documentation of when to use which | Cold agent | P1 |
| `check` tool's Bayesian decision trail completely invisible from its description | Cold agent | P1 |
| `digest` tool name non-intuitive — "context cache" is clearer | Cold agent | P2 |
| `palace walk --depth` options (`identity\|active\|relevant\|full`) undefined in help output | Cold agent | P2 |
| `palace write` silently creates any typo room slug — no validation | Cold agent | P2 |
| `project_status` vs `session_start` distinction unclear from names | Cold agent | P2 |

### Goal 3: Agent search + vector recall quality

| Issue | Source | Priority |
|-------|--------|---------|
| `palace search` is keyword-exact — "framework" returns 0 for tRPC/REST room | Mid + Migration | P1 |
| `ar write` has no auto-routing — all content goes to journal | Mid agent | P1 |
| Project trajectory never auto-generated after sessions | Mid agent | P2 |
| Awareness entry `source` field blank — can't trace which project produced an insight | Mid agent | P2 |

### Structural gaps

| Issue | Source | Priority |
|-------|--------|---------|
| Bootstrap ignores arbitrary source directories (no `--source` flag) | Migration agent | P2 |
| User profile YAML frontmatter bleeds into awareness evidence | Migration agent | P2 |
| Identity.md never populated from AutoMemory/README content during bootstrap | Migration agent | P2 |
| AutoMemory `type:` field ignored during bootstrap import (all → knowledge room) | Migration agent | P3 |

---

## Loop 2 Plan

### Focus: Naming + docs + semantic search quality

**Worker A2**: MCP tool descriptions + CLI help text
- `remember`: add "Use for general notes. For structured decisions use palace write. For Q&A use capture."
- `check`: rewrite description to expose decision trail capability
- `digest`: add "context cache" alias to description, explain store/recall/read/invalidate
- `palace walk --depth`: document all 4 options in help text
- `palace write`: add `--force-create` flag for new rooms; default: validate against known slugs

**Worker B2**: Auto-routing in `ar write`
- When content looks like a decision (contains "chose", "decided", "will use"), suggest palace write
- When content looks like a blocker (contains "blocked", "missing", "broken"), suggest palace blockers
- Output: `{ ...existing, suggested_palace_room: "architecture" | "blockers" | null }`
- This is advisory only — still writes to journal, but guides the agent

**Worker C2**: Semantic search quality
- Test Supabase pgvector path end-to-end
- If Supabase not configured: ensure `palace search` falls back to TF-IDF style matching (at minimum: strip stop words, stem keywords)
- Add `--fuzzy` flag to `palace search` for substring matching

**Worker D2**: Bootstrap improvements
- Add `--source <dir>` flag to `bootstrap_scan` for arbitrary source directories
- Strip YAML frontmatter from content before writing to palace
- Route by `type:` field in source files: `type: feedback` → alignment, `type: project` → goals

**Verifier 2**: Run migration scenario end-to-end + semantic recall tests

---

## Build artifact

All 4 packages rebuilt successfully at v3.4.0. Local binary:
```
node ~/Projects/AgentRecall/packages/cli/dist/index.js
```
