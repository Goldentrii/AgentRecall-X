# Migration Agent Evaluation — 2026-05-01

## Setup

- AgentRecall v3.4.0 CLI: `node ~/Projects/AgentRecall/packages/cli/dist/index.js`
- Test root: `/tmp/ar-eval-migration`
- Seed files: `~/Projects/AgentRecall/eval/seeds/migration/`
- Seeds represent: user-profile.md, project-novada-mcp.md, project-agentrecall.md, CLAUDE.md, 2 feedback/*.md

---

## Task 1: Bootstrap Scan

### What ran

```
AGENT_RECALL_ROOT=/tmp/ar-eval-migration ar bootstrap
```

### What was discovered

- 26 git repos in ~/Projects/ (TypeScript, JavaScript, unknown)
- 88 Claude AutoMemory files in `~/.claude/projects/`
- 12 CLAUDE.md files at git repo roots
- 29 new projects (not yet in AR)

Scan time: **156ms** — fast, non-blocking.

### What it found vs. what the seeds represent

The scan did NOT discover the seed files at `~/Projects/AgentRecall/eval/seeds/migration/`. This is by design: bootstrap only reads:
1. Git repos in `~/Projects/`, `~/work/`, `~/code/`, `~/dev/`, `~/src/`, `~/repos/`, `~/github/`
2. Claude AutoMemory from `~/.claude/projects/*/memory/`
3. CLAUDE.md files at git repo roots

The seed files simulate the MEMORY.md format but live outside `~/.claude/`. A real migrating user's AutoMemory would be at `~/.claude/projects/` and would be picked up automatically.

### What it missed

- **Seed files themselves**: required manual import (they're not in `~/.claude/`)
- **Subdirectory CLAUDE.md**: only scans repo root, not nested packages
- **Non-git project dirs**: if a project has no `.git`, it's invisible
- **Feedback type distinction**: AutoMemory `type: feedback` vs `type: project` is not preserved in routing — all Claude memory files land in `knowledge` room

### Scan quality: 4/5

Scan is fast and correctly multi-source. Discovery logic is sound. Primary gap: no way to point at an arbitrary directory of seed/migration files.

---

## Task 2: Bootstrap Import

### What ran

```
AGENT_RECALL_ROOT=/tmp/ar-eval-migration ar bootstrap --import
```

### Result

- 29 projects created, 152 items imported, 0 errors
- Real AutoMemory (from `~/.claude/projects/-Users-tongwu/memory/`) → imported as `tongwu` project → 83 knowledge room files

### What was auto-imported

| Item | Imported? | Destination |
|------|-----------|-------------|
| Git repos (identity) | Yes | palace/identity.md |
| Git log (last 5 commits) | Yes | journal entry as "bootstrap" |
| CLAUDE.md (if at repo root) | Yes | architecture room |
| Claude AutoMemory `*.md` | Yes | knowledge room (flat dump) |
| Global `user_*.md` files | Yes | `_global` project knowledge room |

### What required manual intervention for the SEED files

Since seeds are not in `~/.claude/`, every seed file required manual `ar palace write` calls. Steps taken:
1. `ar palace write goals <content> --project novada-mcp` — project state
2. `ar palace write architecture <CLAUDE.md content> --project novada-mcp` — conventions
3. `ar palace write alignment <feedback content> --topic <name> --project novada-mcp` — corrections
4. `ar awareness update --insight ... --evidence <user-profile>` — user profile

**Critical blocker discovered**: Two bugs in the CLI that affect migration quality (see Top Issues).

### What got lost in translation

- **Feedback `type` metadata**: `type: feedback` in seed frontmatter is not mapped to AR's correction system — lands in alignment room as raw text
- **`type: project` state**: Not routed to goals/blockers — written to knowledge room alongside everything else
- **Version and semver info**: `v0.8.3`, `439 tests` embedded in project state text, not extracted into structured fields
- **Correction semantics**: AutoMemory has no `prior/posterior` structure. AR's alignment room accepts it but loses the correction trail

### Token cost of import

- Bootstrap auto-import: ~0 agent tokens (no LLM calls, pure file I/O)
- Manual seed import (4 palace write calls): ~200 tokens of prompting overhead per file
- Total for 6 seed files: ~1,200 tokens

---

## Task 3: Verify Import Quality

### Search tests

| Query | Result |
|-------|--------|
| `ar palace search "SERP blocked"` | Found — goals room, architecture room |
| `ar palace search "api framework"` | 0 results — no structured tagging |
| `ar search "SERP blocked"` (before manual write) | 0 results |
| `ar palace search "ambiguous"` | Found after manual write with correct args |
| `ar palace search "version inflation"` | 0 results — term not in stored text |
| `ar palace search "version bump"` | 0 results |
| `ar palace search "versioning" --project tongwu` | 20+ results from AutoMemory import |

### Is imported context usable for a real session?

Partially. The goals room (project state) and architecture room (CLAUDE.md) are retrievable and readable. The alignment room had **silent data loss** on the first two writes due to Bug #1.

### What survived cleanly

- Project state (version, test count, blockers, next goals) — in goals room
- CLAUDE.md conventions (key rules, architecture, current focus) — in architecture room
- User communication style — in awareness (with frontmatter noise)
- Real AutoMemory files — 83 files searchable in `tongwu` project knowledge room

### What was mangled or lost

- **Alignment room**: first two feedback file writes produced empty entries (Bug #1: YAML frontmatter in content strips everything after `---`)
- **All named-topic writes**: topic slug appended to content (Bug #2: CLI positional arg parser includes flag values in positional list)
- **User profile evidence in awareness**: raw YAML frontmatter (`---\nname: ...\n---`) is included verbatim in the stored insight evidence, leaking noise into cold-start output
- **Correction trail**: no `prior/posterior/delta` structure preserved from AutoMemory feedback entries

---

## Task 4: AutoMemory vs AgentRecall Structure

| Memory type | AutoMemory format | AgentRecall equivalent | Info preserved |
|-------------|------------------|----------------------|----------------|
| User profile | `user_profile.md` with frontmatter | awareness insight | ~70% — content preserved, YAML frontmatter bleeds into evidence |
| Project state | `project-*.md` flat markdown | palace/goals room | ~80% — text preserved, no structured version/status fields |
| Feedback/corrections | `feedback_*.md` with type metadata | palace/alignment room | ~40% — content present if written correctly, correction semantics lost |
| CLAUDE.md conventions | Flat markdown at repo root | palace/architecture room | ~90% — auto-imported cleanly by bootstrap |
| Correction trail | None in AutoMemory | alignment-log.json | N/A — AutoMemory has no equivalent; AR can add this |
| Memory type routing | Frontmatter `type:` field | Room-based routing | ~20% — type is ignored, everything goes to knowledge or manually routed |

---

## Task 5: First Session After Migration

### `ar cold-start --project novada-mcp`

Output includes:
- Identity: blank placeholder `_(fill in: 1-line purpose, primary language, key constraint)_` — bootstrap never filled this
- Awareness: user communication style present but with raw YAML frontmatter in the evidence block
- Top rooms: knowledge (salience 0.5), alignment (0.39), architecture (0.39)
- Insight count: 1
- Cache: 0 hot, 0 warm, 0 cold entries
- Journal entries: 0 for novada-mcp (no git log imported because novada-mcp has no journal)

### Would you know what to work on next?

**No.** The cold-start output tells you:
- User prefers terse, bilingual comms (from awareness)
- Alignment and architecture rooms exist
- Nothing about current blockers, priorities, or next actions

To get that you'd need to explicitly `ar palace walk --depth full --project novada-mcp`, which returns the goals and architecture content — but cold-start doesn't surface it.

### Are old priorities preserved?

Yes, if you manually query. `ar palace search "SERP"` returns the blocker. But it's not surfaced automatically in cold-start. AutoMemory surfaces everything at session start (it's injected into the system prompt). AR requires the agent to ask.

### What's better in AgentRecall vs AutoMemory

- **Searchability**: AR's palace search is project-scoped and keyword-ranked — far better than scanning flat files
- **Structure**: rooms provide semantic separation (goals vs blockers vs alignment vs architecture)
- **Correction trail**: AR has a dedicated alignment system; AutoMemory has none
- **Scale**: AR handles 29 projects without context bloat; AutoMemory injects everything

### What's worse in AgentRecall vs AutoMemory

- **Zero-config cold start**: AutoMemory requires zero setup and injects all context passively. AR requires the agent to actively call tools
- **Migration path**: No automated bridge from AutoMemory's flat markdown to AR's typed room structure
- **First-session context**: cold-start doesn't show current goals or blockers by default

---

## Top Issues (ranked by impact)

1. **Bug: YAML frontmatter in content causes silent data loss** — When the text passed to `ar palace write` begins with `---`, the entire content after the frontmatter is dropped and an empty entry is written. AutoMemory files all have frontmatter. This means any automated migration that reads AutoMemory files and pipes them into `palace write` will silently lose all content. Impact: HIGH. All feedback files fail to migrate unless frontmatter is stripped first.

2. **Bug: CLI positional arg parser includes flag values in content** — `ar palace write <room> "content" --topic mytopic` stores content as `"content mytopic"` because `mytopic` is not excluded from the positional arg list. The topic slug is always appended to the stored content. Impact: MEDIUM — content is readable but polluted; search recall degrades because topic name appears in body.

3. **No migration tool for AutoMemory-to-palace routing** — `bootstrap_import` dumps all Claude AutoMemory files into the `knowledge` room without reading the `type:` frontmatter field. A `feedback` file and a `project` file both land in `knowledge`. The routing that would make them useful (feedback → alignment, project → goals, correction → alignment with delta) does not exist. A migrating user must manually re-read and re-write every file.

4. **Bootstrap ignores arbitrary source directories** — `bootstrap_scan` only reads `~/.claude/projects/` and predefined `~/Projects/` etc. dirs. There is no `--source` flag to point at a custom seed directory. A user migrating from a non-standard setup (shared drive, Dropbox, custom path) has no automated path.

5. **Identity.md never populated from AutoMemory content** — After bootstrap, every project's `identity.md` contains the placeholder `_(fill in: 1-line purpose, primary language, key constraint)_`. The description from `package.json` or README is discovered during scan but not written into identity. The agent walking the palace gets no project description on cold-start.

6. **User profile frontmatter bleeds into awareness evidence** — The YAML frontmatter (`---\nname: ...\ntype: user\n---`) from the AutoMemory user profile is stored verbatim in the awareness insight evidence field. Every cold-start context block contains raw YAML, which is noise for agent consumption.

7. **cold-start doesn't surface goals or blockers** — The cold-start output only shows identity, awareness summary, and top room names/saliences. The actual content of goals, blockers, and trajectory rooms is absent. An agent finishing cold-start doesn't know what to work on next.

---

## AutoMemory vs AgentRecall Comparison

| Dimension | AutoMemory | AgentRecall | Winner |
|-----------|------------|-------------|--------|
| Structure | Flat markdown with frontmatter `type:` field | Typed palace rooms (goals/alignment/architecture/blockers) | AgentRecall |
| Searchability | None (file scan only) | Keyword-ranked palace search, project-scoped | AgentRecall |
| Agent readability | Flat injection — everything at once | Structured rooms — agent queries what it needs | AgentRecall |
| Human readability | Excellent — plain .md files, diff-friendly | Good — .md files in palace, but scattered across many paths | AutoMemory |
| Cold start quality | Excellent — all context auto-injected passively | Weak — requires active tool calls, identity blank | AutoMemory |
| Correction tracking | None | alignment room + alignment-log.json | AgentRecall |
| Migration path | N/A (source system) | Broken for frontmatter content | Neither |
| Setup friction | Zero (Claude manages it) | One-time bootstrap + manual routing | AutoMemory |
| Multi-project scale | Moderate (all files injected regardless) | Excellent (project-scoped, salience-ranked) | AgentRecall |

---

## First-Session Experience Post-Migration

- Knew what to work on? **No** — priorities present in palace but not surfaced by cold-start
- Context quality: **2/5** — goals and CLAUDE.md are in there but retrieval requires explicit queries
- Missing:
  - Identity description (blank placeholder)
  - Automatic goal/blocker surfacing at cold-start
  - Correction trail structure (prior/posterior)
  - Frontmatter-stripped awareness evidence

---

## Would you migrate?

**Partial — with conditions.**

I would use AgentRecall alongside AutoMemory, not as a replacement, until these are fixed:

1. The YAML frontmatter bug in `palace write` must be fixed — migration is unsafe without it
2. `cold-start` must surface goals and blockers content, not just room names
3. The bootstrap import should strip frontmatter and route by `type:` field (feedback → alignment, project → goals)
4. The identity.md placeholder must be filled from discovered metadata (description from README/package.json)

What I would migrate today without hesitation:
- The correction trail (AR's alignment room is genuinely better than AutoMemory's flat files)
- CLAUDE.md conventions (auto-imported cleanly)
- Multi-project tracking (AR handles 29 projects gracefully; AutoMemory injects everything)

What I would not migrate today:
- Primary project state (goals, blockers, priorities) — cold-start won't surface it
- Feedback memories — frontmatter bug causes silent data loss

---

## One-line verdict

The migration path is not safe for real users today: a silent data loss bug corrupts frontmatter-containing AutoMemory files on import, and cold-start doesn't restore working context — making the switch feel like starting over.
