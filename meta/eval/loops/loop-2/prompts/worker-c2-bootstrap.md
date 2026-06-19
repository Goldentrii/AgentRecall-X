# Worker C2 — Bootstrap YAML Frontmatter Stripping + Type Routing

## Role
Precision code fixer. Fix the bootstrap import to correctly handle AutoMemory files.

## File
`~/Projects/AgentRecall/packages/core/src/tools-logic/bootstrap.ts`

Read this file first. Then make the changes below.

## Problem 1: YAML frontmatter in AutoMemory files corrupts palace content

When importing AutoMemory `.md` files, their content starts with YAML frontmatter:
```
---
name: feedback-no-version-inflation
type: feedback
---
Never bump version numbers...
```

If passed directly to `palaceWrite`, the `---` delimiters were previously filtered (Bug B1 — now fixed). But the frontmatter metadata (`name:`, `type:`) still appears as raw content in the palace room, adding noise.

**Fix:** Strip YAML frontmatter from content before writing to palace. Add a helper:

```typescript
/** Strip YAML frontmatter from markdown content. */
function stripFrontmatter(content: string): { body: string; meta: Record<string, string> } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { body: content, meta: {} };

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) meta[kv[1].trim()] = kv[2].trim();
  }
  return { body: match[2].trim(), meta };
}
```

Apply this in the bootstrap import logic wherever AutoMemory file content is read and written to palace.

## Problem 2: AutoMemory `type:` field ignored — everything goes to knowledge room

Current behavior: all AutoMemory files → knowledge room.

AutoMemory files have `type:` in their frontmatter:
- `type: user` → awareness (user profile)
- `type: feedback` → palace/alignment room
- `type: project` → palace/goals room
- `type: reference` → palace/knowledge room (this is the correct default)

**Fix:** In the bootstrap import function, after `stripFrontmatter()`, check `meta.type` and route accordingly:

```typescript
function getTargetRoom(meta: Record<string, string>): string {
  switch (meta.type) {
    case "feedback": return "alignment";
    case "project": return "goals";
    case "user": return "awareness"; // handled specially (awareness, not palace)
    default: return "knowledge";
  }
}
```

For `type: user`, instead of palace write, use `awarenessUpdate` with the body content as the insight evidence. Use the `name` field from frontmatter as the insight title.

## Problem 3: Identity.md never populated from discovered metadata

After bootstrap, every project shows `_(fill in: 1-line purpose, primary language, key constraint)_`.

**Fix:** In the bootstrap import function, after creating the project, attempt to populate identity.md from:
1. README.md first line after `#` heading
2. OR package.json `description` field
3. If neither found: leave placeholder as-is

Look for where `ensurePalaceInitialized` is called in bootstrap.ts — after that, check for README.md in the project's discovered path and extract the description.

```typescript
// After ensurePalaceInitialized(slug):
const identityPath = path.join(palaceDir(slug), "identity.md");
const identityContent = fs.readFileSync(identityPath, "utf-8");
if (identityContent.includes("_(fill in:")) {
  // Try to extract description from README or package.json
  let description = "";
  const readmePath = path.join(projectSourceDir, "README.md");
  if (fs.existsSync(readmePath)) {
    const readmeLines = fs.readFileSync(readmePath, "utf-8").split("\n");
    // First non-empty line after the # heading
    let pastHeading = false;
    for (const line of readmeLines) {
      if (line.startsWith("# ")) { pastHeading = true; continue; }
      if (pastHeading && line.trim() && !line.startsWith("#")) {
        description = line.replace(/^[>_*]+/, "").trim().slice(0, 100);
        break;
      }
    }
  }
  if (!description) {
    const pkgPath = path.join(projectSourceDir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        if (pkg.description) description = pkg.description.slice(0, 100);
      } catch { /* skip */ }
    }
  }
  if (description) {
    const updated = identityContent.replace(
      />\s*_\(fill in:.*?\)_/,
      `> ${description}`
    );
    fs.writeFileSync(identityPath, updated, "utf-8");
  }
}
```

## Important
Read the actual bootstrap.ts first to understand its structure. The file may differ from these examples. Adapt the changes to fit the actual code structure. Do NOT rewrite the entire file — make minimal targeted edits.

## Output

Write result to:
`~/Projects/AgentRecall/eval/loops/loop-2/results/worker-c2.md`

Document:
- Whether the stripFrontmatter helper was added
- Where type-based routing was implemented
- Whether identity.md population was implemented
- Any parts that couldn't be implemented due to the actual bootstrap.ts structure
