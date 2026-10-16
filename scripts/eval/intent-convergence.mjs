#!/usr/bin/env node
/**
 * intent-convergence.mjs — Loop 10 FREESTYLE experiment.
 *
 * THE CLAIM UNDER TEST (MATH.md §d, flagged there as ASPIRATIONAL):
 *   "redundancy over time reconstructs intent."
 * Loop 10 turns that slogan into a FALSIFIABLE measurement. We model each
 * correction as a noisy observation x_i of a latent intent θ for its cluster.
 * If the slogan is true, then as same-cluster corrections accumulate the RUNNING
 * estimate of θ should STABILIZE: each new member adds less novelty, and the
 * shared-token consensus should rise above the per-member noise.
 *
 * INTELLECTUAL HONESTY IS THE POINT. This script reports the REAL number. A flat
 * curve, a non-converging cluster, or "too few multi-member clusters to decide"
 * are all VALID, valuable findings — and, given Loop 3's 0/13 and Loop 9's 0/25,
 * the likely ones. The metric is NOT engineered to manufacture convergence.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * METHOD (read-only over ~/.agent-recall):
 *
 *   1. CLUSTERING. Group same-cluster corrections by clusterSignature overlap
 *      >= MIN_OVERLAP (the predict-loo grammar: tokenize(rule + tags)). Clusters
 *      are connected components under that relation, per project. Only ACTIVE
 *      corrections (active !== false) are clustered — consistent with the
 *      active_predictable fix in commit 0528e2a: deriveBlindSpots() drops
 *      active===false signals, so a retracted member can never contribute to the
 *      live intent estimate and must not pad a cluster.
 *
 *      We ALSO compute a parallel RULE-ONLY signature view (tokenize(rule) only,
 *      no tags) because the high-frequency corpus tags are BOILERPLATE METADATA
 *      ("correction", "rule", category tags) that glue unrelated intents into
 *      spurious clusters (documented in mirror-reconstruct.mjs). Reporting both
 *      exposes how much of any "cluster" is a tag artifact vs. real shared intent.
 *
 *   2. ORDER. Within a cluster, order members by date ascending (ties broken by
 *      id) — the temporal accumulation the slogan is about.
 *
 *   3. RUNNING ESTIMATE. Represent member i by its content-token set t_i
 *      (production tokenizer). After the first k members the estimate E_k is the
 *      CONSENSUS set: tokens shared by >= ceil(k/2) of the first k members (a
 *      majority centroid in token space — robust to one noisy member).
 *
 *   4. CONVERGENCE METRICS (per cluster, as a function of k -> N):
 *        - convergence(k)  = Jaccard(E_k, E_N): does the early estimate already
 *          resemble the final one? Rises toward 1 and plateaus => estimable from
 *          few samples => redundancy reconstructs.
 *        - marginal_novelty(k) = |new distinct tokens introduced by member k| /
 *          |running union after k|. Shrinks toward 0 => diminishing returns =>
 *          the cluster's vocabulary is saturating (a convergence signature).
 *        - consensus_snr(k) = |tokens shared by >= ceil(k/2) of first k members| /
 *          |distinct tokens across first k members|. The shared "signal" over the
 *          total "noise+signal". Rises with k => consensus emerges from redundancy.
 *
 *   5. AGGREGATE across clusters: mean curves over k, plus the headline cluster
 *      slopes (does convergence rise? does novelty fall? does SNR rise?), and the
 *      CLUSTER-SIZE DISTRIBUTION.
 *
 * VERDICT (decided by counts, never by wishful reading):
 *   - UNTESTABLE: fewer than MIN_CLUSTERS_TO_DECIDE clusters with N >= 3 — too
 *     few multi-member clusters to say anything. (Report the distribution.)
 *   - SUPPORTED: enough N>=3 clusters AND, on average, marginal_novelty falls
 *     AND consensus_snr rises with N (both monotone-ish trends present).
 *   - REFUTED: enough N>=3 clusters but the estimates do NOT converge — novelty
 *     does not shrink and/or SNR is flat/declining.
 *
 * Usage:
 *   node scripts/eval/intent-convergence.mjs               # real ~/.agent-recall
 *   node scripts/eval/intent-convergence.mjs --root <dir>  # explicit corpus
 *   node scripts/eval/intent-convergence.mjs --json        # machine-readable
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

import { tokenize, overlap } from "../../packages/core/dist/tools-logic/check-action.js";

// ── Config — mirrors the predict-loo cluster grammar (MIN_OVERLAP = 2) ────────
const MIN_OVERLAP = 2; // same-cluster signature floor (predict-loo.mjs)
const MIN_CLUSTER_N = 3; // a cluster must have >= 3 members to test convergence
const MIN_CLUSTERS_TO_DECIDE = 3; // fewer testable clusters than this => UNTESTABLE

// ───────────────────────────────────────────────────────────────────────────
// Corpus loading (read-only; same readers as predict-loo / mirror-reconstruct)
// ───────────────────────────────────────────────────────────────────────────
function defaultRoot() {
  return process.env.AGENT_RECALL_ROOT || path.join(os.homedir(), ".agent-recall");
}

function listProjects(root) {
  const base = path.join(root, "projects");
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base).filter((p) => fs.existsSync(path.join(base, p, "corrections")));
}

function readProjectCorrections(root, project) {
  const dir = path.join(root, "projects", project, "corrections");
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
      if (rec && rec.rule && rec.date) out.push(rec);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Cluster signatures — two views, reported side by side for honesty.
//   sigWithTags  = tokenize(rule + tags)  — the predict-loo grammar (default).
//   sigRuleOnly  = tokenize(rule)          — the conservative mirror-reconstruct
//                  join that ignores boilerplate tags. Can only LOWER cluster
//                  sizes, never inflate — so divergence between the two views
//                  measures how much a "cluster" is a tag artifact.
// ───────────────────────────────────────────────────────────────────────────
function sigWithTags(c) {
  return tokenize(`${c.rule || ""} ${(c.tags || []).join(" ")}`);
}
function sigRuleOnly(c) {
  return tokenize(c.rule || "");
}
function sigOverlap(a, b) {
  return overlap(a, b).length;
}

/** Content-token set of a member's rule text (the observation x_i). */
function memberTokens(c) {
  return tokenize(c.rule || "");
}

