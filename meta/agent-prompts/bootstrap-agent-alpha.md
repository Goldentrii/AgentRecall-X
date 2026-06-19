# Agent Alpha — Bootstrap: Scan-Only Architecture

## Role + Scope
You are building the bootstrap scan feature for AgentRecall. Your philosophy: **read everything, write nothing**. The scan function returns a rich structured report. A separate import step (not your job) will act on it.

You create ONE new file: `packages/core/src/tools-logic/bootstrap.ts`
You modify ONE existing file: `packages/core/src/index.ts` (add export)
Do NOT touch any other file.

## Context
Project: ~/Projects/AgentRecall
AgentRecall stores data at `~/.agent-recall/projects/<slug>/`. A new user has zero data here but may have rich context elsewhere on their machine.

Reusable imports:
- `import { getRoot } from "../types.js"` — gets `~/.agent-recall/`
- `import { ensureDir, todayISO } from "../storage/fs-utils.js"`
- `import * as fs from "node:fs"` and `import * as path from "node:path"`
- `import { execFile } from "node:child_process"` + `import { promisify } from "node:util"`

## What to build

### Interface: BootstrapScanResult

```typescript
export interface DiscoveredProject {
  slug: string;                    // kebab-case project name
  source: "git" | "claude-memory" | "claudemd" | "package-json";
  path: string;                    // absolute path to the project root
  name: string;                    // human-readable name
  description?: string;            // from README first line, package.json, or CLAUDE.md
  language?: string;               // primary language detected
  last_activity?: string;          // ISO date of last git commit or file modification
  has_claudemd?: boolean;          // CLAUDE.md exists in project root
  has_claude_memory?: boolean;     // ~/.claude/projects/*<slug>*/memory/ exists
  memory_file_count?: number;      // number of .md files in Claude memory dir
  git_remote?: string;             // git remote origin URL
  already_in_ar?: boolean;         // project already has ~/.agent-recall/projects/<slug>/
}

export interface BootstrapScanResult {
  projects: DiscoveredProject[];
  user_profile?: string;           // from ~/.claude/projects/-Users-*/memory/user_*.md
  total_claude_memories: number;    // total .md files across all Claude memory dirs
  total_git_repos: number;
  total_already_imported: number;   // how many are already in AR
  scan_duration_ms: number;
}
```

### Function: bootstrapScan

```typescript
export async function bootstrapScan(options?: {
  scan_dirs?: string[];    // override default scan locations
  max_depth?: number;      // how deep to search (default: 3)
  include_archived?: boolean; // include repos with no commits in 90 days
}): Promise<BootstrapScanResult>
```

**Scan order (each step is independent, combine results):**

#### Step 1: Git repo discovery
- Scan `~/Projects/`, `~/work/`, `~/code/`, `~/dev/`, `~/src/`, `~/repos/`, `~/github/` (only dirs that exist)
- Also scan `options.scan_dirs` if provided
- For each directory, walk up to `max_depth` levels looking for `.git/` directories
- For each git repo found:
  - Extract name from `git config --get remote.origin.url` (basename, strip .git) or dirname
  - Extract last commit date: `git log -1 --format=%aI`
  - Detect primary language: count file extensions in top-level dir (.ts → TypeScript, .py → Python, .go → Go, .rs → Rust, .java → Java, .rb → Ruby)
  - Check for CLAUDE.md in root
  - Check for package.json/Cargo.toml/go.mod/pyproject.toml → extract name/description
- Skip: node_modules, .git, vendor, dist, build, __pycache__, .venv directories
- Skip repos with no commits in 90 days unless `include_archived`

#### Step 2: Claude AutoMemory discovery
- Scan `~/.claude/projects/` directories
- Each subdir is a slug-encoded path (e.g., `-Users-tongwu-Projects-myapp`)
- Decode the slug: replace leading `-` with `/`, replace internal `-` with `/` (heuristic: look for `memory/MEMORY.md` to confirm it's a valid project)
- Count `.md` files in `memory/` dir
- Look for `memory/user_*.md` files → read first file's content as `user_profile` (this is who the user is)

#### Step 3: CLAUDE.md discovery
- For each git repo found in Step 1, check if `CLAUDE.md` exists
- Set `has_claudemd: true` on matching projects
- Read first 3 lines of CLAUDE.md → use as `description` if no other source

#### Step 4: Cross-reference with existing AR data
- Read `~/.agent-recall/projects/` → list existing slugs
- For each discovered project, check if slug already exists in AR
- Set `already_in_ar: true` if so

#### Step 5: Dedup and merge
- Same project may be discovered from multiple sources (git + claude-memory + claudemd)
- Merge by slug: prefer git source for path/language/activity, claude-memory for memory_file_count, claudemd for description
- Sort by: `already_in_ar: false` first (new projects), then by `last_activity` descending

**Performance constraints:**
- Each git command gets a 2-second timeout
- Total scan should complete in <10 seconds for ~20 repos
- Use `Promise.all` for parallel git commands within each dir
- Never read file contents larger than 1KB (just first lines for description)

### Export
Add to `packages/core/src/index.ts`:
```typescript
export { bootstrapScan, type BootstrapScanResult, type DiscoveredProject } from "./tools-logic/bootstrap.js";
```

## What NOT to do
- Do NOT write to `~/.agent-recall/` — this is scan-only
- Do NOT read source code files — only metadata (package.json, CLAUDE.md first lines, git log)
- Do NOT modify any file except bootstrap.ts and index.ts
- Do NOT add CLI commands or MCP tools — just the core function

## Verification
```bash
cd ~/Projects/AgentRecall && npm run build 2>&1 | tail -5
```

Then test the scan:
```bash
cd ~/Projects/AgentRecall && node -e "
const { bootstrapScan } = require('./packages/core/dist/index.js');
bootstrapScan().then(r => {
  console.log('Projects found:', r.projects.length);
  console.log('Git repos:', r.total_git_repos);
  console.log('Claude memories:', r.total_claude_memories);
  console.log('Already in AR:', r.total_already_imported);
  console.log('User profile:', r.user_profile?.slice(0, 100));
  console.log('Top 5:');
  r.projects.slice(0, 5).forEach(p => console.log('  ', p.slug, p.source, p.last_activity?.slice(0,10) ?? 'no-date', p.already_in_ar ? '[exists]' : '[new]'));
  console.log('Scan time:', r.scan_duration_ms, 'ms');
});
"
```

## Report back
- Number of projects discovered on this machine
- Scan duration
- User profile found (yes/no)
- Build: PASS / FAIL
- Any errors during scan
