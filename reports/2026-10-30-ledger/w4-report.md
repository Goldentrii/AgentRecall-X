# W4 report — MCP trace tool, lifecycle line, arsave fallback + verify card

Branch ledger/w4 (from feat/ledger @ f4cf0d8). Commit e8f12e4.

## FILES (git show --stat HEAD)
```
 commands/arsave.md                                 |  25 ++++
 experimental/harness-kit/commands/arsave.md        |  25 ++++
 packages/core/test/ledger-commands.test.mjs        |  37 +++++
 packages/mcp-server/src/index.ts                   |   6 +-
 packages/mcp-server/src/lib/lifecycle-line.ts      |  21 +++
 packages/mcp-server/src/tools/session-start.ts     |  13 +-
 packages/mcp-server/src/tools/trace.ts             |  34 +++++
 .../mcp-server/test/ledger-trace-tool.test.mjs     | 163 +++++++++++++++++++++
 8 files changed, 319 insertions(+), 5 deletions(-)
```
index.ts: `setLedgerContext({ via: "mcp", actor: "agent" })` before the first register call; `registerTrace(server)` after `registerRecall(server)`.
session_start: full and lite handlers `await flushLedgerQueue()` then append `lifecycleLine(slug)`. In lite mode the line is passed into `formatLite(lite, lifecycle)` and sits before the fixed hint (the p1-fence-boundary test requires the hint to stay last).

## TOOL
Input schema: `project: string(max 128, optional)`, `since: string regex /^(\d{4}-\d{2}-\d{2}(T[0-9:.]+Z?)?|\d+[dh])$/ (optional)`, `limit: int 1..500 (optional, default 50)`. Project goes through `resolveProject(project ?? "auto", { register: false })`. Second content block is JSON `{project, events}` (second text block; structuredContent not used — no outputSchema registered).
Sample (tool call after one `remember`, first 4 lines, the last event line, summary):
```
2026-10-30T14:19:53.880Z project.create mcp - 01M66JWWMRR40G48Y14VTGM09T
2026-10-30T14:19:53.903Z journal.capture mcp projects/trace-probe/journal/2026-10-30--capture--auto-captured-hello.md 01M66JWWNF7ZTJE78Y9SEQT7YW
2026-10-30T14:19:54.504Z palace.room.create mcp projects/trace-probe/palace/rooms/goals/_room.json 01M66JWX88QA4BRFAVA2YSPTK8
2026-10-30T14:19:54.520Z palace.write mcp projects/trace-probe/palace/rooms/goals/README.md 01M66JWX8REF93SQ47P8EYQGAH
...
2026-10-30T14:19:54.611Z palace.write mcp projects/trace-probe/palace/identity.md 01M66JWXBKN817RFE3K43Y0ZNA
15 events for trace-probe (oldest first; head 01M66JWX)
```
Zero events: `No ledger events for empty-probe. Run: ar ledger backfill --project empty-probe`

## LIFECYCLE LINE
With events (session_start after one remember; last event is the session.start session_start itself appended):
```
lifecycle: born 2026-10-30 · 16 events · last session.start just now via mcp · verify: clean
```
No events (library path on a bare root; not reachable through session_start because it appends session.start first):
```
lifecycle: no ledger events yet (run: ar ledger backfill --project empty-probe)
```
Unavailable (events.jsonl is a directory, heads.json valid):
```
lifecycle: unavailable (EISDIR: illegal operation on a directory, read)
```

## COMMANDS
Both commands/arsave.md and experimental/harness-kit/commands/arsave.md (CRLF preserved; Store root note untouched). Neither file had an MCP-failure branch, so one was added (see CHALLENGED 2).
1. After the Step 3 bullet list: "**If `session_end` fails or times out (MCP unavailable)**, write the journal entry directly to `projects/<slug>/journal/<file>.md` under the store root, then — MANDATORY — record the degraded save in the ledger:" followed by a bash block:
   `ar ledger append --type ledger.note --via file-fallback --project <slug> --target projects/<slug>/journal/<file>.md --note "MCP unavailable; journal written directly"`
   and "This makes the degraded save visible in `ar trace <slug>` and lets `ar verify` explain the orphan."
