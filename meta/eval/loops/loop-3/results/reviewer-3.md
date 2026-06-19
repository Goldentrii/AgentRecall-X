# Loop 3 Code Review

**Reviewer:** Fresh eyes (Loop 3 reviewer)
**Date:** 2026-05-01

---

## A3: palace-write.ts — Frontmatter Stripping

**PASS** — `stripFrontmatterFromContent` correctly handles no-frontmatter files. When the regex fails to match, it falls through to `return rawContent` unchanged (line 41). Zero data loss.

**PASS** — All `input.content` references replaced. Grep confirms only one remaining occurrence on line 47 (the stripping call itself: `const content = stripFrontmatterFromContent(input.content)`). All downstream uses (generateSlug, README entry, non-README append entry, non-README new file write, fanOut) reference the local `content` variable.

**Minor observation (non-blocking):** Line 92 still references `input.room` and `targetTopic` in the new-file path: `` `${fm}# ${input.room} / ${targetTopic}\n\n${content}\n` ``. This is correct — `input.room` is the room name (not content), so this is not a stray `input.content` reference. No issue.

---

## A3: journal-write.ts — Classifier Order

**PASS** — The awareness classifier (`never|always|remember this|important rule|key principle`) is checked at line 58 **before** the knowledge classifier (`learned|lesson|gotcha|...`) at line 62, within the same if/else-if chain. If a string matches both (e.g. "always learned"), it routes to awareness — the more specific intent. Order is correct.

**PASS** — `routing_hint.command` branches correctly on `isAwareness`: awareness content routes to `ar awareness update`, all other rooms route to `ar palace write`. The branch is built at lines 139–145.

---

## B3: journal-cold-start.ts — Trajectory

**PASS** — `trajectory: string | null` is correctly typed in both the `JournalColdStartResult` interface (line 20) and the return object (line 135). No `undefined` leakage.

**PASS** — The trajectory block uses a separate try/catch from the palace block (lines 96–104), so a palace initialization failure does not suppress trajectory. Correct isolation.

**Minor observation (non-blocking):** `readAwarenessState()` is called twice — once inside the palace try/catch (line 87, for insight_count) and once in the trajectory block (line 98). Worker B3 noted this is intentional. Confirmed: both reads are cheap JSON parses, no lock contention, and the design is correct given the separate try/catch scopes.

---

## B3: awareness.ts — source_project in Insight Interface

**PASS** — `source_project?: string` is optional in the `Insight` interface (line 76). Backward compatible: existing `awareness-state.json` entries with no `source_project` field will deserialize with `undefined`, which is expected.

**PASS** — `addInsight` function signature accepts `source_project?: string` in its parameter type (line 205), and propagates it to the new `Insight` object at line 323. The optional field threads through correctly.

**PASS** — `renderAwareness` renders `source_project` conditionally (lines 412–415): if present, appends `[slug]` to the source line; if absent, renders source as-is. Backward compatible with existing insights lacking the field.

**Note on AwarenessState.trajectory:** The field is typed as `string` (not `string | null`) in `AwarenessState` (line 92). `readAwarenessState()` returns `AwarenessState | null`. In `journal-cold-start.ts`, the trajectory extraction guards with `awarenessState?.trajectory && awarenessState.trajectory.trim().length > 0` — this correctly handles both a null state and an empty string trajectory. No issue.

---

## B3: awareness-update.ts — source_project propagation

**PASS** — `source_project?: string` added to the `insights` array element type in `AwarenessUpdateInput` (line 17). The `addInsight` call correctly uses `source_project: insight.source_project ?? input.project` (line 50) — falls back to top-level `input.project` if per-insight value is absent.

---

## B3: session-end.ts — source_project passed to awarenessUpdate

**PASS** — When mapping insights for `awarenessUpdate`, `source_project: slug` is added on line 178. Verified in the actual file. Every insight written via `session_end` carries the originating project slug.

**PASS** — `scopedTrajectory` construction is correct (line 168–170): only set when `input.trajectory` is truthy, prefixed with `${slug}: `. Passed as `trajectory` param to `awarenessUpdate`. The `awarenessUpdate` function then sets `state.trajectory = input.trajectory` (its own `input.trajectory`, which is `scopedTrajectory`). Chain is correct.

---

## C3: bootstrap.ts — Backward Compat with No Args

**PASS** — `bootstrapScan(options?: {...})` remains optional-parameter. When called with no args (options is `undefined`):
```
const scanDirs = [...DEFAULT_SCAN_DIRS, ...(options?.scan_dirs ?? []), ...(options?.source_dirs ?? [])];
```
Optional chaining with `?? []` fallbacks produce `[...DEFAULT_SCAN_DIRS, ...[], ...[]]` — identical to pre-patch behavior. Full backward compat confirmed.

---

## C3: CLI --source flag parsing

**PASS** — `getFlag("--source", rest)` uses the standard `getFlag` helper (returns the next arg after the flag token). `.split(",")` correctly splits on comma for multiple directories. Single-dir case (`--source /path/a`) also works — produces a one-element array.

**PASS** — When `--source` is absent, `getFlag` returns `undefined`, and the ternary passes `undefined` to `bootstrapScan`, which is equivalent to passing no args. No regression.

**Minor observation (non-blocking):** `--source /a /b` (space-separated instead of comma) would silently ignore `/b` since `getFlag` only takes the single next token. This is a UX edge case, not a bug — the help text documents comma separation (`ar bootstrap --source <dir1,dir2>`), and the behavior is consistent with other multi-value flags in the CLI (e.g., `--connections`).

---

## Summary

| Check | Result |
|---|---|
| A3: stripFrontmatterFromContent handles no-frontmatter files | PASS |
| A3: All input.content refs replaced in palace-write.ts | PASS |
| A3: Awareness classifier before knowledge classifier (order) | PASS |
| B3: trajectory typed as string \| null in interface and return | PASS |
| B3: source_project optional in Insight interface | PASS |
| B3: session-end.ts passes source_project to awarenessUpdate | PASS |
| C3: bootstrapScan backward compat with no args | PASS |
| C3: --source CLI splits on comma for multiple dirs | PASS |

**Blocking issues:** None.

**Non-blocking observations:**
1. `readAwarenessState()` called twice in `journal-cold-start.ts` — intentional, documented, acceptable.
2. `--source /a /b` (space-separated) silently ignores second dir — not a bug, matches documented comma-separated contract.
3. `AwarenessState.trajectory` is typed `string` not `string | null` — cold-start handles this correctly via optional chaining + length check, but if `trajectory` is ever assigned `null` directly it would be a type error. Current write path (session_end) only writes when truthy, so no issue in practice.

**Verdict: APPROVE. All Loop 3 changes are correct.**
