# Worker C3 — Bootstrap Source Flag + Check Tool Description

## Task 1: Add `--source <dir>` to bootstrap scan

**File:** `~/Projects/AgentRecall/packages/core/src/tools-logic/bootstrap.ts`

**Problem:** `bootstrapScan` only reads from hardcoded directories (`~/Projects/`, `~/.claude/projects/`, etc.). A user migrating from a non-standard setup (e.g., `/Volumes/Work/memory/`, Dropbox) has no automated path.

**Fix:** Add `source_dirs?: string[]` parameter to `bootstrapScan`:

```typescript
// Find the bootstrapScan function signature, likely:
// export async function bootstrapScan(): Promise<BootstrapScanResult>
// Change to:
export async function bootstrapScan(opts?: { source_dirs?: string[] }): Promise<BootstrapScanResult>
```

Inside the function, when building the list of directories to scan, append any `opts?.source_dirs` entries to the scan list.

Also update the CLI in `packages/cli/src/index.ts`, in the `bootstrap` case:
```typescript
// Find where bootstrapScan() is called with no args, change to:
const sourceDirs = getFlag("--source", rest)?.split(",");
const scan = await core.bootstrapScan(sourceDirs ? { source_dirs: sourceDirs } : undefined);
```

And update the help text in `printHelp()`:
```
  ar bootstrap               Scan machine for projects and show summary card
  ar bootstrap --source <dir1,dir2>  Also scan these custom directories
  ar bootstrap --import      Import all new projects into AgentRecall
```

## Task 2: Improve `check` tool description

**File:** `~/Projects/AgentRecall/packages/mcp-server/src/tools/check.ts`

**Problem:** The current description mentions "Optionally track decision trails" but a new agent using just the title "Check Understanding" and the brief description won't know about the full Bayesian decision trail capability.

**Fix:** Split the description into two clearly labeled use cases:

```typescript
description: 
  "TWO USE CASES: (1) Goal verification — record what you think the human wants, get warnings from past corrections. " +
  "Use before starting work: check({ goal: '...', confidence: 'high/medium/low' }). " +
  "(2) Decision trail — track a decision with Bayesian prior/posterior/evidence for calibrated judgment. " +
  "Use when making important technical or product decisions: add prior (0-1), evidence items, and posterior. " +
  "Set outcome when decision resolves to close the trail.",
```

## Output
Write result to `~/Projects/AgentRecall/eval/loops/loop-3/results/worker-c3.md`
