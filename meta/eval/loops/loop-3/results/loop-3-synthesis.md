# Loop 3 Synthesis — 2026-05-01

**Status:** COMPLETE — 23/24 PASS, 1 PARTIAL (cosmetic)
**Verifier verdict: READY TO SHIP v3.4.0**

---

## What was fixed in Loop 3

| Item | Change | Verified |
|------|--------|---------|
| A3-1 | `palace write` strips YAML frontmatter before storing — migration safe | PASS |
| A3-2 | Classifier: "never/always/remember this" → awareness (not knowledge) | PASS |
| B3-1 | Cold-start surfaces trajectory from last session_end | PASS |
| B3-2 | Awareness insights now carry `source_project` — traceable cross-project | PASS |
| C3-1 | Bootstrap `--source <dir>` flag — supports arbitrary migration source dirs | PASS |
| C3-2 | `check` tool description now exposes BOTH use cases (verification + decision trail) | PASS |

**Remaining partial:** Identity.md placeholder still shows for brand-new projects. Cosmetic — not a data or recall bug.

---

## Complete 3-loop scorecard

### Bugs fixed (were causing wrong behavior / data loss)

| Bug | Loop | Impact |
|-----|------|--------|
| CLI positional parser: `---` filtered + `--topic` appended to content | 1 | P0 — data corruption |
| `ar read --date latest` returns wrong file | 1 | P0 — broken verify-save |
| `ar rooms` shows 0 entries | 1 | P0 — misleading diagnostic |
| Salience inversion: empty rooms above content rooms | 1 | P1 — wrong cold-start context |
| Cold-start shows room names only (no entries) | 1 | P1 — agent can't resume |
| Cold-start missing P0 corrections | 1 | P1 — correction system doesn't warn |
| Search excludes palace with no notice | 1 | P1 — silent miss |
| `palace write` destroys YAML frontmatter content | 3 | P0 — migration data loss |

### UX improvements shipped (advisory, search, routing)

| Improvement | Loop | Impact |
|-------------|------|--------|
| "framework" finds tRPC/REST entries (synonym expansion) | 2 | P1 — search quality |
| `ar write` advisory: suggests architecture/blockers/awareness routing | 2 | P1 — agent guidance |
| CLI help: WRITE PATH GUIDE (4-line routing cheat sheet) | 2 | P1 — onboarding |
| Unknown room slug warns on stderr | 2 | P2 — typo prevention |
| Search without palace → stderr notice | 2 | P2 — transparency |
| Bootstrap strips YAML frontmatter from AutoMemory imports | 2 | P1 — migration quality |
| Bootstrap routes by `type:` field (feedback→alignment, project→goals) | 2 | P1 — migration quality |
| Bootstrap populates identity.md from README/package.json | 2 | P2 — cold-start orientation |
| `remember` MCP description now explains routing rules | 2 | P1 — new agent guidance |
| Trajectory surfaced in cold-start from last session_end | 3 | P2 — resume quality |
| Awareness insights carry source_project | 3 | P2 — traceability |
| Bootstrap `--source <dir>` for arbitrary migration paths | 3 | P2 — migration flexibility |
| `check` tool: both use cases documented (verify + decision trail) | 3 | P2 — feature discovery |
| Awareness classifier: behavioral rules → awareness (not knowledge) | 3 | P2 — routing accuracy |

---

## Delta from baseline eval (concrete improvements)

| Baseline failure | After 3 loops |
|-----------------|---------------|
| "Blockers room silently excluded from cold-start" | Blockers room appears with content in cold-start |
| "4 search commands with different scopes, no guidance" | CLI has WRITE PATH GUIDE + search warns about palace |
| "YAML frontmatter causes silent data loss" | Stripped automatically in palace write + bootstrap |
| "`ar read --date latest` returns stale data" | Returns newest file by mtime |
| "Corrections not injected into cold-start" | p0_corrections field in every cold-start |
| "`ar rooms` shows 0 entries" | Shows actual entry count |
| "'framework' returns 0 for tRPC room" | Returns tRPC entry via synonym expansion |
| "Migration path not safe for real users" | Frontmatter stripped, type-routed, identity populated |
| "`remember` vs `palace write` vs `capture` undocumented" | MCP description + CLI routing guide added |
| "check tool Bayesian trail invisible" | Description now exposes both use cases |

---

## What still needs a future loop (if needed)

- Identity.md placeholder on brand-new projects (cosmetic — agent sees "fill in" template)
- `palace search` is still keyword-only for unconnected synonyms — full vector search requires Supabase pgvector (separate feature gate)
- `ar write` advisory is read-only guidance — true auto-routing (actually sending to palace) would require LLM classification

---

## Build status

All 4 packages built cleanly at v3.4.0 after every loop:
- Loop 1: 0 TypeScript errors
- Loop 2: 0 TypeScript errors  
- Loop 3: 0 TypeScript errors

Local binary: `node ~/Projects/AgentRecall/packages/cli/dist/index.js`
