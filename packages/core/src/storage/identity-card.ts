/** Cards v1 (G2) — <root>/identity-card.md. Personal tier, never synced; the CLI is the only writer. Reads never throw. */
import * as fs from "node:fs";
import * as path from "node:path";
import { getRoot } from "../types.js";
import { writeTextAtomicPrivate } from "./fs-utils.js";
import { scrubSecretContent } from "./content-guard.js";

export const IDENTITY_BODY_CAP = 1600;
export interface IdentityCard { version: number; updated: string; body: string }
export class IdentityCardError extends Error {
  constructor(public readonly code: "empty" | "too_long" | "secret", message: string) { super(message); this.name = "IdentityCardError"; }
}
export const identityCardPath = (): string => path.join(getRoot(), "identity-card.md");
const warn = (msg: string) => { try { process.stderr.write(`[AgentRecall] identity-card.md: ${msg}\n`); } catch { /* never throw */ } };

export function parseIdentityCard(text: string): { card: IdentityCard; malformed: boolean } {
  const t = text.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(t);
  const fm = new Map((m?.[1] ?? "").split("\n").map((l) => [l.split(":")[0].trim(), l.slice(l.indexOf(":") + 1).replace(/\s+#.*$/, "").trim()] as [string, string]));
  const version = Number(fm.get("version"));
  if (m && fm.get("kind") === "identity-card" && Number.isInteger(version) && version >= 0) {
    return { card: { version, updated: fm.get("updated") ?? "", body: m[2].replace(/^\n+/, "").trimEnd() }, malformed: false };
  }
  return { card: { version: 0, updated: "", body: t.trimEnd() }, malformed: true };
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
  if (clean.length > IDENTITY_BODY_CAP) throw new IdentityCardError("too_long", `identity card body is ${clean.length} chars; cap is ${IDENTITY_BODY_CAP} — nothing written`);
  const scan = scrubSecretContent(clean);
  if (scan.redactedCount > 0) throw new IdentityCardError("secret", `identity card body contains a secret (${scan.labels[0] ?? "secret pattern"}) — nothing written`);
  const card = { version: (readIdentityCard()?.version ?? 0) + 1, updated: now.toISOString(), body: clean };
  writeTextAtomicPrivate(identityCardPath(), `---\nkind: identity-card\nversion: ${card.version}\nupdated: ${card.updated}\n---\n${clean}\n`);
  return { ...card, path: identityCardPath() };
}

/** Shared renderer (MCP terse/verbose, CLI hook-start). */
export const formatOwnerSection = (o: { version: number; body: string }): string[] => [`Owner (identity card v${o.version})`, o.body];
