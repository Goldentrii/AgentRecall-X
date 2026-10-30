# W3 report — class-fix: store mutations not recorded in the ledger

bug_class: a store mutation in agent-recall-core that is not recorded in the ledger (no appendLedgerEvent call after the write or delete has succeeded) for a ledgered target class per spec section 8
members_total: 28 wired modules (all call sites below) + 37 derived/out-of-class writer modules (exempt, listed) + 0 not_fixed
choke_point_used: partial. No single choke point exists (each module does its own fs write), so wiring is per call site; the shared seams that DO exist were used: `writeSkill` (all skill writes), `createRoom` + `ensurePalaceInitialized` (all palace scaffolding), `resolveProject` + `watchProjectCreate` (project.create), and a new `storage/ledger-queue.ts` for sync write paths.
suite_status: 0 (`cd packages/core && node --test test/*.test.mjs` => tests 2102, pass 2101, fail 0, skipped 1; `npm run lint` clean)

## FILES

Source (packages/core/src), 30 modified + 1 new:
- NEW `storage/ledger-queue.ts` — `enqueueLedger(task)`, `flushLedgerQueue()`, `fileDigest(file)`. In-process serial queue for appends issued from SYNC write paths (appendLedgerEvent is async). Exported from `index.ts` so sync CLI paths can flush before exit.
- `ledger/types.ts` — MUTATION_ALLOWLIST only (28 entries).
- tools-logic: `journal-write` (project.create, drop duplicate room.create now emitted by createRoom, flush), `journal-capture`, `journal-archive`, `journal-merge`, `journal-rollup`, `palace-write`, `knowledge-write`, `skill-write`, `session-start`, `session-end`, `alignment-check`, `nudge`, `context-synthesize`, `palace-lint`, `bootstrap`.
- palace: `rooms` (createRoom + ensurePalaceInitialized identity), `consolidate`, `compress`, `fan-out`, `identity`, `insights-index`, `pipeline`, `skills`.
- storage: `corrections`, `unclaimed`, `session-card`, `project` (`watchProjectCreate` + wiring in `resolveProject`), `filelock` (lock-order header only).
- `index.ts` — export `enqueueLedger`, `flushLedgerQueue`.

Tests: `test/ledger-no-unledgered-mutation.test.mjs` (new), `test/ledger-append.test.mjs` (block (b) now real palaceWrite + sessionEnd; 17 new class tests).

## CLASS TABLE

Status values: fixed (call site wired), fixed_at_choke_point (covered by a shared seam), derived (not a ledgered class; reason given), not_fixed (none). Line numbers are from the pre-change grep.

### Wired (status fixed / fixed_at_choke_point)

