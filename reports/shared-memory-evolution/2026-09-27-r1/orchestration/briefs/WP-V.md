ROLE: Independent verification owner (Sonnet). You build the FROZEN evaluator. You do not implement drivers and you will not be reviewed by the driver authors.
CONTEXT: Worktree assigned to you (branch wp-v from integration HEAD). Contract: packages/core/src/repository/{contract.ts,trust.ts}; ADR: reports/shared-memory-evolution/2026-09-27-r1/adr/contracts.md + contracts-rev2.md (rev2 wins); harness interface scripts/acceptance/harness.d.ts; catalog docs/plans/shared-memory-evolution/ACCEPTANCE.json; PLAN.md §9, §12.
OUTPUT TO: files under scripts/acceptance/** only, plus reports/shared-memory-evolution/2026-09-27-r1/reviews/WP-V-report.md

PRECONDITIONS:
ASSERT_INVARIANT: DO NOT edit packages/** (drivers are other workers' files)  # checked before every mutating step
ASSERT_INVARIANT: DO NOT edit contract.ts, trust.ts or harness.d.ts; report defects instead
ASSERT_INVARIANT: DO NOT write tests that pass against a stub; every assertion must fail against a naive last-write-wins in-memory repo
ASSERT_INVARIANT: DO NOT read or write ~/.agent-recall or E:/AI-Agent-Data; use mkdtemp roots
ASSERT_INVARIANT: DO NOT commit; DO NOT push

CHALLENGE: If any step below looks wrong, conflicts with the goal, or rests on a false assumption, say so BEFORE executing it. State the conflict and the step number, then await direction.

────────────────────────────────────────────
GOAL: Frozen, driver-agnostic acceptance contract suite + egress guard + mechanical aggregator.

1. WRITE scripts/acceptance/contract-suite.mjs (node:test). Loads harness from env AR_HARNESS (absolute path), default-export createHarness().
   FOR EACH group below: implement tests that use ONLY the MemoryRepository/AdminRepository/Harness APIs:
   - G-validate: non-UUID id/op id/workspace → rejected:schema; update with expectedRevision null → schema; path-traversal ids ("../x") rejected before any fs effect.
   - G-cas (A10 subset): 100 pairs of concurrent updates on same revision → exactly 1 committed + 1 conflict per pair; revision strictly +1; no content loss.
   - G-idem (A09 subset): each op type replayed 10× same payload → one change, identical receipts replayed=true after first; same op id different payload → idempotency_mismatch; other principal reusing op id → independent.
   - G-authz (R2.1): agent cannot retract/quarantine/narrow an explicit_user constraint (requires_owner_approval / proposal effective=false, original still active); agent create constraint → candidate; agent confirm → untrusted_confirm; owner confirm with ownerWrite() → active explicit_user; reserved metadata keys stripped; plain object as trusted_user_event rejected.
   - G-visibility (R2.2) (IF capabilities.multiUser or agents): matrix of ≥ 200 allow/deny requests (get/query/list/export/history/latestHandoff) incl. id guessing; unauthorized → empty/not_found indistinguishable from nonexistent; legit positives succeed.
   - G-retract (A16 subset): retracted content never returned by get/query/readSnapshot/list/export/latestHandoff; history shows tombstone only.
   - G-derived (R2.11): derived record withheld when a closure source is retracted or revised; withheld_derived counts it.
   - G-handoff (A21 subset): verified_done without evidence → schema; latestHandoff returns newest; CAS conflict on concurrent checkpoint update.
   - G-cursor (A13 subset): 1000 events over interleaved writers; paging from every cursor yields no gaps/dups vs final snapshot.
   - G-durability (IF faults include crash_*): 200 committed writes with armed crashes → after restart every committed receipt readable; non-committed never reported committed.
   - G-outbox (IF faults include offline): writes while offline → queued (never committed); restart → still queued; online → exactly one commit each; conflict terminal.
   - G-ackloss (IF ack_lost): unknown receipt → getOperation resolves to original committed receipt; retry does not duplicate.
   For every group not applicable to a harness (capability false) emit a test named "N/A:<group>:<reason>" that passes trivially AND is listed in results as not_applicable (never counted as PASS).
2. WRITE scripts/acceptance/egress-guard.mjs: --import preload that patches node:net Socket.connect, node:dns lookup/resolve, globalThis.fetch, node:http(s).request, undici; records attempts to $AR_EGRESS_LOG (jsonl) and throws; loopback allowed only when AR_EGRESS_ALLOW_LOOPBACK=1.
3. WRITE scripts/acceptance/aggregate.mjs: input = results dir; checks catalog 47 ids exactly once, legal status, required fields per ACCEPTANCE.json.required_result_fields, PASS needs existing evidence files + verified_by ≠ implementer ids listed in orchestration/workers.json, commit consistency (all PASS on same final commit), no required skip; computes ENGINEERING_ACCEPTED / EVOLUTION_VALIDATED / READY_FOR_OWNER_RELEASE per verdict_rules; exits 1 on any structural violation.
4. SELF-TEST: build a deliberately naive repo (in-memory, last-write-wins, no authz) as scripts/acceptance/fixtures/naive-harness.mjs; RUN suite with it. IF naive harness passes any non-N/A group: strengthen that group; repeat.
5. RECORD sha256 of every file under scripts/acceptance/ in scripts/acceptance/FROZEN.sha256.
6. REPORT to OUTPUT TO: files, test count per group, naive-harness failure counts per group, known gaps, any contract defects found.
SUCCESS_WHEN: suite runs under `node --test scripts/acceptance/contract-suite.mjs` with AR_HARNESS=naive and fails in every non-N/A group; aggregator self-test on a synthetic results dir yields correct verdicts; FROZEN.sha256 written.
ESCALATE: IF harness.d.ts or contract.ts cannot express a required test → stop and report the exact gap.
