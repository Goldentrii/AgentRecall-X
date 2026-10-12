#!/usr/bin/env node
/**
 * anonymize-baseline.mjs — pure TRANSFORM for committed baseline artifacts.
 *
 * Maps real project slugs to stable anonymized aliases (proj-01..proj-NN).
 *
 * Mapping contract:
 *   - Aliases derived from lexicographic sort of ALL slugs seen across ALL
 *     targeted artifacts, so the mapping is STABLE even when run on a single
 *     file.  The global slug table is the union of slugs from rmr-baseline-*
 *     and correction-transfer-real-* (not the fixture baseline, which already
 *     uses fictional projects).
 *   - Mapping is NOT embedded in the output (privacy requirement).
 *   - Every numeric value is preserved verbatim — only slug strings change.
 *   - For historical snapshots (rmr-baseline-2026-07-02.json) the transform
 *     does NOT re-run the report against the current corpus; it is a pure
 *     string substitution.  A _note field is added to document this.
 *   - corpus_hash in correction-transfer artifacts covers the manifest sha256s,
 *     which are per-record canonical-JSON hashes that do NOT embed project slugs
 *     (the project field is stored separately in the manifest wrapper, not inside
 *     the hashed record).  So the corpus_hash is UNCHANGED by slug anonymization.
 *
 * Usage:
 *   node scripts/eval/anonymize-baseline.mjs [--dry-run] [file1.json ...]
 *
 *   Without file arguments: transforms the three real-corpus baseline files in
 *   scripts/eval/baselines/ and moves originals to baselines/local/.
 *
 *   --dry-run: print the mapping and the first diff line, write nothing.
 *   --print-mapping: print the slug→alias table to stdout (for auditing).
 *
 * Self-test:
 *   node scripts/eval/anonymize-baseline.mjs --self-test
 *
 * Error paths:
 *   - Source file not found → LOUD FAIL, skip that file.
 *   - Target file already exists in local/ → LOUD FAIL, do not overwrite.
 *   - A slug appears in the global table but is not present in a given
 *     artifact — fine, replacement is a no-op for that artifact.
 *   - Zero Math.random (pure deterministic transform).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import * as crypto from "node:crypto";

// ── Canonical slug table (union of all real-corpus artifacts) ─────────────────
//
// This is the SINGLE authoritative mapping.  To keep the alias stable across
// future runs, the table must be the superset of slugs from all committed
// real-corpus artifacts (rmr and correction-transfer).  Add new slugs at the
// end only if they appear in a new artifact — never reorder.
//
// HOW THIS WAS DERIVED:
//   python3 -c "import json; ..."  against the three target baselines; the
//   full union was sorted lexicographically.  The list below is that sort.
//
// If you add a new artifact with new slugs, append them here AND re-run
// anonymize-baseline.mjs --print-mapping to audit the mapping before pushing.
//
// IMPORTANT: this list must be kept sorted (Unicode code-point order) so that
// the alias numbers are predictable.

export const GLOBAL_SLUG_TABLE = [
  "APQC-Process Automation",   // proj-01
  "APQC-Process-Automation",   // proj-02
  "AgentRecall",               // proj-03
  "aam",                       // proj-04
  "agentrecall",               // proj-05
  "apqc",                      // proj-06
  "claude",                    // proj-07
  "d234ebb2-f31b-4d40-a601-7de39085fc4e", // proj-08
  "default",                   // proj-09
  "eu-ai-gateway",             // proj-10
  "mcp",                       // proj-11
  "novada-intel",              // proj-12
  "novada-mcp",                // proj-13
  "novada-proxy",              // proj-14
  "novada-proxy-extension",    // proj-15
  "novada-tech-group",         // proj-16
  "plywood",                   // proj-17
  "prismma-desktop",           // proj-18
  "prismma-gateway",           // proj-19
  "prismma-web",               // proj-20
  "proxy4agent",               // proj-21
  "skaylink-aws",              // proj-22
  "tongwu",                    // proj-23
  "x-omnier",                  // proj-24
];

// Validate: must be sorted by Unicode code-point order (same as Python sorted()).
// We use < operator (string comparison) not localeCompare because localeCompare is
// locale-aware and would reject our uppercase-first sort.
for (let i = 1; i < GLOBAL_SLUG_TABLE.length; i++) {
  if (GLOBAL_SLUG_TABLE[i] < GLOBAL_SLUG_TABLE[i - 1]) {
    throw new Error(
      `anonymize-baseline: GLOBAL_SLUG_TABLE is not sorted at index ${i}: ` +
      `"${GLOBAL_SLUG_TABLE[i - 1]}" > "${GLOBAL_SLUG_TABLE[i]}"`,
    );
  }
}

// Build alias map: slug → "proj-NN"
function buildAliasMap(slugTable) {
  return new Map(
    slugTable.map((s, i) => [s, `proj-${String(i + 1).padStart(2, "0")}`]),
  );
}

export const ALIAS_MAP = buildAliasMap(GLOBAL_SLUG_TABLE);

// ── Core transform ────────────────────────────────────────────────────────────

/**
 * anonymizeSlugs(json, aliasMap) → transformed JSON string.
 *
 * Performs longest-first quoted-string replacement:
 *   "novada-proxy-extension" → "proj-15"   (before "novada-proxy")
 *   "novada-proxy"           → "proj-14"
 *
 * Only replaces exact quoted strings ("slug") so partial-match false positives
 * (e.g. a word in a prose note containing the slug) are also replaced — this
 * is intentional: any slug occurrence in a value field must be anonymized.
 *
 * Numbers, booleans, null — untouched.
 * corpus_hash — untouched (hashes are of record content, not project wrappers).
 *
 * @param {string} json — serialized JSON (may be pretty-printed)
 * @param {Map<string,string>} aliasMap — slug → alias
 * @returns {string} transformed JSON
 */
