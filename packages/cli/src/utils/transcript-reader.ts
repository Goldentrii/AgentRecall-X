/**
 * transcript-reader.ts
 *
 * Reads Claude Code session transcripts (.jsonl files) from disk.
 * Uses head+tail strategy so it handles 100MB+ files without loading them fully.
 *
 * Discovery order:
 *   1. File paths in tool calls → project slug (most reliable)
 *   2. First real user message → task description
 *   3. Recent tail exchanges → what was accomplished
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface SessionInfo {
  /** Absolute path to the .jsonl file */
  file: string;
  /** UUID from the filename */
  sessionId: string;
  /** File size in MB */
  sizeMb: number;
  /** Last write time */
  lastModified: Date;
  /** Best-guess project slug from file path patterns (e.g. "cdance-eu") */
  projectGuess: string | null;
  /** cwd field from first record (usually just home dir) */
  cwdGuess: string | null;
  /** First non-system user message (<300 chars) */
  firstUserMessage: string | null;
  /** Last N user+assistant exchanges formatted as text, for agent summarization */
  recentExchanges: string;
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

/** Read the first headBytes and last tailBytes of a file without loading it all. */
function readHeadTail(
  filePath: string,
  headBytes = 60_000,
  tailBytes = 25_000,
): { head: string; tail: string } {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;

    const headLen = Math.min(headBytes, size);
    const headBuf = Buffer.allocUnsafe(headLen);
    fs.readSync(fd, headBuf, 0, headLen, 0);

    const tailStart = Math.max(0, size - tailBytes);
    const tailLen = size - tailStart;
    const tailBuf = Buffer.allocUnsafe(tailLen);
    fs.readSync(fd, tailBuf, 0, tailLen, tailStart);

    return { head: headBuf.toString("utf8"), tail: tailBuf.toString("utf8") };
  } finally {
    fs.closeSync(fd);
  }
}

/** Parse JSON lines, silently skipping malformed lines (common at head/tail boundaries). */
function parseLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* skip */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Project identification
// ---------------------------------------------------------------------------

