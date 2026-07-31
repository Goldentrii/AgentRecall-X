/**
 * extraction.ts — shared, single-source extraction helpers for session
 * transcripts and their derivatives (fix2, continuity wave, 2026-07-31).
 *
 * WHY this module exists: session-card.ts (F3, hook-end mechanical
 * distillation) and resurrect.ts (F6, read-only cross-slug session finder)
 * independently reimplemented Linear-ref / artifact-path / next-step-line
 * extraction. M9's tool_result exclusion (session-card.ts, review fix
 * 2026-07-31) and a markdown-heading exclusion never reached resurrect.ts's
 * copies, because there was nothing forcing the two to stay in sync — see
 * reports/2026-07-31-verifier-report.md §V3 and "additional findings" #3/#5.
 * This module is the ONE place those extraction rules live now; both
 * callers consume it, so a future fix to the rule only has to land once.
 *
 * Two input shapes are genuinely different and BOTH are covered here:
 *  - Record-based: parsed JSONL transcript records (`{type, message}`) —
 *    the shape of session-card.ts's rawHead/rawTail, and ALSO the shape
 *    embedded (after a frontmatter block) inside resurrect.ts's raw-archive
 *    bodies (journal/archive/raw/*.md — archive-write.ts writes the
 *    verbatim transcript JSONL as-is after its own frontmatter).
 *  - Text-based: a single flat prose/markdown string — session-card.ts's
 *    own already-reduced `finalAssistantText`/`finalUserText`, and
 *    resurrect.ts's session-card markdown bodies (journal/*--card--*.md,
 *    the RENDERED OUTPUT of session-card.ts, re-parsed generically per
 *    resurrect.ts's own design note: it must stay buildable without
 *    importing the card renderer itself).
 *
 * M9 (tool_result exclusion) is a RECORD-level concept — it distinguishes a
 * tool_use block (the assistant's own intentional call) from a tool_result
 * block (a tool's returned data, which can legitimately reference OTHER,
 * unrelated projects' ticket IDs). It only makes sense where records are
 * available: session-card.ts's rawHead/rawTail, and resurrect.ts's raw
 * archive bodies (Source 2), which are parsed here via `parseJsonlLenient`.
 * resurrect.ts's session-card bodies (Source 3) are already-rendered plain
 * markdown produced BY session-card.ts's own M9-protected extractors — they
 * never contain a raw tool_result JSON blob to exclude in the first place,
 * so a text-level M9 guard would have nothing to do there (see resurrect.ts
 * for the call site and this note reiterated at the point it matters).
 */

// ---------------------------------------------------------------------------
// Shared regex
// ---------------------------------------------------------------------------

// NOTE (CHALLENGE — deviates from the design doc's literal regex): the spec
// says `/[A-Z]{2,6}-\d+/g`, but that pattern cannot match THIS repo's own
// real Linear ID convention — team "TongWu" issues are "TOW2-357" etc., and
// `[A-Z]{2,6}` is uppercase-LETTERS-only, so the digit "2" inside "TOW2"
// breaks the letter run before the hyphen is ever reached (verified: the
// literal spec regex returns zero matches on "TOW2-357"). Widened to allow
// trailing digits in the team-key prefix while keeping the same safety
// properties (must start with a letter, so plain numbers/hex/versions never
// match; still requires a hyphen + digits, so bare words like "HEAD" don't).
const LINEAR_REF_SOURCE = "\\b[A-Z][A-Z0-9]{1,5}-\\d+\\b";

/** Decision-line marker, shared so both callers recognize the same vocabulary. */
export const DECISION_LINE_RE = /决定|decided|locked|confirmed/i;
/** Next-step-line marker, shared so both callers recognize the same vocabulary. */
export const NEXT_STEP_LINE_RE = /next|下一步|待办|todo/i;

/** A markdown ATX heading line (`#`..`######` + whitespace) — never a real content line. */
const MARKDOWN_HEADING_RE = /^#{1,6}\s/;

/** Fresh global-flagged RegExp per call — a shared stateful instance would corrupt concurrent `lastIndex` scans. */
function linearRefRegex(): RegExp {
  return new RegExp(LINEAR_REF_SOURCE, "g");
}

function matchAllLinearRefs(text: string): string[] {
  const re = linearRefRegex();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[0]);
  return out;
}

// ---------------------------------------------------------------------------
// Small shared utilities
// ---------------------------------------------------------------------------

export function unescapeJsonString(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s;
  }
}

