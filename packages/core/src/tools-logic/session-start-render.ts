/**
 * Cards v2 (G6) — the ONE text renderer for session_start. MCP terse (`formatTerse` is now an alias), CLI
 * `hook-start` and the SDK `fencedText` all emit this text.
 *
 * Sections keep the exact line formats and blank-line placement of the pre-slice MCP `formatTerse`
 * (packages/core/test/fixtures/session-start-full-terse.txt pins byte parity), so full-mode output is unchanged
 * except for the Trajectory/Next dedupe (G6.4). On top of that: a UTF-8 byte cap that drops whole sections
 * lowest-priority first and never touches HARD RULES (G6.5), one memory fence around everything that is stored
 * or retrieved text, and the unfenced tail (hook-less hint, A/B tag) exactly where it was.
 */
import { fenceMemory } from "../storage/content-guard.js";
import { agentCorrectionsStaged } from "../types.js";
import { formatOwnerSection } from "../storage/identity-card.js";
import { formatStateSection } from "../storage/state-card.js";
import { continuityEntryMarker, continuityHeaderText, type SessionStartResult } from "./session-start.js";

export const SESSION_START_MAX_BYTES_DEFAULT = 16_384;
export const SESSION_START_MAX_BYTES_ENV = "AGENT_RECALL_SESSION_START_MAX_BYTES";
/** Smaller caps would cut into the cards themselves on every store; refuse them and fall back to the default. */
export const SESSION_START_MAX_BYTES_MIN = 1024;

export type SectionId =
  | "dream_health" | "store_doctor" | "owner" | "alignment" | "continuity" | "header" | "behavior_rules" | "hard_rules"
  | "state" | "watch_for" | "pending" | "recent" | "insights" | "rooms" | "cross_project" | "captures" | "mirror"
  | "unclaimed" | "empty_state" | "extra";

/** `lines` include the section's own blank separators (exactly as formatTerse pushed them); [] when the section is absent. `rank` 0 = never dropped whole. */
export interface RenderedSection { id: SectionId; lines: string[]; rank: number }

export interface RenderSessionStartOptions {
  /** Lines printed BEFORE the fence (the CLI hook-health banner). Never memory. */
  preamble?: string[];
  /** Extra fenced lines after the last section, full mode only (the CLI semantic-prefetch block). */
  extraLines?: string[];
  /** Append the hook-less-host hint outside the fence. The MCP tool passes `!process.env.CLAUDE_CODE_HOOKS`. */
  hooklessTail?: boolean;
  /** UTF-8 byte cap for the whole returned text; default `sessionStartMaxBytes()`. */
  maxBytes?: number;
  /** Append the `[ab:<arm>]` experiment tag outside the fence (default true, as the MCP terse text always did). hook-start passes false: it never printed the arm. */
  abTag?: boolean;
}

/** Truncate to nearest word boundary (lifted verbatim from the MCP renderer). */
function trunc(s: string, n: number): string {
  if (s.length <= n) return s;
  const sliced = s.slice(0, n);
  const lastSpace = sliced.lastIndexOf(" ");
  return (lastSpace > n * 0.6 ? sliced.slice(0, lastSpace) : sliced) + "…";
}

/** `AGENT_RECALL_SESSION_START_MAX_BYTES` when it is an integer ≥ 1024, else 16384 (one stderr line per distinct bad value: a smaller cap than asked would be silent otherwise). */
const warnedCapValues = new Set<string>();
export function sessionStartMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[SESSION_START_MAX_BYTES_ENV] ?? "").trim();
  if (!raw) return SESSION_START_MAX_BYTES_DEFAULT;
  const n = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (Number.isSafeInteger(n) && n >= SESSION_START_MAX_BYTES_MIN) return n;
  if (!warnedCapValues.has(raw)) {
    warnedCapValues.add(raw);
    try { process.stderr.write(`[AgentRecall] ${SESSION_START_MAX_BYTES_ENV}=${raw} is not an integer ≥ ${SESSION_START_MAX_BYTES_MIN} — using ${SESSION_START_MAX_BYTES_DEFAULT}\n`); } catch { /* never throw */ }
  }
  return SESSION_START_MAX_BYTES_DEFAULT;
}

