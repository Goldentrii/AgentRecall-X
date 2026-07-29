/**
 * Auto-naming module — pure text analysis for generating semantic slugs.
 *
 * No LLM calls, no external dependencies. Works offline.
 * The agent knows the content best at save-time. This module captures
 * that understanding in a retrievable name.
 */

import { coOccurs } from "./journal-sig-theme.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlugContext {
  room?: string;
  type?: string;
  existingSlugs?: string[];
}

export interface SlugResult {
  slug: string;
  contentType: string;
  keywords: string[];
}

// ---------------------------------------------------------------------------
// Content type detection
// ---------------------------------------------------------------------------

type ContentType =
  | "decision"
  | "bug-fix"
  | "insight"
  | "architecture"
  | "tool-config"
  | "goal"
  | "blocker"
  | "lesson"
  | "general";

/**
 * A content-type signal is either a plain regex (safe when the word rarely
 * means anything else) or a condition function requiring two signal words to
 * CO-OCCUR near each other — see coOccurs() usage below and its doc comment
 * in journal-sig-theme.ts for the "condition, not vocabulary" rationale.
 */
type ContentSignal = RegExp | ((text: string) => boolean);

// --- tool-config: a tool NOUN (mcp/server/plugin) + an actual config/setup
// ACTION nearby, not just any mention of either word alone. Audit 2026-07-29
// (deferred from ace179a, 2026-07-27) found the bare-word version of this
// category — /\bconfig\b/, /\bsetup\b/, /\binstall\b/, /\bmcp\b/, /\bserver\b/,
// /\bplugin\b/, /\bconfigure\b/ — had an ~87% false-positive rate against the
// real store corpus (novada-mcp/novada-mcpserver/aam-mcp bare PROJECT NAMES
// tripped \bmcp\b; "Configure-MCP console" and "novada-mcp-console-config-*.md"
// UI/filename tokens tripped \bconfigure\b/\bconfig\b; generic "npm install"
// build-verification mentions tripped \binstall\b) — producing garbage slugs
// like tool-config-090-nov-close and tool-config-tow2-owner-key for content
// that was actually a product decision, a release, or a bug-fix postmortem.
const TOOL_CONFIG_ACTION = "\\binstall(?:ed|ing|s)?\\b|\\bset ?up\\b|\\bconfigur(?:e[ds]?|ing)\\b|\\bconfig\\b";

// --- architecture: system-design nouns (design/api/schema/structure) need to
// co-occur with a genuine software/system context word — bare, they match UI
// visual-design work ("design pass", "logos, chips"), generic API mentions
// ("API key", "9 APIs with requireAdmin"), and bug reports ("schema bug").
// Audit found ~83% false-positive rate (5/6 real-corpus matches). "architecture"
// and "system design" stay bare — auditing the same corpus found no case where
// either word meant something else.
const ARCH_SYSTEM_NOUN = "\\barchitecture\\b|\\bsystem\\b|\\bschema\\b|\\bapi\\b|\\bbackend\\b|\\bdatabase\\b|\\binfrastructure\\b|\\bstack\\b|\\bpipeline\\b|\\bmicroservices?\\b|\\bmodule\\b|\\bdata model\\b";
const ARCH_API_CONTEXT = "\\bdesign\\b|\\bschema\\b|\\bendpoint\\b|\\bcontract\\b|\\bspec\\b|\\barchitecture\\b|\\bversioning\\b";
const ARCH_SCHEMA_CONTEXT = "\\bdesign\\b|\\bdatabase\\b|\\bapi\\b|\\barchitecture\\b|\\bmodel\\b|\\btable\\b|\\bmigration\\b";
const ARCH_STRUCTURE_CONTEXT = "\\bsystem\\b|\\barchitecture\\b|\\bschema\\b|\\bapi\\b|\\bdatabase\\b|\\bmodule\\b|\\bcode\\b|\\bdata model\\b";

