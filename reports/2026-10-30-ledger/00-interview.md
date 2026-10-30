# 00 — Interview: AgentRecall Ledger (provenance + verify + trace)

Date: 2026-10-30 · Orchestrator: Claude Fable 5.1 · Repo: AgentRecall-X (`feat/ledger`, built on `fix/recall-project-scope` @ ce4feea, which is on top of v3.5.2 cfdd084)

## 1. Goal (owner's own words)

> 咱们开发了这么久，也用了这么久，理论上来说，很多情况还是好用的；但是现在 inconsistent，也不知道 naming system 怎么样，也没有 verify，也没有整体的一套非常严谨的 structure system。
>
> 我的想法是 progressive head-on，也就是说，一个项目开始的那一天，它有个 date；它被更新的那一天，它有个 date，就像一个时间戳，或者类似 atomic 那种 barrier token。通过 unique ID，我们可以追溯到这个对话它开始的时间是什么，它的 projects 是什么，也就是说它原始的数据是什么。
>
> 你能从 project ID 或者 user ID 去 track back to 这个 user 他的一些保存的东西、他的行为、数据库，包括 the lifetime of these projects，也就是这个 project 它的 path 是什么样的：它的哪一天进行了更新 / 哪一天进行了删除 / 哪一天进行了日志的写入 / 哪一天进行了自动日志的写入 / 哪一天又进行了这样那样的改变。通过这个 map，你就完全能追踪到这一整个链路。
>
> Okay, you can think about it, and you can start our agent craft to have a really, really good improvement on our agent recall.

Trigger incident (2026-10-30): an `/arsave` journal was unfindable by `recall`; root causes were a split store (commands hardcoded `~/.agent-recall` vs server `AGENT_RECALL_ROOT`), a read path that wrote scaffolding, and substring-noise in insight scoring. Fixed in `ce4feea`. **Nothing in the system could have told us a save landed in the wrong store** — that is the gap this work closes.

## 2. Positioning

An append-only **ledger** of every mutation to the AgentRecall store. Each event has a time-sortable unique id, a timestamp, who did it (actor), through which channel (via), what it touched (target), a content hash, and a link to the project's previous event — so any project's lifecycle can be **traced** as a chain, and the store can be **verified** against the ledger (drift, orphans, broken chains). The ledger is provenance, not a content store: files stay the content; the ledger proves them.

## 3. Decisions table

| # | question | answer | who |
|---|---|---|---|
| D1 | Name | **ledger** / **events** / **trace** / **verify**. Not "lifetime value" (a sales metric); the concept is *lifecycle / lineage*. | orchestrator |
| D2 | Storage | One append-only JSONL file `<root>/ledger/events.jsonl` with a `project` field (cross-project trace is one scan). No rotation in v1 (≈300 B/event; 10k events ≈ 3 MB). | orchestrator |
| D3 | Event id | **ULID** (26-char Crockford base32, 48-bit ms time + 80-bit random, monotonic within the same ms). Hand-rolled in `ledger/ulid.ts` (~40 lines) with a spec test — avoids a supply-chain audit for npm `ulid`. | orchestrator |
| D4 | Granularity | **Semantic (tool-level)** events, not fs-level. `journal.write` is one event even if the implementation does tmp+rename. No temp files, no derived indexes in the ledger. | orchestrator |
| D5 | Reads | **Not ledgered in v1** (no `recall.query`). Owner's list is mutations only; read events would bloat the file 10×. v2 may add it behind a flag. | orchestrator |
| D6 | Content | Ledger holds **hashes + metadata only**, never bodies. Earlier claim "everything is derived from the ledger" is corrected: content files are canonical; the ledger proves them; indexes (`index.jsonl`, `palace-index.json`, `recent-sessions.jsonl`) stay derived-from-files. | orchestrator |
| D7 | Privacy | Ledger is **local-only**. Not synced to Supabase in v1 (sync whitelist = none). Transcript content never enters it. | rule (claude-pc sync-leak scar) |
| D8 | Failure policy | `appendLedgerEvent()` **never throws into the caller**: on failure it writes `ledger/errors.log` + stderr and returns `null`; the mutation still succeeds. `verify` later catches the gap as an orphan. Ledger = observability, not a gate. | orchestrator |
| D9 | Parent chain | `parent` = id of the previous event of the **same project**; head pointers in `<root>/ledger/heads.json` (derived; rebuildable by scanning events). This is the owner's "progressive head". | orchestrator |
| D10 | Where via/actor come from | Each entrypoint calls `setLedgerContext({via, actor})` once: mcp-server → `mcp`/`agent`; CLI → `cli`/`user`; CLI `hook-*` subcommands → `hook`/`hook`; direct library use (tests) defaults to `library`/`system`. | orchestrator |
| D11 | Enforcement | A test asserts every module in the **mutation allowlist** calls `appendLedgerEvent(` — a new unledgered mutation fails CI. | orchestrator |
| D12 | Git as the ledger? | **Rejected**: not queryable per-project by an agent without git plumbing; CRLF/path noise on Windows; churny JSON indexes would dominate history. Git remains backup only. | orchestrator |
| D13 | Model routing | Workers/reviewer/verifier = `claude-sonnet-5-5`; orchestrator = Fable 5.1. Every dispatch names its model. | rule (CLAUDE.md) |
| D14 | Scope of this run | Phase P1 only (W1–W4 + red-team + review + verify). Then **stop, write the phase report, wait for owner** before P2 (migration of the C: store, backfill of the real E: store, dogfood). | rule (phase-end memory) |