export function anonymizeSlugs(json, aliasMap) {
  // Sort slugs longest-first to avoid prefix corruption.
  const byLength = [...aliasMap.keys()].sort((a, b) => b.length - a.length);
  let out = json;
  for (const slug of byLength) {
    const alias = aliasMap.get(slug);
    // Match the slug as a quoted JSON string value or key.
    // Escape all regex metacharacters in the slug.
    const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`"${esc}"`, "g"), `"${alias}"`);
  }
  return out;
}

/**
 * transformFile(srcPath, opts) — anonymize a single baseline JSON file.
 *
 * Steps:
 *   1. Read + parse src.
 *   2. Inject _note into root (for historical snapshots).
 *   3. Serialize, then apply anonymizeSlugs.
 *   4. Verify the result parses and contains no remaining real slugs.
 *   5. Return {originalJson, transformedJson, slugsFound, aliasMap}.
 *
 * Does NOT write files — callers handle I/O so dry-run works.
 *
 * @param {string} srcPath
 * @param {{note?: string}} [opts]
 * @returns {{originalJson: string, transformedJson: string, slugsFound: string[]}}
 */
export function transformFile(srcPath, opts = {}) {
  const originalJson = fs.readFileSync(srcPath, "utf-8");
  const obj = JSON.parse(originalJson);

  // Inject _note at top level (documents transform provenance).
  const note =
    opts.note ??
    "transform-not-regenerated: slug anonymization applied as a pure string " +
    "transform to the original artifact; all numeric values are unchanged. " +
    `Source: ${path.basename(srcPath)}. Tool: scripts/eval/anonymize-baseline.mjs.`;
  obj._note = note;

  // Serialize with the same pretty-print as the original artifacts (2-space indent).
  const serialized = JSON.stringify(obj, null, 2);

  // Apply slug anonymization.
  const transformedJson = anonymizeSlugs(serialized, ALIAS_MAP);

  // Verify parse (never write invalid JSON).
  JSON.parse(transformedJson);

  // Audit: collect which slugs were actually replaced in this artifact.
  const slugsFound = [];
  for (const [slug, alias] of ALIAS_MAP) {
    const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`"${esc}"`).test(serialized)) {
      slugsFound.push(slug);
    }
    // Confirm replacement worked.
    if (new RegExp(`"${esc}"`).test(transformedJson)) {
      throw new Error(
        `anonymize-baseline: slug "${slug}" still present in output of ${srcPath}`,
      );
    }
  }

  return { originalJson, transformedJson, slugsFound };
}

// ── Target files ──────────────────────────────────────────────────────────────

const BASELINES_DIR = url.fileURLToPath(new url.URL("./baselines/", import.meta.url));
const LOCAL_DIR = path.join(BASELINES_DIR, "local");