const TYPE_SIGNALS: Record<ContentType, ContentSignal[]> = {
  "bug-fix": [/\bbug\b/i, /\bfix\b/i, /\bregression\b/i, /\bbroke\b/i, /\berror\b/i, /\bcrash\b/i, /\bbroken\b/i],
  lesson: [/\blesson\b/i, /\btakeaway\b/i, /\bnever again\b/i, /\balways remember\b/i, /\blearned that\b/i],
  decision: [/\bdecided\b/i, /\bchose\b/i, /\bwill use\b/i, /\bgoing with\b/i, /\bverdict\b/i, /\bpicked\b/i],
  insight: [/\blearned\b/i, /\brealized\b/i, /\binsight\b/i, /\bpattern\b/i, /\bobservation\b/i, /\bdiscovered\b/i],
  architecture: [
    /\barchitecture\b/i,
    /\bsystem design\b/i,
    (t) => coOccurs(t, "\\bdesign\\b", ARCH_SYSTEM_NOUN, 50),
    (t) => coOccurs(t, "\\bapi\\b", ARCH_API_CONTEXT, 50),
    (t) => coOccurs(t, "\\bschema\\b", ARCH_SCHEMA_CONTEXT, 50),
    (t) => coOccurs(t, "\\bstructure\\b", ARCH_STRUCTURE_CONTEXT, 50),
  ],
  "tool-config": [
    (t) => coOccurs(t, "\\bmcp\\b", TOOL_CONFIG_ACTION, 50),
    (t) => coOccurs(t, "\\bserver\\b", TOOL_CONFIG_ACTION, 50),
    (t) => coOccurs(t, "\\bplugin\\b", TOOL_CONFIG_ACTION, 50),
  ],
  goal: [/\bgoal\b/i, /\bmilestone\b/i, /\bobjective\b/i, /\btarget\b/i, /\broadmap\b/i, /\bokr\b/i],
  blocker: [/\bblocker\b/i, /\bblocked\b/i, /\bstuck\b/i, /\bwaiting\b/i, /\bdependency\b/i, /\bblocking\b/i],
  general: [],
};

function testSignal(signal: ContentSignal, content: string): boolean {
  return typeof signal === "function" ? signal(content) : signal.test(content);
}

/**
 * Detect the content type from text by counting signal matches (each either
 * a plain regex or a coOccurs condition — see ContentSignal).
 * Returns the type with the most matches; ties broken by declaration order.
 * Requires ≥2 distinct patterns matched to avoid false positives.
 */
export function detectContentType(content: string): ContentType {
  let bestType: ContentType = "general";
  let bestCount = 0;

  for (const [type, signals] of Object.entries(TYPE_SIGNALS) as Array<[ContentType, ContentSignal[]]>) {
    if (type === "general") continue;
    let count = 0;
    for (const signal of signals) {
      if (testSignal(signal, content)) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      bestType = type;
    }
  }

  // Only use detected type if 2+ signals matched — prevents false positives
  return bestCount >= 2 ? bestType : "general";
}

// ---------------------------------------------------------------------------
// Stopwords
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  // Common English
  "the", "and", "is", "in", "to", "for", "of", "a", "an", "at", "by", "on",
  "or", "as", "be", "it", "that", "this", "was", "are", "were", "been",
  "not", "but", "what", "all", "when", "we", "there", "can", "had", "has",
  "have", "will", "each", "about", "how", "up", "out", "them", "then",
  "she", "he", "do", "if", "my", "no", "so", "just", "than", "into",
  "its", "also", "our", "your", "new", "would", "could", "should", "now",
  "these", "some", "other", "only", "very", "more", "over", "such",
  "with", "from", "their", "they", "which", "you", "one", "two", "three",
  "after", "before", "because", "between", "both", "during", "here",
  "most", "same", "where", "while", "who", "why", "may", "still",
  "did", "does", "get", "got", "like", "make", "much", "need", "use",
  "used", "using", "way", "well", "work", "first", "last", "even",
  // Markdown / technical noise
  "http", "https", "www", "com", "org", "json", "true", "false", "null",
  "undefined", "const", "let", "var", "function", "return", "import",
  "export", "from", "type", "interface", "class", "async", "await",
  // Generic session/workflow words that add no semantic value
  "phase", "loop", "brief", "audit", "next", "session", "general", "config",
  "task", "done", "complete", "status", "update", "check", "run",
]);

// ---------------------------------------------------------------------------
// Keyword extraction
// ---------------------------------------------------------------------------

