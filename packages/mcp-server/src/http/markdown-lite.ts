/**
 * markdown-lite.ts — a deliberately small markdown renderer for the repo's own policy text
 * (PRIVACY.md). It supports exactly what that file needs and nothing else:
 *
 *   blocks:  # / ## / ### headings, paragraphs, "- " lists, pipe tables
 *   inline:  `code`, **bold**, [text](url)
 *
 * Safety: the source is treated as plain text. Every character that reaches the output
 * goes through esc(), so raw HTML in the markdown is shown as text, never parsed. A link
 * is emitted only for http(s) and mailto targets; any other target (javascript:, data:,
 * relative paths) renders as its text without a link. No attribute is built from source
 * text except an href that passed that check and a table cell's data-label (escaped).
 */
import { esc } from "./oauth-pages.js";

const SAFE_HREF = /^(?:https?:\/\/|mailto:)[^\s<>"'`\\]+$/i;
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/** Inline spans. `nested` stops bold and links from nesting inside themselves. */
function inline(src: string, nested = false): string {
  let out = "";
  let last = 0;
  for (const m of src.matchAll(INLINE)) {
    out += esc(src.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
    if (m[1] !== undefined) out += `<code>${esc(m[1])}</code>`;
    else if (m[2] !== undefined) out += nested ? esc(m[0]) : `<strong>${inline(m[2], true)}</strong>`;
    else if (nested) out += esc(m[0]);
    else out += SAFE_HREF.test(m[4]) ? `<a href="${esc(m[4])}" rel="noopener">${inline(m[3], true)}</a>` : inline(m[3], true);
  }
  return out + esc(src.slice(last));
}

/** Header text without inline markup, for the data-label attribute (esc() is applied at use). */
const plain = (s: string): string => s.replace(/`([^`]+)`|\*\*([^*]+?)\*\*|\[([^\]]+)\]\([^)\s]+\)/g, (_, a, b, c) => a ?? b ?? c);

const cells = (line: string): string[] => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isRule = (line: string | undefined): boolean => line !== undefined && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flush = (): void => {
    if (para.length) html.push(`<p>${inline(para.join(" "))}</p>`);
    if (list.length) html.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join("")}</ul>`);
    para = [];
    list = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const head = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    const item = /^\s*[-*]\s+(.+)$/.exec(line);
    if (line.trim() === "") flush();
    else if (head) {
      flush();
      html.push(`<h${head[1].length}>${inline(head[2])}</h${head[1].length}>`);
    } else if (line.trim().startsWith("|") && isRule(lines[i + 1])) {
      flush();
      const heads = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].trim().startsWith("|"); i++) rows.push(cells(lines[i]));
      i--;
      html.push(`<div class="tbl"><table><thead><tr>${heads.map((h) => `<th scope="col">${inline(h)}</th>`).join("")}</tr></thead><tbody>` +
        rows.map((r) => `<tr>${heads.map((_, c) => `<td data-label="${esc(plain(heads[c]))}">${inline(r[c] ?? "")}</td>`).join("")}</tr>`).join("") + `</tbody></table></div>`);
    } else if (item) {
      if (para.length) flush();
      list.push(item[1]);
    } else {
      if (list.length) flush();
      para.push(line.trim());
    }
  }
  flush();
  return html.join("\n");
}