const DEFAULT_TARGETS = [
  {
    src: path.join(BASELINES_DIR, "rmr-baseline-2026-07-02.json"),
    note:
      "transform-not-regenerated: this is a HISTORICAL snapshot (corpus as of 2026-07-02); " +
      "the current corpus has changed, so re-running the report would produce different " +
      "denominators and is unsafe. Slug anonymization was applied as a pure string transform; " +
      "all numeric values are unchanged. Tool: scripts/eval/anonymize-baseline.mjs.",
  },
  {
    src: path.join(BASELINES_DIR, "rmr-baseline-2026-07-03.json"),
    note:
      "transform-not-regenerated: this is a HISTORICAL snapshot (corpus as of 2026-07-03). " +
      "Slug anonymization applied as a pure string transform; all numeric values unchanged. " +
      "Tool: scripts/eval/anonymize-baseline.mjs.",
  },
  {
    src: path.join(BASELINES_DIR, "correction-transfer-real-2026-07-03.json"),
    note:
      "transform-not-regenerated: slug anonymization applied as a pure string transform " +
      "to preserve the historical corpus snapshot (2026-07-03). corpus_hash is unchanged " +
      "(hashes cover canonicalJson of correction records, not project-wrapper strings). " +
      "Tool: scripts/eval/anonymize-baseline.mjs.",
  },
];

// ── Self-test ─────────────────────────────────────────────────────────────────

