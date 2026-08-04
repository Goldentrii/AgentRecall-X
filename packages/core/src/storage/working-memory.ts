/**
 * working-memory.ts — minutes-level, crash-proof capture tier
 * (v3.4.42 working-memory wave, design doc
 * reports/2026-08-04-working-memory-design.md).
 *
 * WHY: through v3.4.41, AR writes nothing until the Stop hook fires — a
 * crash, `kill -9`, or a context-compact vaporizes the entire live session,
 * and two concurrent Claude Code windows are mutually blind to each other.
 * Owner intent (2026-07-31, verbatim spirit): "like a human brain — you can
 * forget, you can decay, but you need to know what happened 10 minutes
 * before, 5 minutes before." This module is the ONLY new storage primitive
 * for that tier: one JSONL file per session id, appended to on every
 * UserPromptSubmit (hook-ambient), read at hook-start for the cross-window
 * "live" signal and for orphan rescue, and deleted once a session reaches a
 * normal, successful hook-end. WM is NEVER archived — natural forgetting by
 * design; it is a minutes-level cache, not a permanent record.
 *
 * Storage shape: `<AR_ROOT>/working-memory/<sid>.jsonl`, one JSON line per
 * prompt, PLUS a small sidecar counter file `<sid>.jsonl.count` (a bare
 * decimal integer) used ONLY to enforce the per-file line cap in O(1) —
 * see `wmAppend`'s doc comment for why a sidecar counter, not a directory
 * scan or a full-file read, is the right tool here. Per-sid files are a
 * DELIBERATE choice (design doc, non-negotiable): a shared cross-session
 * ledger would need a write-lock on every single prompt across every open
 * window, turning a per-prompt hot path into a cross-process contention
 * point. Per-sid files make that race structurally impossible — two windows
 * literally never touch the same file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { ensureDir, truncateUtf8Bytes } from "./fs-utils.js";
import { isSystemText, parseJsonlLenient } from "./extraction.js";
import { recordHookFailure } from "./hook-health.js";
import { sanitizeSlug } from "./paths.js";
import { isValidProjectSlug } from "./project.js";

const WM_DIRNAME = "working-memory";
const JSONL_EXT = ".jsonl";
const COUNT_EXT = ".count";

/** Per-sid line cap (design doc §Mechanism) — bounds disk, not memory. */
export const WM_LINE_CAP = 2000;
/** Prompt field byte cap (UTF-8-safe) applied at append time. */
export const WM_PROMPT_BYTE_CAP = 300;

/**
 * Cross-window "live" line window (session-start.ts's continuity assembly):
 * a WM file with mtime younger than this is treated as "another session is
 * (or very recently was) active elsewhere". Exported so session-start.ts and
 * this module share ONE threshold instead of two independently-tuned magic
 * numbers.
 */
export const WM_LIVE_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Orphan-rescue window (CLI hook-start): a WM file OLDER than this with no
 * session card and no recency-index entry yet is presumed to belong to a
 * session that crashed/was killed without ever reaching hook-end. Exported
 * for the same single-source-of-truth reason as `WM_LIVE_WINDOW_MS`.
 */
export const WM_ORPHAN_WINDOW_MS = 60 * 60 * 1000; // 1h

export interface WorkingMemoryLine {
  /** ISO-8601 timestamp of the prompt. */
  ts: string;
  /** Boilerplate-excluded, UTF-8-safe byte-capped prompt text. */
  prompt: string;
  /** Working directory at the time of the prompt, when known. */
  cwd?: string;
}

export interface WorkingMemoryFileInfo {
  /** Session id (the sanitized on-disk basename, minus the .jsonl extension). */
  sid: string;
  /** Last-modified time of the .jsonl file, as epoch milliseconds. */
  mtimeMs: number;
  /** Line count — read from the sidecar counter when present, else counted. */
  lines: number;
}

function wmDir(): string {
  return path.join(getRoot(), WM_DIRNAME);
}

function wmFilePath(sid: string): string {
  return path.join(wmDir(), `${sanitizeSlug(sid)}${JSONL_EXT}`);
}