/** Remove markdown syntax from text. */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")     // code blocks
    .replace(/`[^`]+`/g, " ")            // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links → text
    .replace(/[#*_~>|`\-\[\]()]/g, " ")  // markdown chars
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract positional weight multipliers from original content. */
function getPositionWeights(content: string): Map<string, number> {
  const weights = new Map<string, number>();

  // Headers get 2x
  const headers = content.match(/^#{1,6}\s+(.+)$/gm) ?? [];
  for (const h of headers) {
    const words = stripMarkdown(h).toLowerCase().split(/\s+/);
    for (const w of words) {
      if (w.length > 2 && !STOPWORDS.has(w)) {
        weights.set(w, (weights.get(w) ?? 1) * 2);
      }
    }
  }

  // Bold text gets 1.5x
  const bolds = content.match(/\*\*([^*]+)\*\*/g) ?? [];
  for (const b of bolds) {
    const words = b.replace(/\*\*/g, "").toLowerCase().split(/\s+/);
    for (const w of words) {
      if (w.length > 2 && !STOPWORDS.has(w)) {
        weights.set(w, (weights.get(w) ?? 1) * 1.5);
      }
    }
  }

  // First sentence gets 1.5x
  const firstLine = stripMarkdown(content).split(/[.!?\n]/)[0] ?? "";
  const firstWords = firstLine.toLowerCase().split(/\s+/);
  for (const w of firstWords) {
    if (w.length > 2 && !STOPWORDS.has(w)) {
      weights.set(w, (weights.get(w) ?? 1) * 1.5);
    }
  }

  return weights;
}

/**
 * Extract top keywords from content by weighted frequency.
 * Pure text analysis — no LLM, no stemming library.
 */
export function extractKeywords(content: string, limit: number = 3): string[] {
  const posWeights = getPositionWeights(content);
  const clean = stripMarkdown(content).toLowerCase();
  const words = clean.split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));

  // Count frequency
  const freq = new Map<string, number>();
  for (const w of words) {
    // Normalize: strip trailing punctuation, possessives
    const normalized = w.replace(/[^a-z0-9]/g, "");
    if (normalized.length < 3 || STOPWORDS.has(normalized)) continue;
    freq.set(normalized, (freq.get(normalized) ?? 0) + 1);
  }

  // Apply position weights
  const scored = new Map<string, number>();
  for (const [word, count] of freq) {
    const posWeight = posWeights.get(word) ?? 1;
    scored.set(word, count * posWeight);
  }

  // Sort by score descending, take top N
  const sorted = Array.from(scored.entries()).sort((a, b) => b[1] - a[1]);

  // Naive dedup: if word A starts with word B (or vice versa) and length diff <= 4, keep shorter
  const result: string[] = [];
  for (const [word] of sorted) {
    if (result.length >= limit) break;
    const isDupe = result.some(
      (existing) =>
        (word.startsWith(existing) || existing.startsWith(word)) &&
        Math.abs(word.length - existing.length) <= 4
    );
    if (!isDupe) {
      result.push(word);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Slug generation
// ---------------------------------------------------------------------------

/** Sanitize a string into a valid slug. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Generate a semantic slug from content.
 *
 * Format: `{contentType}-{keyword1}-{keyword2}-{keyword3}`
 * Max 60 characters. Unique against existingSlugs (appends -2, -3, etc.).
 */
export function generateSlug(content: string, context?: SlugContext): SlugResult {
  const contentType = context?.type ?? detectContentType(content);
  let keywords = extractKeywords(content, 3);

  // Fix RC2: deduplication against room name and content-type prefix.
  // Without this, a file in room "architecture" of type "architecture" ends up
  // named "architecture-architecture-...". Strip any keyword that is already
  // present as a whole word in the room slug or the content-type string.
  if (context?.room) {
    const roomWords = new Set(
      context.room.toLowerCase().split(/[-_\s]+/).filter((w) => w.length > 2)
    );
    const typeWords = new Set(
      contentType.toLowerCase().split(/[-_\s]+/).filter((w) => w.length > 2)
    );
    keywords = keywords.filter((kw) => !roomWords.has(kw) && !typeWords.has(kw));
  }

  // Build slug
  // Don't prefix slug with content type — sig/theme slots carry that signal now.
  // Only include type prefix if it's genuinely distinctive (not "general") and ≥2 signals matched.
  const parts = contentType !== "general" ? [contentType, ...keywords] : [...keywords];
  let slug = slugify(parts.join("-"));

  // Fallback if slug is empty or just the type
  if (!slug || slug === contentType) {
    // Use first meaningful words from content
    const fallbackWords = stripMarkdown(content)
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
      .slice(0, 3);
    slug = slugify([contentType, ...fallbackWords].join("-"));
  }

  // Ensure uniqueness
  if (context?.existingSlugs) {
    const existing = new Set(context.existingSlugs);
    if (existing.has(slug)) {
      let counter = 2;
      while (existing.has(`${slug}-${counter}`)) counter++;
      slug = `${slug}-${counter}`;
    }
  }

  return { slug, contentType, keywords };
}

/**
 * Generate a human-readable topic name from content.
 * Title-case, max 4 words. For display purposes.
 */
export function generateTopicName(content: string): string {
  const keywords = extractKeywords(content, 4);

  if (keywords.length === 0) {
    // Fallback to first meaningful words
    const words = stripMarkdown(content)
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 4);
    return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ") || "Untitled";
  }

  return keywords
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
