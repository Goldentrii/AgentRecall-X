/**
 * session-card.ts — mechanical session-card distillation (F3).
 *
 * Pure-mechanical, NO LLM: this runs on the hook-end path and must stay
 * fast/offline. Built directly from the 2026-07-31 continuity-fixture
 * incident (reports/2026-07-31-continuity-fixture.md §2 — "session-card
 * field feasibility"): frontmatter, tool-call artifacts, and Linear refs
 * sourced from direct tool calls are ~70% mechanical; goal/narrative state
 * genuinely needs an LLM pass (out of scope here) — this module only builds
 * the mechanical 70%, unconditionally, on every session end.
 *
 * The card is a NORMAL journal file (written under journal/, not
 * journal/archive/raw/) so it enters existing retrieval + consolidation
 * pipelines for free — no new read path required.
 *
 * Precision rule (fixture report §2): hook-injected `attachment` records
 * (startup-hook stdout, folder-lint dumps, memory-stale-check output, etc.)
 * are NEVER a valid source for artifacts/Linear-refs/title/decisions — that
 * is exactly how the incident's forensics got misdirected. Every extractor
 * below filters those out before scanning.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { journalDir, sanitizeSlug } from "./paths.js";
import { ensureDir, todayISO } from "./fs-utils.js";
import { generateFrontmatter } from "../palace/obsidian.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionCardMeta {
  /** Session UUID — untrusted, sanitized before any path.join. */
  sid: string;
  /** Resolved project slug (may be "auto"). */
  slug: string;
  /** F1's resolveSessionProject() confidence, 0 when slug === "auto". */
  slugConfidence: number;
  /** F1's full candidate ranking — kept so a low-confidence card is re-fileable later. */
  slugCandidates: Array<{ slug: string; count: number }>;
  /** ISO date (YYYY-MM-DD). Defaults to today if omitted. */
  date?: string;
}

export interface SessionCardInput {
  /** Head sample of the transcript (JSONL text) — same shape as transcript-reader's `head`. */
  rawHead: string;
  /** Tail sample of the transcript (JSONL text) — same shape as transcript-reader's `tail`. */
  rawTail: string;
  meta: SessionCardMeta;
}

export interface SessionCardResult {
  markdown: string;
  title: string;
  artifacts: string[];
  linearRefs: string[];
  decisions: string[];
  nextStep: string[];
  sid: string;
  slug: string;
  date: string;
}

// ---------------------------------------------------------------------------
// Field size budget (Card <= ~2KB, enforced in BYTES — this repo's content is
// routinely bilingual/CJK-heavy, where a char-length cap would silently blow
// well past 2KB on disk).
// ---------------------------------------------------------------------------

const CARD_BYTE_CAP = 2000;
const TITLE_CHAR_CAP = 120;
const LINE_CHAR_CAP = 200; // per decision/next-step line
const ARTIFACTS_CAP = 10;
const LINEAR_REFS_CAP = 10;
const DECISIONS_CAP = 5;
const NEXT_STEP_CAP = 3;
const LAST_USER_CHAR_CAP = 300;
const LAST_ASSISTANT_CHAR_CAP = 800;

// NOTE (CHALLENGE — deviates from the design doc's literal regex): the spec
// says `/[A-Z]{2,6}-\d+/g`, but that pattern cannot match THIS repo's own
// real Linear ID convention — team "TongWu" issues are "TOW2-357" etc., and
// `[A-Z]{2,6}` is uppercase-LETTERS-only, so the digit "2" inside "TOW2"
// breaks the letter run before the hyphen is ever reached (verified: the
// literal spec regex returns zero matches on "TOW2-357"). Widened to allow
// trailing digits in the team-key prefix while keeping the same safety
// properties (must start with a letter, so plain numbers/hex/versions never
// match; still requires a hyphen + digits, so bare words like "HEAD" don't).
const LINEAR_REF_RE = /\b[A-Z][A-Z0-9]{1,5}-\d+\b/g;
const DECISION_LINE_RE = /决定|decided|locked|confirmed/i;
const NEXT_STEP_LINE_RE = /next|下一步|待办|TODO/i;

const SYSTEM_PREFIXES = [
  /^dangerously-skip/i,
  /^<local-command/,
  /^<command-name/,
  /^<command-message/,
  /^<command-args/,
  /^<system-reminder/,
  /^<user-prompt-submit/,
];

// ---------------------------------------------------------------------------
// Lenient JSONL parsing (local copy — core must not depend on the cli
// package's transcript-reader; this is the same tolerant per-line parse).
// ---------------------------------------------------------------------------

function parseJsonlLenient(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") out.push(parsed as Record<string, unknown>);
    } catch {
      /* skip malformed/truncated lines — expected at head/tail boundaries */
    }
  }
  return out;
}