/** Every section in render order, before capping and fencing. A missing `mode` reads as "full" (hand-built fixtures). */
export function sessionStartSections(result: SessionStartResult, extraLines: string[] = []): RenderedSection[] {
  const full = (result.mode ?? "full") === "full";
  const out: RenderedSection[] = [];
  const add = (id: SectionId, rank: number, lines: string[]) => { out.push({ id, rank, lines }); };

  // ── Diagnostics (top priority, never dropped) ───────────────────────────
  add("dream_health", 0, result.dream_health?.banner
    ? [`${result.dream_health.banner_kind === "thin-corpus" ? "🟡" : "🔴"} ${result.dream_health.banner}`, ""]
    : []);
  add("store_doctor", 0, result.store_doctor ? [result.store_doctor, ""] : []);

  // ── Owner (identity card) — right after the banners, before everything else ─
  add("owner", 0, result.owner ? [...formatOwnerSection(result.owner), ""] : []);

  // ── Alignment KPI (only with real outcome data) ─────────────────────────
  if (result.alignment) {
    const { precision, retrieved, heeded, recurred } = result.alignment;
    const pct = Math.round(precision * 100);
    const recurrStr = recurred > 0 ? `, ${recurred} recurred` : "";
    add("alignment", 4, [`🎯 Alignment: ${pct}% corrections heeded (${heeded}/${retrieved}${recurrStr})`, ""]);
  } else add("alignment", 4, []);

  // ── Continuity (cross-project recency) ──────────────────────────────────
  const continuity: string[] = [];
  if (result.continuity && result.continuity.length > 0) {
    continuity.push(continuityHeaderText(result.continuity_all_cross_project));
    for (const c of result.continuity) {
      const next = c.next_step ? ` → next: ${trunc(c.next_step, 80)}` : "";
      const trustFlag = c.untrusted ? " [unverified — rescued from a crashed session]" : "";
      const marker = continuityEntryMarker(c, result.project);
      continuity.push(`  - ${marker}${c.ago} [${c.slug}] ${trunc(c.title, 100)}${next}${trustFlag}`);
    }
    continuity.push("");
  }
  add("continuity", 5, continuity);

  // ── Header ──────────────────────────────────────────────────────────────
  const header: string[] = [];
  if (full) {
    const sessionCount = result.resume?.sessions_count ?? 0;
    const lastDate = result.resume?.last_date ?? "—";
    header.push(`AgentRecall — ${result.project}   sessions: ${sessionCount}   last: ${lastDate}`);
    if (result.identity) header.push(`Intention: ${trunc(result.identity, 80)}`);
    // G6.4: the state card's Next IS the trajectory (session_end defaults it to the trajectory argument) — print it once.
    if (result.resume?.last_trajectory && !result.state?.next) header.push(`Trajectory: ${trunc(result.resume.last_trajectory, 120)}`);
  } else {
    header.push(`AgentRecall — ${result.project}`);
  }
  add("header", 0, header);

  // ── Behaviour policies (both modes: always-follow rules the owner registered) ─
  const rules: string[] = [];
  if (result.behavior_rules && result.behavior_rules.length > 0) {
    rules.push("", "📜 Behavior policies (always follow):");
    for (const r of result.behavior_rules) rules.push(`  • [${r.name}] WHEN ${trunc(r.when, 80)} → DO ${trunc(r.do, 100)}`);
  }
  add("behavior_rules", 6, rules);

  // ── HARD RULES (P0 corrections) — never dropped, never cut ──────────────
  const hard: string[] = [];
  if (result.corrections && result.corrections.length > 0) {
    hard.push("", "⛔ HARD RULES (always follow, no exceptions):");
    for (const c of result.corrections) {
      const tierTag = c.tier ? ` [${c.tier}]` : "";
      hard.push(`  [${c.severity.toUpperCase()}] ${trunc(c.rule, 120)}${tierTag}`);
    }
  }
  add("hard_rules", 0, hard);

  // ── State card — right after HARD RULES; nothing for a card without fields ─
  const stateLines = result.state ? formatStateSection(result.state) : [];
  add("state", 0, stateLines.length > 0 ? ["", ...stateLines] : []);

  // ── Full-mode sections, in the order formatTerse printed them ───────────
  const watch: string[] = [];
  if (result.watch_for && result.watch_for.length > 0) {
    watch.push("", "⚠ Watch for:");
    for (const w of result.watch_for) watch.push(`  - ${trunc(w.pattern, 50)}: ${trunc(w.suggestion, 80)}`);
  }
  add("watch_for", 7, watch);

  // pending-review count: both modes (one line, count only). Locally the agent learns staged items exist so it can
  // check() them; in an agent channel behind the owner gate it is told they are the owner's to confirm.
  add("pending", 3, result.pending_corrections && result.pending_corrections.count > 0
    ? [agentCorrectionsStaged()
        // Owner gate: agents cannot confirm here, so do not invite them to try.
        ? `⏳ ${result.pending_corrections.count} proposed correction${result.pending_corrections.count === 1 ? " awaits" : "s await"} the owner's confirmation — not active, and agents cannot confirm them. Do not follow or re-submit them.`
        : `⏳ ${result.pending_corrections.count} pending corrections await review — confirm or reject via check() with structured human_correction {rule, why, applies_when, pending_id}.`]
    : []);

  const recent: string[] = [];
  const rc = result.recent;
  if (rc && (rc.today || rc.yesterday || rc.older_count > 0)) {
    recent.push("");
    if (rc.today) recent.push(`📓 Today: ${trunc(rc.today, 150)}`);
    if (rc.yesterday) recent.push(`📓 Yesterday: ${trunc(rc.yesterday, 100)}`);
    if (rc.older_count > 0) recent.push(`   +${rc.older_count} older sessions on record`);
  }
  add("recent", 8, recent);

  const insights: string[] = [];
  if (result.insights && result.insights.length > 0) {
    insights.push("", `💡 Insights (${result.insights.length} total):`);
    for (const i of result.insights.slice(0, 5)) {
      const trend = i.trend && i.trend !== "stable" ? ` ↑${i.trend}` : "";
      insights.push(`  [${i.confirmed}×${trend}] ${trunc(i.title, 100)}`);
    }
  }
  add("insights", 9, insights);

  add("rooms", 10, result.active_rooms && result.active_rooms.length > 0
    ? ["", `🏛  Palace: ${result.active_rooms.map((r) => `${r.name}${r.stale ? " ⚠stale" : ""}`).join(" · ")}`]
    : []);

  const cross: string[] = [];
  if (result.cross_project && result.cross_project.length > 0) {
    cross.push("", "🔗 Cross-project:");
    for (const cp of result.cross_project.slice(0, 3)) cross.push(`  [${cp.from_project}] ${trunc(cp.title, 80)}`);
  }
  add("cross_project", 11, cross);

  const captures: string[] = [];
  if (result.recent_captures && result.recent_captures.length > 0) {
    captures.push("", "📝 Recent captures (unsaved session):");
    for (const c of result.recent_captures.slice(0, 5)) {
      const q = c.question ? trunc(c.question, 80) : "";
      const a = c.answer ? trunc(c.answer, 120) : "";
      captures.push(`  - ${q}${q && a ? " → " : ""}${a}`);
    }
  }
  add("captures", 12, captures);

  add("mirror", 2, result.mirror_available ? ["", `🪞 ${result.mirror_available}`] : []);
  add("unclaimed", 1, result.unclaimed_cards && result.unclaimed_cards > 0
    ? ["", `📥 ${result.unclaimed_cards} unclaimed session card${result.unclaimed_cards === 1 ? "" : "s"} await claim — run \`ar claim --list\` to review and file them.`]
    : []);
  add("empty_state", 0, result.empty_state ? ["", result.empty_state] : []);
  add("extra", 13, full && extraLines.length > 0 ? ["", ...extraLines] : []);
  return out;
}

