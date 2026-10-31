/** Cards v1 (G4) — projects/<slug>/state-card.md, REWRITTEN at session_end with carry-forward. Values single-line (no forged "## "), scrubbed, capped per field and per file; age_days computed at read time. */
import * as fs from "node:fs";
import * as path from "node:path";
import { projectSubPath } from "./paths.js";
import { writeTextAtomicPrivate } from "./fs-utils.js";
import { scrubForCloud } from "./content-guard.js";

export const STATE_CARD_FILE_CAP = 2400;
const CAP = { goal: 300, next: 300, open_decisions: 5, blockers: 5, pointers: 8, item: 160, pointer: 200, summary: 200 } as const;
export interface StateCardInput { goal?: string; open_decisions?: string[]; blockers?: string[]; next?: string; pointers?: string[] }
export interface StateCardBody { updated: string; session: string; goal: string; open_decisions: string[]; blockers: string[]; next: string; pointers: string[]; last_session: string }
export interface StateCard extends StateCardBody { age_days: number }
export interface MergeStateCardArgs { previous: StateCardBody | null; state?: StateCardInput; trajectory?: string; summary?: string; session: string; now?: Date }
type List = "open_decisions" | "blockers" | "pointers";
const LISTS: string[] = ["open_decisions", "blockers", "pointers"];
const SECTIONS: Array<[string, keyof StateCardBody]> = [["Goal", "goal"], ["Open decisions", "open_decisions"], ["Blockers", "blockers"], ["Next", "next"], ["Pointers", "pointers"], ["Last session", "last_session"]];
/** One line, and never starting with a section marker ("## x" as a value would be read back as a heading and the value lost). */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().replace(/^(?:## )+/, "");
/** s.slice(0, n) that never ends on half a surrogate pair (a lone surrogate is written as U+FFFD). */
const cutAt = (s: string, n: number) => { const hi = n > 0 && s.charCodeAt(n - 1) >= 0xd800 && s.charCodeAt(n - 1) <= 0xdbff; return s.slice(0, hi ? n - 1 : n); };
const warn = (slug: string, msg: string) => { try { process.stderr.write(`[AgentRecall] ${slug}/state-card.md: ${msg}\n`); } catch { /* never throw */ } };
export const stateCardPath = (slug: string): string => projectSubPath(slug, "state-card.md");

export function serializeStateCard(c: StateCardBody): string {
  const out = ["---", "kind: state-card", `updated: ${c.updated}`, `session: ${c.session}`, "---"];
  for (const [h, k] of SECTIONS) {
    const v = c[k];
    if (v.length) out.push(`## ${h}`, ...(Array.isArray(v) ? v.map((x) => `- ${x}`) : [v]));
  }
  return out.join("\n") + "\n";
}

/** Normalize + cap each field, then pop list tails (longest first; stable ties pointers → open_decisions → blockers) until the file fits. Idempotent. */
export function capStateCard(c: StateCardBody): { card: StateCardBody; truncated: string[] } {
  const cut = new Set<string>();
  const clip = (name: string, s: string, cap: number) => {
    const t = oneLine(scrubForCloud(s));
    if (t.length <= cap) return t;
    if (name) cut.add(name);
    return cutAt(t, cap - 1) + "…";
  };
  const list = (name: List) => {
    const all = c[name].map(oneLine).filter((x) => x && x !== "(none)");
    if (all.length > CAP[name]) cut.add(name);
    return all.slice(0, CAP[name]).map((x) => clip(name, x, name === "pointers" ? CAP.pointer : CAP.item));
  };
  const card: StateCardBody = {
    updated: c.updated, session: c.session.replace(/\s+/g, "").slice(0, 200),
    goal: clip("goal", c.goal, CAP.goal), next: clip("next", c.next, CAP.next),
    open_decisions: list("open_decisions"), blockers: list("blockers"), pointers: list("pointers"),
    last_session: clip("", c.last_session, 13 + CAP.summary),
  };
  while (serializeStateCard(card).length > STATE_CARD_FILE_CAP) {
    const v = (["pointers", "open_decisions", "blockers"] as const).filter((f) => card[f].length).sort((a, b) => card[b].length - card[a].length)[0];
    if (!v) break;
    card[v] = card[v].slice(0, -1);
    cut.add(v);
  }
  return { card, truncated: [...cut] };
}

export function mergeStateCard(a: MergeStateCardArgs): { card: StateCardBody; truncated: string[] } | null {
  const p = a.previous, s: StateCardInput = a.state ?? {}, summary = oneLine(a.summary ?? ""), now = a.now ?? new Date();
  if (!p && !a.state && !a.trajectory && !summary) return null;
  return capStateCard({
    updated: now.toISOString(), session: a.session,
    goal: s.goal ?? p?.goal ?? "", next: s.next ?? (a.trajectory || p?.next || ""),
    open_decisions: s.open_decisions ?? p?.open_decisions ?? [], blockers: s.blockers ?? p?.blockers ?? [], pointers: s.pointers ?? p?.pointers ?? [],
    last_session: summary ? `${now.toLocaleDateString("sv")} — ${cutAt(summary, CAP.summary)}` : p?.last_session ?? "",
  });
}

export function parseStateCard(text: string, now: Date = new Date()): StateCard | null {
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")); // BOM-tolerant (Notepad, PowerShell)
  const fm = new Map((m?.[1] ?? "").split("\n").map((l) => [l.split(":")[0].trim(), l.slice(l.indexOf(":") + 1).trim()] as [string, string]));
  const ms = Date.parse(fm.get("updated") ?? "");
  if (!m || fm.get("kind") !== "state-card" || Number.isNaN(ms)) return null;
  const v = new Map<string, string[]>();
  let cur: string | undefined;
  for (const line of m[2].split("\n")) {
    const h = /^## (.+?)\s*$/.exec(line);
    if (h) cur = SECTIONS.find(([name]) => name === h[1])?.[1];
    else if (cur && line.trim() && (!LISTS.includes(cur) || line.startsWith("- "))) v.set(cur, [...(v.get(cur) ?? []), LISTS.includes(cur) ? line.slice(2) : line.trim()]);
  }
  const join = (k: string) => (v.get(k) ?? []).join(" ");
  const { card } = capStateCard({ updated: fm.get("updated") ?? "", session: fm.get("session") ?? "", goal: join("goal"), next: join("next"), last_session: join("last_session"), open_decisions: v.get("open_decisions") ?? [], blockers: v.get("blockers") ?? [], pointers: v.get("pointers") ?? [] });
  return { ...card, age_days: Math.max(0, Math.floor((now.getTime() - ms) / 86_400_000)) };
}

export function readStateCard(slug: string, now: Date = new Date()): StateCard | null {
  try {
    if (!fs.existsSync(stateCardPath(slug))) return null;
    const raw = fs.readFileSync(stateCardPath(slug), "utf-8");
    if (raw.includes("\u0000")) { warn(slug, "binary content — skipped"); return null; }
    const card = parseStateCard(raw, now);
    if (!card) warn(slug, raw.trim() ? "malformed frontmatter — skipped" : "empty file — skipped");
    return card;
  } catch (err) { warn(slug, `unreadable (${String(err)}) — skipped`); return null; }
}

/** An existing regular file that readStateCard could not parse is renamed aside, never silently overwritten (one stderr line). Returns the backup path, or null when there was nothing to move. */
export function backupUnreadableStateCard(slug: string, now: Date = new Date()): string | null {
  const p = stateCardPath(slug);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
  const bak = `${p}.bak-${now.toISOString().replace(/[:.]/g, "-")}`;
  fs.renameSync(p, bak);
  warn(slug, `unreadable card moved to ${path.basename(bak)} before rewrite`);
  return bak;
}

export function writeStateCard(slug: string, card: StateCardBody): { path: string; chars: number; truncated: string[] } {
  const { card: capped, truncated } = capStateCard(card);
  const text = serializeStateCard(capped);
  writeTextAtomicPrivate(stateCardPath(slug), text);
  return { path: stateCardPath(slug), chars: text.length, truncated };
}

/** Shared renderer: non-empty fields in the order Goal, Blockers, Next, Open decisions, Pointers, Last session. */
export function formatStateSection(c: StateCard): string[] {
  const d = c.updated.slice(0, 10);
  const out = [c.age_days >= 7 ? `State (updated ${d}, stale: ${c.age_days} d)` : `State (updated ${d})`];
  const list = (label: string, v: string[]) => { if (v.length) out.push(`${label}:`, ...v.map((x) => `  - ${x}`)); };
  if (c.goal) out.push(`Goal: ${c.goal}`);
  list("Blockers", c.blockers);
  if (c.next) out.push(`Next: ${c.next}`);
  list("Open decisions", c.open_decisions);
  list("Pointers", c.pointers);
  if (c.last_session) out.push(`Last session: ${c.last_session}`);
  return out;
}
