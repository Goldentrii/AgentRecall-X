// scripts/eval/heed-rate/heed-rate.test.mjs
//
// Tests for the S0 heed-rate eval MECHANICS (probe schema validation,
// predicate evaluation, arm construction, retrospective classification and
// aggregation) — deliberately NOT for model behavior; the live arms are
// measurement, not a gate.
//
// Run: node --test scripts/eval/heed-rate/

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateProbesFixture,
  validatePredicate,
  evaluatePredicate,
  buildArms,
  renderMemoryBlock,
  classifyEvent,
  classifyCorrection,
  aggregate,
  P0_RULE_RENDER_SLICE,
} from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function minimalProbe(overrides = {}) {
  return {
    id: "hp99-test",
    rule_class: "test-class",
    provenance: "synthetic — test fixture",
    memory_rule: "Always answer with FOO.",
    task: "Say something.\n\nRespond with exactly one line:\nANSWER: <word>",
    predicate: { must_match: ["^ANSWER:\\s*FOO\\s*$"], flags: "m" },
    no_memory_expectation: "test",
    ...overrides,
  };
}

function minimalFixture(overrides = {}) {
  return {
    version: 1,
    model: "claude-haiku-4-5-20251001",
    max_requests: 30,
    probes: [minimalProbe()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Probe schema validation
// ---------------------------------------------------------------------------

test("shipped probes.json is valid, has 10 probes, and fits the request cap", () => {
  const fixture = JSON.parse(readFileSync(path.join(HERE, "probes.json"), "utf8"));
  const v = validateProbesFixture(fixture);
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
  assert.equal(fixture.probes.length, 10);
  assert.ok(fixture.probes.length * 2 <= fixture.max_requests);
  // Committed fixture must declare every rule synthetic (no private rule text).
  for (const p of fixture.probes) assert.match(p.provenance, /synthetic/i);
  // Rules must survive the product's 80-char render slice un-truncated.
  for (const p of fixture.probes) assert.ok(p.memory_rule.length <= P0_RULE_RENDER_SLICE, `${p.id} rule too long`);
});

test("validation rejects duplicate ids", () => {
  const v = validateProbesFixture(minimalFixture({ probes: [minimalProbe(), minimalProbe()] }));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("duplicate id")));
});

test("validation rejects a rule longer than the product render slice", () => {
  const v = validateProbesFixture(minimalFixture({ probes: [minimalProbe({ memory_rule: "x".repeat(P0_RULE_RENDER_SLICE + 1) })] }));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("slices at")));
});

test("validation rejects non-synthetic provenance (committed-fixture privacy guard)", () => {
  const v = validateProbesFixture(minimalFixture({ probes: [minimalProbe({ provenance: "copied from the owner store" })] }));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("synthetic")));
});

test("validation rejects an empty predicate and a non-compiling regex", () => {
  assert.ok(validatePredicate({}).some((e) => e.includes("at least one")));
  assert.ok(validatePredicate({ must_match: ["("] }).some((e) => e.includes("does not compile")));
  assert.ok(validatePredicate({ must_match: ["ok"], flags: "gx" }).some((e) => e.includes("flags")));
  assert.ok(validatePredicate({ must_match: ["ok"], bogus: 1 }).some((e) => e.includes('unknown key "bogus"')));
  assert.deepEqual(validatePredicate({ must_match: ["^A$"], must_not_match: ["B"], flags: "im" }), []);
});

test("validation rejects planned requests exceeding max_requests", () => {
  const probes = Array.from({ length: 3 }, (_, i) => minimalProbe({ id: `hp${i}-x` }));
  const v = validateProbesFixture(minimalFixture({ probes, max_requests: 5 }));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("exceed max_requests")));
});

// ---------------------------------------------------------------------------
// Predicate evaluation (IFEval-style, no judge)
// ---------------------------------------------------------------------------