function runSelfTest() {
  let passed = 0;
  let failed = 0;

  function assert(cond, label, detail = "") {
    if (cond) {
      process.stdout.write(`  PASS: ${label}\n`);
      passed++;
    } else {
      process.stdout.write(`  FAIL: ${label}${detail ? " — " + detail : ""}\n`);
      failed++;
    }
  }

  process.stdout.write("── GLOBAL_SLUG_TABLE sort order ──\n");
  {
    let sorted = true;
    for (let i = 1; i < GLOBAL_SLUG_TABLE.length; i++) {
      if (GLOBAL_SLUG_TABLE[i] < GLOBAL_SLUG_TABLE[i - 1]) {
        sorted = false;
        break;
      }
    }
    assert(sorted, "GLOBAL_SLUG_TABLE is sorted (Unicode code-point order)");
    assert(GLOBAL_SLUG_TABLE.length === 24, `table has 24 entries (got ${GLOBAL_SLUG_TABLE.length})`);
  }

  process.stdout.write("── alias map ──\n");
  {
    assert(ALIAS_MAP.get("novada-proxy-extension") === "proj-15", "novada-proxy-extension → proj-15");
    assert(ALIAS_MAP.get("novada-proxy") === "proj-14", "novada-proxy → proj-14");
    assert(ALIAS_MAP.get("AgentRecall") === "proj-03", "AgentRecall → proj-03");
    assert(ALIAS_MAP.get("skaylink-aws") === "proj-22", "skaylink-aws → proj-22");
    assert(ALIAS_MAP.get("tongwu") === "proj-23", "tongwu → proj-23");
    assert(ALIAS_MAP.get("prismma-gateway") === "proj-19", "prismma-gateway → proj-19");
  }

  process.stdout.write("── anonymizeSlugs replacement ──\n");
  {
    const input = JSON.stringify({
      project: "novada-proxy",
      other: "novada-proxy-extension",
      nested: { project: "skaylink-aws" },
      arr: [{ project: "tongwu" }],
    }, null, 2);
    const out = anonymizeSlugs(input, ALIAS_MAP);
    const parsed = JSON.parse(out);
    assert(parsed.project === "proj-14", "novada-proxy → proj-14");
    assert(parsed.other === "proj-15", "novada-proxy-extension → proj-15 (prefix not corrupted)");
    assert(parsed.nested.project === "proj-22", "nested skaylink-aws → proj-22");
    assert(parsed.arr[0].project === "proj-23", "array tongwu → proj-23");
    // Confirm original slugs are gone
    assert(!/"novada-proxy"/.test(out), "novada-proxy removed");
    assert(!/"novada-proxy-extension"/.test(out), "novada-proxy-extension removed");
  }

  process.stdout.write("── longest-first ordering (prefix safety) ──\n");
  {
    // novada-proxy-extension must be replaced BEFORE novada-proxy
    const input = `{"a":"novada-proxy-extension","b":"novada-proxy"}`;
    const out = anonymizeSlugs(input, ALIAS_MAP);
    const parsed = JSON.parse(out);
    assert(parsed.a === "proj-15", "novada-proxy-extension gets proj-15, not corrupted by proj-14");
    assert(parsed.b === "proj-14", "novada-proxy gets proj-14");
  }

  process.stdout.write("── no-op for non-slug strings ──\n");
  {
    const input = `{"corpus_hash":"abc123def456","n_total":42,"note":"some text"}`;
    const out = anonymizeSlugs(input, ALIAS_MAP);
    assert(out === input, "hash and numeric fields untouched");
  }

  process.stdout.write("── APQC space-variant ──\n");
  {
    // Both "APQC-Process Automation" (with space) and "APQC-Process-Automation" (with dash) are mapped
    const input = `{"a":"APQC-Process Automation","b":"APQC-Process-Automation"}`;
    const out = anonymizeSlugs(input, ALIAS_MAP);
    const parsed = JSON.parse(out);
    assert(parsed.a === "proj-01", "APQC-Process Automation → proj-01");
    assert(parsed.b === "proj-02", "APQC-Process-Automation → proj-02");
  }

  process.stdout.write("── fixture baseline is clean (no real slugs) ──\n");
  {
    const fixturePath = path.join(BASELINES_DIR, "correction-transfer-fixture-baseline.json");
    if (fs.existsSync(fixturePath)) {
      const content = fs.readFileSync(fixturePath, "utf-8");
      let hasReal = false;
      for (const slug of GLOBAL_SLUG_TABLE) {
        const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`"${esc}"`).test(content)) {
          hasReal = true;
          process.stdout.write(`    real slug found in fixture: "${slug}"\n`);
        }
      }
      assert(!hasReal, "fixture baseline contains no real slugs from GLOBAL_SLUG_TABLE");
    } else {
      process.stdout.write("  SKIP: fixture baseline not found\n");
    }
  }

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const args = process.argv.slice(2);

  if (args.includes("--self-test")) {
    runSelfTest();
    process.exit(0);
  }

  if (args.includes("--print-mapping")) {
    for (const [slug, alias] of ALIAS_MAP) {
      process.stdout.write(`${alias}\t${slug}\n`);
    }
    process.exit(0);
  }

  const dryRun = args.includes("--dry-run");
  const fileArgs = args.filter((a) => !a.startsWith("--"));

  const targets = fileArgs.length > 0
    ? fileArgs.map((f) => ({ src: path.resolve(f) }))
    : DEFAULT_TARGETS;

  if (dryRun) {
    process.stdout.write("DRY RUN — no files will be written.\n\n");
  }

  // Ensure local/ directory exists
  if (!dryRun) {
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
  }

  let allOk = true;

  for (const target of targets) {
    const { src, note } = target;
    const basename = path.basename(src);
    const localDst = path.join(LOCAL_DIR, basename);

    process.stdout.write(`\n=== ${basename} ===\n`);

    if (!fs.existsSync(src)) {
      process.stderr.write(`  ERROR: source not found: ${src}\n`);
      allOk = false;
      continue;
    }

    // Safety: do not overwrite an existing local/ backup
    if (!dryRun && fs.existsSync(localDst)) {
      process.stderr.write(
        `  ERROR: local backup already exists: ${localDst}\n` +
        `  Delete it manually if you want to re-run the transform.\n`,
      );
      allOk = false;
      continue;
    }

    let result;
    try {
      result = transformFile(src, { note });
    } catch (e) {
      process.stderr.write(`  ERROR during transform: ${e.message}\n`);
      allOk = false;
      continue;
    }

    const { originalJson, transformedJson, slugsFound } = result;

    process.stdout.write(`  Slugs found and replaced (${slugsFound.length}):\n`);
    for (const s of slugsFound) {
      process.stdout.write(`    "${s}" → "${ALIAS_MAP.get(s)}"\n`);
    }

    if (dryRun) {
      // Print first changed line for auditing
      const origLines = originalJson.split("\n");
      const newLines = transformedJson.split("\n");
      let shown = 0;
      for (let i = 0; i < Math.max(origLines.length, newLines.length); i++) {
        if (origLines[i] !== newLines[i] && shown < 5) {
          process.stdout.write(
            `  line ${i + 1}:\n` +
            `    - ${origLines[i] ?? "(missing)"}\n` +
            `    + ${newLines[i] ?? "(missing)"}\n`,
          );
          shown++;
        }
      }
    } else {
      // 1. Copy original to local/
      fs.copyFileSync(src, localDst);
      process.stdout.write(`  Original preserved → ${localDst}\n`);

      // 2. Overwrite src with anonymized version
      fs.writeFileSync(src, transformedJson, { encoding: "utf-8", mode: 0o600 });
      process.stdout.write(`  Anonymized → ${src}\n`);
    }
  }

  if (!allOk) {
    process.stderr.write("\nSome files could not be transformed. See errors above.\n");
    process.exit(1);
  }

  if (!dryRun) {
    process.stdout.write("\nDone. Verify with: npm run bench -- --verify-baselines\n");
  }
}
