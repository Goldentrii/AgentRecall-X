# Naming System v2 — Specification

**Date:** 2026-07-20 · **Status:** approved-for-implementation (owner directive: make default) · **Method:** 5-seat round-table (standards research / cold-start test / retrieval engineering / robustness / owner taste) + orchestrator arbitration.

## 0. The honest goal

Owner's north star: *a fresh agent recovers ≥90% of needed information without opening content files.*

Empirical baseline (10-question cold-start test on real corpus, 82 projects / 734 room entries / 113 corrections): **55% today**. Filename-only ceiling: **~75–80%** — identity and hard-rules are paragraph-shaped and structurally cannot live in a slug. The 90% target is met by **names + ≤3 pinned always-read files per store** (`_index.md`, `identity.md`). Names route; indexes summarize; content holds truth. This restates, rather than fights, AR's own 2026-05-21 finding that the palace/journal split — not naming — is the retrieval backbone.

## 1. Two-audience ruling (core arbitration)

- **Filename = human + triage index.** 2–4 unlabeled fields max. Immutable-at-birth fields ONLY.
- **Materialized per-store `_index.md` = machine fast-path.** Regenerated on every write. Mutable state (severity escalation, retraction, supersession) lives here + in file body, never in the path.

Rationale: every path consumer (Obsidian `[[wikilinks]]`, Supabase path-keyed mirror rows, git history, open handles) treats the path as identity. `corrections.ts` merge-consolidation escalates severity p1→p0 and `retractCorrection` flips status — encoding either in the filename turns every mutation into a distributed rename with no transaction boundary. (Robustness seat, verified in source.)

## 2. Shared sanitizer (new, MANDATORY for all stores)

One function, used by paths.ts, session.ts, corrections.ts, room writes — call-site divergence is the current case-bug:

```
sanitizeName(input): lowercase → Unicode NFC → strip to [a-z0-9-] (collapse runs) →
                     trim leading/trailing '-' → BYTE-cap (Buffer.byteLength, not .length)
```

Fixes two live pre-existing bugs found during review:
1. **Case-fold divergence**: `projects/agentrecall` and `projects/AgentRecall` are ONE inode on default APFS but become two silently-diverging dirs on any case-sensitive FS (Linux prod, ext4 Docker, CI). `sanitizeProject` never lowercases today.
2. **Byte-vs-char budget**: every `.slice(N)` caps UTF-16 code units; CJK/emoji slugs can pass the char cap yet exceed the 255-byte/component filesystem limit. All caps become byte-caps. Component budget: project ≤100 bytes, slug ≤35 bytes (journal) / ≤48 bytes (corrections rule-slug), total path self-capped ≤200 chars.

## 3. Per-store grammar

Delimiter law: `--` separates fields; `-` only inside a field. A well-formed slug can never contain `--` (enforced by sanitizer collapse).

| Store | Grammar (new writes) | Example |
|---|---|---|
| journal/ | `{date}--{saveType}--[{sig}]--[{theme}]--{slug}.md` — **null sig/theme OMITTED, never printed** | `2026-07-20--arsave--critical--publish-gate--v3437-npm-publish.md` · `2026-07-20--arsave--fixed-dream-cron.md` |
| corrections/ | `{date}--{rule-slug}.json` — slug from the RULE, after stripping leading interjections/stop-phrases ("no,", "yes,", "ok", "you are right"...) | `2026-07-20--never-publish-without-approval.json` |
| palace/rooms/<room>/ | **AMENDED (Wave 1 finding):** rooms are one-file-per-TOPIC with dated `### {date}` blocks appended inside — NOT per-entry files. Grammar stays `{topic-slug}.md`; the observed opaque-ID file (`2026-1523-703010.md`, 1/734) is an upstream empty-slug-default bug to fix at the write path (derive topic from content headline when absent — v2.1 item), not a naming-grammar issue. The original `{date}--{topic-slug}` proposal would have fragmented room content and is withdrawn. | `novada-caller-key-leak.md` |
| palace/pipeline/ | `{NNNN}--{phase-slug}.md` (delimiter unified to `--`) | `0007--rd1-cross-project-recurrence.md` |
| palace/skills/ | `{topic}--{slug}.md` — reference store, topical axis, NO date | `deploy--cloudflare-4step-pattern.md` |
| awareness / insights | `{date}--{slug}.md` | `2026-07-14--phantom-gradient-step-detection.md` |

Field-order law: **field order = retrieval axis.** Time-series stores (journal, corrections, rooms, insights) lead with date; narrative leads with ordinal; procedural leads with topic.