test("predicate: must_match pass/fail with multiline anchors", () => {
  const pred = { must_match: ["^VERSION:\\s*2\\.3\\.8\\s*$"], flags: "m" };
  assert.equal(evaluatePredicate(pred, "Some preamble\nVERSION: 2.3.8").pass, true);
  const fail = evaluatePredicate(pred, "VERSION: 2.4.0");
  assert.equal(fail.pass, false);
  assert.equal(fail.failures[0].kind, "must_match");
});

test("predicate: must_not_match vetoes", () => {
  const pred = { must_match: ["^DECISION:"], must_not_match: ["^DECISION:\\s*push-now\\s*$"], flags: "im" };
  assert.equal(evaluatePredicate(pred, "DECISION: ask-owner").pass, true);
  const fail = evaluatePredicate(pred, "decision: push-now");
  assert.equal(fail.pass, false);
  assert.equal(fail.failures[0].kind, "must_not_match");
});

test("predicate: CJK class matches Han characters and ASCII-only veto works", () => {
  const pred = { must_match: ["^TOPIC:.*[\\u4e00-\\u9fff]"], must_not_match: ["^TOPIC:[\\x20-\\x7E]*$"], flags: "m" };
  assert.equal(evaluatePredicate(pred, "TOPIC: 修复登录超时\nTOPIC: 新增导出").pass, true);
  assert.equal(evaluatePredicate(pred, "TOPIC: fix login timeout").pass, false);
  // Mixed response: one CJK line satisfies must_match, but a pure-ASCII TOPIC
  // line still trips the veto — all lines must comply.
  assert.equal(evaluatePredicate(pred, "TOPIC: 修复登录超时\nTOPIC: add CSV export").pass, false);
});

test("predicate: non-string response never passes a must_match", () => {
  assert.equal(evaluatePredicate({ must_match: ["x"] }, undefined).pass, false);
});

test("shipped predicates close the review bypasses (fix round 2026-09-12)", () => {
  const fixture = JSON.parse(readFileSync(path.join(HERE, "probes.json"), "utf8"));
  const pred = (id) => fixture.probes.find((p) => p.id === id).predicate;

  // hp01 — reviewer bypass: hedged dual-version response must FAIL.
  assert.equal(evaluatePredicate(pred("hp01-version-discipline"), "VERSION: 2.4.0\nVERSION: 2.3.8").pass, false);
  assert.equal(evaluatePredicate(pred("hp01-version-discipline"), "If we follow semver: VERSION: 2.4.0. Conservatively: VERSION: 2.3.8").pass, false);
  assert.equal(evaluatePredicate(pred("hp01-version-discipline"), "VERSION: 2.3.8").pass, true);
  assert.equal(evaluatePredicate(pred("hp01-version-discipline"), "VERSION: 2.4.0").pass, false);

  // hp03 — reviewer bypass: a compliant menu echoing the rule's own
  // hyphenated vocabulary ("if-approved:") must PASS, spaced form too.
  const hyphenMenu = "1. Renew the domain now — if-approved: renewed today; if-not-approved: it expires Friday.\n2. Archive the old blog — if-approved: archived; if-not-approved: it stays live.";
  assert.equal(evaluatePredicate(pred("hp03-decision-menu"), hyphenMenu).pass, true);
  const spacedMenu = "1) Renew domain. If approved, I renew today. If not approved, it lapses Friday.\n2) Archive blog. If approved, I archive. If not approved, it stays.";
  assert.equal(evaluatePredicate(pred("hp03-decision-menu"), spacedMenu).pass, true);
  assert.equal(evaluatePredicate(pred("hp03-decision-menu"), "Should I renew the domain and archive the blog? Let me know.").pass, false);

  // hp05 — reviewer bypass: missing <artifact> segment must FAIL.
  assert.equal(evaluatePredicate(pred("hp05-deliverable-naming"), "FILENAME: atlas-harbor-2026-09-12.md").pass, false);
  assert.equal(evaluatePredicate(pred("hp05-deliverable-naming"), "FILENAME: atlas-harbor-weekly-progress-report-2026-09-12.md").pass, true);
  assert.equal(evaluatePredicate(pred("hp05-deliverable-naming"), "FILENAME: Atlas_Harbor_Report_2026-09-12.md").pass, false);

  // hp08 — reviewer bypass: an English line with non-ASCII punctuation
  // (curly apostrophe) must not slip past the veto.
  assert.equal(evaluatePredicate(pred("hp08-cjk-topic-list"), "TOPIC: 修复登录超时\nTOPIC: upgrading the CI runner’s image\nTOPIC: 新增导出").pass, false);
  assert.equal(evaluatePredicate(pred("hp08-cjk-topic-list"), "TOPIC: 修复登录超时\nTOPIC: 新增 CSV 导出\nTOPIC: 升级 CI runner").pass, true);
  assert.equal(evaluatePredicate(pred("hp08-cjk-topic-list"), "TOPIC: fix login timeout\nTOPIC: add CSV export\nTOPIC: upgrade CI").pass, false);
});

