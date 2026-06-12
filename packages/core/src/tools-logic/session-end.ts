/**
 * session_end — combined session save in one call.
 *
 * Replaces: awareness_update + journal_write + palace consolidation
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { journalWrite } from "./journal-write.js";
import { awarenessUpdate } from "./awareness-update.js";
import { promoteConfirmedInsights } from "./insight-promotion.js";
import { readInsightsIndex, findSimilarInsight } from "../palace/insights-index.js";
import { consolidateJournalToPalace } from "../palace/consolidate.js";
import { resolveProject } from "../storage/project.js";
import { readCorrections, recordOutcome } from "../storage/corrections.js";
import { ensurePalaceInitialized, listRooms } from "../palace/rooms.js";
import { journalDir } from "../storage/paths.js";
import { readAwarenessState } from "../palace/awareness.js";
import { todayISO } from "../storage/fs-utils.js";
import { getRoot } from "../types.js";
import { extractKeywords } from "../helpers/auto-name.js";
import type { SaveType } from "../storage/session.js";
import { autoClassifySig, autoClassifyTheme } from "../helpers/journal-sig-theme.js";
import type { SignificanceTag, ThemeTag } from "../helpers/journal-sig-theme.js";
import { pipelineOpen } from "./pipeline-open.js";
import { pipelineClose } from "./pipeline-close.js";
import { writeHandoff } from "../helpers/handoff.js";

export interface SessionEndInput {
  summary: string;
  insights?: Array<{
    title: string;
    evidence: string;
    applies_when: string[];
    source?: string;
    severity?: "critical" | "important" | "minor";
  }>;
  trajectory?: string;
  project?: string;
  saveType?: SaveType;
  sig?: SignificanceTag;   // NEW — auto-classified if not provided
  theme?: ThemeTag;        // NEW — auto-classified if not provided
  /**
   * Optionally close the currently-active pipeline phase as part of this save.
   * No LLM auto-detect — caller must supply the three reflection fields.
   */
  close_phase?: {
    what_was_hard: string;
    how_solved: string;
    synthesis: string;
    status?: "closed" | "abandoned" | "pivoted";
    related_journal?: string[];
    related_insights?: string[];
  };
  /**
   * Optionally open a new pipeline phase as part of this save (e.g. when a
   * watershed session pivots into the next strategic direction).
   */
  open_phase?: {
    phase_name: string;
    goal: string;
  };
}

export interface MergeSuggestion {
  file: string;
  date: string;
  overlap_keywords: string[];
  reason: string;
}

export interface InsightQualityWarning {
  index: number;
  title: string;
  issues: string[];
  suggestion: string;
}

export interface PipelinePhaseAction {
  ok: boolean;
  order?: number;
  phase?: string;
  file_path?: string;
  error?: string;
}

export interface SessionEndResult {
  success: boolean;
  journal_written: boolean;
  journal_write_error?: string;
  insights_processed: number;
  /** New insights added to the index (no prior match found). */
  insights_added: number;
  /** Existing insights confirmed (near-duplicate title matched, count++). */
  insights_confirmed: number;
  awareness_updated: boolean;
  awareness_error?: string;
  palace_consolidated: boolean;
  palace_error?: string;
  card: string;
  merge_suggestions?: MergeSuggestion[];
  quality_warnings?: InsightQualityWarning[];
  pipeline_closed?: PipelinePhaseAction;
  pipeline_opened?: PipelinePhaseAction;
  /** Path to the handoff artifact written at session_end. Present on success. */
  handoff_path?: string;
}

export function checkInsightQuality(
  insights: SessionEndInput["insights"]
): InsightQualityWarning[] {
  if (!insights || insights.length === 0) return [];
  const warnings: InsightQualityWarning[] = [];

  for (let i = 0; i < insights.length; i++) {
    const insight = insights[i];
    const issues: string[] = [];

    // Rule 1: Title too short (< 20 chars) — almost always too vague to be useful
    if (insight.title.trim().length < 20) {
      issues.push("Title too short (< 20 chars) — likely too vague to be useful");
    }

    // Rule 2: Title starts with a past-tense event verb with no outcome described
    if (
      /^(fixed|resolved|updated|added|removed|changed)\s+\w/i.test(insight.title.trim()) &&
      insight.title.length < 50
    ) {
      issues.push(
        "Title describes an event ('fixed X'), not a reusable pattern — state what was learned, not what was done"
      );
    }

    // Rule 3: Evidence too short (< 15 chars) — not enough to validate the insight
    if (!insight.evidence || insight.evidence.trim().length < 15) {
      issues.push("Evidence too short — add what specifically happened that confirmed this insight");
    }

    // Rule 4: applies_when has fewer than 2 keywords — too broad
    if (!insight.applies_when || insight.applies_when.length < 2) {
      issues.push(
        "applies_when needs at least 2 keywords — when exactly would a future agent apply this?"
      );
    }

    if (issues.length > 0) {
      let suggestion = "Rewrite as: '[Specific trigger/condition] — [concrete fact + what to do]'";
      if (issues[0].includes("event")) {
        suggestion = `Instead of '${insight.title}', try: 'When [condition], [concrete outcome/action]'`;
      }
      warnings.push({ index: i, title: insight.title, issues, suggestion });
    }
  }

  return warnings;
}