/** `over` = even the untouchable sections exceed the cap (the text is returned over cap, P0 completeness first). */
const cutMarker = (maxBytes: number, over: boolean) => over
  ? `… session_start payload cut; diagnostics and HARD RULES alone exceed ${maxBytes} bytes (set ${SESSION_START_MAX_BYTES_ENV} to change)`
  : `… session_start payload cut to ${maxBytes} bytes (set ${SESSION_START_MAX_BYTES_ENV} to change)`;
/** Rank-0 sections that may lose lines from the end once every droppable section is gone (state first, then the owner body, then the empty line, then the header's detail lines); the first line of owner and header always stays. */
const CUT_ORDER: ReadonlyArray<{ id: SectionId; keep: number }> = [
  { id: "state", keep: 0 }, { id: "owner", keep: 1 }, { id: "empty_state", keep: 0 }, { id: "header", keep: 1 },
];

/**
 * preamble (unfenced) → one fence around every section → tail (unfenced). Over `maxBytes` (UTF-8), whole sections are
 * dropped highest `rank` first; then `CUT_ORDER` sections lose lines from the end; `dream_health`, `store_doctor` and
 * `hard_rules` are never touched, so the text can still exceed the cap when they alone do (P0 completeness beats the
 * budget, as in applyCorrectionBudget). Whenever anything was removed the last fenced line is the cut marker.
 */
