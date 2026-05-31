/**
 * smart_remember — classify content and route to the right memory store.
 *
 * Agents call one tool; the system figures out where it belongs.
 * Pure keyword scoring, no LLM calls.
 */

import { generateSlug, detectContentType } from "../helpers/auto-name.js";
import { generateTags } from "../helpers/tag-generator.js";
import { consistencyCheck, type ConsistencyWarning } from "../helpers/consistency.js";
import { scanForConflicts, formatConflictWarning } from "../helpers/conflict-scan.js";
import { journalCapture } from "./journal-capture.js";
import { palaceWrite } from "./palace-write.js";
import { knowledgeWrite } from "./knowledge-write.js";
import { awarenessUpdate } from "./awareness-update.js";
import { getRoot } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SmartRememberInput {
  content: string;
  context?: string;
  project?: string;
}

export interface SmartRememberResult {
  success: boolean;
  routed_to: string;
  classification: string;
  auto_name: string;
  result: unknown;
  /** Exact file path where the memory was stored */
  file_path?: string;
  /** Entry type indicator: "new", "appended", "Q4", "insight #7", etc. */
  entry_indicator?: string;
  /** Query hint: what to search to find this memory again */
  retrieval_hint?: string;
  /** Semantic tags assigned to this memory */
  tags?: string[];
  consistency_warnings?: ConsistencyWarning[];
  /** Conflict warning: populated when new content contradicts existing memories */
  conflict_warning?: string;
}

// ---------------------------------------------------------------------------
// Route classification
// ---------------------------------------------------------------------------

type Route = "journal_capture" | "palace_write" | "knowledge_write" | "awareness_update";

const ROUTE_SIGNALS: Record<Route, RegExp[]> = {
  knowledge_write: [
    /\bbug\b/i, /\bfix(ed)?\b/i, /\berror\b/i, /\broot cause\b/i, /\blesson\b/i,
    /\bregression\b/i, /\bcrash(ed)?\b/i, /\bworkaround\b/i, /\bwhat happened\b/i,
    /\bbroke\b/i, /\bexception\b/i, /\btraceback\b/i, /\bstacktrace\b/i,
    /\bthrew\b/i, /\bpanic\b/i, /\bfailed\b/i, /\bnull pointer\b/i,
    /\bundefined\b.*\berror\b/i, /\btypeerror\b/i, /\battributeerror\b/i,
  ],
  awareness_update: [
    /\balways\b/i, /\bnever\b/i, /\bpattern\b/i, /\bacross projects\b/i,
    /\binsight\b/i, /\bgeneral rule\b/i, /\bapplies when\b/i, /\brealized\b/i,
    /\bcross-project\b/i, /\bobserved that\b/i,
    // Preference / style signals
    /\bprefers?\b/i, /\bpreference[s:]?\b/i, /\balways uses?\b/i,
    /\bstyle\s*:/i, /\buser wants\b/i, /\buser likes?\b/i,
  ],
  palace_write: [
    /\barchitecture\b/i, /\bdecision\b/i, /\bdesign\b/i, /\bschema\b/i,
    /\bapproach\b/i, /\bchose\b/i, /\bdecided\b/i, /\bwill use\b/i,
    /\bstructure\b/i, /\bapi\b/i,
  ],
  journal_capture: [
    /\btoday\b/i, /\bsession\b/i, /\bcompleted\b/i, /\bworked on\b/i,
    /\btried\b/i, /\bstatus\b/i, /\bprogress\b/i, /\bblocked\b/i,
    /\bnext\b/i, /\bdid\b/i,
  ],
};

// Higher boost = more specific store. knowledge and awareness get slight boosts
// because they're more valuable when correctly classified.
const ROUTE_BOOSTS: Record<Route, number> = {
  knowledge_write: 1.2,
  awareness_update: 1.3,
  palace_write: 1.0,
  journal_capture: 1.0,
};

