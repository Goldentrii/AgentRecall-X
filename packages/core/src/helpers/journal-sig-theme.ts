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
 * Runtime-checkable mirrors of the two type unions above (SAME vocabulary,
 * not new values) — naming-v2 spec §3's journal filename parser needs to
 * classify an unlabeled filename segment by ENUM MEMBERSHIP ("is this token
 * a sig or a theme?") rather than by position, since sig/theme are now
 * omitted when absent and a 4-segment name is positionally ambiguous.
 * journal-name-parser.ts imports these; do not let them drift from the type
 * unions above.
 */
export const SIGNIFICANCE_TAGS: readonly SignificanceTag[] = [
  "shipped", "milestone", "blocked", "critical",
  "audit", "decision", "research", "recovery", "minor", "none",
];

export const THEME_TAGS: readonly ThemeTag[] = [
  "naming-drift", "mcp-unavailable", "publish-gate", "cross-project",
  "test-gap", "silent-failure", "multi-loop", "agent-fix",
  "version-bump", "okr-aligned", "phantom-project", "none",
];

/**
 * True if patternA and patternB both occur within `window` characters of
 * each other, in either order, without crossing a sentence boundary
 * (./!/?/newline).
 *
 * Used to require a CONDITION — two co-located signal words — instead of
 * matching a single vocabulary word in isolation. E.g. the bare word "mcp"
 * says nothing about whether an MCP tool was actually unavailable; "mcp"
 * near "unavailable"/"fell back" does. Audit 2026-07-27 found the bare-word
 * versions of these checks had 90%+ false-positive rates in the novada-mcp
 * journal (the project name alone tripped them).
 *
 * Exported (2026-07-29) so auto-name.ts's TYPE_SIGNALS content-type
 * classifier can reuse the same condition-not-vocabulary primitive instead
 * of duplicating it — see that module's tool-config/architecture signals,
 * the deferred follow-up noted in this file's own bare-\bmcp\b fix above.
 */
export function coOccurs(text: string, patternA: string, patternB: string, window = 60): boolean {
  const gap = `[^.!?\\n]{0,${window}}`;
  return new RegExp(`(?:${patternA})${gap}(?:${patternB})|(?:${patternB})${gap}(?:${patternA})`, "i").test(text);
}

// --- mcp-unavailable: tool word + an actual unavailability signal ---------
const MCP_TOOL_WORD = "\\bmcp\\b|claude -p|\\bheadless\\b";
const MCP_UNAVAIL_SIGNAL =
  "unavailable|not available|no access|fell back|fallback|" +
  "couldn.?t (?:reach|connect|access)|failed to (?:reach|connect)|" +
  "无法(?:连接|访问)?|不可用";

// --- version-bump: version string + an actual bump/ship/release action ---
const VERSION_NUM = "v\\d+\\.\\d+\\.\\d+";
const VERSION_ACTION =
  "bump(?:ed|ing)?|shipped|publish(?:ed|ing)?|releas(?:ed|e|ing)|" +
  "tagg(?:ed|ing)|deploy(?:ed|ing)?|cut(?: a)? release";

// --- agent-fix: tool name + an actual fix/update/config action -----------
const AGENT_FIX_TARGET = "dream.?prompt|\\barsave\\b|aam config|\\bar cli\\b";
const AGENT_FIX_ACTION =
  "fix(?:ed|ing)?|updat(?:ed|ing)|config(?:ur(?:ed|ing))?|patch(?:ed|ing)?|" +
  "chang(?:ed|ing)|rewrit(?:e|ing|ten)|refactor(?:ed|ing)?|correct(?:ed|ing)?|" +
  "adjust(?:ed|ing)?|revis(?:ed|ing)|debugg?(?:ed|ing)?";

// --- critical (sig): severity word + an actual problem noun/impact scope -
const CRITICAL_NOUN = "bugs?|issues?|failures?|vulnerabilit(?:y|ies)|errors?|incidents?|regressions?|defects?";
const CRITICAL_OWN_IMPACT = "build|deploy(?:ment)?|prod(?:uction)?|release|pipeline|\\bci\\b|\\bmain\\b|test suite|everything";

/**
 * Auto-classify significance from summary text.
 * Check in order, stop at first match. Default: "minor".
 */
export function autoClassifySig(summary: string): SignificanceTag {
  const s = summary.toLowerCase();
  if (/published|npm publish|pushed to npm|deployed/.test(s)) return "shipped";
  if (/blockers?:\s*\S/.test(s)) return "blocked";
  if (/complete|shipped/.test(s) && /v\d+\.\d+\.\d+/.test(s)) return "milestone";
  if (
    /data loss|silent failure/.test(s) ||
    /\d+\s*(?:个)?\s*critical\b/.test(s) ||
    coOccurs(s, "\\bcritical\\b", CRITICAL_NOUN, 20) ||
    coOccurs(s, "\\b(?:broke|broken)\\b", CRITICAL_OWN_IMPACT, 30)
  ) return "critical";
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
  if (/tool unavailable/.test(s) || coOccurs(s, MCP_TOOL_WORD, MCP_UNAVAIL_SIGNAL)) return "mcp-unavailable";
  if (/awaiting approval|no push|local only|push permission/.test(s)) return "publish-gate";
  if (/silently|no error|silent failure|blocked.*nights?|failing silently/.test(s)) return "silent-failure";
  if (coOccurs(s, AGENT_FIX_TARGET, AGENT_FIX_ACTION, 40)) return "agent-fix";
  if (/version.*bump|bumped to/.test(s) || coOccurs(s, VERSION_NUM, VERSION_ACTION, 40)) return "version-bump";
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