function wmCountPath(sid: string): string {
  return wmFilePath(sid) + COUNT_EXT;
}

/** Best-effort read of a tiny decimal-integer counter file. 0 on any failure. */
function readCounter(countPath: string): number {
  try {
    const raw = fs.readFileSync(countPath, "utf-8").trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0; // no counter yet (first append) or unreadable — treat as empty
  }
}

/**
 * Append one prompt to a session's working-memory file. Never throws — this
 * runs on the hook-ambient hot path (every UserPromptSubmit) and a failure
 * here must never delay or deny the ambient injection output that follows
 * it in the caller. Any failure is reported via `recordHookFailure` instead.
 *
 * Boilerplate exclusion: a prompt that IS boilerplate (matches
 * `isSystemText` — harness scaffolding, `<system-reminder>` blocks, etc.)
 * appends NOTHING, not even an empty line, and does not consume any of the
 * per-file line-cap budget.
 *
 * Line-cap strategy (documented per design doc constraint — "cheap stat
 * size heuristic or first-write counter file is acceptable"): a byte-size
 * heuristic on the growing .jsonl file was rejected because prompt length
 * and cwd length both vary per line, making "file size / N" an unreliable
 * proxy for "N lines" — it would let a run of short prompts blow well past
 * the intended 2000-line cap while a run of near-cap-length prompts hits it
 * early. Reading the .jsonl file itself to count lines was rejected because
 * that makes wmAppend's cost scale with SESSION LENGTH (O(n) per prompt over
 * an n-line file), violating the O(1)-hot-path constraint outright. The
 * chosen alternative is a tiny sidecar counter file (a few bytes, a bare
 * decimal integer) that is read once (cheap: a handful of bytes, not the
 * growing transcript) and rewritten once per append — genuinely O(1) with
 * respect to the session's own size.
 */
export function wmAppend(sid: string, entry: { ts: string; prompt: string; cwd?: string }): void {
  try {
    const prompt = (entry.prompt ?? "").trim();
    if (!prompt || isSystemText(prompt)) return; // boilerplate-only — no line appended, no budget spent

    const countPath = wmCountPath(sid);
    const count = readCounter(countPath);
    if (count >= WM_LINE_CAP) return; // bounded — never grows past the cap

    ensureDir(wmDir());

    const line: WorkingMemoryLine = {
      ts: entry.ts,
      prompt: truncateUtf8Bytes(prompt, WM_PROMPT_BYTE_CAP),
    };
    if (entry.cwd) line.cwd = entry.cwd;

    fs.appendFileSync(wmFilePath(sid), JSON.stringify(line) + "\n", "utf-8");
    fs.writeFileSync(countPath, String(count + 1), "utf-8");
  } catch (err) {
    // Never throw into the hook-ambient hot path — report and move on.
    recordHookFailure("working-memory", err);
  }
}

/**
 * List every working-memory file currently on disk. Never throws — returns
 * `[]` on any read error (missing directory, permissions, etc.). Used by
 * BOTH the cross-window "live" line (session-start.ts, filters mtime <
 * `WM_LIVE_WINDOW_MS`) and orphan rescue (CLI hook-start, filters mtime >
 * `WM_ORPHAN_WINDOW_MS`) — not on any per-prompt hot path, so a full
 * directory read here is acceptable (unlike `wmAppend`).
 */
export function wmList(): WorkingMemoryFileInfo[] {
  try {
    const dir = wmDir();
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(JSONL_EXT));
    const out: WorkingMemoryFileInfo[] = [];
    for (const f of files) {
      const filePath = path.join(dir, f);
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(filePath).mtimeMs;
      } catch {
        continue; // vanished between readdir and stat (concurrent wmDelete) — skip
      }
      const sid = f.slice(0, -JSONL_EXT.length);
      let lines = readCounter(filePath + COUNT_EXT);
      if (lines === 0) {
        // No counter (pre-counter-file data, or a corrupt/missing sidecar) —
        // self-heal by counting the actual file. Not on the hot path.
        try {
          lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean).length;
        } catch {
          lines = 0;
        }
      }
      out.push({ sid, mtimeMs, lines });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Read every parsed line of a session's working-memory file, oldest-first.
 * Never throws — returns `[]` when the file is missing, empty, or every line
 * fails to parse/validate.
 */
