# Agent Gamma — Bootstrap: Layered Scan + Selective Import Architecture

## Role + Scope
You are building the bootstrap feature for AgentRecall with a two-function design: `bootstrapScan()` discovers everything, `bootstrapImport()` imports selected items. This gives the orchestrator/CLI/MCP full control over what gets imported.

You create ONE new file: `packages/core/src/tools-logic/bootstrap.ts`
You modify ONE existing file: `packages/core/src/index.ts` (add exports)
Do NOT touch any other file.

## Context
Project: ~/Projects/AgentRecall
AgentRecall stores data at `~/.agent-recall/projects/<slug>/`. New user = empty store, but machine has context.

Reusable imports:
- `import { getRoot } from "../types.js"`
- `import { ensurePalaceInitialized } from "../palace/rooms.js"`
- `import { writeIdentity } from "../palace/identity.js"`
- `import { ensureDir, todayISO } from "../storage/fs-utils.js"`
- `import { palaceWrite } from "./palace-write.js"`
- `import { journalWrite } from "./journal-write.js"`
- `import * as fs from "node:fs"` and `import * as path from "node:path"`
- `import { execFile } from "node:child_process"` + `import { promisify } from "node:util"`

## What to build

### Types

```typescript
export interface DiscoveredProject {
  slug: string;
  name: string;
  path: string;
  sources: Array<{
    type: "git" | "claude-memory" | "claudemd" | "package-json";
    path: string;
    detail: string;  // e.g. "12 memory files", "TypeScript, last commit 2026-04-20"
  }>;
  description?: string;
  language?: string;
  last_activity?: string;
  already_in_ar: boolean;
  importable_items: ImportableItem[];  // what CAN be imported from this project
}

export interface ImportableItem {
  id: string;           // unique within project: "identity", "claude-memory:filename", "claudemd", "git-trajectory"
  type: "identity" | "memory" | "architecture" | "trajectory";
  source_path: string;  // where the data lives
  size_bytes: number;   // how much data
  preview: string;      // first 100 chars of content
}

export interface BootstrapScanResult {
  projects: DiscoveredProject[];
  global_items: ImportableItem[];  // user profile, global memories
  stats: {
    total_projects: number;
    total_importable_items: number;
    total_already_in_ar: number;
    scan_duration_ms: number;
  };
}

export interface ImportSelection {
  project_slugs?: string[];     // which projects to import (default: all new ones)
  item_types?: string[];        // which item types (default: all)
  skip_items?: string[];        // specific item IDs to skip
  include_global?: boolean;     // import global items like user profile (default: true)
}

export interface ImportResult {
  projects_created: number;
  items_imported: number;
  items_skipped: number;
  errors: Array<{ project: string; item: string; error: string }>;
  duration_ms: number;
}
```

### Function 1: bootstrapScan

```typescript
export async function bootstrapScan(options?: {
  scan_dirs?: string[];
  max_depth?: number;       // default 3
}): Promise<BootstrapScanResult>
```

**Discovery logic:**

1. **Git repos**: Scan `~/Projects/`, `~/work/`, `~/code/`, `~/dev/`, `~/src/`, `~/repos/` + `options.scan_dirs`. Walk to `max_depth` looking for `.git/`. For each repo:
   - Name from git remote URL basename or dirname
   - Language from top-level file extensions (.ts/.tsx → TypeScript, .py → Python, etc.)
   - Last activity from `git log -1 --format=%aI` (2s timeout)
   - Description from package.json `.description` or README.md first non-empty non-heading line
   - Generate `importable_items`:
     - `{ id: "identity", type: "identity", ... }` — always (creates identity.md from name+description+language)
     - `{ id: "git-trajectory", type: "trajectory", ... }` — if git log available (creates initial journal)
     - `{ id: "claudemd", type: "architecture", ... }` — if CLAUDE.md exists (imports to architecture room)

2. **Claude AutoMemory**: Scan `~/.claude/projects/`. For each subdir with `memory/MEMORY.md`:
   - Decode slug-encoded path to find matching project
   - List all `.md` files in `memory/` (skip files > 5KB)
   - Each file becomes an ImportableItem: `{ id: "claude-memory:{filename}", type: "memory", ... }`
   - Read first 100 chars of each as `preview`

