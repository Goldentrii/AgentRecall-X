# Agent Beta — Bootstrap: Full Auto-Import Architecture

## Role + Scope
You are building the bootstrap import feature for AgentRecall. Your philosophy: **scan + import in one call**. The function discovers context, creates AR projects, and writes initial palace/journal entries. User consent is handled by a `dry_run` flag — when true, returns what WOULD be imported without writing.

You create ONE new file: `packages/core/src/tools-logic/bootstrap.ts`
You modify ONE existing file: `packages/core/src/index.ts` (add export)
Do NOT touch any other file.

## Context
Project: ~/Projects/AgentRecall
AgentRecall stores data at `~/.agent-recall/projects/<slug>/`. A new user has zero data here but may have rich context elsewhere.

Reusable imports (use these, don't reinvent):
- `import { getRoot } from "../types.js"`
- `import { ensurePalaceInitialized } from "../palace/rooms.js"`
- `import { writeIdentity } from "../palace/identity.js"`
- `import { ensureDir, todayISO } from "../storage/fs-utils.js"`
- `import { palaceWrite } from "./palace-write.js"` — writes content to a palace room
- `import { journalWrite } from "./journal-write.js"` — writes a journal entry
- `import * as fs from "node:fs"` and `import * as path from "node:path"`
- `import { execFile } from "node:child_process"` + `import { promisify } from "node:util"`

## What to build

### Interface

```typescript
export interface BootstrapOptions {
  scan_dirs?: string[];       // override default scan locations
  dry_run?: boolean;          // if true, scan only — report what would be imported
  import_claude_memory?: boolean;  // import ~/.claude/ memory files (default: true)
  import_git_history?: boolean;    // extract trajectory from git log (default: true)
  import_claudemd?: boolean;       // extract from CLAUDE.md files (default: true)
  max_projects?: number;           // limit imports (default: 20)
}

export interface BootstrapedProject {
  slug: string;
  name: string;
  source: string;
  actions_taken: string[];    // e.g. ["created palace", "wrote identity", "imported 5 memories"]
  skipped_reason?: string;    // if skipped, why
}

export interface BootstrapResult {
  mode: "dry_run" | "imported";
  projects: BootstrapedProject[];
  user_profile_imported: boolean;
  total_memories_imported: number;
  total_projects_created: number;
  total_skipped: number;
  scan_duration_ms: number;
}
```

### Function: bootstrap

```typescript
export async function bootstrap(options?: BootstrapOptions): Promise<BootstrapResult>
```

**Implementation (3 phases):**

#### Phase 1: Discover (same as scan)
- Scan common dirs (`~/Projects/`, `~/work/`, `~/code/`, `~/dev/`, `~/src/`) + `options.scan_dirs`
- For each dir, find git repos (`.git/` present, max depth 3)
- For each repo: extract name, language, last commit date, check for CLAUDE.md, package.json
- Scan `~/.claude/projects/*/memory/` for Claude AutoMemory
- Cross-reference: check which slugs already exist in `~/.agent-recall/projects/`
- Dedup by slug, skip `already_in_ar` projects

#### Phase 2: Import (skip if dry_run)
For each discovered project (up to `max_projects`):

**a) Initialize palace:**
```typescript
ensurePalaceInitialized(slug);
```

**b) Write identity.md:**
Combine sources into a meaningful identity:
```markdown
# {project_name}

{description from package.json or CLAUDE.md first 3 lines or README.md first line}

- Language: {detected language}
- Source: {git remote URL}
- Bootstrapped: {today's date} (auto-imported from {source})
```
```typescript
writeIdentity(slug, identityContent);
```

**c) Import Claude AutoMemory (if exists + flag enabled):**
For the matching `~/.claude/projects/*{slug}*/memory/` directory:
- Read each `.md` file (skip files > 2KB — too large, likely journals)
- For each file, call `palaceWrite({ room: "knowledge", topic: filename-without-ext, content: fileContent, project: slug })`
- Track count

**d) Extract CLAUDE.md → architecture room (if exists + flag enabled):**
```typescript
await palaceWrite({
  room: "architecture",
  topic: "claudemd-conventions",
  content: claudemdContent.slice(0, 3000), // first 3KB only
  project: slug,
});
```

**e) Write initial journal with git trajectory (if flag enabled):**
```typescript
const gitLog = await execGit(["log", "--oneline", "-5"], repoPath);
await journalWrite({
  content: `# Bootstrap — ${todayISO()}\n\n## Brief\nAuto-imported from ${source}.\n\n## Recent git activity\n${gitLog}\n\n## Next\nContinue from last git activity.`,
  project: slug,
  saveType: "arsave",
});
```

#### Phase 3: User profile (global)
If `~/.claude/projects/-Users-*/memory/user_*.md` exists:
- Read the file
- Write to AR awareness via a simple remember call or direct awareness update
- Set `user_profile_imported: true`

**Performance:**
- Git commands: 2s timeout each
- File reads: max 2KB per file, max 20 files per project
- Total: should complete in <15 seconds for 20 repos
- Use `Promise.allSettled` for parallel git + file operations

### Export
Add to `packages/core/src/index.ts`:
```typescript
export { bootstrap, type BootstrapOptions, type BootstrapResult, type BootstrapedProject } from "./tools-logic/bootstrap.js";
```

## What NOT to do
- Do NOT modify source files on the user's machine — only READ from them, WRITE to ~/.agent-recall/
- Do NOT import secrets (.env, credentials, API keys) — skip files matching these patterns
- Do NOT read files larger than 2KB (skip with a note)
- Do NOT import if project already exists in AR (skip with reason)
- Do NOT modify any file except bootstrap.ts and index.ts

## Verification
```bash
cd ~/Projects/AgentRecall && npm run build 2>&1 | tail -5
```

Then test dry run:
```bash
cd ~/Projects/AgentRecall && node -e "
const { bootstrap } = require('./packages/core/dist/index.js');
bootstrap({ dry_run: true }).then(r => {
  console.log('Mode:', r.mode);
  console.log('Would import:', r.projects.length, 'projects');
  console.log('Would import:', r.total_memories_imported, 'memories');
  r.projects.slice(0, 5).forEach(p => console.log('  ', p.slug, '-', p.actions_taken.join(', ')));
  console.log('Scan time:', r.scan_duration_ms, 'ms');
});
"
```

## Report back
- Dry-run results: how many projects found, how many memories would import
- Scan duration
- Build: PASS / FAIL
- List top 5 projects discovered with their actions
