/**
 * store-manifest.ts — the store-ROOT self-description (sibling of
 * memory-protocol.ts, one level up). Writes a `MANIFEST.md` at the top of the
 * AgentRecall store (default `~/.agent-recall`, or `AGENT_RECALL_ROOT`) so a
 * cold agent with ONLY filesystem access — no AgentRecall code, no MCP, a
 * bare copy of the directory dropped into a VM — can orient itself.
 *
 * Design rationale (2026-07-27 round table): `MEMORY-PROTOCOL.md` (see
 * memory-protocol.ts) explains ONE project's folder layout, but nothing
 * explains the STORE itself — which of the many `projects/<slug>/`
 * directories are canonical vs. throwaway test junk, which root files are
 * pinned source-of-truth vs. regenerable caches, that `_index.md` files are
 * machine indexes and not memory entries, or that a naming grammar exists at
 * all. That knowledge lived only in this code repo's docs — invisible from
 * the data directory alone. This file closes that gap.
 *
 * Same write-once contract as memory-protocol.ts: written ONCE, never
 * overwrites an existing MANIFEST.md (a user may hand-edit it), and every
 * path inside the generated body is store-root-RELATIVE — never `~` or a
 * machine-absolute path, so the body stays valid after the store is copied
 * to a different machine or home directory.
 *
 * One guarded exception (3.5.4, P0-2): v1 told agents and restores that the
 * lesson files were "safe to delete", and nothing rebuilds them. An UNEDITED
 * v1 manifest is therefore upgraded in place to v2 — only the four lines this
 * code generated change, by tmp + rename — and an edited one is left alone
 * (`ar doctor` warns about it). The upgrade runs from the raw-dump write
 * (archive-write.ts) and `ar repair --apply`, never from a read path such as
 * session_start.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { ensureDir, renameAtomic } from "./fs-utils.js";
import { VERSION } from "../types.js";

const MANIFEST_FILENAME = "MANIFEST.md";

export const MANIFEST_VERSION = 2;

/**
 * The lesson and recall-feedback files: the ONLY copy of that data (nothing
 * rebuilds them). v1 classified them as regenerable.
 */
export const MANIFEST_LESSON_FILES: readonly string[] = [
  "insights-index.json",
  "awareness-state.json",
  "awareness-archive.json",
  "feedback-log.json",
];

// ── v1 text, byte-exact from the v3.5.3 tag. The generator never changed
// between its introduction and 3.5.3, so every v1 manifest carries exactly
// these lines (generated_by varies and is not matched). The full rendered v1
// body is test/fixtures/manifest-v1-3.5.3.md.
const V1_VERSION_LINE = "manifest_version: 1";
const V1_SYNC_ROW =
  "| sync | pinned, source-of-truth; safe and intended to sync elsewhere | `status.md`, `awareness.md`, `ARCHITECTURE.md`, `projects/**` |";
const V1_REGENERABLE_ROW =
  "| regenerable | derived caches; safe to delete, rebuilt automatically on next use | `dashboard.json`, `dashboard.html`, `dashboard-legacy.html`, `scoreboard.json`, `feedback-log.json`, `insights-index.json`, `arstatus-cache.json`, `awareness-archive.json`, `awareness-state.json`, `static/`, `.ambient-counter-*`, `.consolidation-queue/` |";
const V1_RESTORE = [
  "When restoring or mirroring this store: copy `sync` plus everything under",
  "`projects/`; skip `never-sync` (rotate credentials instead of copying",
  "them — never move `config.json` between machines); let `regenerable`",
  "rebuild itself on next use.",
].join("\n");

// ── v2 text. buildManifestBody renders exactly these, so an upgraded v1 file
// equals a fresh v2 file except for generated_by and the user's own edits.
const V2_VERSION_LINE = `manifest_version: ${MANIFEST_VERSION}`;
const V2_SYNC_ROW =
  "| sync | pinned, source-of-truth; safe and intended to sync elsewhere | `status.md`, `awareness.md`, `ARCHITECTURE.md`, `insights-index.json`, `awareness-state.json`, `awareness-archive.json`, `feedback-log.json`, `projects/**` |";
const V2_REGENERABLE_ROW =
  "| regenerable | derived caches; safe to delete, rebuilt automatically on next use | `dashboard.json`, `dashboard.html`, `dashboard-legacy.html`, `scoreboard.json`, `arstatus-cache.json`, `static/`, `.ambient-counter-*`, `.consolidation-queue/` |";