3. **Global items**: Check for `~/.claude/projects/-Users-*/memory/user_*.md` → global `ImportableItem` for user profile

4. **Cross-reference**: Check `~/.agent-recall/projects/` for existing slugs → set `already_in_ar`

5. **Merge**: Same project from multiple sources → merge into single `DiscoveredProject` with multiple `sources` entries

**Performance:**
- Git commands: 2s timeout, `Promise.allSettled` for parallel execution
- File reads: only first 100 chars for preview, max 5KB for full import
- Skip patterns: node_modules, .git, vendor, dist, build, __pycache__, .venv
- Secret patterns: .env, credentials, secrets, tokens, .pem, .key — never read these

### Function 2: bootstrapImport

```typescript
export async function bootstrapImport(
  scan: BootstrapScanResult,
  selection?: ImportSelection
): Promise<ImportResult>
```

**Import logic:**

For each selected project (default: all where `already_in_ar === false`):

1. `ensurePalaceInitialized(slug)`

2. For each selected `importable_item`:
   - **identity**: Write identity.md with name + description + language + source info
     ```typescript
     writeIdentity(slug, `# ${name}\n\n${description}\n\n- Language: ${language}\n- Source: ${git_remote}\n- Bootstrapped: ${todayISO()}`);
     ```
   
   - **memory** (claude-memory files): Read source file, write to palace knowledge room
     ```typescript
     await palaceWrite({ room: "knowledge", topic: itemId.replace("claude-memory:", ""), content, project: slug });
     ```
   
   - **architecture** (CLAUDE.md): Read first 3KB, write to architecture room
     ```typescript
     await palaceWrite({ room: "architecture", topic: "project-conventions", content: claudemdContent.slice(0, 3000), project: slug });
     ```
   
   - **trajectory** (git log): Write initial journal entry
     ```typescript
     await journalWrite({ content: `# Bootstrap — ${todayISO()}\n\n## Brief\nAuto-imported. Recent: ${gitLogOneline}\n\n## Next\nContinue from last activity.`, project: slug, saveType: "arsave" });
     ```

3. For global items (user profile):
   - Read the user_*.md file
   - Write to awareness or palace knowledge (the existing `smartRemember` function handles routing)

4. Collect errors (never throw — best effort per item)

### Export
Add to `packages/core/src/index.ts`:
```typescript
export {
  bootstrapScan,
  bootstrapImport,
  type BootstrapScanResult,
  type DiscoveredProject,
  type ImportableItem,
  type ImportSelection,
  type ImportResult,
} from "./tools-logic/bootstrap.js";
```

## What NOT to do
- Do NOT modify source files — only READ from user's machine, WRITE to ~/.agent-recall/
- Do NOT import files matching secret patterns (.env, credentials, .pem, .key, tokens)
- Do NOT read files larger than 5KB (skip with note in preview)
- Do NOT import if project already exists in AR (skip, report in result)
- Do NOT touch any file except bootstrap.ts and index.ts

## Verification
```bash
cd ~/Projects/AgentRecall && npm run build 2>&1 | tail -5
```

Then test scan:
```bash
cd ~/Projects/AgentRecall && node -e "
const { bootstrapScan } = require('./packages/core/dist/index.js');
bootstrapScan().then(r => {
  console.log('=== SCAN RESULTS ===');
  console.log('Projects:', r.stats.total_projects);
  console.log('Importable items:', r.stats.total_importable_items);
  console.log('Already in AR:', r.stats.total_already_in_ar);
  console.log('Global items:', r.global_items.length);
  console.log('Scan time:', r.stats.scan_duration_ms, 'ms');
  console.log('\\nTop 5 projects:');
  r.projects.slice(0, 5).forEach(p => {
    console.log(' ', p.slug, p.already_in_ar ? '[exists]' : '[NEW]');
    console.log('    sources:', p.sources.map(s => s.type).join(', '));
    console.log('    items:', p.importable_items.length);
  });
});
"
```

## Report back
- Scan results: projects found, importable items, already-in-AR count
- Global items found (user profile?)
- Scan duration
- Build: PASS / FAIL
- Top 5 projects with their source types
