# WP-V report — frozen acceptance contract suite + egress guard + aggregator

Worktree: `arx-wp-v` @ `82e1157` (branch `wp-v`). Role: independent verification owner. No
files under `packages/**` were touched; `contract.ts`, `trust.ts`, `harness.d.ts` are unmodified
(verified via `git status --porcelain` — only `scripts/acceptance/**` and this report are new).

## STEP 0 VERDICT — rev2.1 D1 / D4 spot-check

**D1 (nested `validateCommand` validation): OK.** **D4 (`stripReservedMetadata`): DEFECT FOUND, with repro.**

### D1 — verified correct

Built `packages/core` (`npm ci && npm run build`) and drove `validateCommand` directly (throwaway
script, not committed) against `packages/core/dist/repository/contract.js`. All ADR-required
behaviors fire exactly as specified:

- `supersede.replacement` gets full create-shape validation (missing content, bad `kind`, same-id-as-target,
  invalid handoff JSON, `verified_done` without `evidence_refs` all threw `ContractValidationError`; a
  valid replacement did not throw).
- `update.patch` enforces the content cap (`content must be 1..64000 chars`) and the visibility enum
  (`invalid visibility`); a valid patch passed.
- `update` with `expectedRevision: null` throws (`update requires a positive integer expectedRevision`),
  mapping to `rejected:schema` as required.
- `create` with an invalid handoff JSON body throws `handoff content must be JSON` (wrapped as
  `ContractValidationError`, not a raw `SyntaxError`).

One caveat worth a line in the record: my first pass at this repro used ids like
`22222222-2222-2222-2222-222222222222` and got `operation_id must be a UUID` for everything — that id
fails `contract.ts`'s own `UUID_RE`, because the regex requires the variant nibble to be `[89ab]`, not
just any hex digit. That's `contract.ts` behaving correctly (strict UUID validation, not a defect); it's
noted here because any future test author hand-rolling UUID literals will hit the same trap. The suite
itself only ever uses `node:crypto`'s `randomUUID()`, which is always variant-compliant.

### D4 — defect: `stripReservedMetadata` is vulnerable to a `__proto__`-keyed prototype hijack

`stripReservedMetadata` (`packages/core/src/repository/contract.ts:549`) copies every non-reserved key
with a plain `out[k] = v` bracket assignment into a plain `{}` literal:

```js
export function stripReservedMetadata(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta ?? {})) {
    if (k.startsWith("_ar") || k.startsWith("dependency_release")) continue;
    out[k] = v;
  }
  return out;
}
```

`JSON.parse` happily produces an object with an **own, enumerable** property literally named
`"__proto__"` (this is a well-known JSON.parse quirk — it does not trigger the accessor). That string
does not start with `_ar` or `dependency_release`, so it survives the filter and reaches `out[k] = v`
where `k === "__proto__"`. Because `out` is an ordinary object literal, that specific bracket assignment
**does** invoke `Object.prototype.__proto__`'s setter, changing `out`'s actual `[[Prototype]]` to
whatever the attacker supplied. Reproduced two ways against the built module:

```js
// A) attacker object as __proto__ -> prototype hijack, visible via for..in but not Object.keys
const out = stripReservedMetadata(JSON.parse('{"__proto__":{"polluted":true},"safe":1}'));
Object.getPrototypeOf(out) === Object.prototype   // -> false (it's now the attacker's {polluted:true})
out.polluted                                      // -> true  (inherited, invisible to Object.keys/JSON.stringify)
for (const k in out) ...                          // -> DOES enumerate "polluted"

// B) attacker sets __proto__ to null -> null-prototype object, breaks naive .hasOwnProperty() calls
const out2 = stripReservedMetadata(JSON.parse('{"__proto__":null,"safe":2}'));
Object.getPrototypeOf(out2)          // -> null
out2.hasOwnProperty("safe")          // -> TypeError: out2.hasOwnProperty is not a function
JSON.stringify(out2)                 // -> '{"safe":2}' (still fine, own-key-only serializers are unaffected)
```

