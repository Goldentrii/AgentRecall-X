#!/usr/bin/env node
/**
 * backfill-cjk-insights — one-shot re-clustering of an existing
 * insights-index.json under the fix #3 CJK-aware normalizeTitle.
 *
 * WHY: before fix #3, normalizeTitle stripped [^a-z0-9\s], so every CJK
 * title normalized to the empty set and findSimilarInsight could never
 * confirm it — the live index accumulated same-meaning CJK entries as
 * independent confirmed_count-1 rows (first in line for 200-cap eviction,
 * never promotion-eligible). This script merges those now-detectable
 * duplicates and re-runs the STANDARD promotion path.
 *
 * SEMANTICS
 *   - Clustering replays the production matcher: each entry is checked with
 *     findSimilarInsight() against the FIRST member of every cluster so far
 *     (exactly what the fixed write path would have matched against).
 *   - Merged confirmed_count = SUM of member counts.
 *   - The member with the RICHEST metadata survives as representative
 *     (applies_when + skill_tags + projects + file presence; ties → higher
 *     confirmed_count, then original index order).
 *   - applies_when unions across members (cap 10 — addIndexedInsight
 *     semantics); projects and skill_tags union; last_confirmed = max.
 *   - Merged-away entries are preserved VERBATIM in a manifest with a
 *     restore path, plus a byte-identical backup of the pre-merge index.
 *     Nothing is ever deleted without a recovery path.
 *   - Promotion re-uses promoteConfirmedInsights(3) — the standard
 *     awareness confirm-first + 20-cap machinery. No bespoke logic.
 *
 * SAFETY
 *   - DRY-RUN IS THE DEFAULT: prints the diff JSON to stdout, writes nothing.
 *     Pass --apply to write.
 *   - Operates ONLY via AGENT_RECALL_ROOT (refuses to run without it — no
 *     hardcoded live path, no homedir fallback).
 *   - Idempotent: a second run finds no clusters and writes nothing.
 *   - Personal-tier Supabase sync is force-disabled for the process
 *     (AGENT_RECALL_SYNC_PERSONAL=false) — a backfill must never push to
 *     the cloud, even when run against a store whose config opts in.
 *   - Refuses --apply when more than 40% of the index would collapse
 *     (over-aggressive identity guard) unless --force is also passed.
 *
 * USAGE
 *   AGENT_RECALL_ROOT=/path/to/store node scripts/backfill-cjk-insights.mjs           # dry-run
 *   AGENT_RECALL_ROOT=/path/to/store node scripts/backfill-cjk-insights.mjs --apply   # write
 *
 *   Run --apply with NO active sessions writing the store: the index is read
 *   at process start and written under the production file lock at the end,
 *   but a concurrent addIndexedInsight between those two points would be
 *   overwritten (one-shot admin tool — not designed for live concurrency).
 */

import fs from "node:fs";
import path from "node:path";

// ── Safety: never let this process sync personal-tier data to Supabase ──────
process.env.AGENT_RECALL_SYNC_PERSONAL = "false";
process.env.AR_SYNC_CORRECTIONS = "false";