export function renderSessionStart(result: SessionStartResult, opts: RenderSessionStartOptions = {}): string {
  const maxBytes = opts.maxBytes ?? sessionStartMaxBytes();
  const sections = sessionStartSections(result, opts.extraLines ?? []);
  const preamble = opts.preamble ?? [];
  const tail: string[] = [];
  // P4 cross-surface adapter — hook-less host pointer; text layer only, omitted where hooks drive the lifecycle.
  if (opts.hooklessTail) tail.push("", "Hook-less host? call brief() once for lifecycle rules.");
  // C4 A/B experiment marker (quiet trailing tag, not a banner).
  if (result.ab_arm && opts.abTag !== false) tail.push(`[ab:${result.ab_arm}]`);

  const assemble = (secs: RenderedSection[], cut: boolean, over = false): string => {
    const body = secs.flatMap((s) => s.lines);
    if (cut) body.push(cutMarker(maxBytes, over));
    // P1 fence (TOW2-388): everything above is retrieved/stored memory or AgentRecall's own labels commingled with it —
    // fenced as ONE block; preamble and tail are generated diagnostics/guidance and stay outside.
    return [...preamble, fenceMemory(body.join("\n")), ...tail].join("\n");
  };
  const fits = (text: string) => Buffer.byteLength(text, "utf8") <= maxBytes;

  let text = assemble(sections, false);
  if (fits(text)) return text;

  const work = sections.map((s) => ({ ...s, lines: [...s.lines] }));
  const nextDroppable = () => work.filter((s) => s.rank > 0 && s.lines.length > 0).sort((a, b) => b.rank - a.rank)[0];
  for (let s = nextDroppable(); s; s = nextDroppable()) {
    s.lines = [];
    text = assemble(work, true);
    if (fits(text)) return text;
  }
  for (const { id, keep } of CUT_ORDER) {
    const s = work.find((w) => w.id === id);
    if (!s) continue;
    while (s.lines.length > keep) {
      s.lines.pop();
      text = assemble(work, true);
      if (fits(text)) return text;
    }
  }
  return assemble(work, true, true); // only the untouchable sections are left and they alone exceed the cap
}