export function wmRead(sid: string): WorkingMemoryLine[] {
  try {
    const content = fs.readFileSync(wmFilePath(sid), "utf-8");
    const records = parseJsonlLenient(content);
    const out: WorkingMemoryLine[] = [];
    for (const rec of records) {
      if (typeof rec.ts === "string" && typeof rec.prompt === "string") {
        const line: WorkingMemoryLine = { ts: rec.ts, prompt: rec.prompt };
        if (typeof rec.cwd === "string") line.cwd = rec.cwd;
        out.push(line);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Delete a session's working-memory file and its counter sidecar. Idempotent
 * (calling twice, or on a sid with no file, is a silent no-op) and never
 * throws — this runs on the hook-end "sleep consolidation" path (after a
 * successful session-card write) and on the orphan-rescue path, neither of
 * which may fail the hook over a best-effort cleanup step.
 */
export function wmDelete(sid: string): void {
  for (const p of [wmFilePath(sid), wmCountPath(sid)]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      // best-effort — a failed cleanup must never throw into the hook
    }
  }
}

/**
 * Cheap, LOCAL cwd-majority slug guess for the two working-memory consumers
 * that live in the CORE package (session-start.ts's live line, resurrect.ts's
 * WM source) and therefore cannot import the CLI package's
 * `resolveSessionProject` (packages/cli/src/utils/transcript-reader.ts) — the
 * core package is a DEPENDENCY of the cli package, never the reverse, so a
 * core module importing cli code would be a layering violation. Uses the
 * SAME regex family as that function's Signal 1 (cwd frequency restricted to
 * paths under `~/Projects/<name>`), deliberately WITHOUT its full three-signal
 * claim-not-generate policy (no existing-slug preference, no content signal —
 * working-memory lines carry only prompts + cwd, not the transcript's
 * user/assistant message records that signal 2 scans).
 *
 * DELIBERATE choice, used by ALL THREE working-memory consumers (this core
 * module's two call sites AND the CLI's orphan rescue, even though the
 * latter COULD reach the real `resolveSessionProject`): F1's own
 * claim-not-generate gate can only mint a BRAND-NEW slug when its content
 * signal (from user/assistant transcript records) sees the name mentioned
 * >=3 times — a signal that structurally never fires from cwd-only
 * working-memory data. Routing orphan rescue through the real F1 function
 * would therefore make it unable to attribute a crashed session's FIRST-EVER
 * interaction with AR to its real project (exactly the case a crash-rescue
 * mechanism most needs to handle) unless that project already has an
 * AR_ROOT/projects/<slug> directory — so all three consumers share this
 * lighter, uniform heuristic instead. Every candidate is still checked
 * against `isValidProjectSlug` (the SAME gate F1 itself applies) so a
 * deny-listed/UUID-shaped/otherwise-invalid cwd segment is never selected.
 * Returns `null` when no line's `cwd` matches the pattern, or when every
 * match was invalid (caller falls back to a literal `"auto"`, the existing
 * convention for an unresolved slug elsewhere in this codebase).
 */
export function guessSlugFromWmLines(lines: WorkingMemoryLine[]): string | null {
  const CWD_SLUG_RE = /^\/Users\/[^/]+\/(?:[Pp]rojects?)\/([^/]+)/;
  const counts = new Map<string, number>();
  for (const l of lines) {
    if (!l.cwd) continue;
    const m = CWD_SLUG_RE.exec(l.cwd);
    if (!m) continue;
    const slug = m[1].replace(/[`'".,;)>]+$/, "");
    if (!isValidProjectSlug(slug)) continue; // same safety gate F1 itself applies
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [slug, count] of counts) {
    if (count > bestCount) {
      best = slug;
      bestCount = count;
    }
  }
  return best;
}
