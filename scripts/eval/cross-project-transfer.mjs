#!/usr/bin/env node
/**
 * cross-project-transfer.mjs — Loop 11 FREESTYLE experiment (FINAL).
 *
 * THE QUESTION (the escape from Loop 10's within-project sparsity ceiling):
 *   Loop 10 proved within-project intent redundancy is too sparse to reconstruct
 *   intent (0 active N>=3 clusters). The within-project well is dry. So: does the
 *   user's CORRECTION-STYLE generalize ACROSS projects? When the user corrects in
 *   project B, has the rest of the corpus ALREADY seen that CLASS of correction in
 *   some OTHER project — making B's correction anticipatable "cold", zero-shot,
 *   before B has accumulated any history of its own?
 *
 * This is the only honest test of whether the GLOBAL blind-spots layer carries
 * real cross-project signal. A correction whose class is novel to the entire rest
 * of the corpus is UNANTICIPATABLE cross-project; one whose class already appeared
 * in another project is a transfer HIT.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * INTELLECTUAL HONESTY IS THE POINT (Loop 10's discipline, carried forward):
 *   - A LOW or UNTESTABLE cross-project hit rate is the EXPECTED, ACCEPTABLE,
 *     VALUABLE outcome. It BOUNDS how much the global layer can transfer. We do
 *     NOT tune, gate, or cherry-pick to look good.
 *   - If it comes back HIGH, the FIRST suspicion is the boilerplate-tag artifact
 *     (Loop 10's scar): every project shares 'correction'/'backend'/'deployment'/
 *     'frontend'/'api' tags, so a tags-inclusive signature glues unrelated intents
 *     across projects into spurious "same-class" transfers. We therefore report
 *     TWO views and the RULE-ONLY view is the real headline.
 *   - SYMMETRIC CAVEAT (the OTHER direction — do not read rule-only as a ceiling):
 *     this matcher is fuzzy-LEXICAL (tokenize/overlap, NO semantics — established
 *     in Loop 5 / scripts/eval/paraphrase-robustness.mjs). So a LOW rule-only hit
 *     rate means "no LEXICAL transfer", NOT "no SEMANTIC transfer". Two corrections
 *     with the same intent but disjoint vocabulary ("pin the lockfile version" vs
 *     "lock the dependency versions") score MISS though they are the same class —
 *     so rule-only may UNDERSTATE true cross-project semantic transfer. It is a
 *     LOWER bound; only a learned representation can tell "no transferable intent"
 *     apart from "transferable intent the words don't show".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * METHOD (read-only over ~/.agent-recall; leave-one-PROJECT-out):
 *
 *   Reuses the predict-loo / Loop-10 grammar EXACTLY so it is symmetric and
 *   comparable: tokenize/overlap from check-action.js, signature overlap >= 2 to
 *   judge "same class", ACTIVE-only headline (consistent with commit 0528e2a —
 *   deriveBlindSpots() drops active===false signals, so a class that only ever
 *   appears among retracted corrections can never live in the global blind-spot
 *   profile and must not count as transferable).
 *
 *   For each project B (the held-out project):
 *     1. HIDE all of B's corrections.
 *     2. Build the CROSS-PROJECT class profile from ALL OTHER projects' corrections
 *        — the set of class signatures that exist somewhere in the rest of the
 *        corpus. (Clustering by signature is implicit: a class = the signature of
 *        any other-project correction; "already seen elsewhere" = overlap >= 2 with
 *        at least one OTHER-project correction's signature.)
 *     3. For each held-out correction C in B:
 *          HIT  if C's class signature overlaps >= MIN_OVERLAP with >= 1 correction
 *               from >= 1 OTHER project (the class was already seen elsewhere →
 *               anticipatable cold / zero-shot).
 *          MISS if C's class is NOVEL to the whole rest of the corpus (no
 *               other-project correction overlaps it by >= MIN_OVERLAP).
 *
 *   We report the cross-project hit rate against BOTH denominators (to line up
 *   with the L3/L9 predict-loo recall denominators):
 *     - all predictable    = every held-out C that has usable signature tokens.
 *     - active_predictable  = held-out C's that are themselves ACTIVE (active!==false)
 *       AND match an ACTIVE other-project correction — the achievable ceiling the
 *       active-only global blind profile can actually represent.
 *
 *   TWO SIGNATURE VIEWS (the tag-artifact guard):
 *     - signature-with-tags : tokenize(rule + tags)   — the predict-loo grammar.
 *     - RULE-ONLY           : tokenize(rule)           — tags excluded. THE REAL
 *       HEADLINE. Tags can only ADD overlap, never remove it, so RULE-ONLY hits
 *       are a strict subset of with-tags hits; the gap is the boilerplate-tag
 *       inflation made visible.
 *
 * VERDICT (decided by COUNTS, never by wishful reading):
 *   - UNTESTABLE : fewer than MIN_HELDOUT_TO_DECIDE held-out testable corrections
 *     across the whole corpus — too few to say anything.
 *   - Otherwise  : report the MEASURED rule-only hit rate as the verdict
 *     ("measured: X% rule-only transfer"). High/low is described, not judged good.
 *
 * Usage:
 *   node scripts/eval/cross-project-transfer.mjs               # real ~/.agent-recall
 *   node scripts/eval/cross-project-transfer.mjs --root <dir>  # explicit corpus
 *   node scripts/eval/cross-project-transfer.mjs --json        # machine-readable
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

import { tokenize, overlap } from "../../packages/core/dist/tools-logic/check-action.js";

// ── Config — mirrors the predict-loo / Loop-10 cluster grammar ───────────────
const MIN_OVERLAP = 2; // signature overlap floor for "same class" (predict-loo.mjs)
const MIN_HELDOUT_TO_DECIDE = 10; // fewer testable held-out C's than this => UNTESTABLE

// ───────────────────────────────────────────────────────────────────────────
// Corpus loading (read-only; identical readers to predict-loo / intent-conv.)
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
      if (rec && rec.rule && rec.date) out.push({ ...rec, project });
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

/** Load every correction across the corpus, each tagged with its project. */
function loadCorpus(root) {
  const corpus = [];
  for (const project of listProjects(root)) {
    for (const c of readProjectCorrections(root, project)) corpus.push(c);
  }
  return corpus;
}

