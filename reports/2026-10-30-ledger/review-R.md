# Review R - feat/ledger (ce4feea..HEAD)

Read-only review; I did not run tests. Findings come from reading code and tests.

## CRITICAL
None.

## HIGH
None. M1 and M2 are just under it.

## MEDIUM

**M1. MCP `trace` can write files (not read-only).**
- `packages/mcp-server/src/tools/trace.ts:16` calls `resolveProject(project ?? "auto", { register: false })`. `register:false` only guards the allowlist write (`packages/core/src/storage/project.ts:394`). The auto branch (`project.ts:357-368`) still calls `stageFailedResolution` -> `recordUnclaimedProvenance` (`storage/unclaimed.ts:112-126`), which does `ensureDir` + `writeFileSync` under `_unclaimed/<sid>/`.
- Scenario: MCP server cwd is not a detectable project, the agent calls `trace()` with no project -> files created. The test no-new-files walk (`ledger-trace-tool.test.mjs:150`) uses an explicit project, so it does not cover this.
- Fix: for `trace`, use the explicit slug or a pure detect with no staging; or add a `stage:false` option to `resolveProject`.

**M2. Queued ledger events are lost when the process exits right after a sync mutation.**
- `mcp-server/src/lib/lifecycle-exit.ts:51-57` calls `distillSessionToCard` then `process.exit(0)` synchronously. That reaches `writeSessionCard`, which only does `enqueueLedger(...)` (`storage/session-card.ts:382-389`); the promise chain never runs before exit. The exit-time card `journal.write` and `project.create` are never recorded, so `verify` shows a permanent orphan. This undercuts "gaps heal via backfill" for every non-hook-owned host.
- CLI: `flushLedgerQueue` is only at the end of `main` (`cli/src/index.ts:4623`); there are 105 `process.exit` calls, e.g. around `cli/src/index.ts:2044-2122` (writeSessionCard, then early exits).
- Fix: bounded `await flushLedgerQueue()` before `process.exit` in `runOnce` and in the CLI hook exits; or a sync append fallback for exit paths.

**M3. `session_start` does heavy work on every call.**
- `mcp-server/src/lib/lifecycle-line.ts:10-16`: `readHeads`, `readEvents` (full parse), `verifyLedger` (second full parse, a third in `computeHeads`, and sha256 of every ledgered file of the project, `verify.ts:124-154`). Cost grows with ledger and project size on the hot lifecycle path.
- Fix: cache by events.jsonl size+mtime, or make the lifecycle `verify:` field cheap (heads/chain only; no hashing).

**M4. A torn line is a permanent finding.**
- `append.ts:94-108` heals the tail, but `verify.ts:46-53` reports the bad line as `unknown-via` forever, since the file is append-only. `ar verify` then exits 2 forever and every `session_start` says "1 findings". It also misuses the `unknown-via` kind from spec section 8.
- Fix: separate kind/severity (e.g. `torn-line`) that does not fail the exit code, or an explicit acknowledge mechanism.

## LOW
- **L1. Stale `heads.json` forks the chain.** `append.ts:71-75` only recomputes when the project has no entry. A present-but-behind `heads.json` (restored backup; or heads write and rebuild both failed, `append.ts:117-124`) gives a wrong `parent`. `verify` catches it; append could self-heal by checking the file tail.
- **L2. False `drift` from event/write reordering.** `journal-write.ts:134-145` hashes the bytes THIS call wrote and appends after the lock is released. Concurrent writers (MCP + hook, cross-process) can append events in the opposite order to the file writes, leaving the latest event with an older hash.
- **L3. `insights-index.json` is ledgered but MANIFEST lists it as `regenerable`/safe to delete** (`storage/store-manifest.ts:69`). Delete or regenerate -> `missing`/`drift`. Reclassify or exempt from hash checks.
- **L4. Weak enforcement test.** `ledger-no-unledgered-mutation.test.mjs` only checks the string `appendLedgerEvent(` appears in an allowlisted module; a new unledgered write inside an already-allowlisted module passes. D11 is overstated.
- **L5. MCP `trace` `project` has no regex** (`trace.ts:10`, only `.max(128)`), against the MCP-param rule. The current sink is `existsSync(path.join(projectsRoot, project))` + string compare, so no traversal impact today. Fix: `z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)`. `since` and `limit` are properly constrained.
- **L6. Meta can carry free text.** `correction.retract` meta includes `reason` (`corrections.ts:1665`) and `ar ledger append --note` is user text; both are cut to 120 chars (`append.ts:31,45-49`) but are not "ids/titles only". The genesis event bypasses `sanitizeMeta` (`append.ts:173-180`) and records the absolute store root.
- **L7. MANIFEST does not say whether `ledger/` is `sync` or `regenerable`** (`store-manifest.ts:76-80`); a mirror routine following "copy everything under..." could copy it. D7 holds in code (nothing in `src/ledger` references supabase; test A1.9), but the contract is unwritten.
- **L8. Test timing/isolation.** `A2.2` (`ledger-append.test.mjs:268`): two processes x 20 appends against a 2 s lock bound can drop events on a starved Windows runner (see the starvation scar at `filelock.ts:471-485`). `A1.7` asserts under 3.5 s wall-clock. Tests set the root in `before` and `delete` the env var in `after` instead of restoring it; if `before` fails, calls fall through to the real `~/.agent-recall`. Pin HOME/USERPROFILE as the MCP test does.
- **L9. Duplicated parsing.** `computeHeads` (`heads.ts:26`), `readEventsWithStats`, and the verify chain loop each re-parse the file with slightly different bad-line rules. One shared `scanEvents` would remove that.
- **L10. Call-site argument expressions run outside the try in append.** E.g. `createHash(...).update(Buffer.from(updated))` in `journal-write.ts:140`. They cannot realistically throw, but the D8 guarantee strictly covers only the append body.
- **L11. Public API.** `writeSkill` gained an optional trailing `opts: { ledger?: boolean }` (`palace/skills.ts`); backward compatible. Other changes are additive exports.

## What is solid
- **D8 on the main paths.** Lock timeout, containment failure, EISDIR on hashing, and `ulid` overflow all throw inside the try. The catch writes `errors.log` (itself guarded) and stderr, and returns null. The module-level promise chain cannot reject, so one failure cannot wedge it. A heads write failure keeps the durable event and attempts a rebuild. Call sites append after the mutation and after their own locks are released (checked `journal-write.ts` and `corrections.ts`). `ledger` is a documented leaf lock and its holder takes no other lock.
- **Containment.** `storeRelativePath` rejects absolute, `..`, and other-drive Windows targets. `verify` refuses escaping targets from hand-edited events (`verify.ts:38-40`). `walk.ts` uses `Dirent.isFile`, so symlinks and junctions are not followed.
- **Read paths.** `verifyLedger`, `traceProject`, `readEvents`, and `lifecycleLine` write nothing. The only leak is the `resolveProject` side effect (M1).
- **Concurrency and genesis.** Genesis-once and torn-line prefixing are correct inside the lock. `ulid` is monotonic and survives a backwards clock.
- **Spec mapping.** Enum, schema, move convention (`meta.moved_to` terminal in verify), and backfill (ts = mtime, idempotent via the seen-target set) match the spec as I read it.
- **Tests.** The tests I read look non-vacuous: forced failure, lost `heads.json`, 50 concurrent appends, a cross-process case, and an escape-target rejection test.
