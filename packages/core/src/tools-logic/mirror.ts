/**
 * mirror.ts — "The Mirror" (Loop 9): a VISIBLE, CORRECTABLE self-model.
 *
 * For nine loops the system has accumulated a one-sided, HIDDEN model of the
 * user (corrections, blind-spots, awareness insights). Loop 3 proved that model
 * is weak at PREDICTION (0/13 keyword recall on a strict LOO). The Mirror flips
 * the hidden model into a first-person reflection the human can READ and CORRECT:
 *
 *   "You've corrected me 8 times about X."
 *   "I've noticed you tend to …" (with the corrections it's derived from)
 *
 * Each correction-OF-the-mirror is itself a high-value correction — the human
 * pointing at the line and saying "no, that's not why" is exactly the signal the
 * predict-the-correction loop needs.
 *
 * HARD RULES (enforced here and asserted in test/mirror.test.mjs):
 *  1. NEVER fabricate a trait. Every rendered observation traces to ≥1 real
 *     stored record — its `cites` array is non-empty and lists real ids.
 *  2. Carry an explicit fallibility caveat on every reflection (Loop 3: this
 *     model is NOT yet predictive — "what I've noticed", not "what's true").
 *  3. Personal-tier, LOCAL-ONLY. Reads the same personal/ + awareness artifacts
 *     the rest of Wave 5 reads. No network, no LLM, fully deterministic.
 *
 * Pure assembly: this module reads stored data via injected readers (so tests
 * can feed a known store) and renders. It performs NO IO of its own beyond the
 * default readers, which are the existing disk-backed functions.
 */

import {
  readActiveCorrections,
  type CorrectionRecord,
} from "../storage/corrections.js";
import { readBlindSpots } from "../storage/blind-spots-store.js";
import { deriveBlindSpots, type BlindSpot, type BlindSpotProfile } from "../helpers/blind-spots.js";
import { readAwarenessState, type AwarenessState, type Insight } from "../palace/awareness.js";
import { listAllProjects } from "../storage/project.js";
import { tokenize, overlap } from "./check-action.js";

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/**
 * One first-person observation in the mirror. `text` is the rendered line;
 * `cites` lists the REAL stored record ids it was derived from — NEVER empty
 * for a real line (the no-fabrication invariant). `kind` tags the source tier.
 */
export interface MirrorObservation {
  /** First-person line, e.g. "You've corrected me 8 times about: …". */
  text: string;
  /** Source tier this observation was assembled from. */
  kind: "correction" | "tendency" | "insight" | "cross_project";
  /** Real stored ids this line is grounded in (≥1; the anti-fabrication anchor). */
  cites: string[];
  /** Evidence weight — how many records back this line (for ordering / display). */
  evidence_count: number;
}

export interface MirrorReflection {
  /** ISO timestamp the reflection was assembled. */
  generated_at: string;
  /** Project this mirror reflects, or "_global" when assembled cross-project. */
  project: string;
  /** First-person observations, strongest-evidence first. Empty ⇒ empty mirror. */
  observations: MirrorObservation[];
  /**
   * The fallibility caveat (Loop 3). ALWAYS present, even on an empty mirror —
   * the mirror is "what I've noticed", explicitly NOT "what's true about you",
   * and explicitly NOT yet predictive.
   */
  caveat: string;
  /** True when there is no stored data to reflect — render an honest empty mirror. */
  empty: boolean;
  /** Headcount of the underlying corpus this was built from (for the header). */
  basis: {
    corrections: number;
    tendencies: number;
    insights: number;
    cross_project_projects: number;
  };
}

/** Injectable readers so tests can feed a known store; defaults read real disk. */
export interface MirrorReaders {
  corrections: (project: string) => CorrectionRecord[];
  blindSpots: (project: string) => BlindSpotProfile | null;
  awareness: () => AwarenessState | null;
  /** Returns [slug, corrections] for every project (cross-project pass). */
  allProjectCorrections: () => Array<{ slug: string; corrections: CorrectionRecord[] }>;
}

const CAVEAT =
  "This is what I've NOTICED from what you've corrected and told me — not a verified " +
  "model of who you are, and (Loop 3) not yet predictive: on a strict leave-one-out " +
  "test the keyword model anticipated 0/13 corrections. Treat every line as a guess " +
  "you can correct. Correcting the mirror is itself a high-value correction.";