const V2_RESTORE = [
  "`insights-index.json`, `awareness-state.json`, `awareness-archive.json` and",
  "`feedback-log.json` are primary data: the only copy of the store's lessons",
  "and recall feedback. Nothing rebuilds them. Never delete them.",
  "",
  "When restoring or mirroring this store: copy `sync` (including those four",
  "lesson files) plus everything under `projects/`; skip `never-sync` (rotate",
  "credentials instead of copying them — never move `config.json` between",
  "machines). Only the files in the `regenerable` row may be skipped; they",
  "rebuild themselves on next use.",
].join("\n");

const V1_TO_V2: ReadonlyArray<readonly [string, string]> = [
  [V1_VERSION_LINE, V2_VERSION_LINE],
  [V1_SYNC_ROW, V2_SYNC_ROW],
  [V1_REGENERABLE_ROW, V2_REGENERABLE_ROW],
  [V1_RESTORE, V2_RESTORE],
];

function buildManifestBody(): string {
  return `---
${V2_VERSION_LINE}
generated_by: agent-recall-core@${VERSION}
---

# AgentRecall — Store Manifest

> This directory is a portable agent memory store. Restore = copy the
> directory to any machine and point the \`AGENT_RECALL_ROOT\` environment
> variable at the copy (defaults to a dot-directory under the current
> user's home when unset) — no database, no server, no other state
> required.

## Orientation (cold-agent read order)

1. \`status.md\` — current cross-project status board.
2. \`projects/<slug>/MEMORY-PROTOCOL.md\` — the per-project self-describing
   protocol (folder layout, read/write rules) for the project you're in.
3. Per-store \`_index.md\` files inside that project (e.g.
   \`palace/rooms/_index.md\`, \`corrections/_index.md\`, \`journal/_index.md\`)
   — machine fast-path summaries, regenerated on every write.
4. File bodies — open these only when the index above is not confident
   enough to answer.

## \`projects/\` convention

One directory per project, under \`projects/<slug>/\`. Inside any store
directory, a file whose name starts with \`_\` (e.g. \`_index.md\`) is a
regenerated INDEX, not a memory entry: never recall it as content, and never
hand-edit it — the next write to that store overwrites it wholesale.

## File classification (root-relative)

| class | meaning | examples |
|---|---|---|
${V2_SYNC_ROW}
| never-sync | secrets or machine-local locks; must never leave this machine or be echoed anywhere | \`config.json\` (contains credentials — do not read or print it), \`*.lock\`, \`.hook-*-lock\`, \`tmp/\` |
${V2_REGENERABLE_ROW}

${V2_RESTORE}

## Naming grammar (condensed self-contained summary)

- \`--\` is the FIELD delimiter; a plain \`-\` only ever appears INSIDE a field.
- journal: \`{date}--{saveType}--[{sig}]--[{theme}]--{slug}.md\` (null
  \`sig\`/\`theme\` are omitted, never printed as literal "none").
- corrections: \`{date}--{rule-slug}.json\`.
- palace rooms: \`{topic-slug}.md\` — one file per topic, with dated
  \`### {date}\` blocks appended inside; NOT one file per entry.
- palace pipeline: \`{NNNN}--{phase-slug}.md\`.
- palace skills: \`{topic}--{slug}.md\` (topical, no date — reference store).
- awareness / insights: \`{date}--{slug}.md\`.
- Mutable state (severity escalation, retraction, supersession) lives ONLY
  in a store's \`_index.md\` and the file body — NEVER encoded in a path.
`;
}

/**
 * Write the store-root MANIFEST.md if it is absent (write-once). Mirrors
 * writeMemoryProtocol's contract exactly: best-effort, never throws — returns
 * the path (written or pre-existing) or an empty string on failure. `root` is
 * the store root (typically the caller's `getRoot()`), passed explicitly so
 * this function stays fs-root-agnostic and testable against a temp directory.
 */
export function ensureStoreManifest(root: string): string {
  try {
    const dest = path.join(root, MANIFEST_FILENAME);
    if (fs.existsSync(dest)) {
      // write-once — never overwrite a user edit. The single exception is the
      // guarded v1 → v2 upgrade of an unedited generated manifest.
      upgradeStoreManifest(root);
      return dest;
    }
    ensureDir(root);
    fs.writeFileSync(dest, buildManifestBody(), "utf-8");
    return dest;
  } catch {
    return "";
  }
}

/**
 * State of an existing MANIFEST.md with respect to the lesson-file fix:
 *   absent        — no MANIFEST.md (nothing to upgrade)
 *   current       — no regenerable row names a lesson file (v2, or a user
 *                   edit that already fixed it)
 *   v1            — the exact generated v1 lines, upgradable in place
 *   edited        — a regenerable row still names a lesson file, but the v1
 *                   lines were edited (or the file mixes CRLF and LF line
 *                   endings), so only the owner can fix it
 *   unreadable    — the file exists but could not be read as UTF-8 text
 *                   (read error, or NUL bytes: e.g. re-saved as UTF-16)
 */
