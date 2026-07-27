/**
 * Session identity + intelligent file naming.
 *
 * Naming format (v3.4.1 — v1):
 *   {date}--{save-type}--{sig}--{theme}--{topic-slug}.md
 *
 * Naming format (naming-v2 spec §3, 2026-07-20 — NEW WRITES ONLY):
 *   {date}--{save-type}--[{sig}]--[{theme}]--{topic-slug}.md
 *   sig==="none" and theme==="none" are OMITTED entirely — the literal string
 *   "none" is never printed. Readers (journal-name-parser.ts) accept both
 *   forms structurally; existing v1 files are never renamed.
 *
 * Example (v1, both tags populated — structurally identical under v2):
 *   2026-05-04--arsave--shipped--version-bump--v341-release.md
 * Example (v2, neither tag present):
 *   2026-07-20--arsave--fixed-dream-cron.md
 *
 * - save-type: arsave / arsaveall / hook-end / hook-correction / capture / hook-archive
 * - sig: significance tag (SignificanceTag) — why this session matters
 * - theme: recurring theme tag (ThemeTag) — cross-session pattern
 * - topic-slug: semantic keywords from generateSlug(), byte-capped at 35
 *
 * Falls back to legacy naming (YYYY-MM-DD.md) when no opts provided.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateSlug } from "../helpers/auto-name.js";
import { sanitizeName } from "./sanitize.js";
import { getRoot } from "../types.js";
import type { SignificanceTag, ThemeTag } from "../helpers/journal-sig-theme.js";

/** 6-char hex ID, unique per process. Generated once on import. */
const SESSION_ID = crypto.randomBytes(3).toString("hex");

/** Track which files this session has claimed (owns). */
const ownedFiles = new Set<string>();

/** Get the current process session ID. */
export function getSessionId(): string {
  return SESSION_ID;
}

/** Save type for intelligent naming. */
export type SaveType =
  | "arsave"
  | "arsaveall"
  | "hook-end"
  | "hook-correction"
  | "capture"
  | "hook-archive";

export interface SmartNameOpts {
  saveType: SaveType;
  content: string;
  sig?: SignificanceTag;
  theme?: ThemeTag;
}

export type { SignificanceTag, ThemeTag } from "../helpers/journal-sig-theme.js";

/**
 * Generate a semantic slug from content, byte-capped at 35 bytes (naming-v2
 * spec §2 — was a 35 UTF-16-char slice; a CJK/emoji-heavy slug could pass
 * that cap yet exceed the filesystem's byte budget).
 */
function topicSlug(content: string): string {
  const result = generateSlug(content);
  return sanitizeName(result.slug, 35);
}

/**
 * Join non-empty tag segments with "--", OMITTING any segment whose value is
 * "none" (naming-v2 spec §3: "null sig/theme OMITTED, never printed"). The
 * literal string "none" must never appear in a new v2 filename.
 */
function joinTagSegments(saveType: string, sig: string, theme: string, slug: string): string {
  const segments = [saveType];
  if (sig !== "none") segments.push(sig);
  if (theme !== "none") segments.push(theme);
  segments.push(slug);
  return segments.join("--");
}

/**
 * Generate an intelligent journal filename.
 *
 * New format: {date}--{saveType}--{lines}L--{slug}.md
 * Legacy fallback: {date}.md or {date}-{sessionId}.md
 *
 * If the computed filename already exists on disk, appends session ID suffix
 * to avoid overwriting a different session's file.
 */
export function journalFileName(date: string, baseExists: boolean, opts?: SmartNameOpts, dir?: string): string {
  // New intelligent naming
  if (opts?.saveType && opts?.content) {
    // SESSION-SCOPED EXCEPTION (arsaveall):
    // When multiple parallel sessions all touch the same project today,
    // the SAME-DAY rule would collapse them into one file and silently
    // drop content. For arsaveall specifically we bypass it and generate
    // a unique per-call session-scoped filename so every session survives.
    if (opts.saveType === "arsaveall") {
      const slug = topicSlug(opts.content);
      const sigTag = opts.sig ?? "none";
      const themeTag = opts.theme ?? "none";
      const uniq = crypto.randomBytes(3).toString("hex");  // per-call random — unique across iterations
      // Same-day rule + this hex exception are UNCHANGED (naming-v2 spec §5) —
      // only the none-omission grammar is new, for consistency with the
      // non-arsaveall branch below (call-site divergence is exactly what v2
      // closes: two near-identical functions should not print "none"
      // differently).
      const segments = [date, "arsaveall"];
      if (sigTag !== "none") segments.push(sigTag);
      if (themeTag !== "none") segments.push(themeTag);
      segments.push(slug, uniq);
      const name = `${segments.join("--")}.md`;
      if (dir) ownedFiles.add(`smart:${name}`);
      return name;
    }

    // SAME-DAY RULE: one file per day per project (other saveTypes only).
    // If ANY file for today already exists (smart or legacy), append to it.
    if (dir) {
      const existingToday = fs.readdirSync(dir)
        .filter(f =>
          f.startsWith(date) &&
          f.endsWith(".md") &&
          f !== "index.md" &&
          !f.endsWith(".merged.md") &&
          !f.includes("-log.") &&      // exclude legacy capture logs ({date}-log.md, {date}-{id}-log.md)
          !f.includes("--capture--")   // exclude smart-named capture logs
        )
        .sort()  // deterministic: pick the first one
        [0];

      if (existingToday) {
        ownedFiles.add(`smart:${existingToday}`);
        return existingToday;
      }
    }

    // No file for today — create a smart-named one
    const slug = topicSlug(opts.content);
    const sigTag = opts.sig ?? "none";
    const themeTag = opts.theme ?? "none";
    const name = `${date}--${joinTagSegments(opts.saveType, sigTag, themeTag, slug)}.md`;

    if (dir) {
      ownedFiles.add(`smart:${name}`);
    }
    return name;
  }

  // Legacy naming (backward compat)
  const baseKey = `journal:${date}`;

  if (ownedFiles.has(`${baseKey}:base`)) return `${date}.md`;
  if (ownedFiles.has(`${baseKey}:session`)) return `${date}-${SESSION_ID}.md`;

  if (!baseExists) {
    ownedFiles.add(`${baseKey}:base`);
    return `${date}.md`;
  }
  ownedFiles.add(`${baseKey}:session`);
  return `${date}-${SESSION_ID}.md`;
}