const PROJECT_RE = /\/Users\/[^/]+\/(?:[Pp]rojects?)\/([^/",\\\s`]+)/g;

/** Count project slug occurrences in raw text; return most-frequent one. */
function extractProjectSlug(text: string): string | null {
  const hits: Record<string, number> = {};
  let m: RegExpExecArray | null;
  PROJECT_RE.lastIndex = 0;
  while ((m = PROJECT_RE.exec(text)) !== null) {
    const slug = m[1].replace(/[`'".,;)>]+$/, ""); // strip trailing punctuation
    hits[slug] = (hits[slug] ?? 0) + 1;
  }
  const sorted = Object.entries(hits).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Message extraction
// ---------------------------------------------------------------------------

const SYSTEM_PREFIXES = [
  /^dangerously-skip/i,
  /^<local-command/,
  /^<command-name/,
  /^<command-message/,
  /^<command-args/,
  /^<system-reminder/,
  /^<user-prompt-submit/,
];

function isSystemText(text: string): boolean {
  const t = text.trimStart();
  return SYSTEM_PREFIXES.some((re) => re.test(t));
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (
        c &&
        typeof c === "object" &&
        (c as Record<string, unknown>).type === "text"
      ) {
        return String((c as Record<string, unknown>).text ?? "");
      }
    }
  }
  return "";
}

/** Find the first meaningful user message — skips hook/system/attachment messages. */
function extractFirstUserMessage(lines: unknown[]): string | null {
  for (const d of lines) {
    if (!d || typeof d !== "object") continue;
    const rec = d as Record<string, unknown>;
    if (rec.type !== "user") continue;
    // Skip attachment records (large skill/system content injected as user turn)
    if ("attachment" in rec) continue;
    const msg = rec.message as Record<string, unknown> | undefined;
    const text = textFromContent(msg?.content);
    if (text.length < 10 || isSystemText(text)) continue;
    return text.slice(0, 300);
  }
  return null;
}

/** Build a condensed transcript of recent exchanges for agent summarization. */
function extractRecentExchanges(lines: unknown[], maxExchanges = 20): string {
  const parts: string[] = [];
  for (const d of lines) {
    if (!d || typeof d !== "object") continue;
    const rec = d as Record<string, unknown>;
    const t = rec.type as string;

    if (t === "user" && !("attachment" in rec)) {
      const msg = rec.message as Record<string, unknown> | undefined;
      const text = textFromContent(msg?.content);
      if (text.length > 10 && !isSystemText(text)) {
        parts.push(`USER: ${text.slice(0, 250)}`);
      }
    } else if (t === "assistant") {
      const msg = rec.message as Record<string, unknown> | undefined;
      const content = msg?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          const cr = c as Record<string, unknown>;
          if (cr.type === "text" && typeof cr.text === "string" && cr.text.length > 10) {
            parts.push(`ASSISTANT: ${cr.text.slice(0, 400)}`);
            break;
          }
        }
      }
    }

    if (parts.length >= maxExchanges * 2) break;
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** A parsed session plus its verbatim head+tail bytes (the lossless dump). */
export interface TranscriptByPath extends SessionInfo {
  /** head + "\n…\n" + tail of the transcript, capped at ~80KB. */
  rawTail: string;
}

const RAW_TAIL_CAP = 80_000;

/**
 * Wave 2: parse a SINGLE transcript by its absolute path (from the Stop hook's
 * `transcript_path`), reusing the same head/tail reader as readTodaySessions —
 * no second reader. Returns the parsed SessionInfo PLUS a verbatim `rawTail`
 * for the lossless archive tier. Returns null if the path is missing/unreadable.
 */
export function readTranscriptByPath(filePath: string): TranscriptByPath | null {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;

    const { head, tail } = readHeadTail(filePath);
    const headLines = parseLines(head);
    const tailLines = parseLines(tail);

    const cwdGuess =
      ((headLines.find(
        (d) => d && typeof d === "object" && "cwd" in (d as object),
      ) as Record<string, unknown> | undefined)?.cwd as string | null) ?? null;

    const projectGuess = extractProjectSlug(head) ?? extractProjectSlug(tail);

    // Verbatim dump: head + tail. If the whole file fit in head, don't duplicate.
    const rawTail = (
      stat.size <= head.length ? head : `${head}\n…\n${tail}`
    ).slice(0, RAW_TAIL_CAP);

    return {
      file: filePath,
      sessionId: path.basename(filePath, ".jsonl"),
      sizeMb: stat.size / 1024 / 1024,
      lastModified: stat.mtime,
      projectGuess,
      cwdGuess,
      firstUserMessage: extractFirstUserMessage(headLines),
      recentExchanges: extractRecentExchanges(tailLines),
      rawTail,
    };
  } catch {
    return null;
  }
}

/**
 * Locate and parse all Claude Code sessions modified today.
 *
 * @param claudeDir  Directory containing the .jsonl files.
 *                   Defaults to ~/.claude/projects/-Users-{username}
 */
export function readTodaySessions(claudeDir?: string): SessionInfo[] {
  const username = os.userInfo().username;
  const dir =
    claudeDir ??
    path.join(os.homedir(), ".claude", "projects", `-Users-${username}`);

  if (!fs.existsSync(dir)) return [];

  const todayStr = new Date().toISOString().slice(0, 10);

  const entries = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      return { full, name: f, mtime: stat.mtime, size: stat.size };
    })
    .filter((e) => e.mtime.toISOString().slice(0, 10) === todayStr)
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  return entries.map(({ full, name, mtime, size }) => {
    const { head, tail } = readHeadTail(full);
    const headLines = parseLines(head);
    const tailLines = parseLines(tail);

    // cwd from first record that has it
    const cwdGuess =
      (headLines.find(
        (d) => d && typeof d === "object" && "cwd" in (d as object),
      ) as Record<string, unknown> | undefined)?.cwd as string | null ?? null;

    // Project: scan head first (fewer lines but more context), fall back to tail
    const projectGuess = extractProjectSlug(head) ?? extractProjectSlug(tail);

    return {
      file: full,
      sessionId: path.basename(name, ".jsonl"),
      sizeMb: size / 1024 / 1024,
      lastModified: mtime,
      projectGuess,
      cwdGuess,
      firstUserMessage: extractFirstUserMessage(headLines),
      recentExchanges: extractRecentExchanges(tailLines),
    };
  });
}
