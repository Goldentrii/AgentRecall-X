# AgentRecall-X shared-memory evolution — run 2026-09-27-r1 FINAL REPORT

Final integrated commit: `b2665b9b4705862dcc6aab49c8f31f743bffb677` (branch `feat/shared-memory-evolution`).
Evaluator commit: `ffe7910` (frozen contract suite v3). Baseline: `db6338a` (3.4.51).
Mechanical verdicts (scripts/acceptance/aggregate.mjs, 0 structural violations, `aggregate-output.json`):

| Verdict | Value |
|---|---|
| ENGINEERING_ACCEPTED | **no** (1/41 engineering cases PASS) |
| EVOLUTION_VALIDATED | **no** (0/4; experiment not run) |
| READY_FOR_OWNER_RELEASE | **no** (0/2) |
| Overall | **NOT PARTIAL_SUCCESS** — engineering not accepted; this run completed P0 + the P1/P2 repository layer only |

This run delivered the **foundation** (frozen contracts + two authoritative Repository drivers + a frozen independent
evaluator). It did **not** wire the new storage into the five MCP tools (P3), nor P4–P7. Nothing below claims
cross-device sharing, cloud operation on real Supabase, or agent improvement.

## A. What changed

**Contracts (P0, frozen after independent review):**
- ADR-001 rev1→rev2→rev2.1→rev2.2 (`adr/contracts*.md`): modes legacy/local/cloud; RuntimeContext; record model;
  mutation authorization matrix (R2.1); visibility matrix (R2.2); existence hiding; CAS+idempotency order; action decision
  table; legacy laundering rules; honest trust anchor; strict context; access epoch; derived validity; outcome uniqueness.
- `packages/core/src/repository/contract.ts`, `trust.ts` (TrustedUserEvent capability), `scripts/acceptance/harness.d.ts`.
- ADR-002 rev2 + `evolution-contract.ts` (experience evolution, roles, validation gate, leases) — frozen, not implemented.

**P1 — instance isolation + local authoritative driver (WP-P1, Sonnet 5):**
- `repository/{runtime,context-store,singleton-key,policy}.ts`; AsyncLocalStorage-backed `getRoot()` with strict mode.
- Root-derived singletons keyed per context (supabase client, recall backend + breaker, embedding provider, memory backend,
  session ownedFiles); `retier.withStoreRoot` global swap removed.
- **SDK: each `AgentRecall` instance owns a runtime; constructor no longer calls `setRoot` (behavior change).** Fixes the
  baseline todo-test "Case B" root leak.
- `repository/local/*`: WAL commit protocol with fsync, crash recovery, multi-record atomic ops, lock with owner token +
  liveness, CAS, idempotency, proposals/exceptions, derived validity, external_edit, history tombstones, admin grants.

**P2 — Supabase/Postgres authoritative driver (WP-P2, Sonnet 5):**
- `migrations/0002_shared_memory.sql`: 10 `ar2_*` tables, REVOKE ALL + RLS from R2.2, SECURITY DEFINER write RPCs
  (pinned search_path, identity from `auth.uid()`), INVOKER reads, xmin change cursor, access epochs, outcome uniqueness.
- `repository/cloud/*`: CloudRepository/AdminRepository, SqlExecutor, Supabase executor (per-runtime client),
  durable outbox, unknown/queued receipts, scrub before egress.
- Test harnesses: `packages/core/test/harness/{local,pglite}-harness.mjs`; PGlite 0.5.8 added as core devDependency.

**Evaluator (WP-V, Sonnet 5, independent):** `scripts/acceptance/{contract-suite,egress-guard,aggregate}.mjs`, fixtures
(naive / reject-all / hang harnesses), FROZEN.sha256, `.gitattributes` LF.

Stats: 64 commits, 162 files, +14,180/−145 under packages/, migrations/, scripts/.

## B. What did not change / not done

- Default mode is still **legacy**: existing users' MCP/CLI behavior is unchanged; no repository writes unless configured.
  (Flipping default → owner decision.)
