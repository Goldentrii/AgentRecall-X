<!-- reviewer: code-reviewer subagent, model=claude-sonnet-5, reviewed commit 6cd016e (scripts/acceptance by WP-V); extracted verbatim -->
## Summary: NEEDS_FIXES

The suite is well-engineered in its scaffolding (real self-test against a naive harness, real aggregator self-test, honest known-gaps section) but has concrete, evidence-backed holes: one vacuous-pass path, two numeric floors from PLAN.md §9.2 that are 4-5x under-delivered while the author's own report claims full compliance, three ADR rules with zero test coverage, an empirically-verified defeat of the aggregator's anti-self-review check against the *real* `workers.json` that now exists in the repo, and an egress guard whose disclosed "one residual gap" is actually at least four gaps.

## Blocking (numbered, required_fix)

**1. G-durability is vacuously passable by a driver that rejects every write, and separately under-shoots its own floor by 5x.**
File: `scripts/acceptance/contract-suite.mjs:847-899`. The violation logic only checks *consistency* (`wasClientCommitted && !isNowCommitted` → violation; `!wasClientCommitted && isNowCommitted` for `crash_before_receipt` → violation). There is no assertion that any attempt actually reaches `status:"committed"`. A driver whose `mutate()` rejects/throws on all 200 attempts produces `wasClientCommitted=false` and `isNowCommitted=false` for every attempt → **zero violations, test passes** — exactly the "只拒绝所有请求来通过" pattern A07/§9.2 explicitly forbids, just untested for in this group. Separately, PLAN.md `docs/plans/shared-memory-evolution/PLAN.md:500-511` (§9.2 "关键硬门槛": 提交持久性 = "1,000 个确认 committed 操作") and `ACCEPTANCE.json:220` (A08 setup: "两个后端分别1000个确认committed写入") require 1000 confirmed-committed writes; the group only drives 200 (`contract-suite.mjs:858-859`).
required_fix: add `assert.ok(attempts.filter(a=>a.receipt?.status==="committed").length >= <threshold>, ...)` before the restart check, and raise the loop to 1000 per fault kind to match A08's stated floor.

