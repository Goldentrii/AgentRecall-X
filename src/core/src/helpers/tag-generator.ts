/**
 * tag-generator — assign semantic tags to memory content using pure keyword matching.
 * No LLM calls. Returns 3-6 tags from domain, type, and area taxonomies.
 */

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

const DOMAIN_TAGS: Record<string, RegExp> = {
  nextjs: /next\.?js|next@|app router|page router/i,
  react: /\breact\b|jsx|tsx|component|hook|useState|useEffect/i,
  typescript: /typescript|\.ts\b|type error|interface|generic/i,
  tailwind: /tailwind|tw-|class:/i,
  shadcn: /shadcn|@\/components\/ui/i,
  drizzle: /drizzle|drizzle-orm/i,
  vercel: /vercel|\.vercel\.|deployment/i,
  auth: /\bauth\b|clerk|supabase|session|login|oauth|jwt/i,
  mcp: /\bmcp\b|model context protocol|mcp server|mcp tool/i,
  api: /\bapi\b|endpoint|rest|graphql|route handler/i,
};

const TYPE_TAGS: Record<string, RegExp> = {
  correction: /\bdon't\b|\bnever\b|\bstop\b|\bwrong\b|\bmistake\b|\bno\b.*\bshould\b|\bprefer\b/i,
  gotcha: /gotcha|caveat|warning|careful|beware|pitfall|trap|footgun/i,
  decision: /decided|chose|going with|will use|verdict|picked|approach/i,
  insight: /realized|learned|discovered|pattern|observation/i,
  "breaking-change": /breaking|removed|deprecated|renamed|migration|upgrade/i,
  rule: /always|never|must|should|rule:|principle:/i,
};

const AREA_TAGS: Record<string, RegExp> = {
  frontend: /frontend|ui|ux|design|component|layout|style|css|modal|button/i,
  backend: /backend|server|api|database|query|schema|endpoint/i,
  deployment: /deploy|vercel|build|ci|pipeline|production|staging/i,
  testing: /test|spec|jest|vitest|playwright|e2e|unit test/i,
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Generate 3-6 semantic tags for a piece of content.
 * @param content  The memory text to classify.
 * @param contentType  Optional known content type (e.g. "decision", "correction").
 *                     If provided and not "general", it is always included.
 * @returns Deduplicated array of tag strings, max 6.
 */
export function generateTags(content: string, contentType?: string): string[] {
  const tags: string[] = [];

  // Always include contentType if meaningful
  if (contentType && contentType !== "general") {
    tags.push(contentType);
  }

  // Score domain tags
  for (const [tag, pattern] of Object.entries(DOMAIN_TAGS)) {
    if (pattern.test(content)) tags.push(tag);
  }

  // Score type tags
  for (const [tag, pattern] of Object.entries(TYPE_TAGS)) {
    if (pattern.test(content)) tags.push(tag);
  }

  // Score area tags
  for (const [tag, pattern] of Object.entries(AREA_TAGS)) {
    if (pattern.test(content)) tags.push(tag);
  }

  // Deduplicate, preserving insertion order
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const t of tags) {
    if (!seen.has(t)) {
      seen.add(t);
      deduped.push(t);
    }
  }

  // Cap at 6
  return deduped.slice(0, 6);
}
