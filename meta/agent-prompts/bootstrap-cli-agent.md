# Agent CLI — Wire bootstrap into `ar` CLI

## Role + Scope
You are adding the `ar bootstrap` command to AgentRecall's CLI.
You modify ONLY `packages/cli/src/index.ts`. Do NOT touch any other file.

## Context
Project: ~/Projects/AgentRecall
The core functions already exist and are exported:
```typescript
import { bootstrapScan, bootstrapImport, type BootstrapScanResult } from "agent-recall-core";
```

Read `packages/cli/src/index.ts` to understand:
- How other commands are structured (look at `case "cold-start":` and `case "saveall":` for patterns)
- The `getFlag()` helper for parsing flags
- The `output()` function for printing results
- The `dryRun` flag pattern (look at `case "saveall":` for how `--dry-run` is handled)

## What to build

Add a `case "bootstrap":` block that supports these sub-commands:

### `ar bootstrap` (no args — interactive scan + prompt)
1. Call `bootstrapScan()`
2. Print a formatted status card:
```
──────────────────────────────────────────────────────────────
  AgentRecall  Bootstrap Scan         2026-04-25
──────────────────────────────────────────────────────────────

  Found on your machine:
    24 git repos (~/Projects/, ~/work/)
    92 Claude memory files (~/.claude/projects/)
     3 CLAUDE.md files

  Projects:
    18 new (not yet in AgentRecall)
    10 already imported

  Scan time: 141ms

  To import: ar bootstrap --import
  To preview: ar bootstrap --dry-run
──────────────────────────────────────────────────────────────
```
3. Print the top 10 new projects (not already in AR) as a numbered list:
```
  New projects found:
   1  agentrecall               TypeScript   2026-04-25   git+claude-memory
   2  agent-chrome-bridge       TypeScript   2026-04-20   git
   3  bestproxy4agents-mcp      TypeScript   2026-04-18   git+claudemd
   ...
```

### `ar bootstrap --dry-run`
1. Call `bootstrapScan()`
2. Call `bootstrapImport(scanResult, { /* no selection = import all new */ })` — BUT wait, dry_run is not on bootstrapImport. Instead, just print what WOULD be imported:
   - For each new project: list the importable_items with their types and sizes
   - Total items that would be imported
   - Do NOT actually call bootstrapImport

### `ar bootstrap --import`
1. Call `bootstrapScan()`
2. Call `bootstrapImport(scanResult)` — import all new projects
3. Print results:
```
  Imported:
    12 projects created
    87 items imported
     3 items skipped
     0 errors

  Run /arstatus to see your projects.
```

### `ar bootstrap --import --project <slug>`
1. Call `bootstrapScan()`
2. Call `bootstrapImport(scanResult, { project_slugs: [slug] })`
3. Print results for that single project

### Flags to support:
- `--dry-run` — show what would be imported without importing
- `--import` — actually run the import
- `--project <slug>` — limit to one project
- `--include-archived` — include repos with no recent commits (passed to scan)

## Implementation pattern

Follow the existing CLI pattern:
```typescript
case "bootstrap": {
  const dryRun = rest.includes("--dry-run");
  const doImport = rest.includes("--import");
  const includeArchived = rest.includes("--include-archived");
  const targetProject = getFlag("--project", rest);
  
  const scan = await core.bootstrapScan({ include_archived: includeArchived });
  
  if (doImport) {
    // import logic
  } else if (dryRun) {
    // dry-run preview
  } else {
    // default: show scan card
  }
  break;
}
```

## Output formatting
- Use box-drawing characters for the card (same style as /arsave and /arstatus cards in the codebase)
- Align columns with padding
- Use `output()` for all printing
- Keep the card concise — max 30 lines

## Verification
```bash
cd ~/Projects/AgentRecall && npm run build 2>&1 | tail -5
```

Then test:
```bash
cd ~/Projects/AgentRecall && node dist/index.js bootstrap
cd ~/Projects/AgentRecall && node dist/index.js bootstrap --dry-run
```
(Do NOT run --import in the test — scan and dry-run only)

## Report back
- Lines added to index.ts
- Sub-commands implemented (list)
- Build: PASS / FAIL
- Scan card output (paste it)
