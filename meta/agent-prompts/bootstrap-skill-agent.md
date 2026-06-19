# Agent Skill — Document bootstrap in SKILL.md

## Role + Scope
You are documenting the bootstrap feature in AgentRecall's SKILL.md.
You modify ONLY `~/Projects/AgentRecall/SKILL.md`. Do NOT touch any other file.

## Context
Project: ~/Projects/AgentRecall

Bootstrap is a new feature that helps new users import existing context into AgentRecall. Two core functions:
- `bootstrapScan()` — discovers git repos, Claude AutoMemory, CLAUDE.md files across the machine. Returns structured report with per-item inventory.
- `bootstrapImport(scan, selection)` — selectively imports discovered items into AR palace, identity, journal.

Also available as:
- CLI: `ar bootstrap`, `ar bootstrap --dry-run`, `ar bootstrap --import`
- MCP tools: `bootstrap_scan`, `bootstrap_import`

## What to write

Read the current SKILL.md first. Then add a new section AFTER the `project_status` tool documentation and BEFORE the `## Session Flow` section.

### Content to add:

```markdown
### `bootstrap_scan`

**When:** First time using AgentRecall, or when /arstatus shows an empty board.

**What it does:** Scans your machine for existing projects — git repos, Claude AutoMemory (`~/.claude/projects/`), and CLAUDE.md files. Returns a structured report of what CAN be imported. Read-only, no writes.

**What it scans:**
- `~/Projects/`, `~/work/`, `~/code/`, `~/dev/`, `~/src/` for git repos
- `~/.claude/projects/` for Claude AutoMemory (user profile, project memories, feedback)
- CLAUDE.md files in project roots

**How to use:**
```
bootstrap_scan()
```

**Returns:** `projects` (array of discovered projects with importable items), `global_items` (user profile), `stats` (totals + scan duration)

### `bootstrap_import`

**When:** After reviewing bootstrap_scan results, to import selected projects.

**What it does:** Creates AgentRecall entries for discovered projects — palace rooms, identity.md, knowledge entries from Claude memory, initial journal from git history.

**How to use:**
```
bootstrap_import({
  scan_result: "<JSON from bootstrap_scan>",
  project_slugs: ["my-app", "api-server"],    // optional: import only these
  item_types: ["identity", "architecture"]     // optional: import only these types
})
```

**CLI equivalent:**
```bash
ar bootstrap                    # scan and show what's available
ar bootstrap --dry-run          # preview what would be imported
ar bootstrap --import           # import all new projects
ar bootstrap --import --project my-app  # import one project
```

**What gets imported per project:**
- `identity` — palace identity.md from project name + description + language
- `memory` — Claude AutoMemory .md files → palace knowledge room
- `architecture` — CLAUDE.md content → palace architecture room
- `trajectory` — git log → initial journal entry with recent activity

**Safety:**
- Scan is read-only — never writes to your machine or to AgentRecall
- Import only writes to `~/.agent-recall/`, never modifies source files
- Skips `.env`, credentials, `.pem`, `.key` files — never reads secrets
- Projects already in AgentRecall are skipped (no double-import)
```

### Also update these existing sections:

1. **Tool count in description**: Should already be "8 MCP tools" — verify. If not, update to "10 MCP tools" (adding bootstrap_scan + bootstrap_import).

2. **Best Practices section**: Add item 9:
```
9. **Run bootstrap on first install.** If `/arstatus` shows no projects, `bootstrap_scan` discovers what's already on your machine and imports it in seconds.
```

3. **Storage section**: Verify the existing paths section is complete. No changes needed if already up to date.

## What NOT to do
- Do NOT modify any file except SKILL.md
- Do NOT change existing tool documentation — only ADD the bootstrap section
- Do NOT remove or reorder existing content
- Do NOT add code examples that differ from the actual function signatures

## Verification
Read the final SKILL.md and confirm:
1. bootstrap_scan and bootstrap_import are documented
2. CLI commands are listed
3. Safety section covers all 4 points
4. Tool count is correct (should be 10 after adding these 2)
5. Best Practices has the new item

## Report back
- Sections added (list)
- Tool count updated to: [number]
- Best Practices item added: yes/no
- Word count of new content: [approximate]
