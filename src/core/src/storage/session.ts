/**
 * Session identity + intelligent file naming.
 *
 * Naming format (v3.4.1+):
 *   {date}--{save-type}--{sig}--{theme}--{topic-slug}.md
 *
 * Example: 2026-05-04--arsave--shipped--version-bump--v341-release.md
 *
 * - save-type: arsave / arsaveall / hook-end / hook-correction / capture
 * - sig: significance tag (SignificanceTag) — why this session matters
 * - theme: recurring theme tag (ThemeTag) — cross-session pattern
 * - topic-slug: semantic keywords from generateSlug(), max 35 chars
 *
 * Falls back to legacy naming (YYYY-MM-DD.md) when no opts provided.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateSlug } from "../helpers/auto-name.js";
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
export type SaveType = "arsave" | "arsaveall" | "hook-end" | "hook-correction" | "capture";

export interface SmartNameOpts {
  saveType: SaveType;
  content: string;
  sig?: SignificanceTag;
  theme?: ThemeTag;
}

export type { SignificanceTag, ThemeTag } from "../helpers/journal-sig-theme.js";

/**
 * Generate a semantic slug from content, capped at 35 chars.
 */
function topicSlug(content: string): string {
  const result = generateSlug(content);
  return result.slug.slice(0, 35);
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
    // SAME-DAY RULE: one file per day per project.
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
    const name = `${date}--${opts.saveType}--${sigTag}--${themeTag}--${slug}.md`;

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
    const slug = topicSlug(opts.content);
    const sigTag = opts.sig ?? "none";
    const themeTag = opts.theme ?? "none";
    return `${date}--capture--${sigTag}--${themeTag}--${slug}.md`;
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

/** Reset all session state (owned files). Call at the start of each session. */
export function resetSessionState(): void {
  resetOwnedFiles();
}