Impact is narrow but real: any client-controlled `metadata` object (the type is
`Record<string, unknown>`, fed straight from a `CreateCommand`/`UpdateCommand` payload) that contains a
`"__proto__"` key survives `stripReservedMetadata` as a prototype mutation on the *returned* object
instead of as a stripped or stored key. Concretely: (a) a `for...in` loop anywhere downstream (unlike
`Object.keys`/`JSON.stringify`) would see attacker-supplied properties smuggled in as if they were real
metadata; (b) a `"__proto__": null` payload produces a null-prototype object whose built-in methods
(`hasOwnProperty`, `toString`, …) are gone, so any driver code that calls `metadata.hasOwnProperty(x)`
(rather than `Object.prototype.hasOwnProperty.call(metadata, x)`) throws an uncaught `TypeError` on
ingestion of that record — a client-triggerable crash on a fully spec-shaped payload. Note also the
inconsistency with this same file's own `canonicalJson()`, which explicitly guards against non-plain
objects (`Object.getPrototypeOf(value) !== Object.prototype && proto !== null → throw`); no equivalent
guard exists in `stripReservedMetadata`.

I did **not** edit `contract.ts` (per PRECONDITIONS). Suggested fix for whoever owns the file
(orchestrator): build `out` with `Object.create(null)` (or skip `k === "__proto__"` explicitly, or use
`Object.defineProperty(out, k, {value: v, enumerable: true, writable: true, configurable: true})`
instead of bracket assignment) and reject/skip `k === "constructor"` too for defense-in-depth on
downstream `Object.assign`-based merges.

`contract-suite.mjs`'s `G-authz` group includes a black-box check for this (create a record through the
harness with a `"__proto__"` + reserved-key-laced metadata payload, read it back, assert
`Object.getPrototypeOf(record.metadata) === Object.prototype`). It passes today only if the harness under
test does its own JSON round-trip on write (which erases the polluted prototype as a side effect); it is
not a proof `contract.ts`'s helper is safe to call directly and forward without a JSON round-trip.

## Files delivered (all under `scripts/acceptance/**`, plus this report)

| File | Purpose |
|---|---|
| `scripts/acceptance/contract-suite.mjs` | Frozen, driver-agnostic `node:test` suite. Loads `AR_HARNESS`, exercises only `MemoryRepository`/`AdminRepository`/`Harness`. |
| `scripts/acceptance/egress-guard.mjs` | `--import` preload: patches `net.Socket.prototype.connect` (+`net.connect`/`createConnection`), `tls.connect`, `dns.lookup`/`resolve`(+promises)+`dns.Resolver` prototype, `globalThis.fetch`, `http(s).request`/`get`, `undici` (best-effort). Logs to `$AR_EGRESS_LOG` (jsonl), throws `EgressBlockedError`, loopback allowed only with `AR_EGRESS_ALLOW_LOOPBACK=1`. |
| `scripts/acceptance/aggregate.mjs` | Mechanical aggregator over a results directory. Cross-checks the 47-id catalog, legal status, required fields, PASS-needs-evidence-file, `verified_by` ≠ implementer, commit consistency, no required skip; computes the three verdicts purely from `ACCEPTANCE.json.verdict_rules`. Exit 1 on any structural violation. |
| `scripts/acceptance/fixtures/naive-harness.mjs` | Deliberately naive last-write-wins, no-authz in-memory harness (self-test fixture). |
| `scripts/acceptance/fixtures/aggregate-selftest/{good,bad}/results/*.json`, `.../workers.json`, `.../evidence/e1.txt` | Synthetic 47-id result sets for the aggregator self-test (see below). |
| `scripts/acceptance/FROZEN.sha256` | sha256 of every other file under `scripts/acceptance/` (102 files), `sha256sum -c`-verifiable. |

## Suite self-test (SUCCESS_WHEN #1)

```
AR_HARNESS=.../scripts/acceptance/fixtures/naive-harness.mjs \
AGENT_RECALL_STRICT_CONTEXT=1 HOME=<mkdtemp> USERPROFILE=<mkdtemp> AGENT_RECALL_ROOT=<mkdtemp>/ar-root \
node --test scripts/acceptance/contract-suite.mjs
```

Result: **exit code 1; all 12 applicable groups report `not ok`; 0 groups marked N/A** (the naive
harness declares `multiUser:true, agents:true, faults:[all four]` specifically so every group gets
exercised against it). `node --test --test-reporter=tap` totals: **41 tests run, 6 pass / 35 fail, 0
cancelled/skipped**. No assertion failure was an uncaught `TypeError`/crash — every failure is a clean,
intentional `AssertionError` pinpointing the exact naive defect the group targets.

