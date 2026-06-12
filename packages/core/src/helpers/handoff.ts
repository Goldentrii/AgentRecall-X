/**
 * Handoff artifact — portable cross-agent briefing written at session_end.
 *
 * Automaticity Law: the file appears at projects/<slug>/handoff.md automatically
 * every session_end; no new MCP tool, no agent prompt needed.
 *
 * Budget: HARD LIMIT 2200 chars (~500 tokens). Content is truncated at word
 * boundaries and sections are omitted when empty.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { readP0Corrections } from "../storage/corrections.js";
import { readBehaviorPolicies } from "../storage/behavior-policies.js";
import { readInsightsIndex } from "../palace/insights-index.js";
import { readIdentity } from "../palace/identity.js";
import { ensureDir } from "../storage/fs-utils.js";
import { listJournalFiles } from "./journal-files.js";
import { extractSection } from "./sections.js";
import { journalDir } from "../storage/paths.js";

const HARD_BUDGET = 2200;

/**
 * Truncate a string at word boundary, appending "…" if truncated.
 */
function truncateAt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf(" ", maxChars - 1);
  const boundary = cut > 0 ? cut : maxChars;
  return text.slice(0, boundary) + "…";
}

/**
 * Extract the first meaningful (non-heading, non-blank) line from a markdown string.
 * Returns empty string when nothing is found.
 */
function firstMeaningfulLine(md: string): string {
  for (const line of md.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#") && !t.startsWith(">") && !t.startsWith("---")) {
      return t;
    }
  }
  return "";
}

/**
 * Local-date string in YYYY-MM-DD format (system TZ).
 */
function localDate(): string {
  return new Date().toLocaleDateString("sv"); // 'sv' locale gives YYYY-MM-DD
}

export interface HandoffResult {
  path: string;
  tokens_estimate: number;
}

/**
 * Generate the handoff markdown for a project.
 * Pure function — reads stores, returns a string.
 * Never throws: missing stores produce empty sections which are omitted.
 */
