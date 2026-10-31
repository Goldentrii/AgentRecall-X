/** Cards v1 (G2) — <root>/identity-card.md. Personal tier, never synced; the CLI is the only writer. Reads never throw. */
import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { writeTextAtomicPrivate } from "./fs-utils.js";
import { scrubSecretContent } from "./content-guard.js";
import { normalizeCardText, parseFrontmatter } from "./frontmatter.js";

export const IDENTITY_BODY_CAP = 1600;
export interface IdentityCard { version: number; updated: string; body: string }
export class IdentityCardError extends Error {
  constructor(public readonly code: "empty" | "too_long" | "secret" | "binary", message: string) { super(message); this.name = "IdentityCardError"; }
}
export const identityCardPath = (): string => path.join(getRoot(), "identity-card.md");
const warn = (msg: string) => { try { process.stderr.write(`[AgentRecall] identity-card.md: ${msg}\n`); } catch { /* never throw */ } };

/** The on-disk form — what `write` stores and `ar identity show` prints, so a shown card feeds straight back into `set`. */
export const serializeIdentityCard = (c: IdentityCard): string => `---\nkind: identity-card\nversion: ${c.version}\nupdated: ${c.updated}\n---\n${c.body}\n`;

export function parseIdentityCard(text: string): { card: IdentityCard; malformed: boolean } {
  const fm = parseFrontmatter(text), version = fm?.fields.get("version") ?? "";
  // `version` must be a plain integer: "3.0", "1e1", "0x3" or "007" are hand edits the bump in writeIdentityCard would mangle.
  if (fm && fm.fields.get("kind") === "identity-card" && /^(0|[1-9]\d*)$/.test(version) && Number.isSafeInteger(Number(version))) {
    return { card: { version: Number(version), updated: fm.fields.get("updated") ?? "", body: fm.body.replace(/^\n+/, "").trimEnd() }, malformed: false };
  }
  return { card: { version: 0, updated: "", body: normalizeCardText(text).trimEnd() }, malformed: true };
}

export function readIdentityCard(): IdentityCard | null {
  let raw: string;
  try {
    if (!fs.existsSync(identityCardPath())) return null;
    raw = fs.readFileSync(identityCardPath(), "utf-8");
  } catch (err) { warn(`unreadable (${String(err)}) — skipped`); return null; }
  if (raw.includes("\u0000")) { warn("binary content — skipped"); return null; }
  if (!raw.trim()) { warn("empty file — skipped"); return null; }
  const { card, malformed } = parseIdentityCard(raw);
  if (malformed) warn("malformed frontmatter — whole file used as body");
  else if (card.body.length > IDENTITY_BODY_CAP) warn(`body over ${IDENTITY_BODY_CAP} chars — truncated for this load`);
  // `set` rejects secrets, but a hand-edited live file bypasses it and is injected into every session.
  const scan = scrubSecretContent(card.body);
  if (scan.redactedCount > 0) {
    card.body = scan.content;
    warn(`contains a secret (${scan.labels[0] ?? "secret pattern"}) — redacted for this load; remove it from the file`);
  }
  if (card.body.length > IDENTITY_BODY_CAP) card.body = card.body.slice(0, IDENTITY_BODY_CAP - 1) + "…";
  return card;
}

export function writeIdentityCard(body: string, now: Date = new Date()): IdentityCard & { path: string } {
  const clean = body.replace(/\r\n/g, "\n").trim();
  if (!clean) throw new IdentityCardError("empty", "identity card body is empty — nothing written");
  // A UTF-16 file read as UTF-8 (PowerShell 5.1 redirection) arrives NUL-laden; stored, it would be skipped as binary on every read.
  if (clean.includes("\u0000")) throw new IdentityCardError("binary", "identity card body contains NUL bytes (a UTF-16 file read as UTF-8?) — nothing written");
  if (clean.length > IDENTITY_BODY_CAP) throw new IdentityCardError("too_long", `identity card body is ${clean.length} chars; cap is ${IDENTITY_BODY_CAP} — nothing written`);
  const scan = scrubSecretContent(clean);
  if (scan.redactedCount > 0) throw new IdentityCardError("secret", `identity card body contains a secret (${scan.labels[0] ?? "secret pattern"}) — nothing written`);
  // Unlocked read-then-write: two concurrent `ar identity set` runs can both read version N and both store N+1. The last atomic
  // rename wins and `version` is informational (one owner, CLI-only writer), so no lock is taken for it.
  const card = { version: (readIdentityCard()?.version ?? 0) + 1, updated: now.toISOString(), body: clean };
  writeTextAtomicPrivate(identityCardPath(), serializeIdentityCard(card));
  return { ...card, path: identityCardPath() };
}

/** Shared renderer (MCP terse/verbose, CLI hook-start). */
export const formatOwnerSection = (o: { version: number; body: string }): string[] => [`Owner (identity card v${o.version})`, o.body];