## 4. REUSE_CHECK

Searched inside the repo first (`packages/core/src`), then npm/GitHub.

| found | decision |
|---|---|
| `storage/lifecycle-telemetry.ts` — append-only JSONL, 4 events, counters only, **no targets/hashes by doctrine** | keep as-is (firing-rate metrics); the ledger is a separate artifact with a different privacy contract. Reuse its rotate/append style. |
| `recent-sessions.jsonl`, `journal/index.jsonl`, `palace-index.json` | keep; derived views, not ledgered (D6) |
| `storage/filelock.ts` `withLock(name, fn)` | **reuse** for append + heads update |
| `storage/fs-utils.ts` `writeJsonAtomic`, `writeTextAtomic`, `renameAtomic`, `ensureDir` | **reuse** |
| `host-profile.ts` `resolveHostProfile().tier` | **reuse** for `host` |
| `storage/session.ts` `getSessionId()` | **reuse** for `session` |
| `storage/store-manifest.ts` MANIFEST.md | extend: W2 adds a `ledger/` paragraph (write-once contract respected: only when creating a new manifest) |
| npm `ulid` (zero-dep) | not adopted (D3) |
| Agent Craft templates `class-fix`, `fix-one-finding`, `adversarial-falsify` | **used** for W3, W2/W4 briefs, and the red-team pass |
| 40 files in core write to disk; `writeJsonAtomic`/`writeTextAtomic` are only partial choke points | no single fs choke point exists → tool-level append calls + the enforcement test (D11) |

## 5. Out of scope (v1)

- Rebuilding content from the ledger; ledgering reads (`recall`); Supabase sync of the ledger; any UI.
- Migrating the 55 C:-only files into the E: store and backfilling the **real** store (P2, owner decision).
- Ledgering Claude's own `memory/*.md` or Supabase writes (different systems; "memory bridges" = v2 idea).
- Cross-machine ledger merge; remote/Supabase memory backends.
- Changing recall ranking (RRF tier weighting, "card" ⊂ "orbitcard") — separate ticket.

## 6. SUCCESS_WHEN (each checkable against a named artifact)