function classifyRoute(content: string, context?: string): Route {
  const text = context ? `${context} ${content}` : content;

  // Pre-check: git note patterns — "git: committed v3.3.27..." should be journal_capture,
  // not knowledge_write. The "fix" keyword in git messages triggers the bug classifier.
  if (/^git\s*:/i.test(content.trim()) || /\bcommitted\b.*v?\d+\.\d+\.\d+/i.test(content)) {
    return "journal_capture";
  }

  // Check context hint first (strong signal)
  if (context) {
    const lower = context.toLowerCase();
    if (/^qa$|^capture$/i.test(lower.trim())) return "journal_capture";
    if (/bug|fix|error|regression|crash/i.test(lower)) return "knowledge_write";
    if (/architecture|design|decision|schema/i.test(lower)) return "palace_write";
    if (/insight|lesson|pattern|across/i.test(lower)) return "awareness_update";
    if (/session|log|today|progress/i.test(lower)) return "journal_capture";
  }

  // Score each route
  const scores: Array<{ route: Route; score: number }> = [];
  for (const [route, patterns] of Object.entries(ROUTE_SIGNALS) as Array<[Route, RegExp[]]>) {
    let count = 0;
    for (const pattern of patterns) {
      if (pattern.test(text)) count++;
    }
    scores.push({ route, score: count * ROUTE_BOOSTS[route] });
  }

  scores.sort((a, b) => b.score - a.score);

  // Default to journal_capture if no clear signal
  return scores[0].score > 0 ? scores[0].route : "journal_capture";
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function smartRemember(input: SmartRememberInput): Promise<SmartRememberResult> {
  if (!input.content || input.content.trim().length < 5) {
    return {
      success: false,
      routed_to: "rejected",
      classification: "too_short",
      auto_name: "",
      result: { error: "Content too short (minimum 5 characters). Memory not saved." },
    };
  }

  const route = classifyRoute(input.content, input.context);
  const slugResult = generateSlug(input.content);
  const autoName = slugResult.slug;

  // Conflict scan: compare new content against existing memories BEFORE saving.
  // Runs only when content is long enough (>20 chars enforced inside scanForConflicts).
  // Never blocks save — wrapped in try/catch.
  let conflict_warning: string | undefined;
  try {
    const conflictResult = await scanForConflicts(input.content, input.project);
    if (conflictResult.hasConflict && conflictResult.matches.length > 0) {
      conflict_warning = formatConflictWarning(conflictResult.matches, input.project);
    }
  } catch (err) {
    // Conflict scan is best-effort — never blocks save
    process.stderr.write(`[agent-recall] conflict scan error: ${err}\n`);
  }

  let result: unknown;

  switch (route) {
    case "journal_capture": {
      result = await journalCapture({
        question: "Auto-captured",
        answer: input.content,
        project: input.project,
      });
      break;
    }
    case "palace_write": {
      // Use content type as room. When "general", pick a better room from context hint or tags.
      const contentType = detectContentType(input.content);
      let room = contentType === "general" ? "knowledge" : contentType;

      // Smarter room routing based on context hint
      if (input.context) {
        const ctxLower = input.context.toLowerCase();
        if (/design|color|theme|style|ui|ux|layout|font/i.test(ctxLower)) room = "design";
        else if (/architecture|tech.?stack|system|infra/i.test(ctxLower)) room = "architecture";
        else if (/decision|chose|picked|going.?with/i.test(ctxLower)) room = "decision";
        else if (/correction|rule|never|always|don.?t/i.test(ctxLower)) room = "alignment";
        else if (/goal|plan|roadmap|next|priority/i.test(ctxLower)) room = "goals";
        else if (/blocker|blocked|stuck|waiting/i.test(ctxLower)) room = "blockers";
      }

      const tags = generateTags(input.content, contentType !== "general" ? contentType : undefined);
      result = await palaceWrite({
        room,
        content: input.content,
        project: input.project,
        auto_name: true,
        tags,
      });
      break;
    }
    case "knowledge_write": {
      // Extract title from first sentence or first line
      const firstLine = input.content.split(/[.\n]/)[0]?.trim() ?? "Auto-captured lesson";
      result = await knowledgeWrite({
        category: slugResult.contentType,
        title: firstLine.slice(0, 80),
        what_happened: input.content,
        root_cause: "See content",
        fix: "See content",
        project: input.project,
      });
      break;
    }
    case "awareness_update": {
      // Extract title from first sentence
      const title = input.content.split(/[.\n]/)[0]?.trim().slice(0, 80) ?? "Auto-captured insight";
      result = await awarenessUpdate({
        insights: [
          {
            title,
            evidence: input.content,
            applies_when: slugResult.keywords,
            source: `smart_remember ${new Date().toISOString().slice(0, 10)}`,
            source_project: input.project,
          },
        ],
        project: input.project,
      });
      break;
    }
  }

  // Consistency check: find contradictions with existing memories
  let consistency_warnings: ConsistencyWarning[] | undefined;
  try {
    const check = await consistencyCheck(input.content, input.project);
    if (check.warnings.length > 0) {
      consistency_warnings = check.warnings;
    }
  } catch (err) {
    // Consistency check is best-effort — never blocks save
    process.stderr.write(`[agent-recall] consistency check error: ${err}\n`);
  }

  // Extract file path and entry indicator from the routed result
  let file_path: string | undefined;
  let entry_indicator: string | undefined;
  const resultObj = result as Record<string, unknown> | undefined;
  if (resultObj) {
    // palace_write returns file_path + is_new directly
    if (typeof resultObj.file_path === "string") {
      file_path = resultObj.file_path;
      entry_indicator = resultObj.is_new === true ? "new" : "appended";
    }
    // knowledge_write returns file
    else if (typeof resultObj.file === "string") {
      file_path = resultObj.file;
      entry_indicator = "appended";
    }
    // awareness_update now returns file_path directly
    else if (route === "awareness_update" && typeof resultObj.file_path === "string") {
      file_path = resultObj.file_path;
      const n = typeof resultObj.total_insights === "number" ? resultObj.total_insights : undefined;
      entry_indicator = n !== undefined ? `insight #${n}` : "insight added";
    }
    // journal_capture now returns file_path directly
    else if (route === "journal_capture" && typeof resultObj.file_path === "string") {
      file_path = resultObj.file_path;
      const q = typeof resultObj.entry_number === "number" ? resultObj.entry_number : undefined;
      entry_indicator = q !== undefined ? `Q${q}` : "captured";
    }
  }

  // Replace agent-recall root dir for readability
  const displayRoot = getRoot();
  const displayPath = file_path?.replace(displayRoot, "~/.agent-recall") ?? undefined;

  // Generate retrieval hint from keywords + classification
  const hintWords = slugResult.keywords.slice(0, 3);
  const retrieval_hint = hintWords.length > 0
    ? `recall('${hintWords.join(" ")}')`
    : undefined;

  // Get tags from the routed result
  const tags = generateTags(input.content, slugResult.contentType !== "general" ? slugResult.contentType : undefined);

  // Associative linking — best-effort, never awaited in critical path
  if (
    (route === "palace_write" || route === "awareness_update") &&
    file_path &&
    input.project
  ) {
    const savedSlug =
      route === "palace_write" &&
      typeof resultObj?.room === "string" &&
      typeof resultObj?.topic === "string"
        ? `${resultObj.room}/${resultObj.topic}`
        : autoName;
    const { linkToSimilar } = await import("../helpers/associative-link.js");
    linkToSimilar(input.project, input.content, savedSlug).catch(() => {});
  }

  // Fire-and-forget vector indexing — never blocks the save path.
  // Only runs when OPENAI_API_KEY is set; silently skipped otherwise.
  if (file_path && input.project) {
    const itemId =
      route === "palace_write" &&
      typeof resultObj?.room === "string" &&
      typeof resultObj?.topic === "string"
        ? `${resultObj.room}/${resultObj.topic}`
        : autoName;
    const vectorSource: "palace" | "journal" | "insight" =
      route === "awareness_update" ? "insight"
      : route === "journal_capture" ? "journal"
      : "palace";
    const vectorExcerpt = input.content.slice(0, 300);
    import("./smart-remember-vector.js")
      .then(({ indexRemembered }) =>
        indexRemembered(input.project!, itemId, vectorSource, autoName, vectorExcerpt, input.content)
      )
      .catch(() => {});
  }

  return {
    success: true,
    routed_to: route,
    classification: slugResult.contentType,
    auto_name: autoName,
    result,
    file_path: displayPath,
    entry_indicator,
    retrieval_hint,
    tags,
    consistency_warnings,
    conflict_warning,
  };
}