// ---------------------------------------------------------------------------
// Derivation helpers (pure)
// ---------------------------------------------------------------------------

/** Trim a rule to a single readable clause for prose, collapsing whitespace. */
function shorten(rule: string, max = 80): string {
  const oneLine = rule.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1).trimEnd() + "…";
}

/**
 * Which active corrections back a blind spot — by trigger-keyword overlap
 * against each correction's rule+tags. Returns real correction ids only. This
 * is the join that lets every "I've noticed you tend to…" line cite the actual
 * corrections it was clustered from (the no-fabrication anchor for tendencies).
 */
function correctionsBehindTendency(bs: BlindSpot, corrections: CorrectionRecord[]): string[] {
  const triggers = new Set(
    [...bs.trigger_keywords, ...tokenize(bs.tendency)].map((k) => k.toLowerCase()),
  );
  const ids: string[] = [];
  for (const c of corrections) {
    if (c.active === false) continue;
    const sig = tokenize(`${c.rule} ${(c.tags ?? []).join(" ")}`);
    if (overlap(sig, triggers).length >= 1) ids.push(c.id);
  }
  return ids;
}

const P0_RE = /\bnever\b|\balways\b|\bdon'?t\b|\bdo not\b|\bmust not\b|\bforbid\b|\bprohibit\b/i;

/**
 * Theme a single correction into a short topic phrase for the "corrected me
 * about X" line. We never invent the topic — it is the cleaned rule itself,
 * shortened. Returns null when the rule is empty (nothing to cite about).
 */
