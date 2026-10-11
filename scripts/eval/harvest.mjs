#!/usr/bin/env node
/**
 * harvest.mjs — CorrectionExport → CorrectionTransferItem (CTI) pipeline.
 *
 * Spec §4.2: the ONE ingestion path is exportCorrections() (fail-closed scrubbed).
 * Never glob raw JSON for scoring input. This module harvests a corpus into CTI
 * items for offline scoring by correction-transfer.mjs.
 *
 * ACCOUNTING CONTRACT (spec §2.2 — no silent denominator drift):
 *   Every record returned by the export lands in exactly one of:
 *     - a CTI with redaction_survived: true   (scoreable)
 *     - a CTI with redaction_survived: false  (counted in corpus + denominators,
 *       NEVER fired — §3.2 "honest null, never a free hit"; itemized in
 *       scoring_excluded[] with reason no_usable_leadin|thin_context)
 *     - count_rule_excluded[] (missing rule/date — not a CTI at all, §2.2)
 *   Invariant (asserted): records.length === items.length + count_rule_excluded.length
 *
 * Exports:
 *   harvestRecords(records)  → {items, countRuleExcluded, scoringExcluded, manifest}
 *   harvestCorpus(opts)      → same, fetching via exportCorrections()
 *   redactLeadIn, clusterSignature, sigOverlap, classId (shared with the scorer)
 *
 * Error paths traced:
 *   - exportCorrections() throws SecretScanError → re-throw (fail-closed, never partial)
 *   - record missing rule/date → count_rule_excluded (counted on disk, not a CTI)
 *   - lead-in empty after redaction → CTI flagged, scoring_excluded{no_usable_leadin}
 *   - lead-in < 6 tokens after redaction → CTI flagged, scoring_excluded{thin_context}
 *   - accounting invariant violation → throws (never silently drops a record)
 *
 * Zero Math.random. Node stdlib only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  exportCorrections,
} from "../../packages/core/dist/tools-logic/export-corrections.js";
import {
  scrubForExport,
} from "../../packages/core/dist/storage/content-guard.js";
import {
  tokenize,
  overlap,
} from "../../packages/core/dist/tools-logic/check-action.js";
import { canonicalJson, corpusManifest, redactHomePaths } from "./bench-artifact.mjs";

// ── Constants (mirror predict-loo.mjs) ────────────────────────────────────

const MIN_OVERLAP = 2;
const MIN_LEAD_IN_TOKENS = 6;
const NEG_PER_LEADIN = 5;

// ── Helpers mirrored from predict-loo.mjs ─────────────────────────────────
// Spec §8 item 2: reuse predict-loo's redactLeadIn/clusterSignature. These are
// re-implemented here with identical semantics (predict-loo verified
// byte-identical before/after) rather than factored into lib/ — factoring would
// require editing predict-loo.mjs, risking the byte-identical guarantee.

function tokenSet(s) {
  return tokenize(s || "");
}

/**
 * redactLeadIn(c) — strip the rule text from c.context.
 * Returns "" when nothing survives (no usable lead-in).
 * Logic is byte-identical to predict-loo.mjs's redactLeadIn.
 */
export function redactLeadIn(c) {
  const rule = (c.rule || "").trim();
  let ctx = (c.context || "").trim();
  if (!ctx) return "";

  // 1. Remove verbatim rule substring (case-insensitive)
  if (rule) {
    const idx = ctx.toLowerCase().indexOf(rule.toLowerCase());
    if (idx >= 0) ctx = (ctx.slice(0, idx) + " " + ctx.slice(idx + rule.length)).trim();
  }

  // 2. Drop sentences whose tokens are fully contained in rule's tokens
  const ruleTokens = tokenSet(rule);
  const kept = [];
  for (const sentence of ctx.split(/(?<=[.!?])\s+/)) {
    const st = tokenSet(sentence);
    if (st.size === 0) continue;
    let subset = true;
    for (const t of st) {
      if (!ruleTokens.has(t)) {
        subset = false;
        break;
      }
    }
    if (!subset) kept.push(sentence.trim());
  }
  return kept.join(" ").trim();
}