- Five MCP tools, CLI, migration tool, handoff, guardedAction, experience worker, docs/README: **not implemented (P3–P7)**.
- Root `migration.sql` and legacy `ar_*` tables untouched; user's 5 README edits in the original worktree untouched.
- No production database, real Supabase project, paid model batch, global host setting, or scheduler touched.
- Known open items: G-existence `can_write && !can_read` CAS gap (fails closed); 3 frozen-suite fixture defects identified
  by reviewers (supersede/release on `private` target; cloud TrustedUserEvent test); Node v24.11.1 nested-subtest hang
  (nodejs/node#58227) in one G-authz subtest; `history()` keeps pre-retraction revision content (design decision needed);
  baseline `heeded-guard` 5/9 still red; 36 baseline Windows test failures unchanged (0 new).

## C. GitHub consistency

- Initial remote `main` = `db6338a` = local HEAD = plan baseline (no divergence).
- Final remote check and push status: see "Release actions" at the end (updated after push).
- Code vs docs: README/package READMEs do **not** yet describe local/cloud repository modes; they must not be updated to
  claim capabilities until P3 wires them into the tools (A46).

## D. Verification

Final integration (`tests/final-integration/summary.txt`, commit b2665b9, Windows 11, Node 24.11.1, sandboxed HOME):
build ✅ lint ✅; core 1998 tests / 31 fail, mcp 79/3, cli 293/2, sdk 40/0 → **0 new failure names vs baseline**, 1 fixed
(Case B). Frozen suite: local 59 pass / 1 fail / 1 cancelled; PGlite 55 / 6 / 1 (details above). heeded-guard 5/9 (baseline).

Independent reviews (verbatim in `reviews/`): contracts R0 (18 blockers) → R0b (4) → closed; suite review (6) → closed →
closure (1 new, fixed); P1 review (5 reproduced bugs incl. path traversal) → MERGE_OK; P2 review FAIL (6 incl. unredacted
secrets, cross-project write) → closure: no security blockers; ADR-002 review (6) → closed.
Orchestrator self-authored code fixes (verified by frozen suite, not self-signed): contract rev2.2 `__proto__`; P2
over-cap closure accept-and-withhold + `ar2_get` derived validity.

All 47 cases: `acceptance-results.json` — PASS 1 (A02), BLOCKED 17, NOT_RUN 29, FAIL 0.
Costs: agent compute only (no paid experiment). Note: in this environment Agent(model="sonnet") runs claude-fable-5;
3 scouts + 1 reviewer ran on Fable 5 before this was detected; all workers after ran on claude-sonnet-5 (`manifest.json`).

## E. Decisions required from the owner

1. Real isolated Supabase project (or approval to run local Supabase via Docker) → unblocks A05/A07/A08/A10–A13/A26/A27.
2. Second device/VM + Ubuntu host → A01/A30/A38.
3. Budget (~$2.2k est.) + an independent author for ≥150 held-out tasks → A42–A45.
4. Default mode legacy→local; SDK `setRoot` behavior change and version strategy.
5. Retraction history semantics (redact pre-retraction revisions or keep).
6. Proposed PLAN §11.2 lease-restore drill (ADR-002 R12).
7. Next run: P3 (five-tool integration) is the critical path.

Plywood: v0.5.1 (Goldentrii/agent-craft c11d05b) used for compile (7 briefs), validate (3), feedback receipts;
dispatch via Claude Code Agent tool; Windows UTF-8 bug in `plywood validate` logged (`orchestration/tool-issues.log`).

## Release actions (owner-approved 2026-09-27)
- Owner chose: merge into main + push; publish new version; wait for agents then shut down (orchestrator objected to publishing, recorded).
- Version bumped to 3.5.0-beta.0 (commits 8b500a9, 5b32de2; cli --version test widened to accept semver prerelease). Tests after bump: 0 new failures.
- Pushed `feat/shared-memory-evolution` to origin; opened PR #42 into main. main is protected (PR + required `build-and-test`).
  PR CI: build/lint OK, GitGuardian pass, bench-fixture pass, `build-and-test` FAIL at baseline `heeded-guard` 5/9 (identical to main). Not merged; no admin bypass used.
- npm publish: BLOCKED — `npm whoami` → ENEEDAUTH on this machine. `npm pack --dry-run` OK for all 4 packages. Command when logged in:
  `npm publish -w packages/core --tag beta` then mcp-server, sdk, cli (all `--tag beta`). Note: migrations/0002_shared_memory.sql is not shipped in packages.
- Final remote check: origin/main still db6338a; origin/feat/shared-memory-evolution = local HEAD. "Not merged to main — awaiting owner (CI red at baseline)."