function correctionTopic(c: CorrectionRecord): string | null {
  const rule = (c.rule ?? "").trim();
  if (!rule) return null;
  return shorten(rule);
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Assemble the mirror for a project (or "_global" when project is omitted).
 *
 * DETERMINISTIC: given the same stored data the output is byte-identical except
 * `generated_at`. Ordering is fully specified (evidence desc, then severity,
 * then a stable text tiebreak) so there is no Set/Map iteration nondeterminism.
 *
 * @param project — project slug; when omitted, assembles a cross-project mirror
 *   keyed "_global" that also surfaces patterns recurring across ≥2 projects.
 * @param readers — injectable for tests; defaults to the real disk-backed store.
 */
export function buildMirror(project?: string, readers?: Partial<MirrorReaders>): MirrorReflection {
  const r: MirrorReaders = {
    corrections: readers?.corrections ?? ((p) => readActiveCorrections(p)),
    // READ-ONLY by default: `ar mirror` must not write the personal tier as a
    // side effect of reading. When no profile is stored yet we derive it
    // in-memory from the active corrections (deriveBlindSpots is pure, no IO) —
    // so the mirror still reflects tendencies without persisting anything.
    blindSpots: readers?.blindSpots ?? ((p) => readBlindSpots(p) ?? deriveInMemory(p)),
    awareness: readers?.awareness ?? (() => readAwarenessState()),
    allProjectCorrections:
      readers?.allProjectCorrections ?? defaultAllProjectCorrections,
  };

  const slug = project && project.trim() ? project.trim() : "_global";
  const observations: MirrorObservation[] = [];

  // ── 1. Tendencies (blind-spots profile) — "I've noticed you tend to…" ──────
  // These are the richest signal: a clustered tendency backed by N corrections.
  // We render the tendency ONLY when we can cite the real corrections behind it.
  let tendencyCount = 0;
  const corrections = project ? r.corrections(slug) : [];
  const profile = project ? r.blindSpots(slug) : null;
  if (profile) {
    for (const bs of profile.blind_spots) {
      const cites = correctionsBehindTendency(bs, corrections);
      if (cites.length === 0) continue; // no backing data ⇒ never render
      tendencyCount++;
      const verb = bs.severity === "p0" ? "tend to insist" : "tend";
      observations.push({
        kind: "tendency",
        text:
          `I've noticed you ${verb}: ${shorten(bs.tendency)} ` +
          `(seen across ${bs.evidence_count} corrections, last ${bs.last_seen}).`,
        cites,
        evidence_count: bs.evidence_count,
      });
    }
  }

  // ── 2. Standalone corrections not already folded into a tendency ───────────
  // "You've corrected me about X." Each line cites exactly its own record id, so
  // it can never be a fabrication. We skip corrections already covered by a
  // rendered tendency to avoid double-counting the same intent.
  const citedByTendency = new Set<string>();
  for (const o of observations) for (const id of o.cites) citedByTendency.add(id);

  // Group remaining corrections by topic so repeated intents read as a count.
  const remaining = corrections.filter((c) => c.active !== false && !citedByTendency.has(c.id));
  for (const c of remaining) {
    const topic = correctionTopic(c);
    if (!topic) continue; // empty rule ⇒ nothing real to cite
    const sev = P0_RE.test(c.rule) || c.severity === "p0" ? "p0" : "p1";
    observations.push({
      kind: "correction",
      text:
        sev === "p0"
          ? `You've drawn a hard line with me: ${topic}.`
          : `You've corrected me on: ${topic}.`,
      cites: [c.id],
      evidence_count: Math.max(1, c.recurrence_count ?? 0) + 1,
    });
  }
  const correctionLineCount = remaining.length;

  // ── 3. Awareness insights — "I've learned…" (cite the insight id) ──────────
  let insightCount = 0;
  const awareness = r.awareness();
  if (awareness) {
    const relevant = (awareness.topInsights ?? []).filter((ins) =>
      project ? insightAppliesToProject(ins, slug) : true,
    );
    for (const ins of relevant) {
      if (!ins.id || !ins.title) continue; // no real anchor ⇒ skip
      insightCount++;
      observations.push({
        kind: "insight",
        text:
          `I've learned: ${shorten(ins.title)} ` +
          `(confirmed ${ins.confirmations}×, last ${ins.lastConfirmed?.slice(0, 10) ?? "?"}).`,
        cites: [ins.id],
        evidence_count: Math.max(1, ins.confirmations ?? 1),
      });
    }
  }

  // ── 4. Cross-project patterns (only for the _global mirror) ────────────────
  // A pattern that recurs across ≥2 projects is the strongest "how you think"
  // signal — it's not tied to one codebase. Cite the correction ids from each
  // project that share the cluster. Pure: derived from the same tokenizer.
  let crossProjectProjects = 0;
  if (!project) {
    const cp = deriveCrossProjectPatterns(r.allProjectCorrections());
    crossProjectProjects = cp.projectCount;
    for (const pat of cp.patterns) {
      observations.push({
        kind: "cross_project",
        text:
          `Across ${pat.projects.length} projects (${pat.projects.join(", ")}) ` +
          `you keep returning to: ${shorten(pat.topic)} ` +
          `(${pat.cites.length} corrections).`,
        cites: pat.cites,
        evidence_count: pat.cites.length,
      });
    }
  }

  // ── Order: evidence desc, then tendency>cross_project>correction>insight,  ──
  //    then stable text tiebreak. Fully deterministic.
  const kindRank: Record<MirrorObservation["kind"], number> = {
    tendency: 0,
    cross_project: 1,
    correction: 2,
    insight: 3,
  };
  observations.sort((a, b) => {
    if (b.evidence_count !== a.evidence_count) return b.evidence_count - a.evidence_count;
    if (kindRank[a.kind] !== kindRank[b.kind]) return kindRank[a.kind] - kindRank[b.kind];
    return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
  });

  return {
    generated_at: new Date().toISOString(),
    project: slug,
    observations,
    caveat: CAVEAT,
    empty: observations.length === 0,
    basis: {
      corrections: correctionLineCount,
      tendencies: tendencyCount,
      insights: insightCount,
      cross_project_projects: crossProjectProjects,
    },
  };
}

// ---------------------------------------------------------------------------
// Default disk-backed helpers
// ---------------------------------------------------------------------------

/**
 * Derive a blind-spots profile in memory from the project's active corrections,
 * WITHOUT persisting (read-only `ar mirror`). Pure: deriveBlindSpots does no IO;
 * the only IO is the corrections read, which is wrapped so a failure ⇒ null.
 */
function deriveInMemory(project: string): BlindSpotProfile | null {
  try {
    return deriveBlindSpots(readActiveCorrections(project), []);
  } catch {
    return null;
  }
}

function defaultAllProjectCorrections(): Array<{ slug: string; corrections: CorrectionRecord[] }> {
  const out: Array<{ slug: string; corrections: CorrectionRecord[] }> = [];
  let projects: Array<{ slug: string }> = [];
  try {
    projects = listAllProjects();
  } catch {
    return out;
  }
  for (const p of projects) {
    try {
      const corr = readActiveCorrections(p.slug);
      if (corr.length > 0) out.push({ slug: p.slug, corrections: corr });
    } catch {
      // skip unreadable project
    }
  }
  return out;
}

/** An insight applies to a project when it has no project scope or names it. */
function insightAppliesToProject(ins: Insight, slug: string): boolean {
  const sp = ins.source_project;
  if (!sp || sp === "_global") return true;
  return sp === slug;
}

// ---------------------------------------------------------------------------
// Cross-project pattern derivation (pure)
// ---------------------------------------------------------------------------

export interface CrossProjectPattern {
  /** Representative topic (cleaned rule of the strongest member). */
  topic: string;
  /** Distinct project slugs the pattern spans (≥2). */
  projects: string[];
  /** Real correction ids backing the pattern. */
  cites: string[];
}

/**
 * Find correction clusters that recur across ≥2 projects. We tokenize each
 * correction, greedily cluster by ≥2 shared content tokens, and keep clusters
 * whose members span ≥2 distinct projects. Deterministic: corrections are
 * pre-sorted by (date, id) before clustering.
 */
export function deriveCrossProjectPatterns(
  perProject: Array<{ slug: string; corrections: CorrectionRecord[] }>,
): { patterns: CrossProjectPattern[]; projectCount: number } {
  interface Item {
    id: string;
    project: string;
    rule: string;
    tokens: Set<string>;
    date: string;
  }
  const items: Item[] = [];
  for (const { slug, corrections } of perProject) {
    for (const c of corrections) {
      if (c.active === false) continue;
      const rule = (c.rule ?? "").trim();
      if (!rule) continue;
      const tokens = tokenize(`${rule} ${(c.tags ?? []).join(" ")}`);
      if (tokens.size === 0) continue;
      items.push({ id: c.id, project: slug, rule, tokens, date: c.date ?? "" });
    }
  }
  // Deterministic order.
  items.sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  const MIN_SHARED = 2;
  const used = new Set<number>();
  const patterns: CrossProjectPattern[] = [];
  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    const seed = items[i];
    const members = [seed];
    used.add(i);
    for (let j = i + 1; j < items.length; j++) {
      if (used.has(j)) continue;
      if (overlap(items[j].tokens, seed.tokens).length >= MIN_SHARED) {
        members.push(items[j]);
        used.add(j);
      }
    }
    const projects = [...new Set(members.map((m) => m.project))].sort();
    if (projects.length < 2) continue; // not cross-project ⇒ skip
    patterns.push({
      topic: seed.rule,
      projects,
      cites: members.map((m) => m.id),
    });
  }
  patterns.sort((a, b) => b.cites.length - a.cites.length);
  const allProjects = new Set<string>();
  for (const p of patterns) for (const pr of p.projects) allProjects.add(pr);
  return { patterns, projectCount: allProjects.size };
}