/**
 * clusterSignature(c) — tokenized rule + tags, recorded fields only.
 * Logic is byte-identical to predict-loo.mjs's clusterSignature.
 */
export function clusterSignature(c) {
  return tokenize(`${c.rule || ""} ${(c.tags || []).join(" ")}`);
}

/** sigOverlap(a, b) — count overlapping tokens between two token sets. */
export function sigOverlap(a, b) {
  return overlap(a, b).length;
}

// ── class_id derivation (spec §2.1) ──────────────────────────────────────

/**
 * classId(sig) — sha256(sorted clusterSignature tokens, joined by space)[:16]
 */
export function classId(sig) {
  const sorted = [...sig].sort().join(" ");
  return crypto.createHash("sha256").update(sorted, "utf-8").digest("hex").slice(0, 16);
}

/** itemId(item) — sha256(canonicalJson(item))[:16], computed on the final CTI shape. */
function itemId(item) {
  return crypto.createHash("sha256").update(canonicalJson(item), "utf-8").digest("hex").slice(0, 16);
}

// ── Negative lead-in selection ─────────────────────────────────────────────

/**
 * selectNegativeLeadIns(targetSig, targetId, allItems) → string[]
 * Zero-cluster-overlap unrelated lead-ins, deterministic stride sample.
 * Donor pool: every harvested CTI with a usable lead-in (retracted donors are
 * fine — a negative is just unrelated TEXT). Candidates iterate in corpus order,
 * which harvestRecords makes deterministic by sorting records by (project, id).
 */
function selectNegativeLeadIns(targetSig, targetId, allItems) {
  const candidates = [];
  for (const other of allItems) {
    if (other.source.correction_export?.id === targetId) continue;
    if (!other.redaction_survived || !other.lead_in) continue;
    if (sigOverlap(clusterSignature(other.canonical_correction), targetSig) >= 1) continue;
    candidates.push(other.lead_in);
  }
  if (candidates.length === 0) return [];
  const stride = Math.max(1, Math.floor(candidates.length / NEG_PER_LEADIN));
  const result = [];
  for (let i = 0, taken = 0; i < candidates.length && taken < NEG_PER_LEADIN; i += stride, taken++) {
    result.push(candidates[i]);
  }
  return result;
}

// ── Record → CTI mapping (spec §4.2) ──────────────────────────────────────

/**
 * mapRecord(rec) → {kind: "cti", cti, scoringExclusion|null}
 *               |  {kind: "count_rule_excluded", excluded}
 *
 * §2.2 count rule: a record COUNTS iff non-empty rule AND valid date. Failures
 * are count_rule_excluded (not CTIs). Counted records ALWAYS become CTIs; when
 * the lead-in dies (empty or <6 tokens after redaction) the CTI is flagged
 * redaction_survived:false and a scoringExclusion names the reason — the record
 * still counts in corpus_size and the predictability denominators (§3.2).
 */