// ───────────────────────────────────────────────────────────────────────────
// Class signatures — two views, side by side for honesty.
//   sigWithTags = tokenize(rule + tags)  — predict-loo grammar (tag-inflatable).
//   sigRuleOnly = tokenize(rule)          — RULE-ONLY, the real headline.
// Tags can only ADD tokens to the with-tags signature, so a with-tags overlap is
// >= the rule-only overlap for the same pair: rule-only HITs ⊆ with-tags HITs.
// ───────────────────────────────────────────────────────────────────────────
export function sigWithTags(c) {
  return tokenize(`${c.rule || ""} ${(c.tags || []).join(" ")}`);
}
export function sigRuleOnly(c) {
  return tokenize(c.rule || "");
}
function sigOverlap(a, b) {
  return overlap(a, b).length;
}

// ───────────────────────────────────────────────────────────────────────────
// Leave-one-PROJECT-out cross-project transfer scorer for ONE signature view.
// ───────────────────────────────────────────────────────────────────────────
/**
 * @param {Array<object>} corpus  every correction, each carrying a `.project`.
 * @param {(c:object)=>Set<string>} sigFn  signature function (with-tags or rule-only).
 * @returns per-view counts: testable held-out C's, transfer HITs against both the
 *          all-predictable and active_predictable denominators, plus the verdict.
 *
 * A held-out C is "testable" when its signature has >= 1 content token (otherwise
 * the class is undefined — excluded from the denominator, never silently a miss).
 * HIT = C's class overlaps >= MIN_OVERLAP with >= 1 OTHER-project correction.
 */