// ---------------------------------------------------------------------------
// Rendering (human-readable)
// ---------------------------------------------------------------------------

/** Render a reflection as first-person human-readable text (for `ar mirror`). */
export function renderMirror(m: MirrorReflection): string {
  const lines: string[] = [];
  const scope = m.project === "_global" ? "across all your projects" : `for ${m.project}`;
  lines.push(`# The Mirror — what I've learned about how you think (${scope})`);
  lines.push("");
  if (m.empty) {
    lines.push(
      "I don't have enough of your corrections or insights yet to reflect anything " +
        "back. The mirror stays empty until there's real stored data — I won't invent " +
        "a persona for you.",
    );
    lines.push("");
    lines.push(`> ${m.caveat}`);
    return lines.join("\n");
  }
  for (const o of m.observations) {
    lines.push(`- ${o.text}`);
    lines.push(`    ↳ from: ${o.cites.join(", ")}`);
  }
  lines.push("");
  lines.push(
    `(${m.basis.tendencies} tendencies · ${m.basis.corrections} corrections · ` +
      `${m.basis.insights} insights` +
      (m.project === "_global" ? ` · ${m.basis.cross_project_projects} cross-project` : "") +
      `)`,
  );
  lines.push("");
  lines.push(`> ${m.caveat}`);
  return lines.join("\n");
}