// ── Root gate: AGENT_RECALL_ROOT is REQUIRED (no fallback to the live store) ─
const root = process.env.AGENT_RECALL_ROOT;
if (!root) {
  console.error("backfill-cjk-insights: AGENT_RECALL_ROOT must be set explicitly — this script never falls back to ~/.agent-recall.");
  process.exit(1);
}
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`backfill-cjk-insights: AGENT_RECALL_ROOT does not exist or is not a directory: ${root}`);
  process.exit(1);
}
const indexPath = path.join(root, "insights-index.json");
if (!fs.existsSync(indexPath)) {
  console.error(`backfill-cjk-insights: no insights-index.json under ${root}`);
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");

// Import AFTER the env safety lines above (config env overrides are read at
// call time, but keeping the order explicit makes the intent auditable).
const core = await import(new URL("../packages/core/dist/index.js", import.meta.url));
const { findSimilarInsight, readInsightsIndex, writeInsightsIndex, promoteConfirmedInsights, withLock } = core;

const PROMOTION_THRESHOLD = 3;
const APPLIES_WHEN_CAP = 10; // addIndexedInsight's merge cap

const originalBytes = fs.readFileSync(indexPath, "utf-8");
const index = readInsightsIndex();
const insights = index.insights ?? [];

// ── Cluster under the FIXED normalization ────────────────────────────────────
// Each cluster's match anchor is its FIRST member — replaying what the fixed
// write path (findSimilarInsight against already-admitted entries) would have
// matched. Entries with an empty normalized identity never match anything
// (findSimilarInsight guards both directions).
const richness = (e) =>
  (e.applies_when?.length ?? 0) +
  (e.skill_tags?.length ?? 0) +
  (e.projects?.length ?? 0) +
  (e.file ? 1 : 0);

/**
 * One cluster+merge pass over `list`.
 *
 * REFERENCE-KEYED throughout (code-review HIGH-1, 2026-09-11): production ids
 * are `idx-${Date.now()}` and CAN collide within one millisecond — keying the
 * rebuild by id was reproduced dropping an unrelated entry that shared a
 * merged-away member's id and emitting the merged row twice. Object identity
 * (every entry comes from one JSON.parse) is collision-free.
 *
 * Returns { out, passClusters } where passClusters carry { rep, merged }
 * object refs for lineage tracking by the fixed-point loop below.
 */
function clusterAndMergeOnce(list) {
  const clusters = []; // { anchor, members: [entry...] }
  for (const entry of list) {
    const anchors = clusters.map((c) => c.anchor);
    const hit = findSimilarInsight(entry.title, anchors);
    if (hit) {
      clusters.find((c) => c.anchor === hit).members.push(entry);
    } else {
      clusters.push({ anchor: entry, members: [entry] });
    }
  }

  const passClusters = [];
  const mergedByAnchor = new Map(); // anchor OBJECT -> merged entry
  const replaced = new Set();       // OBJECT refs of all members of merged clusters

  for (const cluster of clusters) {
    if (cluster.members.length < 2) continue;

    // Representative: richest metadata; ties → higher confirmed_count → list order
    const rep = [...cluster.members].sort((a, b) => {
      const r = richness(b) - richness(a);
      if (r !== 0) return r;
      const c = (b.confirmed_count ?? 0) - (a.confirmed_count ?? 0);
      if (c !== 0) return c;
      return cluster.members.indexOf(a) - cluster.members.indexOf(b);
    })[0];

    const others = cluster.members.filter((m) => m !== rep);
    const merged = { ...rep };
    merged.confirmed_count = cluster.members.reduce((s, m) => s + (m.confirmed_count ?? 0), 0);
    merged.last_confirmed = cluster.members
      .map((m) => m.last_confirmed)
      .filter(Boolean)
      .sort()
      .at(-1) ?? rep.last_confirmed;

    // applies_when: rep first, then members in cluster order — cap 10 (standard)
    const appliesWhen = [...(rep.applies_when ?? [])];
    for (const m of cluster.members) {
      for (const aw of m.applies_when ?? []) {
        if (!appliesWhen.includes(aw) && appliesWhen.length < APPLIES_WHEN_CAP) appliesWhen.push(aw);
      }
    }
    merged.applies_when = appliesWhen;

    // projects: union (standard addIndexedInsight semantics — uncapped)
    const projects = [...(rep.projects ?? [])];
    for (const m of cluster.members) {
      for (const p of m.projects ?? []) {
        if (!projects.includes(p)) projects.push(p);
      }
    }
    if (projects.length > 0) merged.projects = projects;

    // skill_tags: union (richest-metadata doctrine — keep everything recoverable)
    const skillTags = [...(rep.skill_tags ?? [])];
    for (const m of cluster.members) {
      for (const t of m.skill_tags ?? []) {
        if (!skillTags.includes(t)) skillTags.push(t);
      }
    }
    if (skillTags.length > 0) merged.skill_tags = skillTags;

    mergedByAnchor.set(cluster.anchor, merged);
    for (const m of cluster.members) replaced.add(m);

    passClusters.push({
      rep,
      merged,
      record: {
        kept_id: merged.id,
        kept_title: merged.title,
        member_count: cluster.members.length,
        confirmed_count_before_kept: rep.confirmed_count,
        confirmed_count_after: merged.confirmed_count,
        merged_away: others, // VERBATIM entries — never deleted, always restorable
      },
    });
  }

  // Post-merge list: original order; the merged entry sits at the cluster's
  // first-member/anchor position; every other member is removed.
  const out = [];
  for (const entry of list) {
    if (mergedByAnchor.has(entry)) out.push(mergedByAnchor.get(entry));
    else if (!replaced.has(entry)) out.push(entry);
  }
  return { out, passClusters };
}

// ── Iterate to a FIXED POINT (code-review HIGH-2, 2026-09-11) ────────────────
// A single pass matches against cluster ANCHORS, but the surviving entry
// carries the richest-metadata REP's title — which changes the match surface.
// Verified counterexample: C missed anchor A in pass 1 but matches rep B's
// title, so a one-pass run left the index short of the fixed point and a
// second --apply reported changes again (breaking idempotency). Each pass
// strictly shrinks the list, so the loop terminates; the length cap is
// belt-and-braces.
const mergeClusters = []; // flattened { pass, ...record } across passes
// lineage: synthetic merged entry -> the ORIGINAL pre-backfill confirmed_count
// of the physical row that survives (rep chain), for honest "crossed >= 3"
// reporting across passes.
const originalCount = new Map();
const origCountOf = (e) => originalCount.get(e) ?? (e.confirmed_count ?? 0);

let afterInsights = insights;
for (let pass = 1; pass <= insights.length + 1; pass++) {
  const { out, passClusters } = clusterAndMergeOnce(afterInsights);
  if (passClusters.length === 0) break;
  for (const { rep, merged, record } of passClusters) {
    originalCount.set(merged, origCountOf(rep));
    mergeClusters.push({ pass, ...record });
  }
  afterInsights = out;
}

const distribution = (list) => {
  const d = {};
  for (const e of list) d[e.confirmed_count] = (d[e.confirmed_count] ?? 0) + 1;
  return d;
};

const collapseFraction = insights.length > 0 ? (insights.length - afterInsights.length) / insights.length : 0;

// Entries CROSSING the promotion threshold via this backfill: the surviving
// physical row's ORIGINAL count was < 3 and its post-merge count is >= 3.
const promotionCandidates = afterInsights
  .filter((e) => originalCount.has(e)
    && origCountOf(e) < PROMOTION_THRESHOLD
    && e.confirmed_count >= PROMOTION_THRESHOLD)
  .map((e) => ({ id: e.id, title: e.title, confirmed_count_after: e.confirmed_count }));

const diff = {
  mode: APPLY ? "apply" : "dry-run",
  root,
  total_before: insights.length,
  total_after: afterInsights.length,
  merge_clusters: mergeClusters,
  merged_away_total: insights.length - afterInsights.length,
  collapse_fraction: Number(collapseFraction.toFixed(4)),
  distribution_before: distribution(insights),
  distribution_after: distribution(afterInsights),
  promotion_candidates: promotionCandidates,
  promotion: null,
  manifest_path: null,
  backup_path: null,
  changed: mergeClusters.length > 0,
};

// ── Over-aggressive identity guard ───────────────────────────────────────────
if (diff.collapse_fraction > 0.4) {
  console.error(
    `backfill-cjk-insights: WARNING — ${(diff.collapse_fraction * 100).toFixed(1)}% of the index would collapse (>40%). ` +
    `This suggests over-aggressive identity; escalate before applying.`
  );
  if (APPLY && !FORCE) {
    console.error("Refusing --apply above the 40% collapse guard. Re-run with --force only after review.");
    console.log(JSON.stringify(diff, null, 2));
    process.exit(2);
  }
}

// ── Apply ────────────────────────────────────────────────────────────────────
if (APPLY) {
  if (diff.changed) {
    const backupsDir = path.join(root, "backups");
    fs.mkdirSync(backupsDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const stamp = day.replace(/-/g, "");
    const unique = (p) => {
      if (!fs.existsSync(p)) return p;
      let n = 1;
      while (fs.existsSync(`${p}-${n}`)) n++; // re-check every candidate (review LOW-2)
      return `${p}-${n}`;
    };

    // 1. Byte-identical pre-image backup (restore path)
    const backupPath = unique(path.join(backupsDir, `insights-index.json.bak-${stamp}`));
    fs.writeFileSync(backupPath, originalBytes, "utf-8");
    diff.backup_path = backupPath;

    // 2. Manifest — merged-away entries VERBATIM + restore instructions
    const manifestPath = unique(path.join(backupsDir, `insights-backfill-manifest-${day}.json`));
    const manifest = {
      backfill: "cjk-insights",
      version: 1,
      timestamp: new Date().toISOString(),
      root,
      index_backup: backupPath,
      restore: `cp ${backupPath} ${indexPath}`,
      total_before: diff.total_before,
      total_after: diff.total_after,
      clusters: mergeClusters,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
    diff.manifest_path = manifestPath;

    // 3. Write the merged index through the STANDARD write path
    //    (scrubForCloud + gated sync — same as every production write), under
    //    the production insights-index file lock (review LOW-1). NOTE: the
    //    read happened at process start — run this tool with no active
    //    sessions writing the store (see USAGE header).
    withLock("insights-index", () => {
      index.insights = afterInsights;
      writeInsightsIndex(index);
    });
  }

  // 4. STANDARD promotion path — awareness confirm-first + 20-cap machinery.
  //    Invoked ONLY when this backfill actually merged something (the brief's
  //    scope: entries crossing >= 3 POST-MERGE). Clone verification against a
  //    SATURATED awareness (20 topInsights at confirmations 9-364) showed the
  //    standard path is inherently non-idempotent there: a fresh promotion
  //    lands at confirmations 1, is demoted to archive by the 20-cap on the
  //    same call, and the next run promotes → demotes → resurrects it again
  //    (pre-existing rollup behavior, not introduced here). Gating on
  //    `changed` keeps the second backfill run a byte-identical no-op while
  //    still routing every genuine crossing through the unmodified machinery.
  if (diff.changed) {
    diff.promotion = promoteConfirmedInsights(PROMOTION_THRESHOLD);
  }
}

// Human-readable summary → stderr; machine-readable diff → stdout
console.error(
  `backfill-cjk-insights [${diff.mode}] root=${root}\n` +
  `  entries: ${diff.total_before} -> ${diff.total_after} (${diff.merged_away_total} merged away, collapse ${(diff.collapse_fraction * 100).toFixed(1)}%)\n` +
  `  clusters: ${mergeClusters.length}; crossing >=${PROMOTION_THRESHOLD}: ${promotionCandidates.length}\n` +
  (diff.promotion ? `  promotion: ${diff.promotion.promoted.length} promoted, ${diff.promotion.skipped.length} skipped\n` : "") +
  (diff.manifest_path ? `  manifest: ${diff.manifest_path}\n  backup:   ${diff.backup_path}\n` : "")
);
console.log(JSON.stringify(diff, null, 2));