| Group | Result vs naive | What made it fail |
|---|---|---|
| G-validate | not ok | naive never calls `validateCommand`: accepts non-UUID ids/op-ids/workspace, accepts `expectedRevision:null` on update, accepts `../x` as an id. |
| G-cas | not ok | no CAS check: both racers in a concurrent-update pair report `committed` (silent last-write-wins, content loss). |
| G-idem | not ok | no operations table / no payload-hash dedup: replays each create/update/retract as a fresh mutation instead of being idempotent (4/5 sub-checks fail; the 5th — "different principal independent" — passes, which is fine, it's not something naive's brokenness affects). |
| G-authz | not ok | no R2.1 matrix: agent can retract/quarantine/confirm an `explicit_user` constraint, "narrowing" applies directly instead of becoming a proposal, reserved metadata keys are not stripped, a structurally-forged `trusted_user_event` is honored (positive control legitimately passes). |
| G-visibility | not ok | 235 requests issued, 142 allow/deny violations: `get`/`query`/`readSnapshot`/`list`/`history`/`export`/`latestHandoff` return every record to every actor regardless of grant/visibility. |
| G-retract | not ok | retracted records are still returned by all 6 live read paths. |
| G-derived | not ok | no `derived_closure` revalidation: a derived record stays visible after its source is retracted or revised; `withheld_derived` never increments. |
| G-handoff | not ok | `verified_done` with empty `evidence_refs` is accepted (no schema check); CAS conflict check fails for the same last-write-wins reason as G-cas. |
| G-cursor | not ok | naive's change log is a capped 50-entry ring buffer; pumping 1000 create events through it drops 950 of them (`missing 950/1000 create events`). |
| G-durability | not ok | `restart()` returns a brand-new empty in-memory store: 200/200 "committed" writes are unreadable after restart, for both `crash_before_receipt` and `crash_after_wal`. |
| G-outbox | not ok | the `offline` fault is ignored outright; writes commit immediately instead of queuing. |
| G-ackloss | not ok | naive has no operations table at all: `getOperation()` always returns `null`, so the ack-lost write's true committed outcome can't be recovered, and a "retry" just re-applies instead of replaying. |

I also smoke-tested the N/A branch logic with a second, throwaway minimal-capability harness
(`multiUser:false, agents:false, faults:[]`, not part of the frozen deliverable) to confirm the
applicability gating itself doesn't crash: it correctly emitted `N/A:G-authz:...`,
`N/A:G-visibility:...`, `N/A:G-durability:...`, `N/A:G-outbox:...`, `N/A:G-ackloss:...` and ran the
other 7 groups for real.

## Aggregator self-test (SUCCESS_WHEN #2)

