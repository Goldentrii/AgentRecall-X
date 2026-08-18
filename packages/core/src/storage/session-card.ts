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
import { ensureDir, todayISO, truncateUtf8Bytes } from "./fs-utils.js";
import { generateFrontmatter } from "../palace/obsidian.js";
import { recordHookFailure } from "./hook-health.js";
import { scrubForCloud } from "./content-guard.js";
import {
  DECISION_LINE_RE,
  NEXT_STEP_LINE_RE,
  parseJsonlLenient,
  extractArtifactPathsFromRecords,
  extractLinearRefsFromRecords,
  extractLinesMatching,
  extractFirstUserTextFromRecords,
  extractFinalRecordText,
} from "./extraction.js";

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

export interface WriteSessionCardResult {
  path: string;
  bytes: number;
  /**
   * The ACTUAL on-disk project slug this card was filed under, after
   * `journalDir`'s case-fold EXISTING-DIR-reuse resolution (paths.ts's
   * `resolveProjectDirName`, itself lowercasing via `sanitizeName`). This can
   * — and, for a raw cwd-captured candidate like "AgentRecall", WILL —
   * differ from the caller-supplied `card.slug`. Any caller that persists a
   * SEPARATE record of "where this session lives" (e.g. the recency ledger's
   * `slug` field) must key that record off THIS value, never off `card.slug`
   * directly — using the un-normalized input there is exactly the ledger-vs-
   * disk mismatch fixed in `distillOneSession` (working-memory.ts, Train C,
   * 2026-08-13: "rescue ledger slug must match card's normalized on-disk
   * slug"). Empty string only in the failure branch, where the write never
   * got far enough to resolve a slug at all.
   */
  slug: string;
}

// ---------------------------------------------------------------------------
// Field size budget (Card <= ~2KB, enforced in BYTES — this repo's content is
// routinely bilingual/CJK-heavy, where a char-length cap would silently blow
// well past 2KB on disk).
// ---------------------------------------------------------------------------

const CARD_BYTE_CAP = 2000;
const TITLE_CHAR_CAP = 120;
const ARTIFACTS_CAP = 10;
const LINEAR_REFS_CAP = 10;
const DECISIONS_CAP = 5;
const NEXT_STEP_CAP = 3;
const LAST_USER_CHAR_CAP = 300;
const LAST_ASSISTANT_CHAR_CAP = 800;
/** H4 fix: cap on F1's ranked slugCandidates list — see the call site in buildSessionCard. */
const SLUG_CANDIDATES_CAP = 5;

// DECISION_LINE_RE / NEXT_STEP_LINE_RE / the Linear-ref pattern now live in
// ./extraction.ts (fix2, 2026-07-31) — single source shared with
// tools-logic/resurrect.ts. See that module for the "TOW2-357" digit-prefix
// rationale previously documented inline here.

// ---------------------------------------------------------------------------
// Lenient JSONL parsing, boilerplate/content-block/system-text helpers:
// imported from ./extraction.ts (fix2 + fix3, 2026-07-31) — single source
// shared with tools-logic/resurrect.ts. SYSTEM_PREFIXES/isSystemText/
// extractFirstUserText/extractFinal used to be private copies here; they
// are now extraction.ts's isSystemText/extractFirstUserTextFromRecords/
// extractFinalRecordText (identical logic, same minLen defaults: 10 for the
// first-user-text fallback, 1 for the final-record reduction below).
// ---------------------------------------------------------------------------

/**
 * Truncate to at most maxBytes, UTF-8 safe (never splits mid multi-byte char
 * into garbage). M8 fix (review, 2026-07-31): delegates to the shared
 * `truncateUtf8Bytes` helper (fs-utils.ts) — the PREVIOUS local implementation
 * here (`buf.subarray(0, maxBytes).toString("utf-8")`) only claimed to be
 * UTF-8 safe; a cut landing mid-multi-byte-sequence silently produced one or
 * more U+FFFD replacement characters (repro'd), which could even push the
 * re-encoded byte length back OVER maxBytes.
 */