export function dedupCapped(items: string[], cap: number): string[] {
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

// ---------------------------------------------------------------------------
// Record-based extraction (parsed JSONL transcript records)
// ---------------------------------------------------------------------------

/**
 * Lenient per-line JSONL parse. Raw archive bodies and rawHead/rawTail
 * samples are near-JSONL, not valid line-delimited JSON as a whole (they can
 * be head/tail-truncated mid-record, and raw-archive bodies are preceded by
 * a non-JSON YAML-ish frontmatter block) — this deliberately does NOT
 * attempt a full-document parse; it parses one line at a time and silently
 * skips whatever doesn't parse.
 */
export function parseJsonlLenient(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") out.push(parsed as Record<string, unknown>);
    } catch {
      /* skip malformed/truncated lines — expected at head/tail boundaries and at frontmatter/non-JSON lines */
    }
  }
  return out;
}

/** Hook stdout/boilerplate records are never real conversation content. */
export function isBoilerplateRecord(rec: Record<string, unknown>): boolean {
  return rec.type === "attachment";
}

/** First `type: "text"` block of a message's content (string or content-block array). */
export function textFromContent(content: unknown): string {
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

/** Write/Edit tool_use `input.file_path` values, in first-seen order, from parsed transcript records. */
export function extractArtifactPathsFromRecords(lines: Record<string, unknown>[], cap: number): string[] {
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
  return dedupCapped(paths, cap);
}

/**
 * Linear IDs from parsed transcript records. M9: scoped to content the
 * user/assistant actually AUTHORED this turn — a plain string message body,
 * a `type: "text"` content block, or a `type: "tool_use"` block's OWN
 * `input` (the assistant's intentional tool-call arguments, e.g.
 * `mcp__linear__save_issue` called with `{identifier: "TOW2-360"}` — real,
 * intentional content, scanned regardless of which tool). Explicitly
 * EXCLUDES `type: "tool_result"` content blocks — those carry a tool's
 * RETURNED data (e.g. the output of `mcp__agent-recall__recall` or
 * `mcp__linear__list_issues`), which can legitimately contain OTHER,
 * unrelated projects' ticket IDs the assistant never decided or acted on
 * this session.
 */
export function extractLinearRefsFromRecords(lines: Record<string, unknown>[], cap: number): string[] {
  const refs: string[] = [];

  for (const rec of lines) {
    if (isBoilerplateRecord(rec)) continue;
    if (rec.type !== "user" && rec.type !== "assistant") continue;
    const msg = rec.message as Record<string, unknown> | undefined;
    const content = msg?.content;

    if (typeof content === "string") {
      refs.push(...matchAllLinearRefs(content));
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        refs.push(...matchAllLinearRefs(b.text));
      } else if (b.type === "tool_use") {
        // The assistant's OWN tool-call arguments — real, intentional
        // content, unlike a tool_result's returned data (never scanned).
        try {
          refs.push(...matchAllLinearRefs(JSON.stringify(b.input ?? {})));
        } catch {
          /* unstringifiable input — skip */
        }
      }
      // `tool_result` blocks are deliberately NOT scanned (M9).
    }
  }
  return dedupCapped(refs, cap);
}

// ---------------------------------------------------------------------------
// System/injected-text exclusion + record-based "real text" reduction
// ---------------------------------------------------------------------------
// fix3 (2026-07-31, continuity wave): promoted from session-card.ts's private
// isSystemText/extractFirstUserText/extractFinal (identical logic, same
// minLen defaults) to a shared home here — resurrect.ts's raw-archive Source
// 2 needs the SAME record-aware "first real user text" / "final real
// assistant text" reduction session-card.ts already uses for its title
// fallback and finalAssistantText/finalUserText, and reimplementing it a
// second time (as a flat text-level regex scan, which is exactly what
// resurrect.ts used to do — see the "additional findings" this fix closes)
// is the precise class of bug fix2's consolidation already killed once.

/** Harness/system-injected text markers a real user/assistant turn never authors verbatim (slash-command scaffolding, `<system-reminder>` blocks, etc.). */
const SYSTEM_TEXT_PREFIXES = [
  /^dangerously-skip/i,
  /^<local-command/,
  /^<command-name/,
  /^<command-message/,
  /^<command-args/,
  /^<system-reminder/,
  /^<user-prompt-submit/,
];

/** True when `text` opens with one of `SYSTEM_TEXT_PREFIXES` — never real user/assistant content. */
export function isSystemText(text: string): boolean {
  const t = text.trimStart();
  return SYSTEM_TEXT_PREFIXES.some((re) => re.test(t));
}

/**
 * First real (non-boilerplate-record, non-system-text) user message text
 * from parsed transcript records, scanning forward. Record- and content-
 * block-aware via `textFromContent`: a `tool_result` content block (a
 * tool's RETURNED data — e.g. a `remember()` call's own confirmation echo,
 * "Saved → ... Find again: recall(...)") is never returned here, because
 * `textFromContent` only surfaces a `type:"text"` block, never a sibling
 * `tool_result` block in the same content array. This is the "goal" side of
 * M9's tool_result exclusion, generalized from Linear-ref scanning to
 * free-text goal extraction.
 */