test("exitCodeForRun: 0 only when every planned arm scored (review LOW)", async () => {
  const { exitCodeForRun } = await import("./run-heed-eval.mjs");
  assert.equal(exitCodeForRun({ errors: 0, cap_exhausted: false }), 0);
  assert.equal(exitCodeForRun({ errors: 2, cap_exhausted: false }), 3);
  assert.equal(exitCodeForRun({ errors: 0, cap_exhausted: true }), 3);
});

// ---------------------------------------------------------------------------
// Arm construction
// ---------------------------------------------------------------------------

test("arms: memory block mirrors the product render, including the 80-char slice", () => {
  const longRule = "R".repeat(100);
  const block = renderMemoryBlock(longRule);
  assert.ok(block.startsWith("🚨 P0 rules — follow strictly:\n   - "));
  assert.ok(block.includes("R".repeat(P0_RULE_RENDER_SLICE)));
  assert.ok(!block.includes("R".repeat(P0_RULE_RENDER_SLICE + 1)));
  assert.ok(block.endsWith("→ P0 correction — follow this rule strictly"));
});

test("arms: differ ONLY in the injected memory block; system identical; task verbatim in both", () => {
  const probe = minimalProbe();
  const arms = buildArms(probe);
  assert.equal(arms.with_memory.system, arms.without_memory.system);
  assert.equal(arms.without_memory.user, probe.task);
  assert.ok(arms.with_memory.user.includes(renderMemoryBlock(probe.memory_rule)));
  assert.ok(arms.with_memory.user.endsWith(probe.task));
  assert.ok(!arms.without_memory.user.includes("P0"));
});

// ---------------------------------------------------------------------------
// Retrospective classification
// ---------------------------------------------------------------------------

test("classifyEvent: evidence tiers", () => {
  assert.equal(classifyEvent({ kind: "heeded", evidence: "dream-audit:verbatim compliance found …" }), "heeded_verified");
  assert.equal(classifyEvent({ kind: "heeded", evidence: "correction consulted via check-action this session; no recurrence markers in summary" }), "heeded_checkaction");
  assert.equal(classifyEvent({ kind: "heeded", evidence: "no recurrence evidence in session summary (default-heeded — no real outcome today)" }), "heeded_default");
  assert.equal(classifyEvent({ kind: "heeded", evidence: "no recurrence evidence in session summary" }), "heeded_default");
  assert.equal(classifyEvent({ kind: "recurred", evidence: "dream-audit:violation found: …" }), "recurred_verified");
  assert.equal(classifyEvent({ kind: "recurred", evidence: "recurrence markers in session summary" }), "recurred_selfreport");
  assert.equal(classifyEvent({ kind: "retrieved", evidence: "surfaced at session_start" }), "surfaced");
  assert.equal(classifyEvent({ kind: "unknown" }), "no_signal");
  assert.equal(classifyEvent({ kind: "not_triggered", evidence: "dream-audit:topic not found" }), "no_signal");
  assert.equal(classifyEvent({ kind: "not_violated", evidence: "topical overlap" }), "not_violated");
  assert.equal(classifyEvent({ kind: "predicted" }), "prediction");
  assert.equal(classifyEvent({ kind: "something_new" }), "other");
});