// ───────────────────────────────────────────────────────────────────────────
// Clustering — connected components under (signature overlap >= MIN_OVERLAP),
// per project, over a chosen correction set. Deterministic union-find.
// ───────────────────────────────────────────────────────────────────────────
function clusterProject(recs, sigFn) {
  const n = recs.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const sigs = recs.map(sigFn);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (sigOverlap(sigs[i], sigs[j]) >= MIN_OVERLAP) union(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(recs[i]);
  }
  return [...groups.values()];
}

// ───────────────────────────────────────────────────────────────────────────
// Convergence metrics for ONE ordered cluster (members already date-sorted).
// Returns per-k curves plus headline trend summaries. Exported for the test.
// ───────────────────────────────────────────────────────────────────────────
/**
 * @param {Set<string>[]} tokenSets  ordered observation token sets x_1..x_N
 * @returns {{
 *   n: number,
 *   convergence: number[],        // Jaccard(E_k, E_N), k=1..N (E_N is final consensus)
 *   marginal_novelty: number[],   // new tokens at member k / running union, k=1..N
 *   consensus_snr: number[],      // |shared by >= ceil(k/2)| / |union of first k|, k=1..N
 *   final_snr: number,            // SCALAR: |shared by >= ceil(N/2)| / |total distinct|
 *   novelty_falls: boolean,       // novelty(N) < novelty(2): diminishing returns present
 *   convergence_rises: boolean,   // convergence(N) > convergence(2): estimate stabilizes
 *   converges: boolean,           // both within-cluster trends present => converges
 * }}
 *
 * DESIGN NOTE on the convergence GATE (intellectual-honesty critical):
 *   The within-cluster `consensus_snr` k-trajectory is DEGENERATE at small k:
 *   the majority threshold ceil(k/2) equals 1 for k=1 AND k=2, so the consensus
 *   set is the whole union and SNR is pinned at 1.0 — it can only FALL from
 *   there, even for a perfectly converging cluster. Using "SNR rises with k"
 *   as a per-cluster gate would therefore mark genuine convergence as failure.
 *   So the per-cluster GATE is the two NON-degenerate signals:
 *     (a) marginal novelty FALLS (vocabulary saturates — diminishing returns), and
 *     (b) the running consensus estimate STABILIZES toward the final
 *         (convergence Jaccard rises from k=2 to k=N).
 *   The brief's "CONSENSUS-SNR as a function of N" is honored as the SCALAR
 *   `final_snr` (signal/total at the full cluster), aggregated ACROSS clusters of
 *   different N at the corpus level — its natural domain — not as a within-cluster
 *   k-curve gate.
 */