/**
 * Generate a session-scoped log filename for captures.
 *
 * New format: {date}--capture--{lines}L--{slug}.md
 * Legacy fallback: {date}-log.md
 */
export function captureLogFileName(date: string, baseExists: boolean, opts?: SmartNameOpts, dir?: string): string {
  if (opts?.saveType && opts?.content) {
    // SAME-DAY RULE: if any capture file for today already exists, reuse it so
    // entry numbers accumulate within one file per day per project.
    if (dir && fs.existsSync(dir)) {
      const existingCapture = fs.readdirSync(dir)
        .filter(f => f.startsWith(date) && f.endsWith(".md") &&
          (f.includes("-log.md") || f.includes("--capture--")))
        .sort()[0];
      if (existingCapture) return existingCapture;
    }

    const slug = topicSlug(opts.content);
    const sigTag = opts.sig ?? "none";
    const themeTag = opts.theme ?? "none";
    return `${date}--${joinTagSegments("capture", sigTag, themeTag, slug)}.md`;
  }

  // Legacy naming
  const baseKey = `capture:${date}`;

  if (ownedFiles.has(`${baseKey}:base`)) return `${date}-log.md`;
  if (ownedFiles.has(`${baseKey}:session`)) return `${date}-${SESSION_ID}-log.md`;

  if (!baseExists) {
    ownedFiles.add(`${baseKey}:base`);
    return `${date}-log.md`;
  }
  ownedFiles.add(`${baseKey}:session`);
  return `${date}-${SESSION_ID}-log.md`;
}

/** Reset owned files tracking (call at session boundaries). */
export function resetOwnedFiles(): void {
  ownedFiles.clear();
}

// ---------------------------------------------------------------------------
// C2 (2026-07-26) — per-process lifecycle idempotency.
//
// Doctrine: on non-hook hosts the agent drives the memory lifecycle itself,
// so repeated session_start / session_end calls WILL happen (context wipes,
// retries, reconnects). getSessionId() is process-scoped — a workable
// identity for one MCP-server lifetime — so idempotency state is keyed on
// (root, sessionId, project). `root` is included purely for test isolation
// (many tests swap AGENT_RECALL_ROOT per case while reusing project names/
// content in the same process); in real usage root is constant for the life
// of the process, so this changes nothing about production behavior.
// ---------------------------------------------------------------------------

function idempotencyKey(project: string): string {
  return `${getRoot()}::${getSessionId()}::${project}`;
}

/** (root::sessionId::project) keys whose session_start write-phase already fired this process. */
const sessionStartClaimed = new Set<string>();

/**
 * Claim the session_start write-phase (correction "retrieved" outcomes,
 * behavior-policy hit bump) for this process's session + project.
 *
 * Returns true on the FIRST claim — the caller should run its once-per-session
 * side effects. Returns false on every subsequent call for the same key — the
 * caller MUST skip those side effects, but should still recompute and return
 * the full read-side payload (an agent recovering from a context wipe
 * legitimately re-calls session_start and must still get full context).
 */
export function claimSessionStartOnce(project: string): boolean {
  const key = idempotencyKey(project);
  if (sessionStartClaimed.has(key)) return false;
  sessionStartClaimed.add(key);
  return true;
}

/** Last session_end fingerprint + result per (root::sessionId::project). */
const sessionEndLastCall = new Map<string, { fingerprint: string; result: unknown }>();

/**
 * Look up a cached session_end result for (project, fingerprint). Returns the
 * prior result when an IDENTICAL call (same fingerprint) already ran for this
 * process's session — the caller should return it as a no-op without
 * re-executing any writes (journal, awareness, outcomes, consolidation).
 * Returns undefined on the first call for this key, or when the fingerprint
 * differs (genuinely new content) — the caller should proceed normally.
 */
export function getCachedSessionEnd<T>(project: string, fingerprint: string): T | undefined {
  const entry = sessionEndLastCall.get(idempotencyKey(project));
  return entry && entry.fingerprint === fingerprint ? (entry.result as T) : undefined;
}

/** Cache a session_end result so an identical repeat call can be short-circuited. */
export function setCachedSessionEnd(project: string, fingerprint: string, result: unknown): void {
  sessionEndLastCall.set(idempotencyKey(project), { fingerprint, result });
}

/** Clear all idempotency state. Call at test/session boundaries. */
export function resetIdempotencyState(): void {
  sessionStartClaimed.clear();
  sessionEndLastCall.clear();
}

/** Reset all session state (owned files + idempotency). Call at the start of each session. */
export function resetSessionState(): void {
  resetOwnedFiles();
  resetIdempotencyState();
}
