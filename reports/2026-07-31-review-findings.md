# Continuity Wave — Consolidated Review Findings (R1/R2/R3, all PASS-WITH-FIXES)

Worktree: /tmp/ar-wave/integration @ wave/integration (6c9d886). Every finding below was empirically reproduced by the reviewer unless marked code-reading. Fix order: H1→H4 first, then M5→M9, then L-batch.

## HIGH — must fix before merge

### H1. Archive fallback is a no-op for default MCP calling convention (`project:"auto"`)
`smart-recall.ts:970,994` — `archiveSearch(input.project ?? "auto", ...)` and Bridge `fetchVerbatim(input.project ?? "auto", ...)` pass the literal through without `resolveProject()`, unlike journalSearch/palaceSearch. MCP `recall`/`smart_recall` default `project:"auto"` → scans nonexistent `projects/auto/`, returns 0, and `sources_queried` still lists "archive" (misleading).
**Fix:** resolve `input.project` via `resolveProject()` once near the top of `smartRecall()`; reuse the resolved slug for archive gate AND Bridge fetchVerbatim. Red test first: recall with project omitted/"auto" against a store where only raw content matches → must surface the archive hit.

### H2. recency-index roll races concurrent appends → silent permanent entry loss
`recency-index.ts:66-93` — once file >500 lines, EVERY append triggers read→writeFileSync(tmp)→renameSync (inode swap verified per-append). A second process's `appendFileSync` straddling the rename lands on the unlinked inode: write succeeds, data vanishes. `.hook-end-lock` only dedups same-session retries, does not serialize different sessions.
**Fix (throttle + slack):** roll only when lines > MAX_LINES + SLACK (SLACK=50), trim to MAX_LINES — shrinks the race window ~50×; ALSO wrap the roll in a best-effort exclusive lockfile (`recent-sessions.lock`, O_EXCL create, stale after 5s) mirroring the existing lock convention. Red test: seed 505 lines, append 1 → file must NOT be rewritten (inode stable); seed 551 → roll happens.

### H3. Small CJK sessions duplicated in the "lossless" raw archive
`transcript-reader.ts:418` — `if (stat.size <= archiveHead.length)` compares BYTES to UTF-16 code units. Any file ≤20,000 bytes containing CJK falls to the else branch → `combined = fullFile + "\n…\n" + fullFile` (verified: 15,162-byte fixture → exactly 2× duplication).
**Fix:** compare byte counts (`Buffer.byteLength(archiveHead, "utf8")` or have readHeadTail report headLen===size). Red test: CJK file of ~15KB → rawTail contains content exactly once.

### H4. Unbounded slugCandidates truncates card mid-frontmatter (invalid YAML, body lost)
`session-card.ts:308,343` — candidates array unbounded (every other field has a _CAP); `truncateBytes` cuts whole markdown at 2000 bytes → 200 candidates yield a card with no closing `---`, no title/artifacts/next-steps (verified).
**Fix:** cap `slugCandidates` to top 5 by count BEFORE frontmatter serialization; additionally, build frontmatter first and only byte-truncate the BODY (frontmatter must always survive intact). Red test: 200 synthetic candidates → card has valid closed frontmatter + body sections present.

## MEDIUM — fix in this round

### M5. `limit` contract violated when archive source fires
`smart-recall.ts:993-995` — archive items appended after `slice(0, limit)` without consulting limit (limit:1 returned 3). **Fix:** append at most `Math.max(0, limit - finalResults.length)`; if that's 0 but archive had hits, note it in meta instead. Red test: limit:1 + 5 raw matches → exactly 1 result.

### M6. resurrect card source reads every card ever written (no window pre-filter)
`resurrect.ts` Source-3 loop (~:480-500) — readFileSync's ALL `*--card--*.md` across all projects, filters by ts after. **Fix:** pre-filter on filename date vs cutoff with ±1 day padding, mirroring the raw-archive loop. Red test: out-of-window card file → never opened (spy/count or filename trap).

### M7. CJK-blind char budgets for continuity fields
`session-start.ts:93-123` continuity caps are char-based with a chars/4 token model; CJK ≈1-2 tok/char → real budget blown ~4-8× while "looking" fine. **Fix:** byte-based caps for `continuity_title`/`continuity_next_step` using the UTF-8-safe truncation helper from M8 (title ≤120 bytes, next_step ≤160 bytes). Add a CJK-title test.

### M8. UTF-8 boundary corruption (U+FFFD) at hard byte cuts
`transcript-reader.ts` readHeadTail offsets + `session-card.ts:161-165` truncateBytes — mid-character cuts produce U+FFFD (repro'd). **Fix:** one shared UTF-8-safe truncation/backoff helper (back off to last complete character; continuation bytes 0b10xxxxxx), used by truncateBytes and applied to the decoded boundaries in readHeadTail's head/tail sampling. Red test: cut inside a 3-byte char → no U+FFFD in output.

### M9. extractLinearRefs scans full message JSON incl. tool_results → cross-project ID leak vector
`session-card.ts:238-256` — `JSON.stringify(rec.message)` includes wrapped MCP tool_result blobs (recall/search/Linear list output), so unrelated projects' ticket IDs can enter this session's card. Same failure CLASS as the incident's boilerplate contamination, different channel. **Fix:** extract only text-type content blocks authored in user/assistant turns; exclude tool_result/tool_use content blocks. Red test: synthetic transcript with a tool_result containing "ZZZ9-123" → not in linearRefs; same string in assistant prose → captured.

## LOW — batch if cheap, else document as follow-ups in your report
- L1 (R2): ⏪ Continuity placement differs CLI (after `Project:` line) vs MCP terse (before header) — align CLI to before-header.
- L2 (R2): CLI continuity re-slice uses bare `.slice()` — use the shared word-boundary `trunc()` style with ellipsis.
- L3 (R3, document only): archive gate keys off rank-0 `calibrated` (post-feedback ordering tension) — add a code comment referencing Risk #8; no behavior change this wave.
- L4 (R3, follow-up only, DO NOT fix now): `cli/index.ts:~1239` hardcoded homedir — same class as F5's sync.ts fix; record as follow-up item.
- L5 (R1, skip): mid-message boilerplate filter — theoretical, fixture shows attachment-vector already covered.

## Regression guard
After all fixes: full harness (`npm run lint && npm run build && npm test`) green (known pre-existing: awareness.test.mjs env flake, 2 TODO pins). No API/signature breaks to the modules' public exports without noting them.
