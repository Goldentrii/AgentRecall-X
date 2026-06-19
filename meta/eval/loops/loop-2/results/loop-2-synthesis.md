# Loop 2 Synthesis — 2026-05-01

**Status:** COMPLETE — 7 PASS, 2 PARTIAL (both by design)

---

## What was improved

| Item | Change | Verified |
|------|--------|---------|
| A2-1 | Synonyms: "framework" now finds tRPC/REST/Express/gRPC entries | PASS |
| A2-2 | `remember` MCP description now explains routing + context hints | PASS (MCP) |
| B2-1 | `ar write` advisory: decision language → suggests architecture room | PASS |
| B2-2 | `ar write` advisory: blocker language → suggests blockers room | PASS |
| B2-3 | Neutral content → `routing_hint: null` (no false positive) | PASS |
| C2 | Bootstrap strips YAML frontmatter before importing AutoMemory files | PASS |
| C2 | Bootstrap routes by `type:` field (feedback→alignment, project→goals, user→awareness) | PASS |
| C2 | Bootstrap populates identity.md from README/package.json description | PASS |
| D2-1 | CLI help now has WRITE PATH GUIDE (4-line routing cheat sheet) | PASS |
| D2-2 | Unknown palace room slug → stderr warning (write still proceeds) | PASS |
| D2-3 | `ar search` without `--include-palace` → stderr "[ar] Palace rooms were not searched" | PASS |

**Partials (expected, not bugs):**
- C2-1: `palace write` direct path does NOT strip frontmatter — the fix lives in bootstrap.ts. Direct writes store verbatim. Mitigation: Loop 3 will extend stripping to palace_write core.
- A2-2: CLI `--help` can't surface MCP `remember.ts` description — acceptable, two surfaces serve two audiences.

**Reviewer-caught issue (advisory, not blocking):**
- B2 classifier: `"remember"` and `"never"/"always"` words trigger knowledge room suggestion — should be awareness, not knowledge. Fix in Loop 3.

---

## Cumulative bug/improvement scorecard

| ID | Issue | Status |
|----|-------|--------|
| B1 | CLI positional arg parser (`---` + `--topic` leak) | FIXED (Loop 1) |
| B2 | `ar read --date latest` wrong file | FIXED (Loop 1) |
| B3 | `ar rooms` shows 0 entries | FIXED (Loop 1) |
| B4 | Salience inversion (empty rooms above content) | FIXED (Loop 1) |
| B5 | Cold-start shows no room content | FIXED (Loop 1) |
| B6 | Cold-start doesn't inject P0 corrections | FIXED (Loop 1) |
| B7 | Search excludes palace with no notice | FIXED (Loop 1) |
| A2 | "framework" search misses tRPC/REST entries | FIXED (Loop 2) |
| B2x | `ar write` has no routing guidance | IMPROVED (Loop 2 — advisory) |
| C2 | Bootstrap destroys YAML frontmatter content | FIXED (Loop 2) |
| C2b | Bootstrap ignores `type:` field, routes everything to knowledge | FIXED (Loop 2) |
| C2c | Identity.md never populated | FIXED (Loop 2) |
| D2 | CLI help doesn't explain write paths | FIXED (Loop 2) |
| D2b | Typo room slugs created silently | FIXED (Loop 2 — warning) |

---

## Loop 3 Plan

### Remaining issues (from baseline + reviewer notes)

**P1 — Still open:**
1. `palace write` direct path doesn't strip YAML frontmatter (C2-1 partial) — affects any direct migration
2. `routing_hint` classifier: "remember/never/always" → knowledge instead of awareness (reviewer B2 finding)
3. Trajectory never auto-generated — `session_end` trajectory not surfaced in cold-start output
4. Awareness entry `source` field blank — can't trace which project produced which insight

**P2 — Still open:**
5. Bootstrap `--source <dir>` flag for arbitrary migration source directories
6. `check` tool dual-purpose description — Bayesian trail still invisible for new users
7. Full end-to-end re-evaluation: run all 3 original agent scenarios after Loop 1+2 fixes and measure improvement in evaluation quality scores

### Loop 3 assignments

**Worker A3**: Extend frontmatter stripping to `palace write` core + fix classifier false positives
- File: `packages/core/src/tools-logic/palace-write.ts` — strip frontmatter from content before writing
- File: `packages/core/src/tools-logic/journal-write.ts` — fix classifier (awareness signals > knowledge)

**Worker B3**: Trajectory surfacing + awareness source attribution
- File: `packages/core/src/tools-logic/journal-cold-start.ts` — include trajectory from last session_end
- File: `packages/core/src/palace/awareness.ts` — add source project to insight records

**Worker C3**: Bootstrap `--source` flag + `check` tool description improvement
- File: `packages/core/src/tools-logic/bootstrap.ts` — add `--source` parameter to scan
- File: `packages/mcp-server/src/tools/check.ts` — split description into two clear use cases

**Verifier 3**: Full cold/mid/migration re-eval against fixed system — compare scores to baseline
