# W1 report — ledger core library

## FILES
Commit e0a6d81 (branch ledger/w1), 11 files, +600:
- packages/core/src/ledger/{types,ulid,context,heads,read,append,index}.ts (new)
- packages/core/src/index.ts (+ `export * from "./ledger/index.js";`)
- packages/core/src/tools-logic/journal-write.ts (+11: import + one appendLedgerEvent call)
- packages/core/test/ledger-ulid.test.mjs, ledger-append.test.mjs (new)

## PUBLIC API
All exported from `agent-recall-core` (via `export * from "./ledger/index.js"`).

types.ts
```ts
export type LedgerEventType = "project.create" | "project.delete" | "project.claim" | "session.start" | "session.end"
  | "journal.write" | "journal.capture" | "journal.archive" | "journal.merge" | "journal.rollup" | "journal.cold_start"
  | "palace.write" | "palace.room.create" | "palace.consolidate" | "knowledge.write" | "skill.write"
  | "insight.add" | "insight.confirm" | "correction.write" | "correction.retract" | "ledger.backfill" | "ledger.note";
export type LedgerVia = "mcp" | "cli" | "hook" | "file-fallback" | "backfill" | "library";
export type LedgerActor = "agent" | "hook" | "user" | "system";
export interface LedgerEvent { v: 1; id: string; ts: string; type: LedgerEventType; project: string; session: string;
  actor: LedgerActor; via: LedgerVia; target: string | null; sha256: string | null; bytes: number | null;
  parent: string | null; host: string; meta: Record<string, unknown>; }
export interface LedgerAppendInput { type: LedgerEventType; project: string; target?: string | null; ts?: string;
  meta?: Record<string, unknown>; sha256?: string | null; bytes?: number | null; }
export const LEDGER_DIR = "ledger"; LEDGER_EVENTS_FILE = "ledger/events.jsonl"; LEDGER_HEADS_FILE = "ledger/heads.json";
  LEDGER_ERRORS_FILE = "ledger/errors.log"; LEDGER_META_MAX_BYTES = 512;
export const MUTATION_ALLOWLIST: readonly string[] = ["tools-logic/journal-write"];
```
append.ts
```ts
export function storeRelativePath(abs: string, root: string = getRoot()): string   // throws when outside store
export async function appendLedgerEvent(input: LedgerAppendInput): Promise<LedgerEvent | null>  // never throws
```
`target` may be absolute (converted to store-relative inside the try; outside-store => null + errors.log) or store-relative. Explicit `sha256` (even `null`) skips on-disk hashing; `bytes` then defaults to null.

context.ts
```ts
export function setLedgerContext(partial: Partial<{ via: LedgerVia; actor: LedgerActor }>): void
export function getLedgerContext(): { via: LedgerVia; actor: LedgerActor }
export function resetLedgerContext(): void   // tests
```
heads.ts
```ts
export interface LedgerHeads { [project: string]: { head: string; count: number; first_ts: string; last_ts: string } }
export function readHeads(root?: string): LedgerHeads
export function writeHeads(heads: LedgerHeads, root?: string): void
export function rebuildHeads(root?: string): { projects: number; events: number; badLines: number }
```
read.ts
```ts
export interface LedgerReadFilter { project?: string; type?: LedgerEventType; since?: string; limit?: number }
export function readEvents(filter?: LedgerReadFilter, root?: string): LedgerEvent[]   // file order; limit = LAST n
```
ulid.ts
```ts
export function ulid(nowMs?: number): string
export function ulidTime(id: string): number
export function isUlid(s: unknown): s is string
```

