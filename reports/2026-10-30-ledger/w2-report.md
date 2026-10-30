# W2 report — verify, trace, backfill + CLI

## FILES
Commit e073f42 (branch ledger/w2), 9 files, +791/-1:
- packages/core/src/ledger/{walk,verify,trace,backfill}.ts (new), ledger/index.ts (+4 export lines, W1's untouched)
- packages/core/src/storage/store-manifest.ts (+6: ledger/ paragraph under File classification)
- packages/cli/src/index.ts (+128: constants, setLedgerContext, help, trace/verify/ledger cases)
- packages/core/test/ledger-verify.test.mjs (11 tests), packages/cli/test/ledger-cli.test.mjs (11 tests)

## PUBLIC API
All exported from `agent-recall-core`.

```ts
// verify.ts
export type LedgerFindingKind = "orphan" | "drift" | "missing" | "chain" | "unknown-via";
export interface LedgerFinding { kind: LedgerFindingKind; project: string; target: string | null; detail: string; eventId?: string }
export interface LedgerVerifyResult {
  findings: LedgerFinding[];                       // sorted by project, kind, target
  scanned: { files: number; events: number; projects: number; badLines: number };
}
export function verifyLedger(project?: string, root: string = getRoot()): LedgerVerifyResult   // zero writes

// trace.ts
export function traceProject(project: string, opts: { since?: string; limit?: number } = {}, root: string = getRoot()): LedgerEvent[]
  // oldest first; limit keeps the LAST n; throws RangeError on unparsable since
export function formatTraceLine(ev: LedgerEvent): string
  // `${ev.ts} ${ev.type} ${ev.via} ${ev.target ?? "-"} ${ev.id.slice(0, 8)}` (5 space-separated fields)

// backfill.ts
export function backfillLedger(opts: { dryRun?: boolean; project?: string } = {}, root: string = getRoot()):
  Promise<{ candidates: number; written: number; targets: string[] }>

// walk.ts
export const LEDGERED_GLOBS: readonly string[];   // human-readable spec §8 list
export const DERIVED_PATHS: readonly string[];    // spec §8 derived/ignored; "x/" = root-prefix dir, else basename match
export function isLedgeredTarget(rel: string): boolean
export function walkLedgeredFiles(root: string = getRoot(), project?: string): Array<{ target: string; project: string; mtimeMs: number }>
  // sorted by target; insights-index.json -> project "_global"
```

Behaviour W4 needs: verifyLedger("p") ignores `_global` and the genesis note; verifyLedger() reports no finding for genesis. Finding kinds beyond the brief: an unparsable events line, a non-1 `v`, unknown actor/via, or a target escaping the store are all `unknown-via` (an unparsable-line finding has `target: null`, `project: <arg> ?? "_global"`). A stale/missing heads.json entry (head or count != what events imply, or an entry for a project with no events) is a `chain` finding with `target: null`.

## CLI
- `ar trace <project> [--since <iso|7d|24h>] [--limit N] [--json]` — one formatTraceLine per event, oldest first; `--json` = array of events. Exit 1 + usage when project is missing; exit 1 on bad --limit or unparsable --since ("Error: ledger: unparsable since ..."). Positional project, or the global `--project`.
- `ar verify [project] [--json]` — one line per finding `${kind}  ${project}  ${target ?? "-"}  ${detail}`, then `verify: clean (files N, events M)` or `verify: K findings (files N, events M)`; `--json` prints LedgerVerifyResult. Exit 0 clean, 2 findings.
- `ar ledger tail [-n 20] [--project P]` — last n events, formatTraceLine. Exit 1 on bad -n.
- `ar ledger backfill [--dry-run] [--project P]` — prints `backfill: candidates N, written M` then one target per line. Exit 0.
- `ar ledger append --type <LedgerEventType> --project P [--target T] [--via <LedgerVia>] [--note text]` — context via (default `file-fallback`) + actor `user`; prints the event id; exit 1 on unknown --type / --via (stderr lists allowed values), missing --project, or null result.
- Top of dispatch: `setLedgerContext(command.startsWith("hook-") ? hook/hook : cli/user)`.
- Note: the CLI strips `--project` globally before dispatch, so `--project` works anywhere on the line.

## TESTS
- Baselines (step 1): NOT recorded before changes (same gap as W1). Substitute: post-change runs below.
- ledger-verify: tests 11, pass 11, fail 0 (a-h plus e2 stale heads not repaired, f2 bad line counted, trace/since/limit).
- ledger-cli: tests 11, pass 11, fail 0 (seed, a-i, help).
- store-manifest + projects-literal-bypass-guard + ledger-verify together: 20/20.
- Full cli suite (cd packages/cli; --test-concurrency=2): tests 305, pass 305, fail 0.
- Full core suite (cd packages/core; --test-concurrency=2): tests 2092, pass 2090, fail 1, skipped 1. The one failure, W1's `A1.8: 50 concurrent appends` (2 s lock-wait bound), passed when ledger-append.test.mjs was rerun alone (16/16); it fails only under machine load (other agents were running suites).
- Default-concurrency runs of both suites showed load-induced timeout failures (cli.test.mjs 10 s execFile timeout, ab-report, fs-utils EPERM retry); cli.test.mjs rerun alone 11/11. One real failure found and fixed in the process: F2 guard (projects-literal-bypass-guard) rejected `path.join(root, "projects")` in walk.ts; now uses PROJECTS_DIRNAME from storage/paths.ts.
- Real-store check (find newer than 2026-10-30T12:04:11): only C:/Users/tong/.agent-recall/projects/arx-ledger/palace/sops/{24c0e9dc,4cdba878,74650f1f}.md (the orchestrator's Agent Craft SOPs); no `*probe*` path in either store.

## LINT
`npm run lint` exit 0.

## CHALLENGED
- Step 11f: appending a raw line with via "telepathy" on the same project makes heads.json disagree with the last event, which would add a second `chain` finding (orchestrator requires the heads comparison), contradicting "exactly 1". Test instead rewrites the existing event's via in place (heads stay consistent) and asserts exactly 1 `unknown-via`.
- Step 11h: orchestrator added `scanned.badLines`, so the empty-root expectation is `{ files: 0, events: 0, projects: 0, badLines: 0 }`.
- Step 3 heads check: also compares `count` (not just head) against computeHeads, and flags heads entries for projects with no events (only when that project is in scope).
- Step 11: tests use a fresh sub-root per case instead of rm + recreate: the rm between cases took up to 40 s on this Windows box.
- Step 1 baselines not recorded (see TESTS).
- Unparsable lines are surfaced as an `unknown-via` finding rather than only a count, so a torn/tampered ledger cannot verify "clean". Smallest addition that keeps the five normative kinds.

## OPEN
- Orphans of a project whose last event is `project.delete` are still reported (files exist on disk); only missing/drift are suppressed for deleted projects, per the brief. Revisit if W3 emits project.delete while leaving files.
- `insights-index.json` is listed as "regenerable" in MANIFEST.md but ledgered by spec §8; the new manifest paragraph does not reconcile the two. No manifest test pinned the body, so no test edited.
- `ar ledger append` accepts any store-relative or absolute --target with no existence check (append handles hashing/outside-store rejection).

## COMMIT
e073f42

FEEDBACK_HINTS: Step 11f contradicts the heads-vs-last-event comparison the orchestrator added; step 1/13 baselines should be run via a stash or a recorded W1 number; mention that parallel agents make default-concurrency suite runs flaky (use --test-concurrency=2); the F2 projects-literal guard bans path.join(..., "projects") outside storage/paths.ts and should be in the brief's constraints.