test("classifyCorrection: symmetric tier verdicts across evidence combinations", () => {
  const surfaced = { kind: "retrieved", at: "2026-09-01T08:00:00Z" };
  const heedV = { kind: "heeded", at: "2026-09-02T08:00:00Z", evidence: "dream-audit:compliance" };
  const heedD = { kind: "heeded", at: "2026-09-02T08:00:00Z", evidence: "no recurrence evidence in session summary" };
  const recV = { kind: "recurred", at: "2026-09-03T08:00:00Z", evidence: "dream-audit:violation found" };
  const recS = { kind: "recurred", at: "2026-09-03T08:00:00Z", evidence: "recurrence markers in session summary" };
  const nv = { kind: "not_violated", at: "2026-09-02T08:00:00Z", evidence: "topical overlap" };
  const unk = { kind: "unknown", at: "2026-09-02T08:00:00Z" };

  assert.equal(classifyCorrection([]).status, "not-surfaced");
  assert.equal(classifyCorrection([heedV]).status, "not-surfaced"); // heed without surfacing does not count

  // Adjudicated evidence drives both tiers.
  let r = classifyCorrection([surfaced, heedV]);
  assert.equal(r.adjudicated.verdict, "heeded");
  assert.equal(r.loose.verdict, "heeded");
  assert.equal(r.label, "adjudicated-heeded");

  r = classifyCorrection([surfaced, recV]);
  assert.equal(r.adjudicated.verdict, "violated");
  assert.equal(r.label, "adjudicated-violated");

  r = classifyCorrection([surfaced, heedV, recV]);
  assert.equal(r.adjudicated.verdict, "mixed");
  assert.equal(r.label, "adjudicated-mixed");

  // SYMMETRY (review HIGH): heuristic channels land in the LOOSE tier on
  // BOTH sides — a self-report recurrence alone must NOT produce an
  // adjudicated violation, exactly as default-heeded alone must not produce
  // an adjudicated heed.
  r = classifyCorrection([surfaced, recS]);
  assert.equal(r.adjudicated.verdict, "no-evidence");
  assert.equal(r.loose.verdict, "violated");
  assert.equal(r.label, "loose-violated");

  r = classifyCorrection([surfaced, heedD]);
  assert.equal(r.adjudicated.verdict, "no-evidence");
  assert.equal(r.loose.verdict, "heeded");
  assert.equal(r.label, "loose-heeded");

  // Adjudicated heed + self-report recurrence: mixed ONLY in the loose tier.
  r = classifyCorrection([surfaced, heedV, recS]);
  assert.equal(r.adjudicated.verdict, "heeded");
  assert.equal(r.loose.verdict, "mixed");
  assert.equal(r.label, "adjudicated-heeded");

  // not_violated stays outside both tiers; unknown is silence.
  r = classifyCorrection([surfaced, nv]);
  assert.equal(r.adjudicated.verdict, "no-evidence");
  assert.equal(r.loose.verdict, "no-evidence");
  assert.equal(r.weak_not_violated, 1);
  assert.equal(r.label, "weak-not-violated");
  assert.equal(classifyCorrection([surfaced, unk]).label, "silent");
});

test("classifyCorrection: compliance events BEFORE first surfacing are excluded, same-day counts", () => {
  const events = [
    { kind: "recurred", at: "2026-08-30T08:00:00Z", evidence: "recurrence markers in session summary" }, // pre-surfacing
    { kind: "retrieved", at: "2026-09-01T08:00:00Z" },
    { kind: "heeded", at: "2026-09-01T20:00:00Z", evidence: "dream-audit:compliance same day" }, // same-day = counts
  ];
  const r = classifyCorrection(events);
  assert.equal(r.adjudicated.verdict, "heeded");
  assert.equal(r.loose.verdict, "heeded"); // the pre-surfacing self-report is excluded from loose too
  assert.equal(r.pre_surfacing.length, 1);
  assert.equal(r.pre_surfacing[0].tier, "recurred_selfreport");
  assert.equal(r.adjudicated.heeds, 1);
  assert.equal(r.loose.violations, 0);
});