2. New "### Step 4b: Verify the ledger (after EVERY save path — MCP success or fallback)" running `ar verify <slug>`; findings are listed under the card, not fixed.
3. Card row after Insights: `  Verify        clean | <n> findings  (ar verify <slug>)`, plus a "⚠  Verify: <n> findings" block template under the card.
No hardcoded store path added.

## TESTS
- packages/mcp-server ledger-trace-tool.test.mjs: tests 7, pass 7, fail 0 (final run together with p1-fence-boundary: pass 13, fail 0).
- packages/core ledger-commands.test.mjs + recall-owner-repro-2026-10-30.test.mjs: tests 12, pass 12, fail 0.
- core full suite (concurrency 2): tests 2128, pass 2127, fail 0, skipped 1, EXIT=0. (Not a pre-change baseline: only a test file was added to core, so it equals the baseline.)
- mcp-server full suite, final: tests 86, pass 81, fail 2, skipped 3. Failures: fence-completeness "MCP tools + resources" (new, caused by `trace`) and fence-completeness "CLI subcommands".
- mcp-server baseline (stashed my changes, ran fence-completeness only): pass 11, fail 1 — the CLI subcommands failure ("trace, verify, ledger" lack manifest entries) pre-exists from W2/W3. A pre-change whole-suite baseline was not taken; the first post-change run also failed p1-fence-boundary lite, which I fixed (hint ordering).
- Real-store check: `find E:/AI-Agent-Data/agent-recall C:/Users/tong/.agent-recall -type f -newermt <run-start>` returned nothing.

## LINT
`npm run lint` exit 0.

## CHALLENGED
1. Step 8b: journal_write is not registered on the default MCP surface (commented out in index.ts). Used `remember` as the write path. It produces project.create, journal.capture, palace scaffolding events, not exactly one journal.write; 8b asserts every line has 5 fields, field 3 === "mcp", a 26-char id, journal.capture present, a summary line `<n> events for trace-probe (oldest first; head <8>)`, and JSON events.length === number of lines.
2. Step 1/6: neither arsave file had an MCP-failure branch; added one after Step 3.
3. Step 8c/8d (per orchestrator note): session_start appends session.start before the lifecycle line, so "last" is session.start and the no-events line is unreachable via session_start. 8d asserts the no-events form via lifecycleLine on a bare root and via the trace tool's empty message.
4. Step 4 lite: appending after formatLite broke p1-fence-boundary (hint must be last); lifecycle is inserted before the hint via an optional formatLite parameter.

## OPEN
1. Fence manifest (not in my edit list): packages/mcp-server/test/fence-manifest.mjs needs an entry for the new MCP tool, otherwise fence-completeness "MCP tools + resources" fails. Suggested, next to the `recall` line (~35): `{ channel: "mcp_tool", id: "trace", status: "allowlisted", reason: "ledger metadata only: timestamps, event types, via, store-relative targets and ULIDs; no retrieved memory body text (targets are file paths, which can embed content-derived slugs — review whether that warrants fencing)." }`. The CLI failure needs entries for `trace`, `verify`, `ledger` (W2/W3 surface), same file.
2. Real-store check showed no writes; nothing to report.
3. Lifecycle line "unavailable" is only reachable on an unreadable events.jsonl; a corrupt heads.json yields the no-events form.

## COMMIT
e8f12e4

FEEDBACK_HINTS: journal_write is not on the default MCP surface (8b premise wrong); brief edit-allowlist omitted packages/mcp-server/test/fence-manifest.mjs which any new MCP tool or CLI command must update; "no events yet" via session_start is impossible once W3 appends session.start.