export async function sessionEnd(input: SessionEndInput): Promise<SessionEndResult> {
  if (!input.summary || input.summary.trim().length < 10) {
    return {
      success: false,
      journal_written: false,
      insights_processed: 0,
      insights_added: 0,
      insights_confirmed: 0,
      awareness_updated: false,
      palace_consolidated: false,
      card: "Summary too short (minimum 10 characters). Nothing saved.",
      journal_write_error: "Summary too short (minimum 10 characters). Nothing saved.",
    };
  }

  const slug = await resolveProject(input.project);
  let journalWritten = false;
  let journalWriteError: string | undefined;
  let insightsProcessed = 0;
  let insightsAdded = 0;
  let insightsConfirmed = 0;
  let awarenessUpdated = false;
  let awarenessError: string | undefined;
  let palaceConsolidated = false;
  let palaceError: string | undefined;

  // 1. Write journal summary
  // Use ## Brief for first save of the day; ## Update HH:MM for subsequent saves
  // This prevents duplicate ## Brief headers when /arsave is called multiple times per day
  try {
    const jDir = journalDir(slug);
    const date = todayISO();
    let sectionHeading = "## Brief";
    if (fs.existsSync(jDir)) {
      const existingFiles = fs.readdirSync(jDir)
        .filter(f => f.startsWith(date) && f.endsWith(".md") && f !== "index.md");
      for (const f of existingFiles) {
        const content = fs.readFileSync(path.join(jDir, f), "utf-8");
        if (content.includes("## Brief")) {
          const now = new Date();
          const hh = now.getHours().toString().padStart(2, "0");
          const mm = now.getMinutes().toString().padStart(2, "0");
          sectionHeading = `## Update ${hh}:${mm}`;
          break;
        }
      }
    }

    const journalContent = [
      sectionHeading,
      input.summary,
      "",
      input.trajectory ? `## Next\n${input.trajectory}` : "",
    ].filter(Boolean).join("\n");

    const sig = input.sig ?? autoClassifySig(input.summary);
    const theme = input.theme ?? autoClassifyTheme(input.summary);

    await journalWrite({ content: journalContent, project: slug, saveType: input.saveType ?? "arsave", sig, theme });
    journalWritten = true;
  } catch (err) {
    journalWriteError = err instanceof Error ? err.message : String(err);
  }

  // 1b. P0-B: auto-record heeded/recurred outcomes for corrections that were
  // retrieved today (last_retrieved date matches today). This is a default-heeded
  // heuristic with recurrence detection — coarse but closes the learning loop
  // automatically without requiring the agent to remember to call recordOutcome.
  //
  // Heuristic v1: classify "recurred" only when the session summary contains
  // ≥ 2 content words from the correction rule (length ≥ 4, lowercased) AND
  // also contains a recurrence marker. Default to "heeded" when markers absent.
  // Precision improves when check_action wiring lands in a future sprint.
  //
  // Fire-and-forget: outcome tracking must NEVER affect the session_end result.
  if (journalWritten) {
    try {
      // Local-TZ date matching (see session-start.ts guard comment).
      const todayStr = new Date().toLocaleDateString("sv");
      const nowISO = new Date().toISOString();
      const todays = readCorrections(slug).filter(
        (c) => c.last_retrieved && new Date(c.last_retrieved).toLocaleDateString("sv") === todayStr && c.active !== false
      );
      const recurrenceMarker = /\b(again|recurred|repeated|violat|broke the rule|same mistake)\b/i;
      const summaryLower = input.summary.toLowerCase();
      for (const c of todays) {
        try {
          // Extract content words (≥ 4 chars) from the rule text
          const ruleWords = c.rule
            .toLowerCase()
            .split(/\W+/)
            .filter((w) => w.length >= 4);
          const matchCount = ruleWords.filter((w) => summaryLower.includes(w)).length;
          const hasRecurrenceMarker = recurrenceMarker.test(input.summary);
          const violated = matchCount >= 2 && hasRecurrenceMarker;
          recordOutcome({
            correction_id: c.id,
            project: slug,
            kind: violated ? "recurred" : "heeded",
            at: nowISO,
            evidence: violated
              ? "recurrence markers in session summary"
              : "no recurrence evidence in session summary",
          });
        } catch {
          // Per-correction errors are swallowed — don't abort the loop
        }
      }
    } catch {
      // Outcome tracking must NEVER break session_end — swallow all errors
    }
  }

  // 2. Update awareness with insights — confirm-first classification
  // Pre-classify each insight against the current index BEFORE passing to
  // awarenessUpdate. This ensures the count tallies are accurate even if
  // awarenessUpdate itself also performs its own similarity check.
  if (input.insights && input.insights.length > 0) {
    try {
      // Read the current index once for confirm-first classification
      const currentIndex = readInsightsIndex();
      for (const insight of input.insights) {
        const match = findSimilarInsight(insight.title, currentIndex.insights);
        if (match) {
          insightsConfirmed++;
        } else {
          insightsAdded++;
        }
      }

      const scopedTrajectory = input.trajectory
        ? `${slug}: ${input.trajectory}`
        : undefined;
      const result = await awarenessUpdate({
        insights: input.insights.map((i) => ({
          title: i.title,
          evidence: i.evidence,
          applies_when: i.applies_when,
          source: i.source ?? `session_end ${new Date().toISOString().slice(0, 10)}`,
          source_project: slug ?? "_global",
          severity: i.severity,
        })),
        project: slug,
        trajectory: scopedTrajectory,
      });
      insightsProcessed = result.insights_processed?.length ?? input.insights.length;
      awarenessUpdated = true;
    } catch (err) {
      awarenessError = err instanceof Error ? err.message : String(err);
      // Reset tallies on error so they don't misreport
      insightsAdded = 0;
      insightsConfirmed = 0;
    }
  }

  // 3. Consolidate journal to palace
  try {
    ensurePalaceInitialized(slug);
    consolidateJournalToPalace(slug);
    palaceConsolidated = true;
  } catch (err) {
    palaceError = err instanceof Error ? err.message : String(err);
  }

  // 4. Detect similar recent entries — suggest merge if high overlap
  const mergeSuggestions: MergeSuggestion[] = [];
  try {
    const newKeywords = extractKeywords(input.summary, 6);
    if (newKeywords.length >= 2) {
      const jDirPath = journalDir(slug);
      if (fs.existsSync(jDirPath)) {
        const today = todayISO();
        const files = fs.readdirSync(jDirPath)
          .filter(f => f.endsWith(".md") && f !== "index.md")
          .sort()
          .reverse();

        for (const file of files.slice(0, 30)) { // check last 30 entries
          const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
          if (!dateMatch) continue;
          const fileDate = dateMatch[1];

          // Skip today's file (we just wrote to it)
          if (fileDate === today) continue;

          // Only check last 7 days
          const daysAgo = (Date.now() - new Date(fileDate).getTime()) / (1000 * 60 * 60 * 24);
          if (daysAgo > 7) break;

          // Read first 500 chars of the file for keyword comparison
          const filePath = path.join(jDirPath, file);
          const content = fs.readFileSync(filePath, "utf-8").slice(0, 1500);
          const existingKeywords = extractKeywords(content, 6);

          // Compute overlap
          const overlap = newKeywords.filter(k =>
            existingKeywords.some(ek => ek.includes(k) || k.includes(ek))
          );

          if (overlap.length >= 3) {
            mergeSuggestions.push({
              file,
              date: fileDate,
              overlap_keywords: overlap,
              reason: `${overlap.length}/${newKeywords.length} keywords overlap with ${file}`,
            });
          }
        }
      }
    }
  } catch { /* merge detection is best-effort */ }

  // 5. Render save card — server-side, always correct
  const root = getRoot();
  const date = todayISO();
  const jDir = journalDir(slug);
  const journalCount = fs.existsSync(jDir)
    ? fs.readdirSync(jDir).filter(f => f.endsWith(".md") && f !== "index.md").length
    : 0;

  // Get total awareness insights
  let totalInsights = 0;
  try {
    const awareness = readAwarenessState();
    totalInsights = awareness?.topInsights?.length ?? 0;
  } catch { /* non-blocking */ }

  // Get updated rooms
  let roomNames: string[] = [];
  try {
    const rooms = listRooms(slug);
    roomNames = rooms.slice(0, 3).map(r => r.name);
  } catch { /* non-blocking */ }

  // Count corrections for this project
  let correctionCount = 0;
  const corrDir = `${root}/projects/${slug}/corrections`;
  if (fs.existsSync(corrDir)) {
    correctionCount = fs.readdirSync(corrDir).filter(f => f.endsWith(".json")).length;
  }

  const line = "──────────────────────────────────────────────────────────────";
  const cardLines = [
    line,
    `  AgentRecall  ✓ Saved    ${slug}   ${date}   #${journalCount}`,
    line,
    "",
    `  Journal       ${jDir.replace(root, "~/.agent-recall")}/`,
    `                └─ ${date}.md                    ${journalWritten ? "[written]" : journalWriteError ? `[FAILED: ${journalWriteError}]` : "[skipped]"}`,
    "",
    `  Awareness     ${insightsAdded} added, ${insightsConfirmed} confirmed  (${totalInsights} total)`,
    ...(awarenessError ? [`  [WARN: awareness update failed: ${awarenessError}]`] : []),
    ...(palaceError ? [`  [WARN: palace consolidation failed: ${palaceError}]`] : []),
    "",
  ];

  if (palaceConsolidated && roomNames.length > 0) {
    const palacePath = `${root}/projects/${slug}/palace/`.replace(root, "~/.agent-recall");
    cardLines.push(`  Palace        ${palacePath}`);
    for (let i = 0; i < roomNames.length; i++) {
      const prefix = i === roomNames.length - 1 ? "└─" : "├─";
      cardLines.push(`                ${prefix} rooms/${roomNames[i]}              [updated]`);
    }
    cardLines.push("");
  }

  if (correctionCount > 0) {
    cardLines.push(`  Corrections   ${correctionCount} stored  (always loaded at session start)`);
    cardLines.push("");
  }

  if (mergeSuggestions.length > 0) {
    cardLines.push(`  ⚡ Similar entries found — consider merging:`);
    for (const s of mergeSuggestions.slice(0, 4)) {
      cardLines.push(`     ${s.date}  (${s.overlap_keywords.join(", ")})`);
    }
    cardLines.push("");
  }

  cardLines.push(line);

  const card = cardLines.join("\n");

  const qualityWarnings = checkInsightQuality(input.insights ?? []);

  // Auto-promote confirmed cross-session insights into awareness
  promoteConfirmedInsights(3);

  // Pipeline integration: caller can close the current phase and/or open a
  // new one as part of this save. No LLM, no auto-detect — explicit only.
  let pipelineClosed: PipelinePhaseAction | undefined;
  let pipelineOpened: PipelinePhaseAction | undefined;

  if (input.close_phase) {
    const cp = input.close_phase;
    const r = await pipelineClose({
      project: slug,
      what_was_hard: cp.what_was_hard,
      how_solved: cp.how_solved,
      synthesis: cp.synthesis,
      status: cp.status,
      related_journal: cp.related_journal,
      related_insights: cp.related_insights,
    });
    pipelineClosed = r.success
      ? { ok: true, order: r.order, phase: r.phase, file_path: r.file_path }
      : { ok: false, error: r.error };
  }

  if (input.open_phase) {
    const op = input.open_phase;
    const r = await pipelineOpen({
      project: slug,
      phase_name: op.phase_name,
      goal: op.goal,
    });
    pipelineOpened = r.success
      ? { ok: true, order: r.order, phase: r.phase, file_path: r.file_path }
      : { ok: false, error: r.error };
  }

  // WS-5: Auto-write cross-agent handoff artifact — fire-and-forget.
  // Only fires when the journal was successfully written (meaningful session).
  // Never affects result or throws to caller.
  let handoffPath: string | undefined;
  if (journalWritten) {
    try {
      const h = writeHandoff(slug);
      handoffPath = h.path;
    } catch { /* swallow — handoff is best-effort */ }
  }

  return {
    success: journalWritten || awarenessUpdated,
    journal_written: journalWritten,
    ...(journalWriteError ? { journal_write_error: journalWriteError } : {}),
    insights_processed: insightsProcessed,
    insights_added: insightsAdded,
    insights_confirmed: insightsConfirmed,
    awareness_updated: awarenessUpdated,
    ...(awarenessError ? { awareness_error: awarenessError } : {}),
    palace_consolidated: palaceConsolidated,
    ...(palaceError ? { palace_error: palaceError } : {}),
    card,
    merge_suggestions: mergeSuggestions.length > 0 ? mergeSuggestions : undefined,
    quality_warnings: qualityWarnings.length > 0 ? qualityWarnings : undefined,
    ...(pipelineClosed ? { pipeline_closed: pipelineClosed } : {}),
    ...(pipelineOpened ? { pipeline_opened: pipelineOpened } : {}),
    ...(handoffPath ? { handoff_path: handoffPath } : {}),
  };
}
