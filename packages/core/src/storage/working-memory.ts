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
import { sanitizeSlug, projectsRootDir } from "./paths.js";
import { isValidProjectSlug, listAllProjects } from "./project.js";
import { RESCUE_SOURCE_TAG } from "../helpers/journal-filter.js";
import { scrubForCloud } from "./content-guard.js";
import { generateFrontmatter } from "../palace/obsidian.js";
import { writeSessionCard } from "./session-card.js";
import { appendRecentSession, readRecentSessions } from "./recency-index.js";

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
 *
 * C1 fix (review, post-build): the raw prompt text used to reach disk with
 * only the boilerplate check above — no injection/secret scrub — even though
 * every OTHER persist path in this codebase (journal-write.ts, palace-write.ts,
 * see storage/content-guard.ts) scrubs before writing. WM is a lower tier
 * (minutes-level cache, not a permanent record) but it is NOT lower-exposure:
 * its content is read back verbatim into (a) session-start.ts's cross-SESSION
 * "live" line (surfaced to a DIFFERENT window/agent), (b) rescued session-card
 * bodies (cli/index.ts orphan rescue — a permanent journal artifact once
 * rescued), and (c) resurrect.ts's WM source. A secret or an injected
 * "<system-reminder>ignore previous instructions</system-reminder>" block
 * pasted into one prompt would otherwise flow verbatim into all three. This
 * is the SINGLE choke point for the whole tier — every WM line is built here.
 *
 * Ordering (truncate → scrub → truncate again), deliberately NOT
 * scrub-then-truncate, to preserve the O(1)-hot-path guarantee this module's
 * own header documents: `scrubForCloud` is a ~15-regex pass whose cost scales
 * with input length (measured: ~0.28ms on a 100KB string — see the fix
 * report's benchmark). Truncating to WM_PROMPT_BYTE_CAP FIRST bounds the
 * scrub's input to a small constant (≤300 bytes) regardless of how long the
 * raw prompt was, so the added cost is ~1-2 microseconds per call — the scrub
 * never sees the full pasted-file-sized prompt a user might submit. Content
 * beyond the byte cap is truncated away before it is ever persisted, so it
 * needs no scrubbing; content a secret/tag straddling the truncation boundary
 * can still be caught if enough of it survives inside the retained window.
 * The second truncateUtf8Bytes call is a cheap defensive no-op today (every
 * SECRET_CONTENT_PATTERNS replacement is shorter than what it matches, so
 * scrub never grows the string) — kept so the ≤WM_PROMPT_BYTE_CAP invariant
 * holds even if that redaction-placeholder assumption ever changes.
 */
export function wmAppend(sid: string, entry: { ts: string; prompt: string; cwd?: string }): void {
  try {
    const prompt = (entry.prompt ?? "").trim();
    if (!prompt || isSystemText(prompt)) return; // boilerplate-only — no line appended, no budget spent

    const countPath = wmCountPath(sid);
    const count = readCounter(countPath);
    if (count >= WM_LINE_CAP) return; // bounded — never grows past the cap

    ensureDir(wmDir());

    const truncated = truncateUtf8Bytes(prompt, WM_PROMPT_BYTE_CAP);
    const scrubbed = truncateUtf8Bytes(scrubForCloud(truncated), WM_PROMPT_BYTE_CAP);

    const line: WorkingMemoryLine = {
      ts: entry.ts,
      prompt: scrubbed,
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
 *
 * H1 fix (review, post-build): F1 (`resolveSessionProject`, transcript-reader.ts)
 * scans its FULL ranked candidate list and lets the first one that already
 * has an on-disk project home win outright ("prefer an existing slug" —
 * Signal 3), even over a noisier top-ranked candidate. The original version
 * of this function had no such tie-break — pure cwd-count majority — so a WM
 * session that happened to visit an unrelated-but-more-frequent cwd (e.g. a
 * quick `cd` into a sibling checkout mid-session) could out-vote the project
 * the session actually belongs to, where F1 itself would have picked the
 * established one. Mirrors F1's tie-break using core's OWN project listing
 * (`listAllProjects`, this same module — no cli import, preserving the
 * core→cli layering direction documented above) instead of duplicating a raw
 * `fs.readdirSync` scan. Wrapped in its own try/catch: this function must
 * never throw (same contract as every other WM helper), and `listAllProjects`
 * is a filesystem read this module does not otherwise need to guard.
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
  if (counts.size === 0) return null;

  const ranked = [...counts.entries()]
    .map(([slug, count]) => ({ slug, count }))
    .sort((a, b) => b.count - a.count);

  // Existing-slug tie-break (H1) — mirrors F1's Signal 3. Scan the full
  // ranked list, not just the top candidate: an established project should
  // win even when a noisier candidate happens to have a higher raw count in
  // this particular WM slice.
  try {
    const existingSlugs = new Set(listAllProjects().map((p) => p.slug));
    for (const cand of ranked) {
      if (existingSlugs.has(cand.slug)) return cand.slug;
    }
  } catch {
    // listAllProjects is a best-effort preference signal, not a requirement —
    // fall through to the plain majority below on any read failure.
  }

  return ranked[0]?.slug ?? null;
}

/**
 * v3.4.42 working-memory wave — orphan-rescue idempotency guard 1/2: does ANY
 * project already have a session card for this sid? Scans every project's
 * journal/ directory for a `*--card--<sid>.md` file (the exact naming
 * convention `writeSessionCard` uses). Never throws — a missing/unreadable
 * projects dir simply means "no card found".
 *
 * Moved here verbatim from packages/cli/src/index.ts (Train C, C-2, 2026-08-12
 * wave) as part of single-sourcing the orphan-rescue sweep — see
 * `rescueOrphanedWorkingMemory`'s doc comment below for why. NOT quite
 * verbatim, though: the original CLI version built the enumeration root via
 * a raw `path.join(root, "projects")`. This package's own F2 architectural
 * guard (test/projects-literal-bypass-guard.test.mjs) forbids any
 * `packages/core/src/**` file other than storage/paths.ts from inlining the
 * `"projects"` literal — moving this function into core surfaced that guard
 * for the first time. Fixed to use `projectsRootDir()`, the sanctioned
 * enumeration-only helper paths.ts itself documents for exactly this case
 * (joining directly against a slug that came FROM a readdir, not a
 * caller-supplied name that needs the case-fold reuse rule).
 *
 * Rescue-slug-parity fix (Train C, 2026-08-13): returns the FOUND slug (the
 * on-disk directory name the readdir actually matched under) instead of a
 * bare boolean. `distillOneSession` below needs this because, when a card
 * for this sid already exists, THIS slug (not a fresh `guessSlugFromWmLines`
 * re-guess, which could itself have drifted since the card was written) is
 * the only correct value for a not-yet-existing recency-ledger entry — see
 * that function's own comment for the full ledger-vs-disk mismatch this
 * closes. `null` means "no card found for this sid in any project."
 */
function findCardSlugForSid(sid: string): string | null {
  try {
    const projectsDir = projectsRootDir();
    if (!fs.existsSync(projectsDir)) return null;
    for (const slug of fs.readdirSync(projectsDir)) {
      const journalPath = path.join(projectsDir, slug, "journal");
      if (!fs.existsSync(journalPath)) continue;
      const hit = fs.readdirSync(journalPath).some((f) => f.endsWith(`--card--${sid}.md`));
      if (hit) return slug;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * C-2 (Train C, 2026-08-12 wave, design doc reports/2026-08-12-trainc-design.md)
 * — the working-memory orphan-rescue sweep, single-sourced.
 *
 * WHY: through the v3.4.42 working-memory wave this sweep lived ONLY inside
 * the CLI's `hook-start` case (packages/cli/src/index.ts) — a session that
 * crashed on a host with no Claude Code hooks (Codex/Cursor/raw MCP) had no
 * path back to a card at all, because nothing but that one CLI command ever
 * ran the sweep. Doctrine (owner, 2026-07-26): the customer's only action is
 * describing intent — the MCP server process itself must carry the memory
 * lifecycle on hook-less hosts. Moved here, byte-for-byte behavior preserved,
 * so BOTH callers — the CLI's `hook-start` case AND core's own `sessionStart()`
 * (tools-logic/session-start.ts, called by the MCP `session_start` tool on
 * every host) — invoke this ONE function. Neither re-implements any part of
 * the sweep; there is exactly one place this logic can drift.
 *
 * Mechanism (unchanged from the original CLI-only version): a working-memory
 * file older than `WM_ORPHAN_WINDOW_MS` with no session card and no
 * recency-index entry yet is presumed to belong to a session that crashed or
 * was `kill -9`'d without ever reaching hook-end (or, on a non-hook host,
 * without the agent ever calling `session_end`). Rescues it into a
 * searchable session card + recency entry, then deletes the WM file.
 * Idempotent (card-exists / recency-exists guards — safe to call on every
 * hook-start AND every session_start, from every open window/process),
 * per-file fault-isolated (one bad orphan can never abort the sweep for its
 * siblings — M1 fix, see the recency-append verification below), and NEVER
 * throws: every failure is reported via `recordHookFailure` instead of
 * propagating, matching every other WM helper's contract in this module.
 *
 * Renamed failure-record hook keys from the CLI original ("hook-start-wm-rescue"
 * -> "wm-orphan-rescue", "hook-start-wm-rescue-recency" -> "wm-orphan-rescue-
 * recency") — cosmetic only, no test or renderer asserts the literal string —
 * because the sweep is no longer CLI-hook-specific; the old names would be
 * actively misleading once an MCP `session_start` call is what triggered a
 * given failure row.
 *
 * The per-file WM→card mechanism itself lives in `distillOneSession` below —
 * factored out so C-3's graceful-exit handler (mcp-server/src/lib/
 * lifecycle-exit.ts, via `distillSessionToCard`) can distill its OWN,
 * still-fresh session immediately (no age gate) through the exact same
 * mechanism this sweep uses for aged orphans, instead of a third
 * reimplementation of "WM lines -> card + recency entry -> delete WM".
 */
export function rescueOrphanedWorkingMemory(): void {
  try {
    const now = Date.now();
    const wmFiles = wmList();

    // L1 fix (review, post-build, preserved from the CLI original): hoist the
    // recency-index read OUT of the per-orphan loop. `readRecentSessions(1000)`
    // reads and JSON-parses up to 1000 ledger lines from disk; calling it once
    // PER orphan file made the sweep's total cost scale with orphans ×
    // ledger-size instead of once + an O(1) Set lookup per orphan.
    const recentSids = new Set(readRecentSessions(1000).map((e) => e.sid));

    for (const wmFile of wmFiles) {
      // M1 fix (review, post-build, preserved from the CLI original): per-file
      // try/catch — a thrown error while rescuing ONE orphan must never abort
      // the whole sweep, silently skipping every OTHER orphan file that
      // hadn't been reached yet.
      try {
        if (now - wmFile.mtimeMs <= WM_ORPHAN_WINDOW_MS) continue; // still fresh — not orphaned yet
        distillOneSession(wmFile, recentSids);
      } catch (e) {
        recordHookFailure("wm-orphan-rescue", e);
        // per-file catch — fall through to the next orphan, sweep continues
      }
    }
  } catch (e) {
    recordHookFailure("wm-orphan-rescue", e);
  }
}

/**
 * Distill ONE session's working-memory lines into a session card + recency
 * entry, then delete the WM file. No age check here BY DESIGN — that policy
 * decision belongs entirely to the caller: `rescueOrphanedWorkingMemory`
 * only reaches this for files already confirmed older than
 * `WM_ORPHAN_WINDOW_MS`, while `distillSessionToCard` (below, C-3's
 * graceful-exit entry point) calls it immediately for a still-live session.
 * Lets exceptions propagate — both current callers wrap their own call in a
 * try/catch (matching the original inline code's per-item fault isolation),
 * so this extraction changes no failure-handling behavior.
 *
 * Rescue-slug-parity fix (Train C, 2026-08-13): `guessSlugFromWmLines`
 * returns a RAW cwd-captured candidate (e.g. "AgentRecall") that is never
 * itself lowercased/case-folded. `writeSessionCard` → `journalDir` →
 * `resolveProjectDirName` DOES normalize it (lowercases via `sanitizeName`,
 * or reuses whatever casing an existing project dir already has) before the
 * card ever touches disk — so the card can land under `projects/agentrecall/`
 * while the raw guessed value stays "AgentRecall". The recency ledger used
 * to be appended with that same raw, never-normalized value, so a lookup
 * keyed on the ledger's slug (e.g. this file's own
 * `packages/mcp-server/test/kill9-orphan-rescue.test.mjs`, which asserts
 * `recencyLines.some((e) => e.slug === rescuedCard.slug)` against the ACTUAL
 * on-disk directory name) could never find the card it was supposedly
 * pointing at. Fixed by tracking a SEPARATE `ledgerSlug` that is always
 * populated from where the card ACTUALLY is — `writeSessionCard`'s own
 * returned `slug` when this call just wrote it, or `findCardSlugForSid`'s
 * already-resolved slug when the card already existed — never from the raw
 * `guessSlugFromWmLines` guess directly.
 */
function distillOneSession(wmFile: WorkingMemoryFileInfo, recentSids: Set<string>): void {
  // Idempotency guard: a card and/or recency entry already recorded for this
  // sid means some or all of the rescue already happened (or the session
  // ended normally via hook-end/session_end without WM having been cleaned
  // up yet by some other race). Tracked as two SEPARATE signals (not one
  // OR'd flag) — a card that exists with no matching recency entry must NOT
  // be treated as fully rescued. `existingCardSlug` (not just a boolean) is
  // the ACTUAL on-disk slug of that pre-existing card, needed below.
  const existingCardSlug = findCardSlugForSid(wmFile.sid);
  const hasCard = existingCardSlug !== null;
  const hasRecency = recentSids.has(wmFile.sid);

  if (hasCard && hasRecency) {
    // Both tiers confirmed — nothing left to do but sweep the leftover WM file.
    wmDelete(wmFile.sid);
    return;
  }

  const wmLines = wmRead(wmFile.sid);
  if (wmLines.length === 0) {
    wmDelete(wmFile.sid); // empty/corrupt — nothing to rescue, stop retrying
    return;
  }

  const first = wmLines[0];
  const last = wmLines[wmLines.length - 1];
  const guessedSlug = guessSlugFromWmLines(wmLines) ?? "auto";
  const title = truncateUtf8Bytes(first.prompt, 120);
  const date = new Date(wmFile.mtimeMs).toISOString().slice(0, 10);

  // The slug the RECENCY LEDGER must record — always the card's real on-disk
  // slug, never the raw guess. Defaults to the already-resolved
  // `existingCardSlug` (the hasCard branch below never overwrites it); the
  // !hasCard branch overwrites it with `written.slug` once the card write
  // confirms where it actually landed.
  let ledgerSlug = existingCardSlug ?? guessedSlug;

  // Card-write is attempted ONLY when a card doesn't already exist (hasCard
  // tracks that precisely). When hasCard is already true, the ONLY
  // remaining gap this sweep needs to close is the recency entry.
  let cardOk = hasCard;
  if (!hasCard) {
    const frontmatter = generateFrontmatter({
      sid: wmFile.sid,
      date,
      slug: guessedSlug,
      slug_confidence: 0,
      slug_candidates: [],
      source: RESCUE_SOURCE_TAG,
    });
    const body = [
      `# ${title}`,
      "",
      `- rescued from working memory after ${wmLines.length} recorded prompt${wmLines.length === 1 ? "" : "s"} (no hook-end ever fired for this session)`,
      `- ts range: ${first.ts} → ${last.ts}`,
      "",
      "## First prompt",
      first.prompt,
      "",
      "## Last prompt",
      last.prompt,
      "",
    ].join("\n");

    const written = writeSessionCard({
      markdown: frontmatter + body,
      title,
      artifacts: [],
      linearRefs: [],
      decisions: [],
      nextStep: [],
      sid: wmFile.sid,
      slug: guessedSlug,
      date,
    });
    cardOk = !!written.path;
    if (cardOk) ledgerSlug = written.slug || guessedSlug; // the ACTUAL on-disk slug, per WriteSessionCardResult.slug's contract
  }

  if (!cardOk) {
    // The card write itself failed — leave the WM file in place so a future
    // sweep (or the next graceful exit) can retry instead of losing the only
    // remaining record of this session.
    return;
  }

  // M1 fix (preserved from the CLI original): verify the recency append
  // actually landed instead of trusting that it didn't throw.
  // `appendRecentSession` is a DELIBERATELY best-effort, never-throws
  // telemetry ledger — an unwritable root, a full disk, or a permissions
  // error fails SILENTLY inside it. Re-read the ledger after the append and
  // only delete WM once BOTH tiers are confirmed present, so a
  // card-written-but-recency-failed session never becomes permanently
  // invisible to continuity.
  if (!hasRecency) {
    appendRecentSession({
      ts: new Date(wmFile.mtimeMs).toISOString(),
      sid: wmFile.sid,
      slug: ledgerSlug,
      title,
      artifact_count: 0,
      // Identity-trust fix (red-team CRITICAL-2, 2026-08-18): `distillOneSession`
      // is ONLY ever reached via `rescueOrphanedWorkingMemory` or
      // `distillSessionToCard` — every append this function makes is
      // rescue-sourced by construction, so this tag is unconditional (no
      // per-branch reasoning needed). `resurrect()`'s Source 1 loop reads it
      // to keep this entry out of the trusted ranking tier even when the
      // card itself already existed (the `hasCard && !hasRecency` branch).
      source: RESCUE_SOURCE_TAG,
    });
    const confirmedRecency = readRecentSessions(1000).some((e) => e.sid === wmFile.sid);
    if (!confirmedRecency) {
      recordHookFailure(
        "wm-orphan-rescue-recency",
        new Error(`appendRecentSession did not persist for sid=${wmFile.sid}`),
      );
      return; // do NOT delete WM — retry the recency append on the next sweep/exit
    }
  }

  wmDelete(wmFile.sid);
}

/**
 * C-3 (Train C, 2026-08-12 wave) — best-effort freshness for a graceful
 * client close. `mcp-server/src/lib/lifecycle-exit.ts` calls this for the
 * CURRENT process's own `sid` (core's `getSessionId()`) on `stdin` "end"/
 * "close" and on SIGTERM/SIGINT, so a graceful disconnect gets a card
 * immediately instead of waiting up to `WM_ORPHAN_WINDOW_MS` for the NEXT
 * session's orphan sweep to find it. Reuses `distillOneSession` — the SAME
 * WM→card mechanism `rescueOrphanedWorkingMemory` uses for aged orphans —
 * with no age gate, since this is called precisely because the session is
 * ending RIGHT NOW, not because it went stale. A `kill -9` bypasses this
 * entirely by construction (no signal, no stdin event ever fires) and falls
 * through to `rescueOrphanedWorkingMemory` on a LATER session_start/hook-start,
 * exactly as the design doc specifies.
 *
 * No-op (silent) when this session has no working-memory file at all — a
 * session that never had a tool call captured (or whose WM was already
 * cleaned up by a normal `session_end`) has nothing to distill. Never
 * throws: reported via `recordHookFailure` like every other WM helper.
 */
export function distillSessionToCard(sid: string): void {
  try {
    const wmFile = wmList().find((f) => f.sid === sid);
    if (!wmFile) return; // nothing captured for this session — silent no-op
    const recentSids = new Set(readRecentSessions(1000).map((e) => e.sid));
    distillOneSession(wmFile, recentSids);
  } catch (e) {
    recordHookFailure("wm-session-distill", e);
  }
}
