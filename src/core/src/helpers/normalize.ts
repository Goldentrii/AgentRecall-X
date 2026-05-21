/**
 * Search quality floor — basic stemming + synonym expansion.
 * No external dependencies. Improves keyword matching without vector search.
 *
 * Stemming: suffix stripping (not Porter — just the 12 most common English suffixes).
 * Synonyms: ~100 development-term pairs for the most common recall misses.
 */

// --- Stemmer ---

const SUFFIX_RULES: Array<[RegExp, string]> = [
  [/ying$/i, "y"],         // deploying → deploy (before -ing)
  [/([^aeiou])\1ing$/i, "$1"],  // running → run, setting → set (doubled consonant)
  [/([^aeiou])ing$/i, "$1"],  // building → build
  [/ation$/i, ""],         // configuration → configur (close enough for matching)
  [/tion$/i, ""],          // extraction → extrac
  [/ment$/i, ""],          // deployment → deploy
  [/ness$/i, ""],          // readiness → readi
  [/ized?$/i, ""],         // optimized → optim
  [/ised?$/i, ""],         // organised → organis
  [/able$/i, ""],          // searchable → search
  [/ible$/i, ""],          // compatible → compat
  [/ally$/i, ""],          // automatically → automatic (then no more match)
  [/edly$/i, ""],          // repeatedly → repeat
  [/ly$/i, ""],            // correctly → correct
  [/ers?$/i, ""],          // builders → build, server → serv (acceptable)
  [/ies$/i, "y"],          // queries → query
  [/es$/i, ""],            // processes → process
  [/ed$/i, ""],            // configured → configur
  [/s$/i, ""],             // deployments → deployment (then -ment rule on next call won't apply, but stemmed form matches)
];

/**
 * Basic English stemmer — strip common suffixes.
 * Applies ONE rule (first match). Not recursive.
 * Returns lowercased stem. Min length 3 to avoid over-stemming.
 */
export function stem(word: string): string {
  const lower = word.toLowerCase();
  if (lower.length < 4) return lower;

  for (const [pattern, replacement] of SUFFIX_RULES) {
    if (pattern.test(lower)) {
      const stemmed = lower.replace(pattern, replacement);
      if (stemmed.length >= 3) return stemmed;
    }
  }
  return lower;
}

// --- Synonyms ---

/**
 * Synonym groups. Each array is a group of related terms.
 * When searching for any word in a group, all words in that group are considered matches.
 */
const SYNONYM_GROUPS: string[][] = [
  // Deployment & shipping
  ["deploy", "deployment", "ship", "release", "publish", "launch", "push"],
  ["build", "compile", "bundle", "transpile"],
  ["ci", "pipeline", "workflow", "github-actions", "ci-cd"],

  // Frontend
  ["react", "component", "jsx", "tsx", "hook", "usestate", "useeffect"],
  ["css", "style", "tailwind", "stylesheet", "design-token"],
  ["responsive", "mobile", "breakpoint", "viewport"],
  ["animation", "transition", "motion", "framer-motion", "gsap"],

  // Backend & data
  ["api", "endpoint", "route", "handler", "rest", "graphql"],
  ["database", "db", "schema", "query", "migration", "table"],
  ["auth", "login", "session", "jwt", "oauth", "clerk", "authentication"],
  ["cache", "redis", "kv", "memo", "memoize"],

  // Errors & debugging
  ["error", "bug", "crash", "fail", "exception", "broken", "issue"],
  ["fix", "patch", "hotfix", "resolve", "repair"],
  ["debug", "troubleshoot", "diagnose", "investigate"],
  ["test", "spec", "jest", "vitest", "playwright", "e2e", "unit-test"],

  // Architecture
  ["architecture", "design", "structure", "pattern", "system-design"],
  ["refactor", "restructure", "reorganize", "cleanup", "simplify"],
  ["performance", "perf", "slow", "fast", "optimize", "speed", "latency"],
  ["security", "vulnerability", "xss", "injection", "csrf", "auth"],

  // Tools & frameworks
  ["framework", "library", "sdk", "toolkit", "trpc", "express", "fastify", "hono", "koa", "nestjs", "grpc"],
  ["api-framework", "web-framework", "rest-api", "graphql-api", "rpc", "trpc"],
  ["nextjs", "next", "next-js", "app-router", "page-router"],
  ["vercel", "deployment", "serverless", "edge"],
  ["drizzle", "orm", "prisma", "typeorm"],
  ["shadcn", "radix", "base-ui", "ui-library"],
  ["mcp", "model-context-protocol", "mcp-server", "mcp-tool"],

  // Project management
  ["block", "blocked", "stuck", "waiting", "pending", "dependency"],
  ["done", "complete", "finished", "shipped", "implemented"],
  ["todo", "task", "ticket", "issue", "backlog"],
  ["priority", "urgent", "critical", "p0", "p1"],

  // Memory & recall
  ["correction", "feedback", "wrong", "mistake", "adjust"],
  ["remember", "memory", "recall", "context", "history"],
  ["insight", "lesson", "pattern", "observation", "learning"],

  // Design & UI
  ["color", "colour", "palette", "theme", "scheme", "brand"],
  ["dark", "light", "mode", "background", "foreground"],
  ["font", "typography", "typeface", "heading", "body-text"],
  ["layout", "grid", "flex", "spacing", "gap", "margin", "padding"],
  ["icon", "svg", "lucide", "image", "asset", "logo"],
  ["button", "cta", "action", "click", "submit"],
  ["modal", "dialog", "popup", "overlay", "drawer"],
  ["nav", "navbar", "sidebar", "menu", "navigation", "header"],
  ["card", "tile", "panel", "section", "container"],

  // Scraping & data
  ["scrape", "scraper", "crawl", "crawler", "extract", "extraction"],
  ["proxy", "residential", "datacenter", "rotation", "ip"],
  ["website", "site", "page", "url", "domain", "web"],
];

// Build a reverse lookup: word → set of all synonyms
const synonymMap = new Map<string, Set<string>>();
for (const group of SYNONYM_GROUPS) {
  const stemmedGroup = new Set(group.map(w => stem(w)));
  for (const word of group) {
    const s = stem(word);
    const existing = synonymMap.get(s) ?? new Set<string>();
    for (const syn of stemmedGroup) existing.add(syn);
    synonymMap.set(s, existing);
  }
}

/**
 * Get all synonyms for a word (including the word itself), stemmed.
 * Returns empty set if no synonyms found.
 */
export function getSynonyms(word: string): Set<string> {
  const s = stem(word.toLowerCase());
  return synonymMap.get(s) ?? new Set([s]);
}

/**
 * Expand a list of query words with stemming + synonyms.
 * Returns deduplicated array of all stemmed forms + synonyms.
 */
export function expandQuery(words: string[]): string[] {
  const expanded = new Set<string>();
  for (const word of words) {
    const s = stem(word.toLowerCase());
    expanded.add(s);
    const syns = synonymMap.get(s);
    if (syns) {
      for (const syn of syns) expanded.add(syn);
    }
  }
  return Array.from(expanded);
}