function mapRecord(rec) {
  const recId = typeof rec.id === "string" && rec.id.length > 0 ? rec.id : null;
  const hasRule = typeof rec.rule === "string" && rec.rule.trim().length > 0;
  const hasDate =
    typeof rec.date === "string" &&
    rec.date.trim().length > 0 &&
    !Number.isNaN(new Date(rec.date.trim()).getTime());

  if (!hasRule || !hasDate) {
    const reason = !hasRule ? "missing_rule" : "missing_date";
    return {
      kind: "count_rule_excluded",
      excluded: {
        id: recId ?? "_no_id",
        project: rec.project ?? "_unknown",
        reason,
        disposition: "dropped_from_corpus",
      },
    };
  }

  // §3.3: zero the four counter fields (post-t leak fix)
  const exportRecord = {
    schema_version: rec.schema_version,
    id: rec.id,
    date: rec.date,
    project: rec.project,
    severity: rec.severity,
    kind: rec.kind,
    rule: rec.rule,
    context: rec.context,
    tags: rec.tags ?? [],
    weight: rec.weight ?? null,
    confidence_basis: rec.confidence_basis,
    active: rec.active,
    authoritative: rec.authoritative ?? null,
    retrieved_count: 0,
    heeded_count: 0,
    recurrence_count: 0,
    last_outcome: null,
  };

  const sig = clusterSignature(rec);
  const leadIn = redactLeadIn(rec);

  let exclusionReason = null;
  if (leadIn.length === 0) {
    exclusionReason = "no_usable_leadin";
  } else if (tokenize(leadIn).size < MIN_LEAD_IN_TOKENS) {
    exclusionReason = "thin_context";
  }
  const survived = exclusionReason === null;

  const cti = {
    schema_version: "ar-bench-item/v1",
    item_id: null, // filled below
    class_id: classId(sig),
    source: {
      kind: "harvested",
      correction_export: exportRecord,
    },
    canonical_correction: {
      rule: rec.rule,
      severity: rec.severity,
      tags: rec.tags ?? [],
      date: rec.date,
    },
    lead_in: survived ? leadIn : "",
    redaction_survived: survived,
    exclusion_reason: exclusionReason, // null when scoreable
    priors_active_at_t: null, // v1 approximation — needs corrections-export/v2
    negative_lead_ins: [], // filled by harvestRecords after all CTIs exist
    active_approximation: "export-time",
    _counters_zeroed: true,
  };
  cti.item_id = itemId(cti);

  const scoringExclusion = survived
    ? null
    : {
        id: rec.id,
        project: rec.project ?? "_unknown",
        reason: exclusionReason,
        disposition: "counted_not_fired", // stays in per_item + denominators + prior universe
      };

  return { kind: "cti", cti, scoringExclusion };
}

// ── harvestRecords (pure — records in, CTIs + accounting out) ──────────────

/**
 * harvestRecords(records) → {items, countRuleExcluded, scoringExcluded, manifest}
 *
 * Pure mapping over export-shaped records (no IO). Fixture mode and real mode
 * both funnel through here so accounting is identical.
 *
 * Determinism: records are sorted by (project, id) BEFORE mapping so negative
 * stride-sampling and item order are stable across machines/filesystems.
 */
export function harvestRecords(records) {
  const sorted = [...records].sort((a, b) => {
    const proj = (a.project ?? "").localeCompare(b.project ?? "");
    if (proj !== 0) return proj;
    return (a.id ?? "").localeCompare(b.id ?? "");
  });

  const manifest = corpusManifest(sorted);

  const items = [];
  const countRuleExcluded = [];
  const scoringExcluded = [];

  for (const rec of sorted) {
    const mapped = mapRecord(rec);
    if (mapped.kind === "count_rule_excluded") {
      countRuleExcluded.push(mapped.excluded);
    } else {
      items.push(mapped.cti);
      if (mapped.scoringExclusion) scoringExcluded.push(mapped.scoringExclusion);
    }
  }

  // §2.2 invariant — no record may vanish silently.
  if (items.length + countRuleExcluded.length !== sorted.length) {
    throw new Error(
      `harvest accounting violation: ${sorted.length} records → ` +
      `${items.length} CTIs + ${countRuleExcluded.length} count-rule excluded ` +
      `(${sorted.length - items.length - countRuleExcluded.length} unaccounted)`,
    );
  }

  // Second pass: negative lead-ins for scoreable items (donor pool = all CTIs).
  for (const item of items) {
    if (!item.redaction_survived) continue;
    const sig = clusterSignature(item.canonical_correction);
    item.negative_lead_ins = selectNegativeLeadIns(
      sig,
      item.source.correction_export?.id,
      items,
    );
  }

  return { items, countRuleExcluded, scoringExcluded, manifest };
}