| location (pre-change) | event(s) | status | reason |
|---|---|---|---|
| tools-logic/journal-write.ts:127,179,182 | journal.write, palace.room.create(via createRoom), palace.write, project.create | fixed | W1 reference; added project.create + queue flush, removed duplicate room.create |
| tools-logic/journal-capture.ts:96,98,124,126 | journal.capture (log), palace.write (captures.md), project.create | fixed | |
| tools-logic/journal-archive.ts:52,53,70 | journal.archive on the SOURCE path (pre-move hash, meta.moved_to) | fixed | :58/:59 state.json and :70 archive/index.md are derived |
| tools-logic/journal-merge.ts:94,99 | journal.merge x3: target (new hash), source (moved_to), `.merged.md` backup | fixed | |
| tools-logic/journal-rollup.ts:74,82-94 | journal.rollup: weekly summary, each moved entry, each moved `-log.md` (meta.moved_to, rolled_into) | fixed | |
| tools-logic/palace-write.ts:101,106,114 | palace.write (hash of the string written), project.create | fixed | |
| tools-logic/knowledge-write.ts:64,69,85,89 | knowledge.write for legacy `knowledge/<cat>.md` and `palace/rooms/knowledge/<cat>.md`; none when dedup skips the write | fixed | |
| palace/skills.ts:299,300 (writeSkill) | skill.write | fixed_at_choke_point | every skill write (skillWrite, reinforce-on-recall, archive flag, promotion) funnels through writeSkill; `opts.ledger:false` lets tools-logic/skill-write await its own event |
| tools-logic/skill-write.ts | skill.write (awaited) | fixed | named in spec SW-4 |
| palace/rooms.ts:62,67 (createRoom) | palace.room.create (_room.json, sha null) + palace.write (README.md hash) | fixed_at_choke_point | all 6 createRoom callers + ensurePalaceInitialized default rooms |
| palace/rooms.ts:229 (ensurePalaceInitialized identity.md) | palace.write kind identity | fixed_at_choke_point | called by ~20 tools incl. read paths |
| palace/identity.ts:19 (writeIdentity) | palace.write kind identity | fixed | |
| tools-logic/bootstrap.ts:925 | palace.write kind identity (patched placeholder); project.create around ensurePalaceInitialized; flush | fixed | :944 writeIdentity and journalWrite/palaceWrite calls covered by their modules |
| palace/consolidate.ts:137,140,169,175 | palace.consolidate per topic/evolution write | fixed | |
| tools-logic/context-synthesize.ts:180,183,195,198,209,212 | palace.consolidate (decisions, evolution, blockers) | fixed | |
| palace/compress.ts:227,247 | palace.consolidate kind compress (rewritten topic) + kind compress-archive (`_archive/` copy) | fixed | |
| palace/fan-out.ts:53 | palace.write kind backref (rewritten room README) | fixed | |
| palace/pipeline.ts:334,335 (writeMilestone) | palace.write kind milestone | fixed_at_choke_point | sole milestone write path (pipeline_open/close) |
| tools-logic/palace-lint.ts:76,78 | palace.consolidate kind room-archive: one event on each `.md` that left rooms/ (pre-hash, moved_to) and one on its archive/ arrival | fixed | :112 palace-index.json derived |
| tools-logic/alignment-check.ts:60,62,81,84 | journal.write kind alignment (journal/<date>-alignment.md), palace.write (rooms/alignment/*.md), project.create | fixed | |
| tools-logic/nudge.ts:42,44 | journal.write kind nudge | fixed | |
| palace/insights-index.ts:162 (writeInsightsIndex via addIndexedInsight) | insight.add / insight.confirm, appended after the "insights-index" lock is released | fixed | project = the single named project else `_global` |
| storage/corrections.ts:567 (writeRecordAtomic) | correction.write (new/merged), correction.retract, correction.write meta.kind outcome-counters / tier / outcomes-rebuild | fixed | all 5 writers of a record file funnel through writeRecordAtomic; events appended after the `corrections-<p>` lock is released |
| storage/unclaimed.ts:226 (archiveExpiredUnclaimed) | ledger.note kind unclaimed-archive | fixed | no enum member fits a whole-dir sweep move |
| storage/unclaimed.ts:281,282 (stageUnclaimedCard) | journal.write project `_unclaimed` kind card | fixed | |
| storage/unclaimed.ts:372 (claimUnclaimedSession) | project.claim x2 per moved file (left `_unclaimed/..` with moved_to; arrived in `projects/<p>/journal/` with moved_from) + project.create | fixed | |
| storage/unclaimed.ts:481 (undoClaimUnclaimedSession) | project.claim x2 per moved-back file (op undo-claim) | fixed | |
| storage/session-card.ts:375,376 (writeSessionCard) | journal.write kind card, project.create | fixed | |
| tools-logic/session-start.ts | session.start once per (session, project) | fixed | mirrors claimSessionStartOnce idempotency; project.create + scaffold flush |
| tools-logic/session-end.ts | session.end (target null) after the final result is cached; its journal write is journal.write via journalWrite; corrections/insights/pipeline/consolidation via their modules | fixed | duplicate (cached) calls emit nothing |
| storage/project.ts (resolveProject, watchProjectCreate) | project.create | fixed_at_choke_point | first creation happens in resolveProject's cwd-allowlist write or the first mutating tool; `watchProjectCreate` records it exactly once |
| project.delete | — | fixed (vacuous) | no code path in core/cli/sdk/mcp-server removes a `projects/<slug>/` dir (grep rmSync/rmdirSync/fs.rm). Nothing to wire. |

### Derived / out-of-class (status derived; each is a row in DERIVED_EXEMPT in the enforcement test)

| location | reason |
|---|---|
| helpers/journal-files.ts:432,437,487 | index.md / _index.md / index.jsonl (derived journal indexes) |
| helpers/handoff.ts:270 | handoff.md generated artifact, not in the ledgered target list |
| helpers/alignment-patterns.ts:117,121,132 | alignment-log.json at project root, not in the ledgered list |
| palace/index-manager.ts:57, palace/graph.ts:19, palace/rooms.ts:62(_room.json),214,242,252,372 | palace-index.json, graph.json, _room.json, rooms/_index.md (derived) |
| palace/log.ts:31,33 | palace/log.md operation log (audit trail). See OPEN: verify must exclude it |
| palace/awareness.ts:107,111,201,262 | global awareness.md / awareness-state.json / archive; not in the ledgered target list |
| digest/store.ts:55,140,277,334,364,379 | projects/<p>/digest/; not in the ledgered target list (candidate for a later spec revision) |
| embeddings/index-store.ts:95,96, retrieval/lexical-index.ts:385 | derived retrieval indexes |
| storage/recency-index.ts:134-171 | recent-sessions.jsonl |
| storage/cwd-allowlist.ts:118,119 | cwd-allowlist.json |
| storage/hook-health.ts, lifecycle-telemetry.ts, ab-experiment.ts, hygiene.ts | telemetry/ and store-doctor state |
| storage/working-memory.ts:186,187,268 | working-memory/ scratch |
| storage/capture-router.ts:95, consolidation-queue.ts:69,196,197, dream-yield.ts:103, tools-logic/dream-admission.ts:479, safety-consolidation.ts:210 | dream / consolidation / dedup internals |
| storage/pending.ts:153,158,231,249,389 | `_pending/` review queue (reserved `_` namespace) |
| storage/behavior-policies.ts:112,113,130,131, blind-spots-store.ts:46,55,56 | json state outside the ledgered md/json list |
| storage/memory-protocol.ts:97, store-manifest.ts:104 | generated docs at store/project root |
| storage/archive-write.ts, archive-prune.ts | journal/archive/raw transcripts (below `journal/*.md`) |
| tools-logic/association.ts:476, journal-state.ts:110, smart-recall.ts:492-502, local-archive-backend.ts:121 | edges.json, journal/<date>.state.json, feedback log, exports/ |
| storage/filelock.ts, fs-utils.ts | lock dirs; generic atomic helpers (callers classified individually) |
| supabase/config.ts:88, supabase/sync.ts:119-127 | cloud sync config/log |

## ALLOWLIST

`MUTATION_ALLOWLIST` (ledger/types.ts), 28 entries, each resolves to `packages/core/src/<entry>.ts` and contains `appendLedgerEvent(` (asserted by the test):

tools-logic/{journal-write, journal-capture, journal-archive, journal-merge, journal-rollup, palace-write, knowledge-write, skill-write, session-start, session-end, alignment-check, nudge, context-synthesize, palace-lint, bootstrap}; palace/{rooms, consolidate, compress, fan-out, identity, insights-index, pipeline, skills}; storage/{corrections, unclaimed, session-card, project}.

SW-4 names present (endsWith): journal-write, journal-capture, journal-archive, palace-write, knowledge-write, skill-write, session-end, insights-index, corrections, unclaimed. The test additionally fails on ANY src module that calls a file-mutation primitive (writeFileSync, appendFileSync, renameSync, copyFileSync, unlinkSync, rmSync, writeTextAtomic, writeJsonAtomic, renameAtomic) and is neither allowlisted nor in the 37-entry DERIVED_EXEMPT map (and fails on stale exemptions), so the class stays closed.

## TESTS

Run from `packages/core` with HOME, USERPROFILE, AGENT_RECALL_ROOT, AGENT_CRAFT_HOME, TEMP, TMP, TMPDIR under E:/Users/tong/tmp/w3/.
- `ledger-no-unledgered-mutation.test.mjs`: 4 tests, pass 4.
- `ledger-append.test.mjs`: 33 tests, pass 33. Block (b) is now real `palaceWrite` + `sessionEnd`: palace.write hash equals the file on disk, session.end is last (target null, sha null), the per-project parent chain is unbroken, heads.json count/head match, rebuildHeads is byte-identical. 17 new class tests, one per member family: journalCapture, journalArchive, journalMerge, journalRollup, knowledgeWrite, skillWrite+writeSkill, writeCorrection/recordOutcome/setCorrectionTier/retractCorrection, addIndexedInsight (add then confirm), sessionStart/sessionEnd (idempotent start), writeSessionCard + staged card + claim, createRoom/ensurePalaceInitialized/writeIdentity, consolidate + contextSynthesize, pipelineOpen + fan-out backref, compressTopic, palaceLint room archive, alignmentCheck/nudge, and "ledger failure never changes a tool's result".
- RED proof: with `git stash` of packages/core/src (pre-fix), rebuilt: 17 of 18 class/chain tests and 2 of 4 enforcement tests FAIL (the 18th, "ledger failure never changes a tool result", is a safety property that passes pre-fix by construction). After `git stash pop` + rebuild all pass.
- Full core suite: tests 2102, pass 2101, fail 0, skipped 1. One earlier full run had 3 failures: `identity-trust-completeness` (my raw `readFileSync` hashing in journalRollup/claimUnclaimedSession tripped its journal-shape scanner; fixed by hashing through `fileDigest` in ledger-queue.ts) and two win32 timing tests (filelock A14, fs-utils bounded retry) that passed in isolation and in the final full run (load-sensitive flakes, not touched by this change).
- `npm run lint`: exit 0.
- Real-store check: no file under E:/AI-Agent-Data/agent-recall changed; `C:/Users/tong/.agent-recall` shows only the orchestrator's `projects/arx-ledger/palace/sops/*.md` Agent Craft writes (same as W1 reported), no `ledger/`.

## CHALLENGED

1. Brief step 1 / spec §8 name the corrections target as `palace/corrections.json`; the code has no such file. Corrections are per-record files `projects/<p>/corrections/<date>--<slug>.json` (plus derived `_index.md`, `_outcomes.jsonl`, `_rejected.jsonl`). I ledgered the record files (target = that path). verify's glob must be `projects/*/corrections/*.json` excluding `_`-prefixed names.
2. Orchestrator mapping `journal-cold-start → journal.cold_start`: journal-cold-start.ts performs no mutation (read-only plus ensurePalaceInitialized scaffolding, which createRoom already records) and spec D5 says reads are not ledgered. Not wired and not on the allowlist; the enum member `journal.cold_start` stays unused. It is not in SW-4's required list.
3. Brief step 5 prefers a single choke point. There is none (no shared write function), so per-site wiring with the seams listed above; the enforcement test is the closure mechanism instead.
4. `appendLedgerEvent` is async but 9 mutation sites are sync and public (createRoom, writeSkill, writeMilestone, writeIdentity, writeSessionCard, claim/undo, compressTopic, ensurePalaceInitialized). Making them async would change published SDK signatures. I added the serial `ledger-queue` instead; an event is therefore not guaranteed durable if a sync caller exits the process immediately (see OPEN).
5. Spec SW-3 "three mutations produce exactly three events" cannot hold once the class is closed (project.create, scaffold events, journal.write inside sessionEnd). The test asserts the chain properties instead of the count.

## OPEN

- Sync paths + immediate `process.exit()`: queued events issued by sync writers (createRoom scaffolding, writeSkill reinforce, writeMilestone, writeSessionCard, claim/undo) are written on a later microtask. CLI commands that call them and then `process.exit()` can lose the event (surfaces as an orphan; backfill heals it). `core.flushLedgerQueue()` is exported; W4/CLI owner should await it in `ar claim`, hook-end card writes and any command that exits explicitly. status: not_fixed for CLI (outside my write scope).
- Lock nesting: `addIndexedInsight` is called inside the "dream-admission" critical section (storage/dream-admission.ts:386), so its insight.add/confirm append runs while "dream-admission" is held ("ledger" is a leaf; no cycle). Documented in storage/filelock.ts ("dream-admission" -> "ledger"). Every other site appends after its own lock is released.
- verify (W2) must know the move convention: events with `meta.moved_to` sit on the path that LEFT the ledgered set (journal.archive, journal.merge source, journal.rollup entries/logs, palace.consolidate kind room-archive, project.claim left-side) and carry the PRE-move hash; treat them as terminal (not `missing`). Arrival events (`meta.moved_from`, or `.merged.md` backup, `_archive/` copy) are normal events on a live path.
- verify must EXCLUDE from `palace/**/*.md` orphan checks: `palace/log.md` (operation log, derived/audit), `palace/rooms/_index.md` and any `_index.md`, plus `palace/archive/**` only if W2 decides archive copies are out of class (they ARE ledgered here: palace-lint writes an arrival event). `journal/*.md` also includes `<date>-alignment.md` (ledgered as journal.write kind alignment) and `<date>--card--<sid>.md` (kind card).
- Event ordering: `project.create` for a brand-new project can land after the first scaffold events (the queue and the direct append race for the leaf lock). Chain integrity is unaffected; chronological `ts` order is.
- recordOutcome counter rewrites emit one `correction.write` (meta.kind outcome-counters) per retrieved/heeded/recurred outcome (needed so the record's hash never drifts). This is the noisiest new event; ledger-only kinds (triggered, cited, ignored, ...) emit nothing because they do not touch the file.
- bootstrap.ts has no behavior test of its own (needs a scan nonce from a real home scan); it is covered by the enforcement test and by the palaceWrite/journalWrite/ensurePalaceInitialized tests it delegates to. The identity-patch write at bootstrap.ts:925 is wired but untested.
- `projects/<p>/knowledge/<cat>.md` (legacy) is ledgered as knowledge.write although it is outside the spec's ledgered glob; harmless extra event, verify ignores it unless W2 widens the glob.
- Out-of-class but memory-like: `digest/`, global `awareness.md`, `alignment-log.json`, `behavior-policies.json`, `personal/blind-spots.json`. Candidates for a spec revision; currently derived/exempt with a reason.
- Code review (never self-review) was not run by me; the orchestrator's R phase covers it.

## COMMIT

6c0fc43 on ledger/w3 (one commit on top of 0953018), message starts `feat(ledger):`, ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Not pushed. `git status --short` shows only `?? .npmci.log` and `?? reports/`.

FEEDBACK_HINTS: Brief assumed one choke point and event-per-mutation counts (SW-3 "exactly three events") that a closed class cannot satisfy; spec §8 names a corrections.json that does not exist; journal.cold_start has no mutating module; sync public write functions need a queue the brief never mentioned; the identity-trust scanner rejects raw readFileSync in journal-shape functions so hashing helpers must live outside them; run `rm -rf packages/core/Microsoft` after full suites (PowerShell cache with redirected HOME).
