ROLE: Core worker (Sonnet) for P1 — instance-scoped runtime + local authoritative Repository driver. You implement; an independent reviewer and verifier will check you.
CONTEXT: Your own worktree (branch wp-p1 from integration HEAD). Read first: reports/shared-memory-evolution/2026-09-27-r1/adr/contracts.md then contracts-rev2.md (rev2 wins); packages/core/src/repository/{contract.ts,trust.ts} (FROZEN); scripts/acceptance/harness.d.ts (FROZEN); grounding orchestration/ground/G1-root-sdk.md (your exact work list, file:line); orchestration/dag.md (owner matrix). Baseline Windows failures: reports/.../baseline/results.json (36 known; you must not add any).
OUTPUT TO: code in your worktree + reports/shared-memory-evolution/2026-09-27-r1/reviews/WP-P1-report.md

PRECONDITIONS:
ASSERT_INVARIANT: DO NOT edit contract.ts, trust.ts, harness.d.ts, scripts/acceptance/**, packages/core/src/repository/cloud/**, migrations/**, tools-logic/{session-start,check,check-action,smart-remember,smart-recall,session-end}.ts, packages/mcp-server/**, packages/cli/src/**, any README  # checked before every mutating step
ASSERT_INVARIANT: DO NOT delete or weaken existing tests; baseline failing tests stay listed, not removed
ASSERT_INVARIANT: DO NOT touch ~/.agent-recall or E:/AI-Agent-Data; tests use mkdtemp roots and set AGENT_RECALL_ROOT + HOME + USERPROFILE to temp
ASSERT_INVARIANT: DO NOT add runtime network calls; DO NOT add dependencies
ASSERT_INVARIANT: DO NOT push; commit only on your branch

CHALLENGE: If any step below looks wrong, conflicts with the ADR, or rests on a false assumption, say so BEFORE executing it. State the conflict and the step number, then await direction.

────────────────────────────────────────────
GOAL: RuntimeContext isolation (R2.9, D1–D3) and a local MemoryRepository + AdminRepository implementing contract.ts exactly.

1. FIRST write failing tests (RED), commit them:
   - packages/sdk/test: un-todo audit-sdk-contract Case B (make it a hard test).
   - packages/core/test/repo-local-isolation.test.mjs: 2 runtimes, 2 roots, ≥50 interleaved async calls each incl. fire-and-forget + setImmediate + a thrown error branch → 0 cross-root files; strict mode getRoot() outside run() throws NoRuntimeContextError; singleton crossing (recall backend / supabase client / embedding provider keyed per context) with a fake config in one root.
2. packages/core/src/repository/runtime.ts: createMemoryRuntime(config, principal?) → { ctx, repository, admin, run(fn), close() }; AsyncLocalStorage store; strict flag per R2.9; export runWithContext, currentContext, NoRuntimeContextError.
3. types.ts getRoot(): ALS store root first; IF strict AND no store → throw; ELSE legacy global/env/default. Keep setRoot/resetRoot signatures.
4. FOR EACH singleton in G1 §2a S2–S6, S8: key by context key (sha256 of root|mode|config hash|principal) in a Map; evict on runtime.close(). retier.withStoreRoot → runWithContext. sdk: each AgentRecall instance owns a runtime; wrap every public method in runtime.run; remove setRoot call.
5. packages/core/src/repository/policy.ts (pure, shared with P2 as reference): authorize(op, target, principal, grants, trusted) implementing R2.1 exactly; canRead(record, principal, grants) implementing R2.2; recomputeAuthority per rev1 §4.2.
6. packages/core/src/repository/local/: LocalRepository implementing every MemoryRepository + AdminRepository method.
   - Storage per rev1 §3 + R2.15 N5: records/<id>.json (all revisions kept in history/<id>/<rev>.json), events jsonl, ops/<sha(principal|opid)>.json, wal/; FORMAT marker file.
   - Commit protocol rev1 §5 with fsync; recovery on open replays WAL idempotently; torn jsonl last line tolerated; Windows rename retry.
   - Order per R2.5; validateCommand before any path.join; ids only via isUuid.
   - Local grants in <root>/repo/grants.json (logical ACL, owner = local OS user principal); agents = principals with grants.
   - Markdown views per rev1 §3 with content_hash frontmatter; on read, IF view hash ≠ record.content_hash → create external_edit revision (constraints: stay at previous active revision until owner confirm; A03).
   - derived_closure validity per R2.11; access_epoch per R2.10; pending_ops always 0; freshness "fresh".
   - Failpoints for tests via env AR_FAILPOINT ∈ {after_wal, before_receipt} → process.exit(137) at that point.
7. packages/core/test/harness/local-harness.mjs implementing scripts/acceptance/harness.d.ts (capabilities: multiUser false, agents true, faults [crash_after_wal, crash_before_receipt] using a child process, realCloud false).
8. RUN: `npm run build && npm run lint && npm test -w packages/core && npm test -w packages/sdk` with temp HOME. IF new failures vs baseline list → fix (retry ≤3) ELSE ESCALATE with names.
9. IF scripts/acceptance/contract-suite.mjs exists in your base: RUN it with AR_HARNESS=<abs path to local-harness.mjs>; record result counts (do not edit the suite).
10. REPORT to OUTPUT TO: files changed, commits, commands + exit codes, test counts vs baseline, which G1 sites converted (and which not, why), known limitations, any contract defects. Trace ≥1 error path (catch/finally) explicitly.
SUCCESS_WHEN: Case B passes; isolation test passes with ≥50 interleaved calls/instance; LocalRepository compiles against contract.ts with no casts to any; no new baseline failures; report written.
ESCALATE: IF a frozen file blocks correct implementation → stop that item, report exact file/line + proposed change.