export type ManifestState = "absent" | "current" | "v1" | "edited" | "unreadable";

export interface ManifestInspection {
  state: ManifestState;
  /** Lesson files still listed in a regenerable row (empty unless v1/edited). */
  lessonFilesMarkedRegenerable: string[];
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Pure classifier over manifest text (any line ending; a BOM is harmless). */
function classifyManifestText(raw: string): ManifestInspection {
  // UTF-16 (or any binary) read as UTF-8 is full of NULs: no row would match
  // and the file would look "current" while it may still say "safe to delete".
  if (raw.includes("\u0000")) return { state: "unreadable", lessonFilesMarkedRegenerable: [] };
  const text = raw.replace(/\r\n/g, "\n");
  const marked = new Set<string>();
  for (const line of text.split("\n")) {
    if (!/^\|\s*regenerable\s*\|/.test(line)) continue;
    for (const f of MANIFEST_LESSON_FILES) if (line.includes(f)) marked.add(f);
  }
  const lessonFilesMarkedRegenerable = MANIFEST_LESSON_FILES.filter((f) => marked.has(f));
  if (lessonFilesMarkedRegenerable.length === 0) return { state: "current", lessonFilesMarkedRegenerable };
  // Exact v1: every generated v1 passage present exactly once, as whole lines.
  const lines = text.split("\n");
  const exact =
    lines.filter((l) => l === V1_VERSION_LINE).length === 1 &&
    lines.filter((l) => l === V1_SYNC_ROW).length === 1 &&
    lines.filter((l) => l === V1_REGENERABLE_ROW).length === 1 &&
    countOccurrences(`\n${text}\n`, `\n${V1_RESTORE}\n`) === 1;
  // Mixed CRLF/LF: one line-ending style could not be kept byte-exact for
  // every line, so leave the file to the owner.
  const mixedEol = raw.includes("\r\n") && /(^|[^\r])\n/.test(raw);
  return { state: exact && !mixedEol ? "v1" : "edited", lessonFilesMarkedRegenerable };
}

/**
 * READ-ONLY inspection of `<root>/MANIFEST.md` (used by `ar doctor`, which
 * also runs on the session_start path, and by `ar repair` dry-run). Never
 * throws, never writes.
 */
export function inspectStoreManifest(root: string): ManifestInspection {
  const dest = path.join(root, MANIFEST_FILENAME);
  let raw: string;
  try {
    if (!fs.existsSync(dest)) return { state: "absent", lessonFilesMarkedRegenerable: [] };
    raw = fs.readFileSync(dest, "utf-8");
  } catch {
    return { state: "unreadable", lessonFilesMarkedRegenerable: [] };
  }
  return classifyManifestText(raw);
}

/**
 * Upgrade an UNEDITED v1 `<root>/MANIFEST.md` to v2 in place. Replaces only
 * the four generated v1 passages (version line, sync row, regenerable row,
 * restore paragraph) and keeps every other byte, the line-ending style and
 * any BOM. Written via a unique tmp + rename, so a concurrent reader (or a
 * second hook doing the same upgrade) sees either the old or the new file.
 * Returns "upgraded", "failed" (write error; the old file is kept), or the
 * non-upgradable state found. Never throws.
 */
export type ManifestUpgradeOutcome = "upgraded" | "failed" | Exclude<ManifestState, "v1">;

export function upgradeStoreManifest(root: string): ManifestUpgradeOutcome {
  const dest = path.join(root, MANIFEST_FILENAME);
  let raw: string;
  try {
    if (!fs.existsSync(dest)) return "absent";
    raw = fs.readFileSync(dest, "utf-8");
  } catch {
    return "unreadable";
  }
  const { state } = classifyManifestText(raw);
  if (state !== "v1") return state;

  const crlf = raw.includes("\r\n");
  // Whole-line replacement: wrap in newlines so "\nFROM\n" only matches a
  // passage that is its own line(s), never a substring of a longer line.
  let wrapped = `\n${crlf ? raw.replace(/\r\n/g, "\n") : raw}\n`;
  for (const [from, to] of V1_TO_V2) wrapped = wrapped.replace(`\n${from}\n`, () => `\n${to}\n`);
  let text = wrapped.slice(1, -1);
  if (crlf) text = text.replace(/\n/g, "\r\n");

  const tmp = `${dest}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, text, "utf-8");
    // The owner may have saved the file since we read it: never replace
    // their edit with our upgrade of the older text.
    if (fs.readFileSync(dest, "utf-8") !== raw) {
      fs.rmSync(tmp, { force: true });
      return "edited";
    }
    renameAtomic(tmp, dest);
    return "upgraded";
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    return "failed";
  }
}