1. `packages/core/src/ledger/{ulid,types,context,append,heads,verify,trace,backfill}.ts` exist and are exported from `packages/core/src/index.ts`; `npm run lint` (tsc --noEmit for all 4 packages) is clean.
2. `packages/core/test/ledger-ulid.test.mjs`: 26-char Crockford base32, time prefix decodes to the ms used, 1000 ids generated in one ms are strictly increasing, 10k ids unique.
3. `packages/core/test/ledger-append.test.mjs`: three mutations (`journalWrite` — wired by W1 as the reference integration; `palaceWrite` and `sessionEnd` — wired by W3, which extends this test) against a temp `AGENT_RECALL_ROOT` produce exactly three events; each `sha256` equals the sha256 of the target file on disk; `parent` links form a chain; `heads.json[project].head` = last id; a forced append failure (unwritable `ledger/`) does not throw and leaves the mutation's file written.
4. `packages/core/test/ledger-no-unledgered-mutation.test.mjs`: every module in `MUTATION_ALLOWLIST` (exported from `ledger/types.ts`, produced by W3's class-fix enumeration) contains the string `appendLedgerEvent(`; the list has ≥ 14 entries and includes `journal-write`, `journal-capture`, `journal-archive`, `palace-write`, `knowledge-write`, `skill-write`, `session-end`, `insights-index`, `corrections`, `unclaimed`.
5. `packages/core/test/ledger-verify.test.mjs`: on a clean temp store `verify` reports 0 findings; after hand-writing `journal/2026-10-31.md` it reports exactly 1 `orphan`; after modifying a ledgered file it reports exactly 1 `drift`; after corrupting one `parent` it reports exactly 1 `chain`; `backfill --dry-run` counts the orphan, `backfill` emits 1 `ledger.backfill` event, a second run emits 0.
6. `packages/cli/test/ledger-cli.test.mjs`: `ar trace <project>` prints one line per event (ts · type · via · target · id[0:8]) and `--json` is valid JSON; `ar verify` exits 0 when clean and 2 with findings; `ar ledger tail`, `ar ledger backfill [--dry-run]`, `ar ledger append --type ledger.note …` work.
7. `packages/mcp-server/test/ledger-trace-tool.test.mjs`: tool `trace` is registered and returns the timeline; `session_start` output contains a `lifecycle:` line (`born <date> · <n> events · last <type> <ago> via <via> · verify: clean|<n> findings`).
8. `commands/arsave.md` and `experimental/harness-kit/commands/arsave.md`: the file-fallback branch runs `ar ledger append --type ledger.note --via file-fallback …`, and the save card shows the `ar verify <slug>` result — asserted by `packages/core/test/ledger-commands.test.mjs` (same grep style as `recall-owner-repro-2026-10-30.test.mjs`).
9. Full suite green (baseline 2473 pass / 0 fail, run with `HOME`, `USERPROFILE`, `AGENT_RECALL_ROOT`, `AGENT_CRAFT_HOME` pointed at temp dirs) and `npm run lint` clean, on `feat/ledger` after all merges.
10. `reports/2026-10-30-ledger/verify.md` written by an independent verifier (Sonnet, never the author) with a per-line verdict for 1–9, each citing the artifact it opened.

## 7. Phases / workers

| worker | scope | template | depends on | worktree / branch |
|---|---|---|---|---|
| RT (red team) | `adversarial-falsify` on this interview + the W1 brief; verdict SHIP-CANDIDATE or RECOMPILE with named amendments | adversarial-falsify | — | read-only on `arx-ledger` |
| W1 | core ledger lib: ulid, types (schema + enum + `MUTATION_ALLOWLIST` placeholder), context, append (lock, hash, heads), heads rebuild; tests for SW-2, SW-3 | compile (systematic) | — | `arx-ledger-w1` / `ledger/w1` |
| W2 | verify / trace / backfill lib + CLI subcommands + MANIFEST paragraph; tests for SW-5, SW-6 | compile | W1 merged | `arx-ledger-w2` / `ledger/w2` |
| W3 | class-fix: enumerate every mutation site in core, wire `appendLedgerEvent`, fill `MUTATION_ALLOWLIST`, enforcement test SW-4 | class-fix | W1 merged | `arx-ledger-w3` / `ledger/w3` |
| W4 | MCP `trace` tool + `session_start` lifecycle line + `setLedgerContext` in mcp-server/cli entrypoints + arsave command fallback/verify card; tests SW-7, SW-8 | compile | W1 merged | `arx-ledger-w4` / `ledger/w4` |
| R | code-reviewer on merged `feat/ledger` (fresh eyes) | — | W2–W4 merged | read-only |
| V | verifier: SW-1…9 against artifacts → `verify.md` (SW-10) | — | R fixes applied | read-only |

W2, W3, W4 run in parallel after W1 (disjoint files: W2 = `ledger/verify|trace|backfill.ts` + cli; W3 = `tools-logic/*`, `storage/*`, `palace/*` call sites; W4 = mcp-server + `commands/*.md`). The one shared file is `ledger/types.ts` (`MUTATION_ALLOWLIST`): W1 creates it with a placeholder array; **only W3 edits it**.

## 8. Event schema (v1) — normative for all workers

```jsonc
{
  "v": 1,
  "id": "01JBX3Q9W7K2M5N8P1R4S7T0VX",       // ULID; append order
  "ts": "2026-10-30T10:12:11.123Z",          // event time (backfill: file mtime)
  "type": "journal.write",                   // closed enum below
  "project": "orbitcard-clone",              // slug; "_unclaimed" allowed
  "session": "6afe041e",                     // getSessionId()
  "actor": "agent" | "hook" | "user" | "system",
  "via": "mcp" | "cli" | "hook" | "file-fallback" | "backfill" | "library",
  "target": "projects/orbitcard-clone/journal/2026-10-29.md", // store-relative, "/" only; null for session.*
  "sha256": "<hex>" | null,                  // target bytes AFTER the write; BEFORE for *.delete
  "bytes": 2744 | null,
  "parent": "<ulid>" | null,                 // previous event of the same project
  "host": "A" | "B" | "C",                   // resolveHostProfile().tier
  "meta": { }                                // ≤ 512 bytes JSON; ids/titles/sections only, never bodies
}
```

`type` enum: `project.create`, `project.delete`, `project.claim`, `session.start`, `session.end`, `journal.write`, `journal.capture`, `journal.archive`, `journal.merge`, `journal.rollup`, `journal.cold_start`, `palace.write`, `palace.room.create`, `palace.consolidate`, `knowledge.write`, `skill.write`, `insight.add`, `insight.confirm`, `correction.write`, `correction.retract`, `ledger.backfill`, `ledger.note`.

Ledgered targets (what `verify` scans for orphans): `projects/*/journal/*.md` (excluding `index.md`, `_index.md`, `*-log.md` capture logs are ledgered as `journal.capture`), `projects/*/palace/**/*.md`, `projects/*/palace/corrections.json`, `projects/*/skills/**`, `insights-index.json`. Derived/ignored: `index.jsonl`, `palace-index.json`, `_room.json`, `graph.json`, `recent-sessions.jsonl`, `cwd-allowlist.json`, `owner.json`, `index/`, `telemetry/`, `ledger/` itself.

`verify` finding kinds: `orphan` (ledgered-class file with no event), `drift` (latest event hash ≠ file hash), `missing` (latest event says file exists, file gone, no `*.delete`), `chain` (parent ≠ previous head), `unknown-via` (never expected; schema violation).
