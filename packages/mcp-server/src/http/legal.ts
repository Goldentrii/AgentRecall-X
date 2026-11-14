/**
 * legal.ts — the privacy policy as the website serves it.
 *
 * PRIVACY.md at the repo root is the single source. The build copies it into
 * dist/http/legal/ (scripts/copy-site-assets.mjs, which fails if it is missing), and this
 * module renders it once at start. The support page takes its contact address from the
 * same text, so the two can never name different people.
 *
 * If the shipped copy is missing or unreadable, LEGAL is null: /privacy then answers 503
 * and says so, and the operator sees a line on stderr. A privacy page must never show stale
 * or partial text, so there is no built-in fallback copy.
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { renderMarkdown } from "./markdown-lite.js";

export interface Legal {
  /** The rendered policy: safe HTML, no wrapper. */
  html: string;
  /** The controller's contact address, read from the policy's "contact: **...**" line; null if it names none. */
  contact: string | null;
}

const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

export function parseLegal(md: string): Legal {
  const contact = /contact:\s*\*\*([^*\s]+)\*\*/i.exec(md)?.[1] ?? null;
  return { html: renderMarkdown(md), contact: contact !== null && EMAIL.test(contact) ? contact : null };
}

export function loadLegal(file: string): Legal | null {
  try {
    const md = fs.readFileSync(file, "utf8");
    return md.trim() === "" ? null : parseLegal(md);
  } catch {
    return null;
  }
}

export const LEGAL: Legal | null = loadLegal(fileURLToPath(new URL("./legal/PRIVACY.md", import.meta.url)));
if (!LEGAL) process.stderr.write("[site] PRIVACY.md missing in dist/http/legal; /privacy will answer 503\n");
else if (!LEGAL.contact) process.stderr.write("[site] PRIVACY.md names no contact address; /support will show none\n");