**2. G-visibility under-shoots A07's explicit 1000-request floor by ~5x, and the WP-V report misstates this as compliant.**
File: `contract-suite.mjs:604` (`assert.ok(requestCount >= 200, ...)`), self-test actually issued 235 (`WP-V-report.md:127`). `ACCEPTANCE.json:199-201` (A07 setup: "至少1000次矩阵请求"; pass_standard explicitly: "不能只拒绝所有请求来通过") and `PLAN.md:500-511` both fix this at 1,000. `WP-V-report.md:229-233` claims "I met or exceeded every floor stated in the brief and in PLAN.md §9.1/§9.2" — this is false for A07 (and for A08, see #1).
required_fix: widen the actor/fixture/path matrix (or repeat rounds) until `requestCount >= 1000`; correct the claim in the report or re-issue it.

**3. R2.3 "Existence hiding" (mutation side) has zero test coverage.**
`reports/shared-memory-evolution/2026-09-27-r1/adr/contracts-rev2.md:43-45` (R2.3, closes B6): "Any id collision or mutation on a record P cannot read returns `rejected:not_found`, indistinguishable from a nonexistent id. ConflictReceipt.current only when P can read T." `grep -n "not_found" scripts/acceptance/contract-suite.mjs` returns **zero matches** in the entire file. G-visibility only exercises the *read*-side existence hiding (id-guessing vs denied real id, `contract-suite.mjs:587-591`); no test ever calls `mutate()` (update/retract/CAS-conflict) against a record the actor cannot read to assert the reason is `not_found` rather than `forbidden`/`conflict.current` leaking existence.
required_fix: add a group (e.g. `G-existence`) driving update/retract/CAS attempts by an unauthorized actor against fixtures they cannot read, asserting `reason === "not_found"` and that a resulting `conflict` receipt carries no readable `current`.

**4. Three of eleven R2.1 authorization-matrix rows (`supersede`, `exception`, `release_dependency`) have zero test coverage.**
`contracts-rev2.md:17-20` lists these as distinct rows each requiring `owner_trusted + can_approve`, else `rejected:requires_owner_approval` (or `conflict` for stale supersede). `grep -n "supersede\|exception\|release_dependency"` against `contract-suite.mjs` returns nothing except the naive-harness fixture implementation of these ops (`fixtures/naive-harness.mjs:184-211`) — the frozen suite never exercises them at all, positively or negatively.
required_fix: add G-authz sub-tests mirroring the existing retract/quarantine/confirm pattern for each of the three ops.

**5. `aggregate.mjs`'s `verified_by != implementer` self-review check is empirically defeated by the real `orchestration/workers.json` that now exists.**
`reports/shared-memory-evolution/2026-09-27-r1/orchestration/workers.json` has shape `{"implementers": {"WP-P1": {...}, "WP-P2": {...}, "orchestrator": {...}}, "verifiers": {...}}` — an object keyed by id, matching **neither** of `aggregate.mjs`'s two accepted shapes (`{implementer_ids:[]}` or `{workers:[{id,role}]}`, `aggregate.mjs:126-134`). I ran it directly: `node scripts/acceptance/aggregate.mjs .../bad/results --workers reports/.../orchestration/workers.json ...` with a planted `A02.json` whose `verified_by:"wp-p1"` (a fixture implementer) produced **zero** `pass_verified_by_implementer` violations — only the generic `workers_manifest_unrecognized_shape` fires (`aggregate.mjs:133`, `:243-251`), because `implementerIds` silently stays an empty `Set`. The single most important anti-cheating check in the whole pipeline is inert for the artifact that actually exists in this repo today, and nothing in the violation message says "self-review detection did not run."
required_fix: either extend `aggregate.mjs` to also accept `{implementers: {<id>: {...}}, ...}` (derive ids via `Object.keys`), or fix the real `workers.json` to one of the two documented shapes — and split `workers_manifest_unrecognized_shape` from a distinct, louder violation stating the self-review check was skipped.

**6. Egress guard's disclosed "one residual gap" undercounts by at least three routes, against an `engineering_required` gate (A22).**
`scripts/acceptance/egress-guard.mjs` patches `net`, `tls`, `dns` (+ `dns.Resolver` prototypes), `http(s)`, `fetch`, best-effort `undici` — and documents exactly one gap, ESM-named `dns.lookup`/`dns.resolve` imports (`egress-guard.mjs:25-42`, explicitly called "the one residual gap"). Never patched, never mentioned: `node:dgram` (UDP — no reference anywhere in the file), `node:worker_threads` (a `Worker` runs in a separate V8 realm with fresh, unpatched core-module bindings — the parent thread's monkeypatches do not apply), and `child_process`-spawned processes (no `NODE_OPTIONS`/`--import` propagation to children anywhere in the file). `ACCEPTANCE.json:497-515` names A22 ("local默认零网络") `engineering_required` with evidence `security/local-egress.json`, and this file is its enforcement mechanism.
required_fix: patch `dgram.Socket.prototype.send/connect`; propagate the guard to spawned children via `NODE_OPTIONS`, or explicitly document that spawned processes are out-of-scope and must be independently audited; update the header comment to list all residual gaps (not just the DNS one) so A22 evidence isn't overstated.

## Non-blocking

- **R2.5 "replay after grant revocation still returns the original committed receipt" is untested.** `contracts-rev2.md:54-56` names this explicitly. `contract-suite.mjs:536-540` has a "revoked" actor but only uses it for read-denial in G-visibility, never combined with an idempotent-replay scenario in G-idem.
- **R2.2's `local_only` visibility row (1 of 5 rows) is untested.** `fixtureSpecs` at `contract-suite.mjs:489-495` covers private/project(x2)/workspace/owner_shared but not `local_only`.
- **`FROZEN.sha256` does not verify on a stock Windows checkout.** The hash list was generated from LF content (`git show HEAD:scripts/acceptance/FROZEN.sha256` confirms LF), but this Windows worktree's default `core.autocrlf=true` checks files out as CRLF; `sha256sum -c FROZEN.sha256` fails on filenames (`...json'\r': No such file`) and `sha256sum scripts/acceptance/contract-suite.mjs` (`fd5f5ee6...`) does not match the recorded value (`faff1425...`). `WP-V-report.md:264`'s own verification command fails as documented on one of the plan's two target platforms (A01). Fix: `.gitattributes` forcing LF for `scripts/acceptance/**`, then regenerate the hash file.
- **G-handoff's "newest checkpoint" test relies on 5ms wall-clock separation** (`contract-suite.mjs:749,753`) rather than a monotonic sequence — thin margin if a real driver's `latestHandoff` also uses wall-clock `created_at` comparison under a coarse system clock.
- **G-authz's authority-downgrade check is only exercised for `kind:"constraint"`**, not for the general "authority silently downgraded" row when `kind != constraint`.
- **`derived_closure`'s 256-entry cap/overflow behavior (R2.11) is untested** in G-derived — only the equality/withholding logic is covered.
- Positive note: the rev2.2 `__proto__`/`constructor`/`prototype` fix in `packages/core/src/repository/contract.ts:549-559` is correctly implemented (explicit skip + `Object.defineProperty`, not just relying on drivers' incidental JSON round-trip) — good, no action needed.

## Uncovered ADR rules

- R2.3 (existence hiding, mutation side — `not_found` vs `forbidden`/`conflict.current`)
- R2.1 rows: `supersede`, `exception`, `release_dependency`
- R2.2 row: `local_only`
- R2.5: replay-after-grant-revocation → original receipt
- R2.11 (partial): D4 `dependency_release.source_revisions` exemption path, and the 256-entry closure cap/overflow

## Compound lessons (exactly 3)

1. A frozen suite that correctly fails against a naive harness only proves it detects *the specific bugs the naive fixture contains* — it says nothing about whether every ADR row and every PLAN.md numeric floor is actually exercised. Always diff the suite's assertions against the ADR's row-by-row table and the plan's exact numbers, not against the author's self-test narrative.
2. Self-authored compliance claims ("met or exceeded every floor") are exactly the kind of unverified field the same author's own aggregator is designed to distrust elsewhere — apply that same skepticism recursively to the review report itself, and re-derive the numbers from spec text rather than trusting the summary table.
3. Silent-degrade paths (unrecognized manifest shape, self-declared capabilities, N/A tests) are where gaming concentrates precisely because they fail "softly" (a generic violation code, a passing TAP line) instead of loudly. Any such path must be exercised against the *real* artifacts already in the repo — not just synthetic self-test fixtures — before the pipeline is trusted end-to-end; this review found a live example (#5) by doing exactly that.

FEEDBACK_HINTS: outcome=needs_fixes challenge_fired=true