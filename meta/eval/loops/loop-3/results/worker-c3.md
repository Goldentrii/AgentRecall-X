# Worker C3 — Results

## Status: DONE

## Changes Made

### 1. `packages/core/src/tools-logic/bootstrap.ts`

Added `source_dirs?: string[]` to the `bootstrapScan` options type and merged it into the `scanDirs` array alongside the existing `scan_dirs` param.

```typescript
export async function bootstrapScan(options?: {
  scan_dirs?: string[];
  source_dirs?: string[];
  max_depth?: number;
}): Promise<BootstrapScanResult>
```

Scan line:
```typescript
const scanDirs = [...DEFAULT_SCAN_DIRS, ...(options?.scan_dirs ?? []), ...(options?.source_dirs ?? [])];
```

Backward compatible: existing `scan_dirs` callers unaffected.

### 2. `packages/cli/src/index.ts`

Two edits:

**bootstrap case** (line ~1298): Added `--source` flag parsing before `bootstrapScan()` call.
```typescript
const sourceDirs = getFlag("--source", rest)?.split(",");
const scan = await core.bootstrapScan(sourceDirs ? { source_dirs: sourceDirs } : undefined);
```

**printHelp()**: Added `--source` line to BOOTSTRAP section.
```
ar bootstrap --source <dir1,dir2>  Also scan these custom directories
```

### 3. `packages/mcp-server/src/tools/check.ts`

Replaced single-line description with two-use-case format:
```typescript
description:
  "TWO USE CASES: (1) Goal verification — record what you think the human wants, get warnings from past corrections. " +
  "Use before starting work: check({ goal: '...', confidence: 'high/medium/low' }). " +
  "(2) Decision trail — track a decision with Bayesian prior/posterior/evidence for calibrated judgment. " +
  "Use when making important technical or product decisions: add prior (0-1), evidence items, and posterior. " +
  "Set outcome when decision resolves to close the trail.",
```

## Notes

- No new files created.
- All edits minimal and targeted.
- `source_dirs` and `scan_dirs` both work additively on top of `DEFAULT_SCAN_DIRS`. No deduplication issue since `findGitRepos` is idempotent and the result set uses `new Set(allRepoDirs)`.
