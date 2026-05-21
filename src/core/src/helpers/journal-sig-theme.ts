/**
 * Significance and theme tags for journal filename classification.
 * sig = per-session importance; theme = recurring cross-session pattern.
 */

export type SignificanceTag =
  | "shipped" | "milestone" | "blocked" | "critical"
  | "audit" | "decision" | "research" | "recovery" | "minor" | "none";

export type ThemeTag =
  | "naming-drift" | "mcp-unavailable" | "publish-gate" | "cross-project"
  | "test-gap" | "silent-failure" | "multi-loop" | "agent-fix"
  | "version-bump" | "okr-aligned" | "phantom-project" | "none";

/**
 * Auto-classify significance from summary text.
 * Check in order, stop at first match. Default: "minor".
 */
export function autoClassifySig(summary: string): SignificanceTag {
  const s = summary.toLowerCase();
  if (/published|npm publish|pushed to npm|deployed/.test(s)) return "shipped";
  if (/blockers?:\s*\S/.test(s)) return "blocked";
  if (/complete|shipped/.test(s) && /v\d+\.\d+\.\d+/.test(s)) return "milestone";
  if (/critical|silent failure|data loss|broke/.test(s)) return "critical";
  if (/loop [123]|scored \d+\/10|re-audit/.test(s)) return "audit";
  if (/decisions?:/.test(s)) return "decision";
  if (/researching|research phase|gathered information/.test(s)) return "research";
  if (/fixed|recovered|unblocked|resolved/.test(s)) return "recovery";
  return "minor";
}

/**
 * Auto-classify theme from summary text.
 * Check all signals; pick highest priority match. Default: "none".
 */
export function autoClassifyTheme(summary: string): ThemeTag {
  const s = summary.toLowerCase();
  // Priority order: check all, return first match in this order
  if (/naming correction|slug drift|env var rename|naming convention/.test(s)) return "naming-drift";
  if (/\bmcp\b|claude -p|headless|tool unavailable/.test(s)) return "mcp-unavailable";
  if (/awaiting approval|no push|local only|push permission/.test(s)) return "publish-gate";
  if (/silently|no error|silent failure|blocked.*nights?|failing silently/.test(s)) return "silent-failure";
  if (/dream.?prompt|arsave|aam config|ar cli/.test(s)) return "agent-fix";
  if (/v\d+\.\d+\.\d+|version.*bump|bumped to/.test(s)) return "version-bump";
  // cross-project: 3+ project names from known set
  const projectNames = ["agentrecall", "novada-mcp", "novada-proxy", "novada-web", "aam", "prismma", "genome"];
  const matchedProjects = projectNames.filter(p => s.includes(p));
  if (matchedProjects.length >= 3) return "cross-project";
  if (/missing tests|test gap|no tests|test coverage/.test(s)) return "test-gap";
  if (/\d+\+ agent|multiple.*loops|loop \d+.*loop \d+/.test(s)) return "multi-loop";
  if (/okr|key result|kr-\d/.test(s)) return "okr-aligned";
  if (/phantom|duplicate.*project|ghost.*project|orphan.*slug/.test(s)) return "phantom-project";
  return "none";
}
