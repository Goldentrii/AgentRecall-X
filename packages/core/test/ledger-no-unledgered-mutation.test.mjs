// packages/core/test/ledger-no-unledgered-mutation.test.mjs — ledger spec SW-4 / D11.
// A new store mutation that is not recorded in the ledger fails CI:
//   1. every module in MUTATION_ALLOWLIST really calls appendLedgerEvent(
//   2. every src module that writes/moves/removes files is EITHER on the
//      allowlist OR on the DERIVED_EXEMPT list below (with the reason it is
//      not a ledgered target class). An unlisted writer is a class member nobody
//      decided about — add it to the allowlist (and wire it) or exempt it here.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const { MUTATION_ALLOWLIST } = await import("../dist/ledger/types.js");

/** Ledgered target classes (spec §8): journal/*.md, palace/**\/*.md, corrections, skills, insights-index.json. */
const SPEC_NAMES = [
  "journal-write", "journal-capture", "journal-archive", "palace-write", "knowledge-write",
  "skill-write", "session-end", "insights-index", "corrections", "unclaimed",
];

/** Modules that write files but whose targets are derived/ignored or outside the ledgered class. */
const DERIVED_EXEMPT = {
  // derived indexes / generated artifacts
  "helpers/journal-files": "index.md / _index.md / index.jsonl (derived journal indexes)",
  "helpers/handoff": "handoff.md (generated artifact, not in the ledgered target list)",
  "palace/index-manager": "palace-index.json (derived)",
  "palace/graph": "graph.json (derived)",
  "palace/log": "palace/log.md operation log (audit trail; verify must not treat it as content)",
  "retrieval/lexical-index": "index/ (derived retrieval index)",
  "embeddings/index-store": "index/ (derived embedding index)",
  "storage/recency-index": "recent-sessions.jsonl (derived)",
  "storage/store-manifest": "MANIFEST.md (generated store doc)",
  "storage/memory-protocol": "MEMORY-PROTOCOL.md (generated doc)",
  "tools-logic/association": "edges.json (derived association graph)",
  // infrastructure state
  "storage/filelock": "lock directories",
  "storage/fs-utils": "generic atomic-write helpers (callers are classified individually)",
  "storage/cwd-allowlist": "cwd-allowlist.json (derived/registry)",
  "storage/hook-health": "telemetry/hook-health (telemetry/)",
  "storage/lifecycle-telemetry": "telemetry/lifecycle.jsonl (telemetry/)",
  "storage/working-memory": "working-memory/ (scratch)",
  "storage/hygiene": "hygiene baseline (store doctor state)",
  "storage/capture-router": "capture dedup cache (derived)",
  "storage/consolidation-queue": "consolidation queue internals",
  "storage/ab-experiment": "A/B experiment rows (telemetry)",
  "storage/dream-yield": "dream yield records (dream internals)",
  "tools-logic/dream-admission": "dream admission ledger (dream internals; insights go through addIndexedInsight)",
  "tools-logic/safety-consolidation": ".consumed.json marker (consolidation internals)",
  "storage/behavior-policies": "palace/behavior-policies.json (json policy state, not a ledgered md/json class)",
  "storage/blind-spots-store": "personal/blind-spots.json (not in the ledgered target list)",
  "storage/pending": "_pending/ capture review queue (reserved _ namespace)",
  "helpers/alignment-patterns": "alignment-log.json (project-root json, not in the ledgered target list)",
  "tools-logic/journal-state": "journal/<date>.state.json (working state, not a *.md journal file)",
  "tools-logic/smart-recall": "feedback log (retrieval telemetry)",
  // outside the spec's ledgered list (candidates for a later spec revision)
  "palace/awareness": "global awareness.md / awareness-state.json (not in the ledgered target list)",
  "digest/store": "projects/<p>/digest/ (not in the ledgered target list)",
  "storage/archive-write": "journal/archive/raw/ transcript archive (below journal/*.md)",
  "storage/archive-prune": "journal/archive/raw/ retention pruning",
  "tools-logic/local-archive-backend": "exports/ (outside the store's ledgered classes)",
  "supabase/config": "cloud sync config",
  "supabase/sync": "cloud sync log",
};

const MUTATION_RE = /\b(?:writeFileSync|appendFileSync|renameSync|copyFileSync|unlinkSync|rmSync|writeTextAtomic|writeJsonAtomic|renameAtomic)\(/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = walk(SRC).map((f) => ({ r: path.relative(SRC, f).replaceAll("\\", "/").replace(/\.ts$/, ""), text: fs.readFileSync(f, "utf-8") }));
const mutates = new Map(files.map((f) => [f.r, MUTATION_RE.test(f.text)]));


describe("ledger: no unledgered mutation (D11)", () => {
  it("MUTATION_ALLOWLIST has >= 14 entries and covers every spec-named module", () => {
    assert.ok(MUTATION_ALLOWLIST.length >= 14, `only ${MUTATION_ALLOWLIST.length} entries`);
    assert.equal(new Set(MUTATION_ALLOWLIST).size, MUTATION_ALLOWLIST.length, "duplicate allowlist entries");
    for (const name of SPEC_NAMES) {
      assert.ok(MUTATION_ALLOWLIST.some((e) => e.endsWith(name)), `spec module missing from allowlist: ${name}`);
    }
  });

  it("every allowlisted module exists and calls appendLedgerEvent(", () => {
    for (const entry of MUTATION_ALLOWLIST) {
      const file = path.join(SRC, `${entry}.ts`);
      assert.ok(fs.existsSync(file), `allowlist entry does not resolve to a file: ${entry}`);
      assert.ok(fs.readFileSync(file, "utf-8").includes("appendLedgerEvent("), `${entry} never calls appendLedgerEvent(`);
    }
  });

  it("every module that mutates files is allowlisted or explicitly exempt (class closed)", () => {
    const allow = new Set(MUTATION_ALLOWLIST);
    const unclassified = [];
    for (const { r } of files) {
      if (r.startsWith("ledger/")) continue;
      if (!mutates.get(r)) continue;
      if (allow.has(r) || r in DERIVED_EXEMPT) continue;
      unclassified.push(r);
    }
    assert.deepEqual(
      unclassified, [],
      "these modules mutate files but are neither in MUTATION_ALLOWLIST (wire appendLedgerEvent) " +
      "nor in DERIVED_EXEMPT (derived / outside the ledgered classes): " + unclassified.join(", "),
    );
  });

  it("exempt entries are real, mutate files, and are not also allowlisted", () => {
    const allow = new Set(MUTATION_ALLOWLIST);
    for (const entry of Object.keys(DERIVED_EXEMPT)) {
      const file = path.join(SRC, `${entry}.ts`);
      assert.ok(fs.existsSync(file), `exempt entry does not resolve to a file: ${entry}`);
      assert.ok(mutates.get(entry), `stale exemption (no file mutation left): ${entry}`);
      assert.ok(!allow.has(entry), `${entry} is both allowlisted and exempt`);
    }
  });
});
