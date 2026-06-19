# Worker C2 Result — Bootstrap YAML Frontmatter Stripping + Type Routing

## Status: All 3 changes implemented. TypeScript: 0 errors.

---

## Change 1: stripFrontmatter helper — DONE

Added at line 252 in `bootstrap.ts`, after the existing `readReadmeDescription` helper.

```typescript
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

Handles files with no frontmatter gracefully (returns `{ body: content, meta: {} }`).

---

## Change 2: Type-based room routing — DONE

Added `getTargetRoom()` helper at line 264:

```typescript
function getTargetRoom(meta: Record<string, string>): string {
  switch (meta["type"]) {
    case "feedback": return "alignment";
    case "project":  return "goals";
    default:         return "knowledge";
  }
}
```

Applied in two places:

### 2a. Project-level `claude-memory:` handler (bootstrapImport, ~line 709)

Before: read raw content, always wrote to `"knowledge"` room.

After:
- Calls `stripFrontmatter(rawContent)` → `{ body, meta }`
- Uses `meta["name"]` as topic if present, else falls back to filename
- If `meta["type"] === "user"`: calls `awarenessUpdate({ insights: [{ title, evidence: body, ... }] })` — no palace write
- Otherwise: calls `getTargetRoom(meta)` → writes to `alignment`, `goals`, or `knowledge`

### 2b. Global items handler (bootstrapImport, ~line 783)

Same pattern applied to `scan.global_items` processing (`user_*.md` files). Global user-type files go to `awarenessUpdate` with no `project` field (global scope).

### Import added
`awarenessUpdate` imported from `./awareness-update.js` at the top of the file.
`palaceDir` imported from `../storage/paths.js` (needed for Problem 3).

---

## Change 3: Identity.md population from README/package.json — DONE

Inserted inside the `bootstrapImport` per-project loop, inside the `!createdThisProject` block (runs exactly once per project, right after `ensurePalaceInitialized`):

```typescript
// Problem 3: Populate identity.md from README/package.json if still placeholder
try {
  const identityPath = path.join(palaceDir(proj.slug), "identity.md");
  if (fs.existsSync(identityPath)) {
    const identityContent = fs.readFileSync(identityPath, "utf-8");
    if (identityContent.includes("_(fill in:")) {
      let description = "";
      // Try README.md — first non-heading non-empty line after # heading
      const readmePath = path.join(proj.path, "README.md");
      if (fs.existsSync(readmePath)) { ... }
      // Fallback: package.json description
      if (!description) { ... }
      if (description) {
        const updated = identityContent.replace(/>\s*_\(fill in:.*?\)_/, `> ${description}`);
        fs.writeFileSync(identityPath, updated, "utf-8");
      }
    }
  }
} catch { /* non-fatal */ }
```

**Interaction with existing identity item handler:** The existing `item.id === "identity"` branch calls `writeIdentity()` which writes a full computed identity (using `proj.description` from pkgInfo/README). For git-sourced projects, the placeholder will not appear because `writeIdentity` runs. The Problem 3 fix primarily helps claude-memory-only projects where no identity item exists and `ensurePalaceInitialized` creates a default identity.md with the placeholder.

---

## Decisions / Notes

- `type: "reference"` not explicitly cased — falls through to `default: return "knowledge"` which matches the brief's spec.
- `awarenessUpdate` for `type: user` uses `applies_when: ["always"]` and `severity: "important"` as sensible defaults. The brief did not specify these fields.
- Identity population is wrapped in its own try/catch separate from the item-level try/catch — failure to populate identity does not affect import counts or error reporting.
- `palaceDir` was already transitively available (used internally) but not imported in bootstrap.ts — added the explicit import.
- TypeScript compilation: `npx tsc --noEmit` — 0 errors.