export function generateHandoff(slug: string): string {
  const date = localDate();
  const lines: string[] = [];

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push(`# Handoff — ${slug} (${date})`);
  lines.push("");

  // ── Intention ─────────────────────────────────────────────────────────────
  try {
    const identity = readIdentity(slug);
    const intention = firstMeaningfulLine(identity);
    if (intention) {
      lines.push(`**Intention:** ${intention}`);
      lines.push("");
    }
  } catch { /* omit */ }

  // ── Binding rules (P0 corrections, ≤5) ───────────────────────────────────
  try {
    const p0 = readP0Corrections(slug).slice(0, 5);
    if (p0.length > 0) {
      lines.push("## Binding rules");
      for (const c of p0) {
        lines.push(`- ${c.rule}`);
      }
      lines.push("");
    }
  } catch { /* omit */ }

  // ── Behavior policies (≤3) ────────────────────────────────────────────────
  try {
    const { rules } = readBehaviorPolicies(slug);
    const top = rules.slice(0, 3);
    if (top.length > 0) {
      lines.push("## Behavior policies");
      for (const r of top) {
        lines.push(`- **${r.name}**: ${r.do}`);
      }
      lines.push("");
    }
  } catch { /* omit */ }

  // ── Active blockers (from latest journal "## Blockers" section) ───────────
  try {
    const entries = listJournalFiles(slug);
    if (entries.length > 0) {
      const latest = entries[0];
      const content = fs.readFileSync(path.join(latest.dir, latest.file), "utf-8");
      // extractSection expects the SECTION_HEADERS map key; check if a
      // "## Blockers" heading is present by scanning directly (no SECTION_HEADERS key).
      const blockerIdx = content.indexOf("## Blockers");
      if (blockerIdx !== -1) {
        const section = content.slice(blockerIdx);
        const sectionLines = section.split("\n");
        const body: string[] = [];
        for (let i = 1; i < sectionLines.length; i++) {
          if (sectionLines[i].startsWith("## ")) break;
          const t = sectionLines[i].trim();
          if (t) body.push(t);
        }
        if (body.length > 0) {
          lines.push("## Active blockers");
          lines.push(body.slice(0, 5).join("\n"));
          lines.push("");
        }
      }
    }
  } catch { /* omit */ }

  // ── Top insights (≤3, highest confirmed_count for this project) ───────────
  try {
    const index = readInsightsIndex();
    const projectInsights = index.insights
      .filter((i) => !i.projects || i.projects.length === 0 || i.projects.includes(slug))
      .sort((a, b) => b.confirmed_count - a.confirmed_count)
      .slice(0, 3);
    if (projectInsights.length > 0) {
      lines.push("## Top insights");
      for (const ins of projectInsights) {
        lines.push(`- ${ins.title} (confirmed ×${ins.confirmed_count})`);
      }
      lines.push("");
    }
  } catch { /* omit */ }

  // ── Trajectory (## Next from newest journal) ──────────────────────────────
  try {
    const entries = listJournalFiles(slug);
    if (entries.length > 0) {
      const latest = entries[0];
      const content = fs.readFileSync(path.join(latest.dir, latest.file), "utf-8");
      // Use extractSection for the "next" key if available; fall back to raw scan.
      let nextText: string | null = null;
      const nextIdx = content.indexOf("## Next");
      if (nextIdx !== -1) {
        const section = content.slice(nextIdx);
        const sectionLines = section.split("\n");
        const body: string[] = [];
        for (let i = 1; i < sectionLines.length; i++) {
          if (sectionLines[i].startsWith("## ")) break;
          const t = sectionLines[i].trim();
          if (t) body.push(t);
        }
        if (body.length > 0) {
          nextText = body.join(" ");
        }
      }
      if (nextText) {
        lines.push("## Trajectory");
        lines.push(truncateAt(nextText, 300));
        lines.push("");
      }
    }
  } catch { /* omit */ }

  // ── Footer ────────────────────────────────────────────────────────────────
  lines.push("---");
  lines.push("*Generated by AgentRecall session_end · paste into any agent*");

  // ── Budget enforcement ─────────────────────────────────────────────────────
  // HARD LIMIT: output MUST NOT exceed HARD_BUDGET characters.
  // Truncate at word boundary, preserving the footer.
  const footer = "\n---\n*Generated by AgentRecall session_end · paste into any agent*";
  let body = lines.join("\n");

  // Remove the footer from body before budget check, re-append after.
  const bodyWithoutFooter = body.endsWith(footer)
    ? body.slice(0, body.length - footer.length)
    : body.slice(0, body.lastIndexOf("\n---\n"));

  if (body.length > HARD_BUDGET) {
    const budgetForBody = HARD_BUDGET - footer.length - 1;
    const truncated = truncateAt(bodyWithoutFooter.trimEnd(), budgetForBody);
    body = truncated + "\n" + footer;
  }

  // Assertion: enforce hard budget (catches regressions in section growth).
  if (body.length > HARD_BUDGET) {
    // Last-resort hard slice at word boundary.
    body = truncateAt(body, HARD_BUDGET);
  }

  return body;
}

/**
 * Write the handoff file for a project atomically.
 * Returns path and rough token estimate (chars / 4).
 * Never throws — errors are propagated to caller for fire-and-forget swallowing.
 */
export function writeHandoff(slug: string): HandoffResult {
  const root = getRoot();
  // Sanitize slug for path safety (same pattern as sanitizeProject).
  const safe = (slug || "unnamed")
    .replace(/[^a-zA-Z0-9_\-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "unnamed";

  const projectDir = path.join(root, "projects", safe);
  ensureDir(projectDir);

  const handoffPath = path.join(projectDir, "handoff.md");
  const content = generateHandoff(slug);

  // Atomic write: tmp + rename (POSIX-atomic).
  const tmp = `${handoffPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, handoffPath);

  return {
    path: handoffPath,
    tokens_estimate: Math.ceil(content.length / 4),
  };
}