function truncateBytes(text: string, maxBytes: number): string {
  return truncateUtf8Bytes(text, maxBytes);
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

// extractFirstUserText / extractFinal / extractArtifacts / extractLinearRefs
// (M9-fixed) / extractLinesMatching now live in ./extraction.ts as
// extractFirstUserTextFromRecords / extractFinalRecordText /
// extractArtifactPathsFromRecords / extractLinearRefsFromRecords /
// extractLinesMatching — imported above. Single source shared with
// tools-logic/resurrect.ts (fix2 + fix3, 2026-07-31).

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

    // P0-a (2026-08-18): buildSessionCard runs directly on the RAW hook-end
    // transcript sample (rawHead/rawTail) — no upstream scrub has ever
    // touched this content (unlike working-memory.ts's wmAppend, which
    // scrubs at capture). This is the SURFACING BOUNDARY: the card is a
    // DERIVED artifact written to journal/ (not the lossless archive/raw
    // tier), and it feeds resurrect()/recall() unconditionally on every
    // session end. Scrub each extracted free-text field HERE, immediately
    // after extraction and BEFORE it is used for further regex extraction
    // (decisions/nextStep) or section-building, so every downstream
    // consumer of this card only ever sees already-clean text.
    const rawTitle =
      extractAiTitle(allLines) ??
      extractFirstUserTextFromRecords(allLines) ??
      "(untitled session)";
    const title = scrubForCloud(rawTitle).slice(0, TITLE_CHAR_CAP);

    const artifacts = extractArtifactPathsFromRecords(allLines, ARTIFACTS_CAP);
    const linearRefs = extractLinearRefsFromRecords(allLines, LINEAR_REFS_CAP);

    const finalAssistantText = scrubForCloud(extractFinalRecordText(allLines, "assistant") ?? "");
    const finalUserText = scrubForCloud(extractFinalRecordText(allLines, "user") ?? "");

    // Extracted from the ALREADY-SCRUBBED finalAssistantText above — decisions
    // and next-step lines inherit its cleanliness for free, with no separate
    // scrub pass needed. DECISION_LINE_RE/NEXT_STEP_LINE_RE match keyword
    // vocabulary ("decided"/"locked"/"next"/"待办"/...), which the scrub never
    // touches, so extraction fidelity is unaffected.
    const decisions = extractLinesMatching(finalAssistantText, DECISION_LINE_RE, DECISIONS_CAP);
    const nextStep = extractLinesMatching(finalAssistantText, NEXT_STEP_LINE_RE, NEXT_STEP_CAP);

    // H4 fix (review, 2026-07-31): cap slugCandidates to the top SLUG_CANDIDATES_CAP
    // by count BEFORE frontmatter serialization. Every other list field on this
    // card already has its own _CAP constant (ARTIFACTS_CAP, LINEAR_REFS_CAP, ...)
    // — this one didn't, and F1's ranked candidate list is NOT length-limited
    // upstream. An uncapped list let a single JSON.stringify'd frontmatter field
    // alone consume the ENTIRE CARD_BYTE_CAP, so the whole-markdown byte
    // truncation below cut mid-YAML — invalid frontmatter (no closing `---`),
    // and every body section after the cut point silently vanished.
    const cappedSlugCandidates = [...(raw?.meta?.slugCandidates ?? [])]
      .sort((a, b) => b.count - a.count)
      .slice(0, SLUG_CANDIDATES_CAP);

    const frontmatter = generateFrontmatter({
      sid,
      date,
      slug,
      slug_confidence: Number((raw?.meta?.slugConfidence ?? 0).toFixed(3)),
      slug_candidates: cappedSlugCandidates,
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

    // H4 fix: byte-truncate ONLY the body, never the frontmatter. A cut
    // mid-YAML produces an invalid card with no closing `---` and silently
    // drops every section after the cut point. Frontmatter is now bounded
    // (capped candidates above, plus the existing per-field caps on every
    // other frontmatter value) so it always fits comfortably on its own; the
    // body absorbs whatever budget remains, BYTE-based (CJK content can far
    // exceed a char-based cap on disk).
    const body = sections.join("\n");
    const frontmatterBytes = Buffer.byteLength(frontmatter, "utf-8");
    const bodyBudget = Math.max(0, CARD_BYTE_CAP - frontmatterBytes);
    const markdown = frontmatter + truncateBytes(body, bodyBudget);

    return { markdown, title, artifacts, linearRefs, decisions, nextStep, sid, slug, date };
  } catch (err) {
    // Never throw into the hook-end path — degrade to a minimal, valid card.
    // F5 depth (2026-08-12, followups wave): degrading silently means the
    // hook-end path reports success (a card WAS written) while the card is
    // actually a content-free stub — recordHookFailure makes that visible
    // without changing the degrade-to-stub behavior itself.
    recordHookFailure("session-card-build", err);
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
export function writeSessionCard(card: SessionCardResult): WriteSessionCardResult {
  try {
    const slug = sanitizeSlug(card.slug); // slug is caller-controlled; harden before path.join
    const sid = sanitizeSlug(card.sid); // sid is UNTRUSTED (from hook stdin) — sanitize first
    const dir = journalDir(slug);
    // The ACTUAL on-disk slug directory name, AFTER journalDir's case-fold
    // EXISTING-DIR-reuse resolution — see WriteSessionCardResult.slug's doc
    // comment above for why this (not `slug`/`card.slug`) is the value
    // callers must record wherever "where this card lives" needs persisting.
    const resolvedSlug = path.basename(path.dirname(dir));
    ensureDir(dir);

    const dest = path.join(dir, `${card.date}--card--${sid}.md`);
    if (fs.existsSync(dest)) {
      return { path: dest, bytes: 0, slug: resolvedSlug };
    }

    const tmp = dest + ".tmp." + process.pid;
    fs.writeFileSync(tmp, card.markdown, "utf-8");
    fs.renameSync(tmp, dest);

    return { path: dest, bytes: Buffer.byteLength(card.markdown, "utf-8"), slug: resolvedSlug };
  } catch (err) {
    // F5 depth (2026-08-12, followups wave): silent disk-write failure —
    // same visibility fix as archiveSession/buildSessionCard above.
    recordHookFailure("session-card-write", err);
    return { path: "", bytes: 0, slug: "" };
  }
}