## TESTS
- Baseline (step 1): NOT recorded before changes. Substitute: post-change full core suite `cd packages/core && node --test test/*.test.mjs` => tests 2069, pass 2068, fail 0 (1 skipped).
- ledger-ulid: tests 5, pass 5, fail 0.
- ledger-append: tests 5, pass 5, fail 0. Checks a-d are one sequential `it` (they share the 3-event chain); e, f, g, h are separate.
- Real-store check: `find` over E:/AI-Agent-Data/agent-recall and C:/Users/tong/.agent-recall for files newer than my start found only C:/Users/tong/.agent-recall/projects/arx-ledger/palace/sops/4cdba878.md (12:45, project arx-ledger = the orchestrator's Agent Craft SOP write, not a test fixture; no `ledger-probe` anywhere). No ledger/ dir exists in the E: store. My START shell var was lost between calls, so I bounded the window by hand (12:41 start).

## LINT
`npm run lint` exit 0 (tsc --noEmit on core, mcp-server, sdk, cli).

## CHALLENGED
- Step 9: brief says `target: storeRelativePath(<abs path>)`. storeRelativePath throws on an outside-store path, and in journalWrite that call sits OUTSIDE appendLedgerEvent's try, so it could break the mutation (violates the non-throwing invariant). Instead passed the absolute `filePath` as `target`; appendLedgerEvent converts it inside its try. Same rule for W3: pass absolute paths straight to appendLedgerEvent; do not call storeRelativePath at the call site.
- Step 13 / TEST_ENV: `node --test packages/core/test/*.test.mjs` from the repo root fails 15 tests (filelock, child-process races, session-id-pairing) because they spawn children with cwd-relative `dist/...` paths. Run from `packages/core` (`cd packages/core && node --test test/*.test.mjs`). Not caused by this change. Run-from-root single ledger tests work fine.
- Step 12: also set TEMP/TMP to E:/Users/tong/tmp/w1/... for runs (tests use os.tmpdir(); default would be C:).

## OPEN
- Bounded retry: withLock("ledger") can throw LockContentionError (5 s, live holder) => logged + null, an orphan for verify. A short bounded retry in appendLedgerEvent could cut orphans under heavy multi-process load; not implemented.
- Concurrency: "ledger" is a leaf lock, taken only after the caller releases its own locks (journalWrite appends after journal-day-* is released). W3: do not call appendLedgerEvent inside another withLock critical section unless the lock ordering header in storage/filelock.ts is updated with "<x>" -> "ledger".
- Hash race: journalWrite hashes after the day-lock is released, so a concurrent writer to the same day file between release and append yields a drift finding (self-healing on next write). Acceptable for v1; W2's verify should treat drift as "latest event hash != file hash" only.
- `since` parsing: local parser (supports `Nd`, `Nh`, ISO); `parseSinceDate` from journal-search.ts lacks "24h". Unparsable `since` => no time filter.
- Events with a timestamp before heads' last_ts (backfill) still append in file order; `parent` is chain order, not time order.
- W2: readEvents reads the whole file each call (no rotation in v1, per D2).
- No data-race guard on heads.json beyond the "ledger" lock; rebuildHeads is NOT locked (run it only when no writers, or W2 wraps it in withLock("ledger")).

## COMMIT
e0a6d81

FEEDBACK_HINTS: Brief's step 9 (storeRelativePath at the call site) conflicts with the never-throw invariant; step 13 command must run from packages/core, not repo root; step 1 baseline needs the same cwd note; `$START` timestamp for the real-store find should be written to a file, not a shell var.

## A1 AMENDMENT
Commit f32d92c (ledger/w1, on top of e0a6d81). Files: ledger/{append,heads,read,ulid}.ts, tools-logic/journal-write.ts, test/ledger-{append,ulid}.test.mjs.

DONE: A1.1-A1.12 all implemented and tested.
- A1.1 every target = storeRelativePath(path.resolve(root, target)); `""`/".."/outside => throw inside try => null + errors.log.
- A1.2 chain: missing head + existing history => heads recomputed in memory (new `computeHeads`, pure) before appending; writeHeads failure after the append => best-effort rebuildHeads, rethrow => null + errors.log.
- A1.3 torn-line "\n" fence; A1.4 meta strings cut to 117+"...", stringify guarded; A1.5 journal.write passes sha256/bytes of the written string; A1.6 `Math.max(now,last)`; A1.7 `withLock("ledger", fn, { maxTotalWaitMs: 2000 })` (option exists; held-lock test returns null in ~2.2 s); A1.10 genesis `ledger.note` on `_global` when events.jsonl is absent; A1.11 journalWrite palace_room branch emits palace.room.create (new room) + palace.write; A1.12 unparsable `since` throws RangeError.

TESTS (cd packages/core, TEMP/TMP/HOME/USERPROFILE/AGENT_RECALL_ROOT/AGENT_CRAFT_HOME on E:/Users/tong/tmp/w1): ledger-ulid 6/6; ledger-append 16/16; full core suite tests 2081, pass 2080, fail 0 (1 skipped); `npm run lint` clean.

PUBLIC API CHANGES
```ts
// read.ts
export function readEvents(filter?: LedgerReadFilter, root?: string): LedgerEvent[]   // now throws RangeError on unparsable since
export function readEventsWithStats(filter?: LedgerReadFilter, root?: string): { events: LedgerEvent[]; badLines: number }  // NEW
// heads.ts
export function computeHeads(root?: string): { heads: LedgerHeads; events: number; badLines: number }  // NEW, pure
export function rebuildHeads(root?: string): { projects: number; events: number; badLines: number }    // unchanged signature
// ulid.ts
export function resetUlidClock(): void   // NEW, test helper (ulid now pins time to the max seen)
// append.ts: storeRelativePath now also throws for "" (target == store root). appendLedgerEvent signature unchanged.
```

BEHAVIOUR NOTES FOR W2/W3/W4
- Genesis: the first append on a store writes a `ledger.note` on project `_global` (meta.kind "genesis", root, host, version) before the requested event. Tests/verify counting events per store must expect it (rebuildHeads on a fresh store with 3 events reports projects 2, events 4). The `_global` chain is its own project.
- Meta: strings over 120 chars are cut; anything over 512 bytes or unserializable becomes `{ _truncated: true }`. 600 bytes of one string is now cut to 120, not truncated.
- `palace.room.create` is recorded with target `.../_room.json` and `sha256: null` (derived/mutable file; verify must not treat it as ledgered-class).
- ulid pins to the max ms seen: ulidTime(id) can exceed the event ts after a clock step back. Parent chain, not id, is the ordering authority.

OPEN
- Windows: renaming over a directory-at-heads.json costs 5 s x2 (rename retry budget) while holding the lock; I test the failure with a directory squatting on `heads.json.tmp.<pid>` instead. A real heads.json-is-a-directory store would stall one append ~10 s (still bounded by nothing but the rename budget; maxTotalWaitMs only bounds lock acquisition, not the critical section).
- Lock-wait null result for held "ledger" lock: the first mutation of a second process waits up to 2 s, then the event is lost (orphan for verify); backfill heals it.
- A1.5 test asserts sha256 == sha256(file on disk) after a single-writer call; a true "not re-read" proof would need a concurrent writer injected between the lock release and append, not done.
- A1.11: createRoom's own `_room.json` and fanOut/updatePalaceIndex writes remain unledgered (derived/side effects); fan-out into other rooms is not recorded.
