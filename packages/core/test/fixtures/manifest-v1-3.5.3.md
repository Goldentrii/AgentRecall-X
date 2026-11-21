---
manifest_version: 1
generated_by: agent-recall-core@3.5.3
---

# AgentRecall — Store Manifest

> This directory is a portable agent memory store. Restore = copy the
> directory to any machine and point the `AGENT_RECALL_ROOT` environment
> variable at the copy (defaults to a dot-directory under the current
> user's home when unset) — no database, no server, no other state
> required.

## Orientation (cold-agent read order)

1. `status.md` — current cross-project status board.
2. `projects/<slug>/MEMORY-PROTOCOL.md` — the per-project self-describing
   protocol (folder layout, read/write rules) for the project you're in.
3. Per-store `_index.md` files inside that project (e.g.
   `palace/rooms/_index.md`, `corrections/_index.md`, `journal/_index.md`)
   — machine fast-path summaries, regenerated on every write.
4. File bodies — open these only when the index above is not confident
   enough to answer.

## `projects/` convention

One directory per project, under `projects/<slug>/`. Inside any store
directory, a file whose name starts with `_` (e.g. `_index.md`) is a
regenerated INDEX, not a memory entry: never recall it as content, and never
hand-edit it — the next write to that store overwrites it wholesale.

## File classification (root-relative)

| class | meaning | examples |
|---|---|---|
| sync | pinned, source-of-truth; safe and intended to sync elsewhere | `status.md`, `awareness.md`, `ARCHITECTURE.md`, `projects/**` |
| never-sync | secrets or machine-local locks; must never leave this machine or be echoed anywhere | `config.json` (contains credentials — do not read or print it), `*.lock`, `.hook-*-lock`, `tmp/` |
| regenerable | derived caches; safe to delete, rebuilt automatically on next use | `dashboard.json`, `dashboard.html`, `dashboard-legacy.html`, `scoreboard.json`, `feedback-log.json`, `insights-index.json`, `arstatus-cache.json`, `awareness-archive.json`, `awareness-state.json`, `static/`, `.ambient-counter-*`, `.consolidation-queue/` |

When restoring or mirroring this store: copy `sync` plus everything under
`projects/`; skip `never-sync` (rotate credentials instead of copying
them — never move `config.json` between machines); let `regenerable`
rebuild itself on next use.

## Naming grammar (condensed self-contained summary)

- `--` is the FIELD delimiter; a plain `-` only ever appears INSIDE a field.
- journal: `{date}--{saveType}--[{sig}]--[{theme}]--{slug}.md` (null
  `sig`/`theme` are omitted, never printed as literal "none").
- corrections: `{date}--{rule-slug}.json`.
- palace rooms: `{topic-slug}.md` — one file per topic, with dated
  `### {date}` blocks appended inside; NOT one file per entry.
- palace pipeline: `{NNNN}--{phase-slug}.md`.
- palace skills: `{topic}--{slug}.md` (topical, no date — reference store).
- awareness / insights: `{date}--{slug}.md`.
- Mutable state (severity escalation, retraction, supersession) lives ONLY
  in a store's `_index.md` and the file body — NEVER encoded in a path.