export function extractFirstUserTextFromRecords(records: Record<string, unknown>[], minLen = 10): string | null {
  for (const rec of records) {
    if (isBoilerplateRecord(rec)) continue;
    if (rec.type !== "user") continue;
    const msg = rec.message as Record<string, unknown> | undefined;
    const text = textFromContent(msg?.content);
    if (text.length < minLen || isSystemText(text)) continue;
    return text;
  }
  return null;
}

/**
 * Last real (non-boilerplate-record, non-system-text) record of `type`,
 * scanning from the end of `records`. Shared by session-card.ts's
 * finalAssistantText/finalUserText reduction and resurrect.ts's raw-archive
 * next-step derivation — both need "the final thing a user/assistant
 * actually said", never a raw JSONL line matched by substring.
 */
export function extractFinalRecordText(
  records: Record<string, unknown>[],
  type: "user" | "assistant",
  minLen = 1,
): string | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (isBoilerplateRecord(rec)) continue;
    if (rec.type !== type) continue;
    const msg = rec.message as Record<string, unknown> | undefined;
    const text = textFromContent(msg?.content);
    if (!text || text.length < minLen || isSystemText(text)) continue;
    return text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Text-based extraction (flat prose/markdown — no record structure available)
// ---------------------------------------------------------------------------

/** Plain global scan for Linear refs across a flat text/markdown string. No record structure is available at this
 *  level, so there is no tool_result to exclude — see the file header note on why that's the case in practice for
 *  every current text-based caller (already-distilled session-card markdown). */
export function extractLinearRefsFromText(text: string, cap: number): string[] {
  return dedupCapped(matchAllLinearRefs(text), cap);
}

/**
 * Artifact paths from a flat text/markdown body, precision-first: only a
 * `"file_path":"..."` JSON value or a markdown list-item path is trusted —
 * never a bare path floating in prose/hook-boilerplate text, which is
 * exactly how naive extraction gets misled by folder-lint warnings quoting
 * unrelated files.
 *
 * fix2 (2026-07-31): the list-item pattern now tolerates a backtick or bold
 * marker immediately after the list marker (`- \`~/path\`` / `- **~/path**`)
 * — real session cards (session-card.ts's own
 * `sections.push("## Artifacts", ...artifacts.map((p) => \`- \\\`${p}\\\`\`))`)
 * ALWAYS wrap the path in backticks, and the pre-fix pattern required the
 * character right after the marker + space to be `~`/`/` directly, so it
 * silently never matched a real card's own artifact list (confirmed against
 * the real store — verifier-report V3, `交付物2_MCP原型_V14.html`).
 *
 * The opening marker is matched as a literal alternation (backtick / `**` /
 * `__`), NOT folded into the captured path's character class — a char-class
 * exclusion of `_`/`*` would also strip those characters from the MIDDLE of
 * a legitimate path, and this repo's own real filenames routinely contain
 * underscores (e.g. `交付物2_MCP原型_V14.html`, verified: an earlier draft of
 * this fix corrupted exactly that path to `交付物2` by excluding `_` from the
 * capture class). Any trailing closing marker is stripped in a separate,
 * bounded cleanup step after the capture completes.
 */
export function extractArtifactPathsFromText(text: string, cap: number): string[] {
  const found = new Set<string>();

  const filePathRe = /"file_path"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let m: RegExpExecArray | null;
  while ((m = filePathRe.exec(text)) !== null) {
    if (found.size >= cap) break;
    found.add(unescapeJsonString(m[1]));
  }

  const listItemRe = /^\s*[-*]\s+(?:`|\*\*|__)?(~\/[^\s`]+|\/[^\s`]+)/;
  for (const line of text.split("\n")) {
    if (found.size >= cap) break;
    const li = line.match(listItemRe);
    if (!li) continue;
    const cleaned = li[1].replace(/(`|\*\*|__)+$/, "");
    if (cleaned) found.add(cleaned);
  }

  return [...found].slice(0, cap);
}

/**
 * Lines matching `re`, each capped to `lineCharCap` chars (ellipsis-suffixed
 * when truncated). Markdown ATX heading lines (`^#{1,6}\s`) are always
 * skipped — a card's own "## Next steps" section heading must never be
 * mistaken for one of its own next-step bullet lines (a real, reproduced
 * bug in resurrect.ts's pre-refactor copy of this logic, which had no such
 * exclusion and produced a spurious duplicate "next step" entry).
 */
export function extractLinesMatching(text: string, re: RegExp, cap: number, lineCharCap = 200): string[] {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || MARKDOWN_HEADING_RE.test(line)) continue;
    if (!re.test(line)) continue;
    out.push(line.length > lineCharCap ? line.slice(0, lineCharCap) + "…" : line);
    if (out.length >= cap) break;
  }
  return out;
}
