# Worker A — Result Report

## Status: DONE

Both bugs fixed. No other lines touched.

---

## Bug B1 Fix — `palace write` positional arg parser

**File:** `~/Projects/AgentRecall/packages/cli/src/index.ts`
**Location:** Lines 247–257 (after edit)

### Before (lines 248–250 original)
```typescript
        case "write": {
          const positional = palaceRest.filter((a) => !a.startsWith("--"));
          const room = positional[0] || "";
          const content = positional.slice(1).join(" ");
```

### After (lines 247–257 new)
```typescript
        case "write": {
          const knownPalaceFlags = new Set(["--topic", "--importance", "--connections", "--project", "--root"]);
          const positional: string[] = [];
          for (let i = 0; i < palaceRest.length; i++) {
            const arg = palaceRest[i];
            if (knownPalaceFlags.has(arg)) { i++; continue; } // skip flag + its value
            if (arg.startsWith("--")) continue;                 // skip unknown/future flags
            positional.push(arg);
          }
          const room = positional[0] || "";
          const content = positional.slice(1).join(" ");
```

**What changed:** Replaced the single-filter approach with an explicit known-flag skipper. Known flags (`--topic`, `--importance`, `--connections`, `--project`, `--root`) and their values are now consumed together via `i++`. Unknown `--` flags are skipped. Non-flag args (including `---` YAML separators) are preserved in `positional`.

---

## Bug B3 Fix — `ar rooms` entry count

**File:** `~/Projects/AgentRecall/packages/cli/src/index.ts`
**Location:** Lines 1254–1264 (after edit)

### Before (lines 1248–1249 original)
```typescript
          const files = fs.readdirSync(roomPath).filter(f => f.endsWith(".md") && f !== "README.md");
          entryCount = files.length;
```

### After (lines 1255–1263 new)
```typescript
          const topicFiles = fs.readdirSync(roomPath).filter(f => f.endsWith(".md") && f !== "README.md");
          entryCount = topicFiles.length;
          // Count entries inside README.md
          const readmePath = path.join(roomPath, "README.md");
          if (fs.existsSync(readmePath)) {
            const readmeContent = fs.readFileSync(readmePath, "utf-8");
            const entryMatches = readmeContent.match(/^### /gm);
            entryCount += entryMatches ? entryMatches.length : 0;
          }
```

**What changed:** Variable renamed `files` → `topicFiles` to clarify scope. After counting topic `.md` files, also opens `README.md` and counts `### ` header lines (each represents one `palace write` entry). The two counts are summed into `entryCount`.

---

## TypeScript Issues Spotted (not fixed — report only)

None spotted. `fs` and `path` are both imported at the top of the file (lines 3–4). The `Set<string>` and `string[]` types are inferred correctly without explicit annotations. The `i++` inside the `for` body is valid and increments before the outer `i++`, which correctly skips the flag value.