`scripts/acceptance/fixtures/aggregate-selftest/{good,bad}/` are two synthetic 47-id result sets built
from the real `ACCEPTANCE.json` (all `engineering_required` cases either genuinely PASS or, in `bad`,
one of five planted defects; `evolution_required`/`release_required` honestly `NOT_RUN` in both, since
this run hasn't reached P7).

```
node scripts/acceptance/aggregate.mjs .../good/results --catalog docs/plans/.../ACCEPTANCE.json \
  --workers .../fixtures/aggregate-selftest/workers.json --evidence-root .../fixtures/aggregate-selftest
```
→ **0 structural violations, exit 0**, verdicts `ENGINEERING_ACCEPTED=true, EVOLUTION_VALIDATED=false,
READY_FOR_OWNER_RELEASE=false, PARTIAL_SUCCESS=true` — correct given 41/41 engineering PASS and 0/6
evolution+release PASS.

```
node scripts/acceptance/aggregate.mjs .../bad/results --catalog ... --workers ... --evidence-root ...
```
→ **5 structural violations, exit 1**, all five planted defects caught exactly:
`id_duplicate` (A10 has 2 result files), `id_missing` (A14 deleted — "required skip"),
`pass_evidence_missing_file` (A03's evidence path doesn't exist), `pass_verified_by_implementer`
(A02's `verified_by:"wp-p1"` is listed as an implementer in the fixture `workers.json`),
`pass_commit_inconsistent` (A08's commit differs from the rest of the PASS set). Verdicts correctly
downgrade to `ENGINEERING_ACCEPTED=false` (A10/A14 count as `MISSING_OR_DUPLICATE`, not PASS).

I also ran the aggregator with its default path-discovery (no `--catalog`/`--workers` flags) from the
repo root: it correctly auto-finds the real `docs/plans/shared-memory-evolution/ACCEPTANCE.json`, and
correctly reports `workers_manifest_missing` because `orchestration/workers.json` genuinely does not
exist in this worktree today (see Known Gaps).

## Egress guard — verified behavior and one honest limitation

Smoke-tested directly (`node --import file:///.../egress-guard.mjs probe.mjs`, not committed as a
permanent test file — kept out of `scripts/acceptance/**` deliberately since the brief's WRITE list for
this file doesn't ask for a bundled self-test, and I wanted `FROZEN.sha256` to only cover the actual
deliverable):

- `fetch("http://…")`, `fetch("https://…")`, `http.request(...)`, `https.request(...)` → all throw
  `EgressBlockedError` and get logged to `$AR_EGRESS_LOG`.
- `AR_EGRESS_ALLOW_LOOPBACK=1` + connect to `127.0.0.1` → allowed; `AR_EGRESS_ALLOW_LOOPBACK` unset →
  same loopback connect throws.
- **Known, documented gap** (verified empirically on Node 24, called out prominently in the file's own
  header comment): Node's CJS→ESM interop snapshots each *named/namespace* import of a core module
  (`import { request } from "node:http"`, `import * as dns from "node:dns"`) at first module evaluation;
  reassigning the property via `import x from "node:mod"` (what this guard does, per the brief's own
  spec) does not propagate to that snapshot. Empirically, `http`/`https`/`fetch`/raw `net` traffic is
  still caught regardless of import style, because all of them transitively call
  `net.Socket.prototype.connect` — a shared prototype method, patched here, so it's import-style-agnostic
  — before anything leaves the process (confirmed: an `https.request` call was actually blocked via the
  `tls.connect` patch, not the `https.request` patch, and still blocked correctly). Plain
  `dns.lookup`/`dns.resolve` calls do **not** open a socket, so a caller that imports `"node:dns"` via
  named/namespace syntax specifically bypasses the `dns.lookup`/`dns.resolve` patches (verified: blocked
  with `import dns from "node:dns"`, not blocked with `const dns = await import("node:dns")`). I closed
  part of this gap by also patching `dns.Resolver.prototype`/`dns.promises.Resolver.prototype` methods
  (shared-prototype, so import-style-agnostic like `net.Socket`), leaving only bare
  `dns.lookup`/`dns.resolve` via named/namespace import as the residual hole — a narrow DNS-only
  exfiltration channel. This is a Node ECMAScript-module spec property, not a bug in this file; a
  loader-hook-based guard (`module.register()`) would close it fully but is a materially different
  implementation than the `--import` preload the brief specifies. Recommend treating this guard as a
  fast in-process tripwire, backed by an OS/CI-level egress block for the actual A22 production gate.

## Known gaps / things the next worker or the orchestrator needs to know

1. **`orchestration/workers.json` does not exist in this worktree** (referenced by WP-V.md step 3 and by
   `dag.md`'s file-owner table, but never created by P0). `aggregate.mjs` treats its absence as a
   structural violation (`workers_manifest_missing`) rather than silently skipping the
   verified-by-≠-implementer check — by design, per PLAN.md's `unknown_or_insufficient_evidence: never
   PASS`. Whoever runs the real aggregation for P7 needs to create it first; documented schema (two
   accepted shapes) is in `aggregate.mjs`'s header comment.
2. **`dag.md` assigns me `packages/core/test/acceptance-contract.test.mjs`** ("WP-V, implementers
   READ-ONLY"), but WP-V.md's own `OUTPUT TO` restricts me to `scripts/acceptance/**` + this report, and
   `packages/**` is an explicit `ASSERT_INVARIANT` no-edit zone. I did not create that file. Flagging the
   discrepancy rather than resolving it unilaterally — orchestrator should either update `dag.md` or issue
   a follow-up brief for that file.
3. **G-durability's exact semantics for `crash_before_receipt` vs `crash_after_wal` are my own,
   documented interpretation**, since `harness.d.ts` describes the fault kinds abstractly and no real
   driver exists yet to calibrate against. I test: (a) any write the client saw as `committed` before the
   fault must still read as committed after `restart()` (durability, both fault kinds); (b) for
   `crash_before_receipt` specifically, a write the client did *not* see as committed must not silently
   resolve to committed after restart. When WP-P1/WP-P2's real drivers land, this group needs a second
   look against their actual crash semantics — flagging now so it isn't mistaken for a rubber-stamped
   contract clause.
4. **Evidence-path convention for `aggregate.mjs`** isn't pinned down by PLAN.md §12 beyond "relative
   paths like `tests/local-lifecycle.json`"; I made `--evidence-root` an explicit flag (default:
   `resultsDir/..`) rather than guessing a repo-wide convention. Whoever wires this into a real P7 run
   should pass `--evidence-root` explicitly pointing at the run's `reports/shared-memory-evolution/<run-id>/`
   directory.
5. **[CORRECTED in Fix round 1 — see that section below] G-cursor, G-visibility, G-durability, G-outbox
   use my own combinatorics** rather than a single canonical number pulled from PLAN.md, because PLAN.md
   gives *floors* (≥1000, ≥1000/200, ×10, ×100 etc.) not exact counts for every group.
   **This bullet originally claimed "I met or exceeded every floor stated in the brief and in PLAN.md
   §9.1/§9.2." That claim was FALSE for A07 (G-visibility issued ~235 requests against a ≥1000 floor)
   and for A08 (G-durability drove 200 writes against a ≥1000-confirmed-committed floor) — caught by an
   independent review, not by me. Do not trust a self-authored "met every floor" summary; re-derive the
   numbers from the spec text, which is exactly what the reviewer did. See "Fix round 1" for the
   corrected counts and evidence.**
6. Did not implement a bundled self-test file for `egress-guard.mjs` inside `scripts/acceptance/**`
   (kept `FROZEN.sha256` scoped to the actual deliverable); verification was done ad hoc against throwaway
   scripts outside the worktree, results reported above.

## CHALLENGE — none blocking

No step in the brief conflicted with the stated goal or rested on a false assumption that I couldn't
route around by making (and documenting) a reasonable, narrow judgment call — see "Known gaps" above for
every place I had to fill in an underspecified detail. The one thing worth flagging as a genuine
pre-existing inconsistency (not something *I* introduced) is item 2 above (`dag.md` vs `WP-V.md`
`OUTPUT TO` scope).

## Verification commands (for the next agent / orchestrator)

```bash
export TMPROOT=$(mktemp -d) HOME=$TMPROOT USERPROFILE=$TMPROOT AGENT_RECALL_ROOT=$TMPROOT/ar-root
export AGENT_RECALL_STRICT_CONTEXT=1
export AR_HARNESS="$(pwd)/scripts/acceptance/fixtures/naive-harness.mjs"
node --test scripts/acceptance/contract-suite.mjs   # expect: exit 1, all 13 groups not-ok, 0 N/A

node scripts/acceptance/aggregate.mjs scripts/acceptance/fixtures/aggregate-selftest/good/results \
  --catalog docs/plans/shared-memory-evolution/ACCEPTANCE.json \
  --workers scripts/acceptance/fixtures/aggregate-selftest/workers.json \
  --evidence-root scripts/acceptance/fixtures/aggregate-selftest   # expect: 0 violations, exit 0

node scripts/acceptance/aggregate.mjs scripts/acceptance/fixtures/aggregate-selftest/bad/results \
  --catalog docs/plans/shared-memory-evolution/ACCEPTANCE.json \
  --workers scripts/acceptance/fixtures/aggregate-selftest/workers.json \
  --evidence-root scripts/acceptance/fixtures/aggregate-selftest   # expect: 5 violations, exit 1

(cd scripts/acceptance && sha256sum -c FROZEN.sha256)   # expect: all OK
```

---

## Fix round 1 (independent review `reviews/suite-review.md`, NEEDS_FIXES, 6 blockers)

Merged `feat/shared-memory-evolution` into `wp-v` first (`git merge --no-edit`, fast-forward:
`cadc562..6cd016e`), bringing in contract rev2.2's `__proto__`/`constructor`/`prototype` fix in
`stripReservedMetadata` (confirmed applied, matches the review's positive note) and the real
`orchestration/workers.json`. Addressed all 6 blockers and all 5 non-blocking items below, plus found
and fixed one additional self-test-masking bug while re-verifying (not in the original 6/5, disclosed
under "Bonus finding").

### Blocker 1 — G-durability vacuous-pass + 5x under-shoot

`contract-suite.mjs` G-durability now: (a) drives **1000** writes per fault kind (was 200), with the
fault explicitly re-armed+cleared around only every 100th write (10 fault-armed boundaries per kind) so
the ~990 unaffected writes give a real signal; (b) asserts
`committedBeforeRestart >= 940` (a `~94%` non-vacuous floor) **before** checking the durability
invariant, so a driver that rejects/throws on everything (or nearly everything) can no longer pass by
producing zero violations. **Regression-tested against a purpose-built adversarial "reject everything"
harness** (`mutate()` always returns `rejected:forbidden`, not committed to `scripts/acceptance/**`):
```
AR_HARNESS=/tmp/wpv-check2/reject-everything-harness.mjs node --test --test-reporter=tap scripts/acceptance/contract-suite.mjs
```
→ `not ok 11 - G-durability`, with the new assertion firing exactly as intended:
`G-durability(crash_before_receipt): only 0/1000 writes reached client-visible committed (need >= 940); a driver that rejects/throws on (nearly) everything must not pass this group vacuously` (and the same for `crash_after_wal`). This is the direct, empirical proof the vacuous-pass hole is closed, not just a code-review argument.

### Blocker 2 — G-visibility 5x under A07's 1000-request floor + false report claim

The full actor × fixture × read-path matrix now repeats for **5 rounds** (reads are side-effect-free, so
repetition is a legitimate way to reach a volume floor — same principle as G-cas's 100 CAS pairs). Naive
self-test now issues **1405 requests** (was 235), assertion raised to `requestCount >= 1000`. The false
"I met or exceeded every floor ... §9.1/§9.2" claim in the original report body is struck through and
corrected in place (see the bracketed note on that bullet above) rather than deleted, per the reviewer's
own "apply that same skepticism recursively to the review report itself" lesson.

### Blocker 3 — new G-existence group (R2.3, mutation-side)

Added `test("G-existence", ...)` (gated on `capabilities.agents || capabilities.multiUser`, same as
G-visibility): (1) `update`/`retract` by a caller with zero grant on T → `rejected:not_found`, never
`forbidden`; (2) a deliberately-wrong `expectedRevision` from the same unauthorized caller still resolves
`not_found`, never `conflict` (a CAS-shaped response would itself leak existence); (3) — when
`capabilities.agents` — a `can_write:true, can_read:false` agent grant hitting a genuine stale-revision
CAS conflict gets `status:"conflict"` (real CAS comparison, not short-circuited as not_found) **with
`current === null`** (R2.3: "ConflictReceipt.current only when P can read T"). Confirmed retract doesn't
silently take effect (`ownerRepo.get` still shows `status:"active"` afterward).

### Blocker 4 — G-authz: supersede / exception / release_dependency (previously zero coverage)

Added 8 new subtests mirroring the existing retract/quarantine/confirm pattern: owner supersede
(matching revision → old superseded + replacement active), owner supersede against a stale revision →
`conflict` (not `requires_owner_approval` — a distinct, previously-unexercised branch of the same row),
agent supersede without trust → `rejected:requires_owner_approval` + T unchanged; owner exception →
committed + `exceptions[]` updated, agent exception without trust → `rejected:requires_owner_approval`;
owner release_dependency → committed + `dependency_release` server-set, agent release_dependency without
trust → `rejected:requires_owner_approval` + no `dependency_release` recorded.

### Blocker 5 — aggregate.mjs vs the real workers.json shape

`aggregate.mjs` now accepts a third shape, `{ implementers: {<ID>: {branch, ...}}, verifiers: {...} }`
(the real shape shipped in `orchestration/workers.json`), deriving implementer identifiers from both the
object keys and each entry's `branch` field, all compared **case-insensitively**. Also added a
distinct, unconditional `self_review_check_skipped` violation whenever the resolved implementer set is
empty, for ANY reason (missing file, unparseable, unrecognized shape, or a validly-shaped-but-empty
manifest) — this can never again be silently indistinguishable from "checked, and clean."

Re-ran the reviewer's exact repro, now against the fix:
```
node scripts/acceptance/aggregate.mjs scripts/acceptance/fixtures/aggregate-selftest/bad/results \
  --workers reports/shared-memory-evolution/2026-09-27-r1/orchestration/workers.json \
  --catalog docs/plans/shared-memory-evolution/ACCEPTANCE.json \
  --evidence-root scripts/acceptance/fixtures/aggregate-selftest
```
→ `[pass_verified_by_implementer] A02: verified_by "wp-p1" is listed as an implementer (self-review)`
now fires (previously: zero violations of this kind, only the generic unrecognized-shape one). Also
verified the `self_review_check_skipped` violation fires standalone against `{"implementers":{}}` and
against a totally unrecognized-shape manifest.

### Blocker 6 — egress-guard: dgram, NODE_OPTIONS propagation, worker_threads, full gap list

- **`node:dgram`**: patched `dgram.Socket.prototype.send`/`.connect` (shared-prototype, so import-style-
  agnostic like `net.Socket`). Verified: `dgram.createSocket("udp4").send(buf, 53, "8.8.8.8")` and
  `.connect(53, "8.8.8.8")` both throw `EgressBlockedError`.
- **`NODE_OPTIONS` propagation**: the guard now appends `--import <self-url>` to
  `process.env.NODE_OPTIONS` on load. Verified with a real child process: a parent-guarded script spawns
  `node -e "fetch(...)"` via `spawnSync` **without passing `--import` to the child**; the child still
  throws `EgressBlockedError`, proving the propagation works end-to-end (not just "NODE_OPTIONS is set").
- **`node:worker_threads`**: best-effort wrap of the default-imported `Worker` class that auto-injects
  `execArgv: [..., "--import", <self-url>]`. Verified: a `new Worker(url)` constructed after this guard
  loads runs a worker script calling `fetch()`, and the worker reports back
  `worker-blocked:EgressBlockedError` — the spawned thread genuinely got its own independently-guarded
  realm, not just a cosmetic wrapper.
- **Header comment rewritten** to enumerate all 4 residual gaps found (was: 1): (1) ESM named/namespace
  import of `node:dns`'s bare `lookup`/`resolve` (pre-existing, now also noted as the same root cause
  behind the worker_threads gap: named-import callers of `node:worker_threads` get the unwrapped
  `Worker`); (2) child_process coverage is via `NODE_OPTIONS` only — doesn't cover children with an
  explicit `env` omitting it, non-Node children, or children that unset it; (3) worker_threads named-
  import bypass (see 1); (4) native addons doing raw syscalls are invisible to any JS-level guard by
  construction.

### Non-blocking items adopted

- **R2.5 replay-after-revocation**: new G-idem subtest — an agent creates a record, gets revoked
  (`harness.revoke`), then replays the *same* `operation_id`+payload; asserts the original committed
  receipt (same id/revision, `replayed:true`) is returned rather than a fresh authorization decision.
- **`local_only` visibility row**: G-visibility now creates a `local_only` fixture when
  `repo.mode === "local"` (must be owner-readable, denied to everyone else, folded into the existing
  matrix) and asserts the create itself is `rejected:local_only` when `repo.mode === "cloud"` (per
  contract.ts: "cloud drivers reject it").
- **256-entry `derived_closure` cap**: new G-derived subtest creates 257 independent sources and one
  record deriving from all of them directly; asserts the create itself still succeeds but the record is
  withheld from `query()` with `withheld_derived >= 1` (R2.11: "cap 256; overflow -> withheld").
- **G-handoff wall-clock**: removed the `setTimeout(5ms)` gaps between the three checkpoint creates
  (sequential `await`s alone already give a real happens-before, independent of clock resolution); added
  a `commit_cursor` monotonicity assertion across the three receipts as a clock-independent ordering
  signal.
- **`.gitattributes` + FROZEN.sha256 regeneration**: added `scripts/acceptance/** text eol=lf` at repo
  root. Reproduced the reviewer's exact failure first (two pre-existing tracked files,
  `harness.d.ts`/`run-baseline.sh`, were stored as LF blobs but checked out as CRLF under this Windows
  worktree's `core.autocrlf=true`), then fixed and **empirically verified against a real fresh checkout**
  (not just an index diff): `rm -rf scripts/acceptance && git checkout HEAD -- scripts/acceptance
  .gitattributes` → zero CRLF bytes anywhere under the directory, `(cd scripts/acceptance && sha256sum -c
  FROZEN.sha256)` → all 102 entries `OK`, exit 0.

### Bonus finding (not in the original 6 blockers or 5 non-blocking items)

While re-verifying that every new G-authz subtest actually *runs* against naive, found that the
pre-existing (pre-fix-round) `assert.equal(constraintCreated.effective_authority, "explicit_user", ...)`
sat as a **bare assertion directly in the G-authz test body**, outside any `t.test(...)`. Since naive
doesn't recompute authority (echoes back whatever the client requested) that assertion throws
synchronously and **cancels every sibling subtest registered after it** — which, before this fix round,
was *all of them* (retract/quarantine/narrow/confirm-chain/metadata-strip/forged-trust, and now also the
8 new supersede/exception/release_dependency subtests). My original WP-V-report.md's per-group table
described those subtests as if they had run and failed individually against naive; they never actually
executed. Fixed by moving that assertion into its own `t.test(...)`, with `constraintId`/
`constraintRevision` derived with a safe fallback so downstream subtests can still attempt (and
independently fail) their own logic. Confirmed via TAP output: G-authz now reports all **15** individual
subtests (was 1, immediately followed by a group-level abort) --- 5 legitimately pass against naive
(the owner-trusted/positive-path branches, which naive happens to get right by doing no enforcement at
all), 10 fail. This is exactly the class of bug the reviewer's "compound lesson 1" warned about, found by
applying the same lesson to my own suite rather than trusting the original self-test's group-level
"not ok" as proof of full internal coverage.

### Full re-verification after all fixes

```bash
export TMPROOT=$(mktemp -d) HOME=$TMPROOT USERPROFILE=$TMPROOT AGENT_RECALL_ROOT=$TMPROOT/ar-root
export AGENT_RECALL_STRICT_CONTEXT=1
export AR_HARNESS="$(pwd)/scripts/acceptance/fixtures/naive-harness.mjs"
node --test --test-reporter=tap scripts/acceptance/contract-suite.mjs
```
→ exit 1. All **13** groups (`G-validate, G-cas, G-idem, G-authz, G-visibility, G-existence, G-retract,
G-derived, G-handoff, G-cursor, G-durability, G-outbox, G-ackloss`) report `not ok`; `zzz-harness-teardown`
`ok`. TAP totals: **62 tests, 8 pass / 54 fail**, 0 cancelled/skipped, 0 uncaught crashes.

```bash
node scripts/acceptance/aggregate.mjs scripts/acceptance/fixtures/aggregate-selftest/good/results \
  --catalog docs/plans/shared-memory-evolution/ACCEPTANCE.json \
  --workers scripts/acceptance/fixtures/aggregate-selftest/workers.json \
  --evidence-root scripts/acceptance/fixtures/aggregate-selftest
```
→ exit 0, 0 structural violations, `ENGINEERING_ACCEPTED=true / EVOLUTION_VALIDATED=false /
READY_FOR_OWNER_RELEASE=false / PARTIAL_SUCCESS=true`.

```bash
node scripts/acceptance/aggregate.mjs scripts/acceptance/fixtures/aggregate-selftest/bad/results \
  --catalog docs/plans/shared-memory-evolution/ACCEPTANCE.json \
  --workers scripts/acceptance/fixtures/aggregate-selftest/workers.json \
  --evidence-root scripts/acceptance/fixtures/aggregate-selftest
```
→ exit 1, 5 structural violations (`id_duplicate`, `id_missing`, `pass_evidence_missing_file`,
`pass_verified_by_implementer`, `pass_commit_inconsistent`), `ENGINEERING_ACCEPTED=false`.

```bash
node scripts/acceptance/aggregate.mjs scripts/acceptance/fixtures/aggregate-selftest/bad/results \
  --catalog docs/plans/shared-memory-evolution/ACCEPTANCE.json \
  --workers reports/shared-memory-evolution/2026-09-27-r1/orchestration/workers.json \
  --evidence-root scripts/acceptance/fixtures/aggregate-selftest
```
→ exit 1, `pass_verified_by_implementer` fires against the REAL `orchestration/workers.json` (the
reviewer's exact repro from blocker #5) — now correctly detected instead of silently passing.

```bash
AR_HARNESS=/tmp/wpv-check2/reject-everything-harness.mjs node --test --test-reporter=tap scripts/acceptance/contract-suite.mjs
```
→ exit 1, `not ok 11 - G-durability` with the non-vacuous-threshold message (blocker #1 regression proof;
harness not committed to the repo, deliberately adversarial, kept out of `scripts/acceptance/**`).

```bash
rm -rf scripts/acceptance && git checkout HEAD -- scripts/acceptance .gitattributes
(cd scripts/acceptance && sha256sum -c FROZEN.sha256)
```
→ exit 0, all 102 entries `OK`, zero CRLF bytes found anywhere under the directory (non-blocking item,
verified against a real fresh checkout, not just a staged-index diff).

`npm run build` (all 4 workspace packages) rerun clean after the `feat/shared-memory-evolution` merge and
again after all fix-round edits; `git status --porcelain` shows only `scripts/acceptance/**`,
`.gitattributes`, and this report as touched -- `packages/**`, `contract.ts`, `trust.ts`, `harness.d.ts`
remain untouched by me (the rev2.2 `contract.ts` fix came in via the merge, authored by the orchestrator,
not by me).

---

SOP_ID: WP-V
FEEDBACK_HINTS: outcome=success challenge_fired=false