// ── harvestCorpus (exportCorrections + harvestRecords) ─────────────────────

/**
 * harvestCorpus(opts) → {items, countRuleExcluded, scoringExcluded, manifest}
 *
 * @param {{includeRetracted?: boolean, since?: string, outDir?: string}} [opts]
 *   outDir: if set, write scoreable CTIs to <outDir>/<item_id>.json and ALL
 *   exclusions (count-rule + scoring) to <outDir>/_excluded.jsonl with reasons.
 * @throws {SecretScanError} if exportCorrections() hits a secret (fail-closed)
 */
export async function harvestCorpus(opts = {}) {
  const { includeRetracted = false, since, outDir } = opts;

  // The ONLY ingestion path (spec §4.1). Throws SecretScanError on any secret.
  const records = exportCorrections({ includeRetracted, since });

  const result = harvestRecords(records);

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    for (const item of result.items) {
      const outPath = path.join(outDir, `${item.item_id}.json`);
      // Security review 1a: CTI files are an egress sink (lead_in + rule + the
      // full correction_export). Scrub the SERIALIZED CTI fail-closed — a
      // SecretScanError aborts the whole write loop (propagates, no swallowing)
      // — and apply the same home-path redaction the baseline path gets.
      // (Records already passed exportCorrections' per-field scrub; this is the
      // whole-document post-condition, same defense-in-depth as writeBaseline.)
      const ctiJson = scrubForExport(redactHomePaths(JSON.stringify(item, null, 2)));
      fs.writeFileSync(outPath, ctiJson, { encoding: "utf-8", mode: 0o600 });
    }
    // _excluded.jsonl — EVERY exclusion (both stages) with reason + disposition.
    const allExcluded = [...result.countRuleExcluded, ...result.scoringExcluded];
    const excludedPath = path.join(outDir, "_excluded.jsonl");
    const lines = allExcluded.map((e) => JSON.stringify(e)).join("\n");
    fs.writeFileSync(excludedPath, lines.length > 0 ? lines + "\n" : "", {
      encoding: "utf-8",
      mode: 0o600,
    });
    process.stderr.write(
      `harvest: wrote ${result.items.length} CTIs + ${allExcluded.length} exclusion lines to ${outDir}\n`,
    );
  }

  return result;
}

// ── CLI ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const outDir = outIdx >= 0 ? args[outIdx + 1] : null;
  const json = args.includes("--json");
  const includeRetracted = args.includes("--include-retracted");

  try {
    const { items, countRuleExcluded, scoringExcluded, manifest } = await harvestCorpus({
      includeRetracted,
      outDir: outDir ?? undefined,
    });

    const scoreable = items.filter((i) => i.redaction_survived).length;
    const summary = {
      n_on_disk: manifest.n_on_disk,
      n_counted: manifest.n_counted,
      n_ctis: items.length,
      n_scoreable: scoreable,
      count_rule_excluded: countRuleExcluded,
      scoring_excluded: scoringExcluded,
      tree_hash: manifest.tree_hash,
    };

    if (json) {
      process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    } else {
      process.stdout.write(
        `harvest: n_on_disk=${summary.n_on_disk} n_counted=${summary.n_counted} ` +
        `ctis=${summary.n_ctis} scoreable=${summary.n_scoreable} ` +
        `tree_hash=${summary.tree_hash.slice(0, 16)}…\n`,
      );
      for (const e of countRuleExcluded) {
        process.stdout.write(`  count-rule excluded: ${e.id}  reason=${e.reason}\n`);
      }
      for (const e of scoringExcluded) {
        process.stdout.write(`  counted-not-fired:   ${e.id}  reason=${e.reason}\n`);
      }
    }
  } catch (e) {
    process.stderr.write(`harvest FATAL: ${e.message}\n`);
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) main();
