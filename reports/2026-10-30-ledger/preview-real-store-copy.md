# Preview: ledger on a copy of the real store (2026-10-30, after W1+W2 merged @ 735c801)

Copy: `cp -rp E:/AI-Agent-Data/agent-recall → E:/Users/tong/tmp/ar-store-copy` (mtimes preserved). Real store untouched. CLI = `packages/cli/dist/index.js` from `feat/ledger`, `AGENT_RECALL_ROOT` pointed at the copy.

| step | result |
|---|---|
| `ar verify` before backfill | 518 findings (all `orphan`), files 518, events 0; **no `ledger/` dir created** (read-only confirmed) |
| `ar ledger backfill --dry-run` | candidates 518, written 0; no writes |
| `ar ledger backfill` | written 518 in **20 s**; `events.jsonl` 519 lines (518 + genesis note) = 232 KB; `heads.json` 7.5 KB |
| `ar verify` after | **clean** (files 518, events 519) |
| second `ar ledger backfill` | candidates 0, written 0 (idempotent) |

Per-project lifecycle from `heads.json` (42 projects): oldest `linkedin-ssi` born 2026-05-10; `job-applications` born 2026-07-03 · last 2026-09-27 · 29 events; `tong` born 2026-07-08 · last 2026-10-15 · 18 events; newest `orbitcard-clone` and `unireverse-ai` born 2026-10-30.

`ar trace orbitcard-clone` → 7 `ledger.backfill` events, all `ts` 2026-10-30T08:38:45 = the empty palace templates created by this session's own `recall` call (bug 2 of the morning). With the ledger wired, that write-on-read would have been visible immediately.

## Findings for the review/fix round

1. **`formatTraceLine` prints `id.slice(0, 8)` — the ULID *time* prefix**, identical for every event within ~256 ms (every line above shows `01M66E2N`). Spec SW-6 mistake (orchestrator's). Fix: print the full 26-char id (agents consume these lines; width is not a concern).
2. `ar trace <project>` with zero events prints nothing and exits 0; it should print `No ledger events for <slug>. Run: ar ledger backfill --project <slug>` (the MCP tool already does).
3. W1's `A1.8` 50-concurrent-appends test fails under machine load (2 s lock bound → dropped events). Root cause class: in-process callers contend on the *file* lock. Fix: serialize appends inside the process with a promise queue before `withLock`, so only cross-process writers ever wait on the file lock.
4. `cp -r` without `-p` resets mtimes → backfill dates become copy time. Not a code bug; document in P2's migration brief: always `cp -rp` / `robocopy /COPY:DAT`.
