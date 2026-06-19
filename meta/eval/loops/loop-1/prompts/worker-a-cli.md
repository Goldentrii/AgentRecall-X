# Worker A — CLI Arg Parser Fixes

## Role
You are a precision code fixer. Fix exactly the bugs described below. No refactoring, no extra changes. Minimal diffs only.

## Scope
File: `~/Projects/AgentRecall/packages/cli/src/index.ts`

## Bug B1: CLI positional arg parser

**Location:** The `palace write` case inside `switch (sub)`, around line 247–260.

**Root cause:** `const positional = palaceRest.filter((a) => !a.startsWith("--"))` has two flaws:
1. `---` (YAML frontmatter separator) starts with `--` → gets filtered out as if it were a flag. Any content containing `---` (e.g. AutoMemory files) silently loses those lines.
2. When `--topic mytopic` is used, `mytopic` doesn't start with `--` so it IS included in positionals → gets appended to content as `"content mytopic"`.

**Fix:** Replace the positional extraction with explicit known-flag skipping:

```typescript
// Replace lines that look like:
//   const positional = palaceRest.filter((a) => !a.startsWith("--"));
//   const room = positional[0] || "";
//   const content = positional.slice(1).join(" ");
// With:
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

## Bug B3: `ar rooms` entry count

**Location:** The `rooms` case in the switch at the bottom of main(), around line 1235–1255.

**Root cause:** Current code counts `.md` files excluding `README.md`. But most palace writes go INTO `README.md` (each write appends a `### date — importance` section). So the count is always 0 for the most common write pattern.

**Fix:** Also count `### ` header lines inside README.md:

```typescript
// Find lines like:
//   const files = fs.readdirSync(roomPath).filter(f => f.endsWith(".md") && f !== "README.md");
//   entryCount = files.length;
// Replace with:
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

Note: `fs` and `path` are already imported at the top of the file.

## Output

Write your result to:
`~/Projects/AgentRecall/eval/loops/loop-1/results/worker-a.md`

Include:
- The exact lines you changed (before → after)
- Confirmation that no other lines were touched
- Any TypeScript issues you spotted (don't fix them — just report)