### journal parsing note (why omission is safe)
`SignificanceTag` and `ThemeTag` vocabularies are **disjoint sets**. Parser rule for v2: `seg[0]` strict date, `seg[1] ∈ SaveType` anchors v2; remaining middle segments classified by enum membership (sig-enum → sig, theme-enum → theme), last segment = slug. Field COUNT is never the discriminator within v2 (retrieval seat's rule); cross-generation discrimination stays structural (legacy bare-date / old `\d+L` marker / current 5-part / v2 enum-anchored) — a 4th branch in `journal-name-parser.ts`, no in-name version sentinel (rejected as human noise; any future v3 MUST introduce an explicit sentinel instead).

## 4. Materialized indexes (the bridge from ~78% → 90%+)

Regenerated atomically on every write to their store (write-temp + rename):

- `corrections/_index.md` — **severity-first sorted** table: `| severity | failure_class | status | date | one-line rule |`. Serves the retrieval seat's "show me my worst active pattern" via one `ls`+`cat`; P0-active section doubles as the hard-rules answer for cold start.
- `palace/rooms/_index.md` — per room: room-slug, entry count, latest entry date, top-salience topics (from existing `_room.json` data).
- `journal/_index.md` — last 10 sessions: date, sig, theme, slug (board already covers cross-project; this is the in-project view).

Pinned-read contract for cold start: `identity.md` + store `_index.md`s ≤3 files.

## 5. Collision & concurrency policy (explicit table — was implicit)

| Store | Same-key collision | Policy |
|---|---|---|
| journal | same day | merge-append into day file (existing same-day rule) — EXCEPT arsaveall: per-session `--{6hex}` (existing) |
| corrections | same day + same rule-slug | dedupe: it IS the same rule → merge/confirm-count bump, no new file |
| rooms | same day + same topic | first write wins name; second gets `--{4hex}` |
| pipeline | ordinal | `nextOrder()` under lock |

Known TOCTOU: `session.ts` same-day read-then-append runs without filelock — v2 wraps the check+write in the existing filelock (bug fix, not new design).

## 6. Migration: stratified, zero-rename (unanimous)

- Old files are NEVER renamed. No bulk migration script. Blast radius on wikilinks / Supabase path keys / git history is not worth any name cleanup; `--none--none--` offenders age out via rollup/archive.
- New writes use v2 from the release that ships this spec.
- Readers: add v2 branch beside the 3 existing generation branches; anything non-conforming falls back exactly as today.
- Optional later (NOT in v2.0): rename-on-touch for individual files, wikilink-checked.

## 7. Explicitly deferred (v2.1 candidates)

- sig(10)+theme(13) vocabulary pruning into two small orthogonal axes (overlaps: shipped/milestone, critical/blocked; classifier first-match masking) — touches autoClassify + board + docs; separate change.
- Room-entry topic derivation from content headline when `topic` param is absent/opaque.
- Rename-on-touch cleanup pass.
- **Room/topic-level case-fold** (final-review finding): `sanitizeSlug` (room/topic dirs and topic files) remains case-PRESERVING in v2.0 — lowercasing it retroactively would re-case existing topic files (e.g. `README.md`) with no existing-dir-reuse safety net at that layer. Needs its own reuse-rule design before adoption.
- **Extract `corrections-index.ts`** — corrections.ts is 1556 lines (repo convention ~800); the `_index.md` regen/render logic is a clean extraction seam.
- **Index-regen perf** — `regenerateCorrectionsIndex` is O(n) full-store re-read per write; fine at today's scale (~113/project), revisit if long-lived projects reach 10k+ corrections (corrections never roll up).
- Wire `listCaseVariantForks()` into store-doctor so pre-existing case-forked corpora are surfaced to the user, not just stderr-warned.
- ~~**(2026-07-27) `auto-name.ts` TYPE_SIGNALS has the same vocabulary-vs-condition bug just fixed in `journal-sig-theme.ts`.**~~ **RESOLVED 2026-07-29.** Real-corpus audit (185 journal Brief sections across the live store, same grounding method as the 2026-07-27 fix) measured `tool-config` at ~87% false-positive (13-15/15 real matches — bare `\bmcp\b`/`\bserver\b`/`\bconfig\b`/`\bconfigure\b`/`\binstall\b` tripped on bare project names like "novada-mcp"/"aam-mcp", UI feature names like "Configure-MCP console", and filename substrings) and additionally found `architecture` at ~83% false-positive (5/6 — bare `\bdesign\b`/`\bapi\b`/`\bschema\b` tripped on UI/visual design, generic "API key" mentions, and "schema bug" bug-fix content) — a shadow epidemic uncovered only once `tool-config` was audited, same pattern as the theme/sig fix's version-bump/agent-fix discovery. Fixed by exporting `coOccurs()` from `journal-sig-theme.ts` and reusing it in `auto-name.ts`: `tool-config` now requires a tool noun (mcp/server/plugin) to co-occur with a real install/setup/config verb; `architecture`'s design/api/schema/structure signals now require co-occurrence with a genuine system/software noun (kept `architecture`/`system design` bare — audit found no false positives for either). The other 6 categories (bug-fix, lesson, decision, insight, goal, blocker) showed 0-1 real-corpus matches each in the same audit — no measured epidemic, left unchanged. Per-caller audit confirmed only `smart_remember`'s palace-room routing (not just naming) is affected by `detectContentType`, and the change is a correctness fix there (previously mis-routed into the off-taxonomy ad-hoc `tool-config` room, or into the canonical `architecture` room despite being unrelated content; now correctly falls to the `general`→`knowledge` default). `ContentType` enum, `generateSlug`/`detectContentType` signatures, and the sanitizeName byte-budget pipeline are all unchanged (zero-rename policy).

## 8. Round-table provenance (hills honored/overruled)

- Seat 1 (standards): temporal-lead, suffix-disambiguators, materialized index, no-opaque-IDs — **adopted**. Type-word in filename — overruled (directory IS the type field, seat 5).
- Seat 2 (cold-start): honest ceiling + index-bridge + lesson-not-utterance — **adopted**; status-in-room-name — overruled (mutable, seat 4).
- Seat 3 (retrieval): rule-slug, enum-membership parsing, field-order=retrieval-axis, grep economics — **adopted**; severity-first corrections filename — overruled (mutable), need served by severity-sorted `_index.md`.
- Seat 4 (robustness): immutable-fields-only, shared lowercase+NFC sanitizer, byte budgets, zero-rename migration, explicit collision table — **adopted wholesale** (hard constraints). In-name `g2` sentinel — replaced by structural discrimination + future-sentinel commitment.
- Seat 5 (taste): never-print-null, directory-is-type, generated-gist slugs, ASCII kebab zero exceptions — **adopted**; 2-field ceiling for journal — relaxed to ≤5-with-omission (3/5 seats found journal's rich triage earns its keep; empty runs were the real offense).