function isSystemText(text: string): boolean {
  const t = text.trimStart();
  return SYSTEM_PREFIXES.some((re) => re.test(t));
}

/** First `type: "text"` block of a message's content (string or content-block array). */
function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && typeof c === "object" && (c as Record<string, unknown>).type === "text") {
        return String((c as Record<string, unknown>).text ?? "");
      }
    }
  }
  return "";
}

/** Hook stdout/boilerplate records are never real conversation content (fixture report §0/§2). */
function isBoilerplateRecord(rec: Record<string, unknown>): boolean {
  return rec.type === "attachment";
}

function dedupCapped(items: string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}

/** Truncate to at most maxBytes, UTF-8 safe (never splits mid multi-byte char into garbage). */
function truncateBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString("utf-8");
}

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

/** Transcript summary record (`{"type":"ai-title","aiTitle":"..."}`), if the transcript has one. */
function extractAiTitle(lines: Record<string, unknown>[]): string | null {
  for (const rec of lines) {
    if (rec.type === "ai-title" && typeof rec.aiTitle === "string" && rec.aiTitle.trim()) {
      return rec.aiTitle.trim();
    }
  }
  return null;
}

/** First real (non-boilerplate, non-system) user message, for the title fallback. */
function extractFirstUserText(lines: Record<string, unknown>[]): string | null {
  for (const rec of lines) {
    if (isBoilerplateRecord(rec)) continue;
    if (rec.type !== "user") continue;
    const msg = rec.message as Record<string, unknown> | undefined;
    const text = textFromContent(msg?.content);
    if (text.length < 10 || isSystemText(text)) continue;
    return text;
  }
  return null;
}

/** Last real (non-boilerplate) user / assistant-with-text record, scanning from the end. */
function extractFinal(lines: Record<string, unknown>[], type: "user" | "assistant"): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const rec = lines[i];
    if (isBoilerplateRecord(rec)) continue;
    if (rec.type !== type) continue;
    const msg = rec.message as Record<string, unknown> | undefined;
    const text = textFromContent(msg?.content);
    if (!text || text.length < 1 || isSystemText(text)) continue;
    return text;
  }
  return null;
}

/** Write/Edit tool_use `input.file_path` values, in first-seen order. */
function extractArtifacts(lines: Record<string, unknown>[]): string[] {
  const paths: string[] = [];
  for (const rec of lines) {
    if (isBoilerplateRecord(rec)) continue;
    if (rec.type !== "assistant") continue;
    const msg = rec.message as Record<string, unknown> | undefined;
    const content = msg?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      const cr = c as Record<string, unknown>;
      if (cr.type !== "tool_use") continue;
      if (cr.name !== "Write" && cr.name !== "Edit") continue;
      const input = cr.input as Record<string, unknown> | undefined;
      const filePath = input?.file_path;
      if (typeof filePath === "string" && filePath) paths.push(filePath);
    }
  }
  return dedupCapped(paths, ARTIFACTS_CAP);
}

/**
 * Linear IDs, scanned across the full record of every non-boilerplate
 * user/assistant turn (not just its "text" block) — a direct tool call
 * (e.g. mcp__agent-recall__remember, mcp__linear__*) carries the ID inside
 * a tool_use/tool_result payload, not necessarily a "text" content block.
 * Still boilerplate-excluded (fixture report §2: "TOW2-310/276 leak in from
 * unrelated projects" via hook-injected memory dumps) — this widens WHERE
 * we look inside a real turn, never loosens WHICH turns count as real.
 */
function extractLinearRefs(lines: Record<string, unknown>[]): string[] {
  const refs: string[] = [];
  for (const rec of lines) {
    if (isBoilerplateRecord(rec)) continue;
    if (rec.type !== "user" && rec.type !== "assistant") continue;
    let blob: string;
    try {
      blob = JSON.stringify(rec.message ?? {});
    } catch {
      continue;
    }
    LINEAR_REF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINEAR_REF_RE.exec(blob)) !== null) {
      refs.push(m[0]);
    }
  }
  return dedupCapped(refs, LINEAR_REFS_CAP);
}

function extractLinesMatching(text: string, re: RegExp, cap: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || !re.test(line)) continue;
    out.push(line.length > LINE_CHAR_CAP ? line.slice(0, LINE_CHAR_CAP) + "…" : line);
    if (out.length >= cap) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a session card (F3) — pure-mechanical distillation of a session's
 * head+tail transcript sample. Never throws: any internal failure degrades
 * to an empty/best-effort card rather than breaking the hook-end path.
 */