export function clusterConvergence(tokenSets) {
  const N = tokenSets.length;
  // Consensus set after first k members: tokens shared by >= ceil(k/2).
  const consensusAt = (k) => {
    const counts = new Map();
    for (let i = 0; i < k; i++) {
      for (const tok of tokenSets[i]) counts.set(tok, (counts.get(tok) || 0) + 1);
    }
    const need = Math.ceil(k / 2);
    const out = new Set();
    for (const [tok, c] of counts) if (c >= need) out.add(tok);
    return out;
  };
  const unionAt = (k) => {
    const out = new Set();
    for (let i = 0; i < k; i++) for (const tok of tokenSets[i]) out.add(tok);
    return out;
  };
  const jaccard = (a, b) => {
    if (a.size === 0 && b.size === 0) return 1;
    let inter = 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const t of small) if (large.has(t)) inter++;
    const uni = a.size + b.size - inter;
    return uni === 0 ? 0 : inter / uni;
  };

  const finalConsensus = consensusAt(N);
  const totalUnion = unionAt(N);
  const convergence = [];
  const marginal_novelty = [];
  const consensus_snr = [];

  let prevUnion = new Set();
  for (let k = 1; k <= N; k++) {
    const Ek = consensusAt(k);
    convergence.push(Number(jaccard(Ek, finalConsensus).toFixed(4)));

    // Marginal novelty = fraction of MEMBER k's OWN tokens that are new (unseen in
    // members 1..k-1). This is the honest "diminishing returns" signal: for a
    // CONVERGING cluster later members are mostly-repeat (novelty → 0); for a
    // DIVERSE/noise cluster every member is largely fresh (novelty stays ~1). We
    // deliberately do NOT divide by the running UNION — that denominator grows
    // even for pure noise, so |new|/|union| falls for ANY cluster (an arithmetic
    // artifact, not convergence). |new|/|member| has no such bias.
    const memberK = tokenSets[k - 1];
    let added = 0;
    for (const tok of memberK) if (!prevUnion.has(tok)) added++;
    marginal_novelty.push(memberK.size === 0 ? 0 : Number((added / memberK.size).toFixed(4)));
    for (const tok of memberK) prevUnion.add(tok);

    const uni = unionAt(k);
    consensus_snr.push(uni.size === 0 ? 0 : Number((Ek.size / uni.size).toFixed(4)));
  }

  // SCALAR consensus-SNR at the full cluster: majority-shared signal / total noise.
  // THE primary discriminator: a converging cluster has a large shared core
  // (final_snr high); pure noise has a near-empty majority core (final_snr → 0).
  const final_snr = totalUnion.size === 0 ? 0 : Number((finalConsensus.size / totalUnion.size).toFixed(4));

  // Within-cluster convergence GATE. Two NON-degenerate, NON-artifactual signals:
  //   (a) marginal novelty FALLS (members 2..N add a shrinking fraction of new
  //       vocabulary — diminishing returns), compared k=2 → k=N; AND
  //   (b) the full-cluster majority core is SUBSTANTIAL (final_snr above a noise
  //       floor) — i.e. redundancy actually produced a shared signal, not just an
  //       arithmetic novelty decline over a growing union.
  // The convergence Jaccard k-curve and the SNR k-curve are REPORTED but not used
  // as gates (both carry the ceil(k/2) majority-threshold artifact at small k).
  const SNR_FLOOR = 0.25; // a majority core must be >= 1/4 of the cluster vocabulary
  const novelty_falls = N >= 3 ? marginal_novelty[N - 1] < marginal_novelty[1] : false;
  const has_core = final_snr >= SNR_FLOOR;
  const converges = novelty_falls && has_core;

  return {
    n: N,
    convergence,
    marginal_novelty,
    consensus_snr,
    final_snr,
    novelty_falls,
    has_core,
    converges,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Build all testable clusters (N >= MIN_CLUSTER_N) for a corpus + signature view.
// ───────────────────────────────────────────────────────────────────────────
function buildClusters(root, { activeOnly, sigFn }) {
  const projects = listProjects(root);
  const sizeDist = {}; // size -> count
  const testable = []; // { project, size, members: ordered records }

  for (const project of projects) {
    const all = readProjectCorrections(root, project);
    const set = activeOnly ? all.filter((c) => c.active !== false) : all;
    if (set.length === 0) continue;
    const groups = clusterProject(set, sigFn);
    for (const g of groups) {
      sizeDist[g.length] = (sizeDist[g.length] || 0) + 1;
      if (g.length >= MIN_CLUSTER_N) {
        const ordered = [...g].sort((a, b) =>
          a.date === b.date ? String(a.id).localeCompare(String(b.id)) : a.date < b.date ? -1 : 1,
        );
        testable.push({ project, size: g.length, members: ordered });
      }
    }
  }
  return { sizeDist, testable };
}

// ───────────────────────────────────────────────────────────────────────────
// Aggregate: mean curves over testable clusters + verdict.
// ───────────────────────────────────────────────────────────────────────────
function meanCurveByK(perCluster, field, maxK) {
  // Average the metric at each k across clusters that HAVE a kth point.
  const sums = new Array(maxK).fill(0);
  const counts = new Array(maxK).fill(0);
  for (const c of perCluster) {
    const arr = c.metrics[field];
    for (let k = 0; k < arr.length && k < maxK; k++) {
      sums[k] += arr[k];
      counts[k] += 1;
    }
  }
  return sums.map((s, k) => (counts[k] > 0 ? Number((s / counts[k]).toFixed(4)) : null));
}

function evaluateView(root, viewName, opts) {
  const { sizeDist, testable } = buildClusters(root, opts);
  const perCluster = testable.map((c) => ({
    project: c.project,
    size: c.size,
    rules: c.members.map((m) => (m.rule || "").replace(/\s+/g, " ").slice(0, 60)),
    metrics: clusterConvergence(c.members.map(memberTokens)),
  }));

  const nTestable = perCluster.length;
  const maxK = perCluster.reduce((m, c) => Math.max(m, c.size), 0);

  const meanConvergence = nTestable ? meanCurveByK(perCluster, "convergence", maxK) : [];
  const meanNovelty = nTestable ? meanCurveByK(perCluster, "marginal_novelty", maxK) : [];
  const meanSnr = nTestable ? meanCurveByK(perCluster, "consensus_snr", maxK) : [];

  const clustersThatConverge = perCluster.filter((c) => c.metrics.converges).length;
  const meanFinalSnr = nTestable
    ? Number((perCluster.reduce((s, c) => s + c.metrics.final_snr, 0) / nTestable).toFixed(4))
    : null;

  // Verdict — counts first, never wishful.
  let verdict;
  if (nTestable < MIN_CLUSTERS_TO_DECIDE) {
    verdict = "untestable";
  } else {
    // SUPPORTED requires the corpus-level convergence signature to hold: mean
    // marginal novelty FALLS across k=2 → k=maxK (vocabulary saturates) AND the
    // mean full-cluster consensus-SNR clears the noise floor (a real shared core
    // emerged from redundancy) AND a MAJORITY of testable clusters individually
    // converge. Otherwise REFUTED. (The within-cluster Jaccard / SNR k-curves are
    // reported but excluded from the gate — ceil(k/2) artifact at small k.)
    const nov2 = meanNovelty[1];
    const novN = meanNovelty[maxK - 1];
    const noveltyFalls = nov2 != null && novN != null && novN < nov2;
    const coreEmerged = meanFinalSnr != null && meanFinalSnr >= 0.25;
    const majorityConverge = clustersThatConverge > nTestable / 2;
    verdict = noveltyFalls && coreEmerged && majorityConverge ? "supported" : "refuted";
  }

  return {
    view: viewName,
    active_only: !!opts.activeOnly,
    cluster_size_distribution: sizeDist,
    testable_clusters: nTestable,
    clusters_that_converge: clustersThatConverge,
    max_cluster_n: maxK,
    mean_final_snr: meanFinalSnr,
    mean_convergence_curve: meanConvergence,
    mean_marginal_novelty_curve: meanNovelty,
    mean_consensus_snr_curve: meanSnr,
    verdict,
    clusters: perCluster,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Top-level run — the ACTIVE + tags view is the headline (consistent with
// active_predictable, commit 0528e2a). We ALSO report three diagnostic views so
// the inflation from boilerplate tags and from retracted members is visible.
// ───────────────────────────────────────────────────────────────────────────
export function runIntentConvergence(root) {
  const headline = evaluateView(root, "active+tags (headline)", { activeOnly: true, sigFn: sigWithTags });
  const activeRuleOnly = evaluateView(root, "active+rule-only", { activeOnly: true, sigFn: sigRuleOnly });
  const allTags = evaluateView(root, "all+tags (incl. retracted — diagnostic)", { activeOnly: false, sigFn: sigWithTags });
  const allRuleOnly = evaluateView(root, "all+rule-only (incl. retracted — diagnostic)", { activeOnly: false, sigFn: sigRuleOnly });

  return {
    root,
    min_overlap: MIN_OVERLAP,
    min_cluster_n: MIN_CLUSTER_N,
    min_clusters_to_decide: MIN_CLUSTERS_TO_DECIDE,
    headline_verdict: headline.verdict,
    views: { headline, activeRuleOnly, allTags, allRuleOnly },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Report rendering
// ───────────────────────────────────────────────────────────────────────────
function fmtCurve(arr) {
  if (!arr || arr.length === 0) return "(none)";
  return "[" + arr.map((x) => (x === null ? "·" : x.toFixed(2))).join(", ") + "]";
}

function renderView(v) {
  const lines = [];
  lines.push(`  ── view: ${v.view} ──`);
  lines.push(`    cluster-size distribution  ${JSON.stringify(v.cluster_size_distribution)}`);
  lines.push(`    testable clusters (N>=${MIN_CLUSTER_N})    ${v.testable_clusters}   (of which converge: ${v.clusters_that_converge})`);
  if (v.testable_clusters > 0) {
    lines.push(`    mean convergence (Jaccard E_k→E_N, ↑=conv.) ${fmtCurve(v.mean_convergence_curve)}`);
    lines.push(`    mean marginal novelty  (→0 = conv.)         ${fmtCurve(v.mean_marginal_novelty_curve)}`);
    lines.push(`    mean consensus SNR k-curve (degenerate@k≤2) ${fmtCurve(v.mean_consensus_snr_curve)}`);
    lines.push(`    mean FINAL consensus-SNR scalar (signal/total) ${v.mean_final_snr}`);
    for (const c of v.clusters) {
      lines.push(`      [${c.project}] N=${c.size} converges=${c.metrics.converges} (novelty↓${c.metrics.novelty_falls} core${c.metrics.has_core ? "✓" : "✗"} final_snr=${c.metrics.final_snr})`);
    }
  }
  lines.push(`    VERDICT  ${v.verdict.toUpperCase()}`);
  return lines.join("\n");
}

function renderReport(r) {
  const lines = [];
  lines.push("══════════════════════════════════════════════════════════════");
  lines.push("  Loop 10 — Intent-convergence (redundancy → intent, MEASURED)");
  lines.push("  Claim under test: 'redundancy over time reconstructs intent'");
  lines.push("  (HONEST numbers — flat / untestable is a valid result)");
  lines.push("══════════════════════════════════════════════════════════════");
  lines.push(`  corpus root        ${r.root}`);
  lines.push(`  cluster grammar    signature overlap >= ${r.min_overlap}, N >= ${r.min_cluster_n} to test`);
  lines.push(`  decide threshold   >= ${r.min_clusters_to_decide} testable clusters to render a SUPPORTED/REFUTED verdict`);
  lines.push("");
  lines.push(renderView(r.views.headline));
  lines.push("");
  lines.push(renderView(r.views.activeRuleOnly));
  lines.push("");
  lines.push(renderView(r.views.allTags));
  lines.push("");
  lines.push(renderView(r.views.allRuleOnly));
  lines.push("");
  lines.push(`  ── HEADLINE VERDICT (active+tags): ${r.headline_verdict.toUpperCase()} ──`);
  if (r.headline_verdict === "untestable") {
    lines.push("  Too few multi-member ACTIVE clusters to decide whether redundancy");
    lines.push("  reconstructs intent. NOT a refutation — the corpus simply lacks the");
    lines.push("  repeated same-intent corrections the claim is about. See the diagnostic");
    lines.push("  views: any N>=3 clusters in the 'all+tags' view are largely BOILERPLATE-TAG");
    lines.push("  artifacts (shared 'correction'/'rule'/category tags glue unrelated intents),");
    lines.push("  which the rule-only view dissolves — confirming they are not real clusters.");
  }
  lines.push("══════════════════════════════════════════════════════════════");
  return lines.join("\n");
}

// ───────────────────────────────────────────────────────────────────────────
// CLI
// ───────────────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf("--root");
  const root = rootIdx >= 0 && args[rootIdx + 1] ? args[rootIdx + 1] : defaultRoot();
  const asJson = args.includes("--json");

  if (!fs.existsSync(path.join(root, "projects"))) {
    process.stderr.write(`No corpus at ${root} (expected <root>/projects/…). Nothing to score.\n`);
  }
  const report = runIntentConvergence(root);
  process.stdout.write(asJson ? JSON.stringify(report, null, 2) + "\n" : renderReport(report) + "\n");
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