export function scoreView(corpus, sigFn) {
  const projects = [...new Set(corpus.map((c) => c.project))];

  // Precompute signatures once.
  const sig = new Map();
  for (const c of corpus) sig.set(c, sigFn(c));

  let testable = 0; // held-out C's with a non-empty signature
  let hits = 0; // class already seen in >= 1 OTHER project (transfer-anticipatable)
  let misses = 0; // class novel to the whole rest of the corpus

  let activeTestable = 0; // ACTIVE held-out C's whose class could match an ACTIVE other-proj sibling
  let activeHits = 0; // of those, matched an ACTIVE other-project correction

  const byProject = {}; // project -> { testable, hits, active_testable, active_hits }
  const exemplars = []; // a few HIT examples for the report (rule-only honesty)

  const bump = (proj, field) => {
    byProject[proj] = byProject[proj] || {
      testable: 0,
      hits: 0,
      active_testable: 0,
      active_hits: 0,
    };
    byProject[proj][field] += 1;
  };

  for (const B of projects) {
    const heldOut = corpus.filter((c) => c.project === B);
    const others = corpus.filter((c) => c.project !== B);
    if (others.length === 0) continue; // single-project corpus: nothing to transfer FROM

    for (const C of heldOut) {
      const cSig = sig.get(C);
      if (cSig.size === 0) continue; // class undefined → not testable (excluded honestly)
      testable += 1;
      bump(B, "testable");

      // Did C's class already appear in ANY other project? (zero-shot anticipatable)
      let matchedOther; // first matching other-project correction (any active state)
      let matchedActiveOther; // first matching ACTIVE other-project correction
      for (const o of others) {
        if (sigOverlap(cSig, sig.get(o)) >= MIN_OVERLAP) {
          if (!matchedOther) matchedOther = o;
          if (o.active !== false && !matchedActiveOther) matchedActiveOther = o;
          if (matchedOther && matchedActiveOther) break;
        }
      }

      if (matchedOther) {
        hits += 1;
        bump(B, "hits");
        if (exemplars.length < 12) {
          exemplars.push({
            project: B,
            rule: (C.rule || "").replace(/\s+/g, " ").slice(0, 70),
            matched_project: matchedOther.project,
            matched_rule: (matchedOther.rule || "").replace(/\s+/g, " ").slice(0, 70),
            shared: overlap(cSig, sig.get(matchedOther)),
          });
        }
      } else {
        misses += 1;
      }

      // ACTIVE denominator (achievable ceiling, lines up with active_predictable in
      // predict-loo): C is itself ACTIVE and there exists an ACTIVE other-project
      // sibling the active-only global blind profile could actually represent.
      if (C.active !== false) {
        activeTestable += 1;
        bump(B, "active_testable");
        if (matchedActiveOther) {
          activeHits += 1;
          bump(B, "active_hits");
        }
      }
    }
  }

  const hitRate = testable > 0 ? hits / testable : null;
  const activeHitRate = activeTestable > 0 ? activeHits / activeTestable : null;

  return {
    projects: projects.length,
    testable_heldout: testable,
    hits,
    misses,
    hit_rate_all: hitRate, // HITs / all predictable (every testable held-out C)
    active_testable_heldout: activeTestable,
    active_hits: activeHits,
    hit_rate_active: activeHitRate, // HITs / active_predictable (achievable ceiling)
    by_project: byProject,
    exemplars,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Top-level run — ACTIVE corpus is the headline (consistent with 0528e2a). We
// score the ACTIVE corpus under BOTH views, and ALSO report a full-corpus
// (incl. retracted) diagnostic so the retracted-padding effect is visible.
// RULE-ONLY on the ACTIVE corpus is THE headline number.
// ───────────────────────────────────────────────────────────────────────────
export function runCrossProjectTransfer(root) {
  const full = loadCorpus(root);
  const active = full.filter((c) => c.active !== false);

  // Headline corpus = ACTIVE-only (the active-only global blind profile's domain).
  const ruleOnly = scoreView(active, sigRuleOnly); // THE HEADLINE
  const withTags = scoreView(active, sigWithTags); // tag-inflated comparison

  // Diagnostic: full corpus incl. retracted, both views (padding visibility).
  const ruleOnlyFull = scoreView(full, sigRuleOnly);
  const withTagsFull = scoreView(full, sigWithTags);

  // Verdict — by COUNTS. Untestable when too few held-out testables; otherwise
  // report the MEASURED rule-only rate (high/low described, never judged "good").
  const testable = ruleOnly.testable_heldout;
  let verdict;
  if (testable < MIN_HELDOUT_TO_DECIDE) {
    verdict = `untestable (only ${testable} held-out testable corrections < ${MIN_HELDOUT_TO_DECIDE})`;
  } else {
    const rr = (ruleOnly.hit_rate_all * 100).toFixed(1);
    const ra =
      ruleOnly.hit_rate_active != null ? (ruleOnly.hit_rate_active * 100).toFixed(1) : "n/a";
    const tr = (withTags.hit_rate_all * 100).toFixed(1);
    verdict =
      `measured: rule-only cross-project transfer = ${rr}% of all-predictable ` +
      `(${ra}% of active_predictable); with-tags = ${tr}% (tag-inflated). ` +
      `RULE-ONLY is the real headline.`;
  }

  return {
    root,
    min_overlap: MIN_OVERLAP,
    min_heldout_to_decide: MIN_HELDOUT_TO_DECIDE,
    corpus_total: full.length,
    corpus_active: active.length,
    headline_rule_only_hit_rate_all: ruleOnly.hit_rate_all,
    headline_rule_only_hit_rate_active: ruleOnly.hit_rate_active,
    with_tags_hit_rate_all: withTags.hit_rate_all,
    with_tags_hit_rate_active: withTags.hit_rate_active,
    verdict,
    views: {
      active_rule_only: ruleOnly, // HEADLINE
      active_with_tags: withTags,
      full_rule_only: ruleOnlyFull, // diagnostic
      full_with_tags: withTagsFull, // diagnostic
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Report rendering
// ───────────────────────────────────────────────────────────────────────────
function fmtPct(x) {
  return x === null ? "n/a (0 in denominator)" : `${(x * 100).toFixed(1)}%`;
}

function renderView(name, v, headline = false) {
  const lines = [];
  lines.push(`  ── view: ${name}${headline ? "   ★ HEADLINE" : ""} ──`);
  lines.push(`    projects (transfer-from set per held-out) ${v.projects}`);
  lines.push(`    testable held-out corrections             ${v.testable_heldout}`);
  lines.push(
    `    HIT  (class seen in >=1 OTHER project)    ${v.hits}     (anticipatable cold / zero-shot)`,
  );
  lines.push(`    MISS (class novel to rest of corpus)      ${v.misses}`);
  lines.push(
    `    HIT-RATE  hits / all-predictable          ${fmtPct(v.hit_rate_all)}  (${v.hits}/${v.testable_heldout})`,
  );
  lines.push(
    `    HIT-RATE* hits / active_predictable       ${fmtPct(v.hit_rate_active)}  (${v.active_hits}/${v.active_testable_heldout})  [achievable ceiling]`,
  );
  if (headline && v.exemplars.length) {
    lines.push(`    ── transfer exemplars (rule-only class overlap) ──`);
    for (const e of v.exemplars.slice(0, 6)) {
      lines.push(`      [${e.project}] "${e.rule}"`);
      lines.push(`         ↳ seen in [${e.matched_project}] "${e.matched_rule}"`);
      lines.push(`           shared class tokens: {${e.shared.join(", ")}}`);
    }
  }
  return lines.join("\n");
}

function renderReport(r) {
  const lines = [];
  lines.push("══════════════════════════════════════════════════════════════");
  lines.push("  Loop 11 — Zero-shot CROSS-PROJECT transfer (leave-one-project-out)");
  lines.push("  Q: does the user's correction-STYLE generalize ACROSS projects?");
  lines.push("  (HONEST numbers — a LOW / UNTESTABLE rate is a valid result that");
  lines.push("   BOUNDS cross-project transfer; RULE-ONLY is the real headline)");
  lines.push("══════════════════════════════════════════════════════════════");
  lines.push(`  corpus root        ${r.root}`);
  lines.push(`  class grammar      signature overlap >= ${r.min_overlap} (predict-loo / Loop-10)`);
  lines.push(`  corpus             ${r.corpus_total} total, ${r.corpus_active} ACTIVE (headline corpus)`);
  lines.push(`  decide threshold   >= ${r.min_heldout_to_decide} held-out testables to render a measured rate`);
  lines.push("");
  lines.push("  ╭─ ACTIVE corpus (headline domain, consistent with commit 0528e2a) ─╮");
  lines.push(renderView("active + RULE-ONLY", r.views.active_rule_only, true));
  lines.push("");
  lines.push(renderView("active + with-tags (tag-inflated)", r.views.active_with_tags));
  lines.push("");
  lines.push("  ╭─ FULL corpus incl. retracted (diagnostic — padding visibility) ─╮");
  lines.push(renderView("full + RULE-ONLY", r.views.full_rule_only));
  lines.push("");
  lines.push(renderView("full + with-tags", r.views.full_with_tags));
  lines.push("");
  lines.push("  ── HEADLINE (active + RULE-ONLY) ──");
  lines.push(`    rule-only hit-rate (all-predictable)    ${fmtPct(r.headline_rule_only_hit_rate_all)}`);
  lines.push(`    rule-only hit-rate (active_predictable) ${fmtPct(r.headline_rule_only_hit_rate_active)}`);
  lines.push(`    with-tags hit-rate (all-predictable)    ${fmtPct(r.with_tags_hit_rate_all)}  ← tag-inflated`);
  lines.push("");
  lines.push(`  VERDICT  ${r.verdict}`);
  lines.push("");
  lines.push("  Reading: HIT means B's correction-class had ALREADY been corrected in");
  lines.push("  another project — so the GLOBAL blind-spot layer could have warned B cold.");
  lines.push("  The with-tags ↔ rule-only GAP is boilerplate-tag inflation (every project");
  lines.push("  shares 'correction'/'backend'/'deployment'/'frontend'/'api' tags), which the");
  lines.push("  rule-only view strips. Trust rule-only.");
  lines.push("  BUT rule-only is a LOWER bound, not a ceiling: the matcher is fuzzy-LEXICAL,");
  lines.push("  so a low rate = 'no LEXICAL transfer', NOT 'no transfer'. Same-intent");
  lines.push("  corrections worded differently score MISS and are invisible here — true");
  lines.push("  semantic transfer may be higher (needs a learned representation to see).");
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
  const report = runCrossProjectTransfer(root);
  process.stdout.write(asJson ? JSON.stringify(report, null, 2) + "\n" : renderReport(report) + "\n");
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