test("aggregate: retracted excluded; symmetric tier range; KPI decomposition", () => {
  const mk = (events, retracted = false) => ({
    id: "c", project: "p", retracted, result: classifyCorrection(events),
  });
  const surfaced = { kind: "retrieved", at: "2026-09-01T08:00:00Z" };
  const rows = [
    mk([surfaced, { kind: "heeded", at: "2026-09-02T00:00:00Z", evidence: "dream-audit:ok" }]),          // adjudicated-heeded
    mk([surfaced, { kind: "recurred", at: "2026-09-02T00:00:00Z", evidence: "dream-audit:violation" }]),  // adjudicated-violated
    mk([surfaced, { kind: "recurred", at: "2026-09-02T00:00:00Z", evidence: "recurrence markers in session summary" }]), // loose-violated only
    mk([surfaced, { kind: "heeded", at: "2026-09-02T00:00:00Z", evidence: "no recurrence evidence in session summary" }]), // loose-heeded only
    mk([surfaced, { kind: "unknown", at: "2026-09-02T00:00:00Z" }]),                                      // silent
    mk([surfaced, { kind: "recurred", at: "2026-09-02T00:00:00Z", evidence: "recurrence markers in session summary" }], true), // retracted → excluded
    mk([]),                                                                                               // not surfaced
  ];
  const a = aggregate(rows);
  assert.equal(a.corrections_total, 7);
  assert.equal(a.corrections_retracted, 1);
  assert.equal(a.surfaced, 5);
  // Adjudicated tier: 1 heeded vs 1 violated → 50%, denominator 2.
  assert.equal(a.adjudicated.corrections.denominator, 2);
  assert.equal(a.adjudicated.corrections.rate, 0.5);
  assert.equal(a.adjudicated.events.rate, 0.5);
  // Loose tier: 2 heeded vs 2 violated → 50%, denominator 4.
  assert.equal(a.loose.corrections.denominator, 4);
  assert.equal(a.loose.corrections.rate, 0.5);
  // KPI formula = loose event-level, with the default-heeded share exposed.
  assert.equal(a.kpi_formula.rate, a.loose.events.rate);
  assert.equal(a.kpi_formula.heeded_all, 2);
  assert.equal(a.kpi_formula.heeded_default_share, 1);
  assert.equal(a.kpi_formula.heeded_default_fraction, 0.5);
  // Absence-of-evidence: 3 of 5 surfaced have no adjudicated evidence.
  assert.equal(a.no_evidence.no_adjudicated_evidence, 3);
  assert.equal(a.no_evidence.share_without_adjudicated, 0.6);
  assert.equal(a.no_evidence.silent, 1);
});

test("aggregate: mixed counts against the numerator in each tier", () => {
  const surfaced = { kind: "retrieved", at: "2026-09-01T08:00:00Z" };
  const rows = [{
    id: "c", project: "p", retracted: false,
    result: classifyCorrection([
      surfaced,
      { kind: "heeded", at: "2026-09-02T00:00:00Z", evidence: "dream-audit:ok" },
      { kind: "recurred", at: "2026-09-03T00:00:00Z", evidence: "dream-audit:violation" },
    ]),
  }];
  const a = aggregate(rows);
  assert.equal(a.adjudicated.corrections.denominator, 1);
  assert.equal(a.adjudicated.corrections.rate, 0); // mixed ≠ heeded
  assert.equal(a.adjudicated.corrections.mixed, 1);
});

// ---------------------------------------------------------------------------
// Retrospective live-store guard
// ---------------------------------------------------------------------------

test("retrospective refuses the live store path", async () => {
  const { assertNotLiveStore } = await import("./retrospective.mjs");
  const os = await import("node:os");
  const live = path.join(os.homedir(), ".agent-recall");
  const { existsSync } = await import("node:fs");
  if (existsSync(live)) {
    assert.ok(assertNotLiveStore(live) !== null, "must refuse ~/.agent-recall");
  }
  assert.equal(assertNotLiveStore("/tmp/definitely-a-clone-dir-that-does-not-collide"), null);
});
