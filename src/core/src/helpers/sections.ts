/**
 * Markdown section extraction and manipulation.
 */

import { SECTION_HEADERS } from "../types.js";

/**
 * Extract a section from a markdown journal entry.
 */
export function extractSection(content: string, section: string): string | null {
  if (section === "all") return content;

  if (section === "brief") {
    const lines = content.split("\n");
    const nonEmpty: string[] = [];
    let pastTitle = false;
    for (const line of lines) {
      if (line.startsWith("# ")) {
        pastTitle = true;
        continue;
      }
      if (!pastTitle) continue;
      const trimmed = line.trim();
      if (trimmed === "") continue;
      nonEmpty.push(trimmed);
      if (nonEmpty.length >= 4) break;
    }
    return nonEmpty.join("\n") || null;
  }

  const header = SECTION_HEADERS[section];
  if (!header) return null;

  const idx = content.indexOf(header);
  if (idx === -1) return null;

  const afterHeader = content.slice(idx);
  const lines = afterHeader.split("\n");
  const result: string[] = [lines[0]];
  let inCodeFence = false;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startsWith("```")) inCodeFence = !inCodeFence;
    if (!inCodeFence && lines[i].startsWith("## ")) break;
    result.push(lines[i]);
  }

  return result.join("\n").trimEnd();
}

/**
 * Append content to a specific section in a journal file, or to end of file.
 */
export function appendToSection(
  existingContent: string,
  newContent: string,
  section: string | null
): string {
  if (section === "replace_all") {
    return newContent;
  }

  if (!section) {
    return existingContent.trimEnd() + "\n\n" + newContent + "\n";
  }

  const header = SECTION_HEADERS[section];
  if (!header) {
    return existingContent.trimEnd() + "\n\n" + newContent + "\n";
  }

  const idx = existingContent.indexOf(header);
  if (idx === -1) {
    return (
      existingContent.trimEnd() + "\n\n" + header + "\n\n" + newContent + "\n"
    );
  }

  const afterHeader = existingContent.slice(idx);
  const lines = afterHeader.split("\n");
  let insertAt = lines.length;
  let inCodeFence = false;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startsWith("```")) inCodeFence = !inCodeFence;
    if (!inCodeFence && lines[i].startsWith("## ")) {
      insertAt = i;
      break;
    }
  }

  const before = existingContent.slice(
    0,
    idx + lines.slice(0, insertAt).join("\n").length
  );
  const after = existingContent.slice(
    idx + lines.slice(0, insertAt).join("\n").length
  );

  return before.trimEnd() + "\n\n" + newContent + "\n" + after;
}