export function buildSessionCard(raw: SessionCardInput): SessionCardResult {
  const sid = raw?.meta?.sid ?? "";
  const slug = raw?.meta?.slug ?? "auto";
  const date = raw?.meta?.date ?? todayISO();

  try {
    const headLines = parseJsonlLenient(raw.rawHead ?? "");
    const tailLines = parseJsonlLenient(raw.rawTail ?? "");
    const allLines = [...headLines, ...tailLines];

    const title = (
      extractAiTitle(allLines) ??
      extractFirstUserText(allLines) ??
      "(untitled session)"
    ).slice(0, TITLE_CHAR_CAP);

    const artifacts = extractArtifacts(allLines);
    const linearRefs = extractLinearRefs(allLines);

    const finalAssistantText = extractFinal(allLines, "assistant") ?? "";
    const finalUserText = extractFinal(allLines, "user") ?? "";

    const decisions = extractLinesMatching(finalAssistantText, DECISION_LINE_RE, DECISIONS_CAP);
    const nextStep = extractLinesMatching(finalAssistantText, NEXT_STEP_LINE_RE, NEXT_STEP_CAP);

    const frontmatter = generateFrontmatter({
      sid,
      date,
      slug,
      slug_confidence: Number((raw?.meta?.slugConfidence ?? 0).toFixed(3)),
      slug_candidates: raw?.meta?.slugCandidates ?? [],
      source: "hook-end",
    });

    const sections: string[] = [`# ${title}`, ""];

    if (linearRefs.length > 0) {
      sections.push("## Linear", linearRefs.join(", "), "");
    }
    if (artifacts.length > 0) {
      sections.push("## Artifacts", ...artifacts.map((p) => `- \`${p}\``), "");
    }
    if (decisions.length > 0) {
      sections.push("## Decisions", ...decisions.map((d) => `- ${d}`), "");
    }
    if (nextStep.length > 0) {
      sections.push("## Next steps", ...nextStep.map((n) => `- ${n}`), "");
    }
    if (finalUserText || finalAssistantText) {
      sections.push("## Last exchange");
      if (finalUserText) {
        const u = finalUserText.trim();
        sections.push(`**User:** ${u.length > LAST_USER_CHAR_CAP ? u.slice(0, LAST_USER_CHAR_CAP) + "…" : u}`, "");
      }
      if (finalAssistantText) {
        const a = finalAssistantText.trim();
        sections.push(
          `**Assistant:** ${a.length > LAST_ASSISTANT_CHAR_CAP ? a.slice(0, LAST_ASSISTANT_CHAR_CAP) + "…" : a}`,
          "",
        );
      }
    }

    let markdown = frontmatter + sections.join("\n");
    // Hard cap, BYTE-based (CJK content can far exceed a char-based cap on disk).
    markdown = truncateBytes(markdown, CARD_BYTE_CAP);

    return { markdown, title, artifacts, linearRefs, decisions, nextStep, sid, slug, date };
  } catch {
    // Never throw into the hook-end path — degrade to a minimal, valid card.
    const frontmatter = generateFrontmatter({
      sid,
      date,
      slug,
      slug_confidence: 0,
      slug_candidates: [],
      source: "hook-end",
    });
    const markdown = truncateBytes(`${frontmatter}# (session card build failed)\n`, CARD_BYTE_CAP);
    return {
      markdown,
      title: "(session card build failed)",
      artifacts: [],
      linearRefs: [],
      decisions: [],
      nextStep: [],
      sid,
      slug,
      date,
    };
  }
}

/**
 * Write a session card as a normal journal file: projects/<slug>/journal/
 * <date>--card--<sid>.md — no new directory, no new read path; existing
 * journal search/consolidation reach it automatically.
 *
 * Idempotent on the session UUID (never overwrites an existing card, matching
 * archive-write.ts's convention) and never throws — a failed write must not
 * break the hook-end / Stop turn.
 */
export function writeSessionCard(card: SessionCardResult): { path: string; bytes: number } {
  try {
    const slug = sanitizeSlug(card.slug); // slug is caller-controlled; harden before path.join
    const sid = sanitizeSlug(card.sid); // sid is UNTRUSTED (from hook stdin) — sanitize first
    const dir = journalDir(slug);
    ensureDir(dir);

    const dest = path.join(dir, `${card.date}--card--${sid}.md`);
    if (fs.existsSync(dest)) {
      return { path: dest, bytes: 0 };
    }

    const tmp = dest + ".tmp." + process.pid;
    fs.writeFileSync(tmp, card.markdown, "utf-8");
    fs.renameSync(tmp, dest);

    return { path: dest, bytes: Buffer.byteLength(card.markdown, "utf-8") };
  } catch {
    return { path: "", bytes: 0 };
  }
}
