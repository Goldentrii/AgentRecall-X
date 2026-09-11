// packages/core/test/pending-capture-gate.test.mjs
//
// Fix #2 (plan-v2, 2026-09-11) — dual-channel capture gate, core battery.
//
// THE CONTRACT UNDER TEST (three layers + merge):
//   L1  check(human_correction) becomes a UNION: the legacy STRING form is
//       STAGED to corrections/_pending/ (never the active ledger, never the
//       alignment-log `corrections` field); the new STRUCTURED form
//       {rule, why, applies_when} passes completeness validation and reaches
//       the active ledger via writeCorrection; incomplete structured input is
//       rejected with an `agent_instruction` teaching the exact restructure.
//   MERGE  active-ledger consolidation matches by DISTILLED rule identity
//       (CJK-aware tokenization via helpers/tokenize.ts) instead of the old
//       verbatim char-normalization — a reworded restatement of the SAME rule
//       merges (proof_count++); junk can no longer accrue proof_count at all
//       because junk never reaches the active ledger.
//   LIFECYCLE  _pending/ is capped (PENDING_CAP) and TTL'd
//       (PENDING_TTL_DAYS); nothing is silently dropped — evictions/expiries/
//       hard-noise land in _pending/_rejected.jsonl with provenance; promote/
//       reject via check() structured form resolves a staged item by id.
//
// RIDER R1 (orchestrator condition): the FLIP ITSELF is pinned — string form
// lands in _pending/ and NEVER in the active ledger; the alignment-log
// `corrections` field stays untouched by the string form; watch_for /
// auto-promote can no longer be driven by the string form.
//
// EVALUATION EXEMPLARS (regression fixtures from the 2026-09-11 eval):
//   E1  ×34 verbatim repeats of a business question ("需要确认一下这个产品
//       是否有充值活动" — passed the old gate via 需要) gain NO proof_count:
//       the active ledger stays empty; the pending store dedupes to ONE row.
//   E3  a business-question sentence cannot reach the active ledger as a p0
//       (or at all) through EITHER form.
// (E2 — fragment applies_when insights — lives in
//  session-end-insight-gate.test.mjs.)

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { check } from "../dist/tools-logic/check.js";
import { sessionStart } from "../dist/tools-logic/session-start.js";
import { readInsightsIndex } from "../dist/palace/insights-index.js";
import {
  readCorrections,
  readP0Corrections,
  writeCorrection,
  distillRuleIdentity,
} from "../dist/storage/corrections.js";
import {
  PENDING_CAP,
  PENDING_TTL_DAYS,
  pendingDir,
  stagePendingCorrection,
  listPendingCorrections,
  resolvePendingCorrection,
  validateStructuredCorrection,
} from "../dist/storage/pending.js";

let testRoot;
let savedAbEnabled;
let savedAbForce;

beforeEach(() => {
  testRoot = path.join(tmpdir(), `ar-pending-gate-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(testRoot, { recursive: true });
  process.env.AGENT_RECALL_ROOT = testRoot;
  // Hermeticity (same convention as session-start-injection.test.mjs): the C4
  // A/B experiment can assign an "off" arm under AR_AB_ENABLED=1, which
  // suppresses every correction-derived session_start surface — including the
  // pending-review counter under test here.
  savedAbEnabled = process.env.AR_AB_ENABLED;
  savedAbForce = process.env.AR_AB_FORCE;
  delete process.env.AR_AB_ENABLED;
  delete process.env.AR_AB_FORCE;
});

afterEach(() => {
  delete process.env.AGENT_RECALL_ROOT;
  if (savedAbEnabled !== undefined) process.env.AR_AB_ENABLED = savedAbEnabled;
  if (savedAbForce !== undefined) process.env.AR_AB_FORCE = savedAbForce;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

function alignmentLog(project) {
  const p = path.join(testRoot, "projects", project, "alignment-log.json");
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function rejectedLines(project) {
  const p = path.join(pendingDir(project), "_rejected.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const VALID_STRUCTURED = {
  rule: "Never push to the main branch without explicit owner approval",
  why: "Owner corrected an unauthorized push on 2026-09-10; second occurrence",
  applies_when: ["git", "push", "deploy"],
};

// ---------------------------------------------------------------------------
// L1 — string form → _pending/, never active (R1 pin)
// ---------------------------------------------------------------------------

describe("L1: string human_correction is STAGED, never active (R1 pin)", () => {
  it("string form lands in corrections/_pending/ and the ACTIVE ledger stays empty", async () => {
    const project = "l1-string-stages";
    const result = await check({
      goal: "ship the release",
      confidence: "high",
      human_correction: "Never push to the main branch without explicit owner approval",
      project,
    });
    assert.equal(result.recorded, true);

    // ACTIVE ledger: zero records — the flip itself.
    assert.equal(readCorrections(project).length, 0, "string form must NOT reach the active corrections ledger");
    assert.equal(readP0Corrections(project).length, 0);

    // PENDING store: exactly one staged record, with provenance.
    const pending = listPendingCorrections(project);
    assert.equal(pending.length, 1, `expected exactly one staged pending record, got: ${JSON.stringify(pending)}`);
    assert.equal(pending[0].kind, "correction");
    assert.equal(pending[0].channel, "check_string");
    assert.ok(pending[0].rule.includes("Never push"), "the staged rule must carry the correction text");
    assert.ok(pending[0].reason, "a staged record must say WHY it is pending");
    assert.ok(pending[0].provenance && pending[0].provenance.source, "provenance must be stamped");

    // The result must tell the caller it was staged, and HOW to activate it.
    assert.ok(result.correction_pending, "result must carry correction_pending");
    assert.equal(result.correction_pending.status, "staged");
    assert.equal(result.correction_pending.id, pending[0].id);
    const instr = result.correction_pending.agent_instruction ?? "";
    assert.ok(/rule/.test(instr) && /why/.test(instr) && /applies_when/.test(instr),
      `agent_instruction must teach the structured {rule, why, applies_when} form, got: ${instr}`);
  });

  it("R1 pin: the alignment-log `corrections` field stays UNTOUCHED by the string form", async () => {
    const project = "l1-alignment-untouched";
    await check({
      goal: "ship the release",
      confidence: "high",
      human_correction: "Never push to the main branch without explicit owner approval",
      project,
    });
    const log = alignmentLog(project);
    assert.equal(log.length, 1);
    assert.equal(log[0].corrections, undefined,
      `alignment-log corrections field must NOT be fed by the string form, got: ${JSON.stringify(log[0])}`);
  });

  it("R1 pin: watch_for / auto-promote can no longer be driven by the string form", async () => {
    const project = "l1-no-watchfor";
    let last;
    for (let i = 0; i < 3; i++) {
      last = await check({
        goal: `ship feature batch ${i}`,
        confidence: "high",
        human_correction: "Always verify the deployment checklist before shipping",
        project,
      });
    }
    assert.equal(last.auto_promoted, undefined, "string form must not auto-promote");
    assert.equal(last.watch_for.length, 0, "string form must not feed watch_for patterns");
    const index = readInsightsIndex();
    assert.ok(
      !index.insights.some((ins) => ins.title.includes("Always verify")),
      "no insight may be minted from string-form corrections",
    );
    // The three identical captures dedupe to ONE pending row with seen_count 3.
    const pending = listPendingCorrections(project);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].seen_count, 3);
  });

  it("HIGH-1 pin (delta side-door): hook-style string capture with correction text packed into delta cannot seed watch_for/auto-promote", async () => {
    // The CLI hook and `ar correct` pass the SAME un-reviewed correction text
    // in `delta` — and extractWatchPatterns treats past.delta as a correction.
    // The gate therefore suppresses delta whenever the accompanying
    // human_correction was merely staged (not activated).
    const project = "l1-delta-sidedoor";
    const CORRECTION = "Always verify the deployment checklist before shipping";
    let last;
    for (let i = 0; i < 3; i++) {
      last = await check({
        goal: `ship feature batch ${i}`,
        confidence: "high",
        human_correction: CORRECTION,
        correction_source: "hook-correction",
        delta: `Was: "shipping" | Correction: "${CORRECTION}"`,
        project,
      });
    }
    assert.equal(last.auto_promoted, undefined, "delta must not smuggle staged text into auto-promote");
    assert.equal(last.watch_for.length, 0, "delta must not smuggle staged text into watch_for");
    const log = alignmentLog(project);
    assert.equal(log.length, 3);
    for (const rec of log) {
      assert.equal(rec.delta, undefined, `delta must be suppressed when the correction was only staged, got: ${JSON.stringify(rec)}`);
      assert.equal(rec.corrections, undefined);
    }
    // Staged rows carry hook provenance.
    const pending = listPendingCorrections(project);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].channel, "hook");
    assert.equal(pending[0].seen_count, 3);
  });

  it("delta STILL records for pure alignment notes and for the validated structured form", async () => {
    const project = "l1-delta-allowed";
    await check({ goal: "pure alignment", confidence: "medium", delta: "scope was narrower than assumed", project });
    await check({
      goal: "structured capture",
      confidence: "high",
      human_correction: VALID_STRUCTURED,
      delta: "the human corrected the push policy",
      project,
    });
    const log = alignmentLog(project);
    assert.equal(log[0].delta, "scope was narrower than assumed");
    assert.equal(log[1].delta, "the human corrected the push policy");
  });

  it("whitespace-only string human_correction reports rejected_junk (never a silent no-op)", async () => {
    const project = "l1-whitespace";
    const r = await check({ goal: "g", confidence: "low", human_correction: "   ", project });
    assert.equal(r.correction_pending?.status, "rejected_junk");
    assert.equal(listPendingCorrections(project).length, 0);
    assert.equal(readCorrections(project).length, 0);
  });

  it("hard-noise junk string → _pending/_rejected.jsonl with provenance, no pending row, nothing active", async () => {
    const project = "l1-junk";
    const result = await check({
      goal: "quick ack",
      confidence: "low",
      human_correction: "ok thanks",
      project,
    });
    assert.equal(readCorrections(project).length, 0);
    assert.equal(listPendingCorrections(project).length, 0);
    const rej = rejectedLines(project);
    assert.equal(rej.length, 1, `hard-noise capture must land in _pending/_rejected.jsonl, got: ${JSON.stringify(rej)}`);
    assert.ok(rej[0].reason, "rejected line must carry the gate reason");
    assert.ok(rej[0].channel, "rejected line must carry the channel provenance");
    assert.equal(result.correction_pending?.status, "rejected_junk");
  });
});

// ---------------------------------------------------------------------------
// L1 — structured form → active ledger (validated) / rejected with instruction
// ---------------------------------------------------------------------------

describe("L1: structured human_correction {rule, why, applies_when}", () => {
  it("valid structured form reaches the ACTIVE ledger with severity/failure_class/applies_when", async () => {
    const project = "l1-structured-valid";
    const result = await check({
      goal: "ship the release",
      confidence: "high",
      human_correction: VALID_STRUCTURED,
      project,
    });
    assert.equal(result.recorded, true);
    assert.equal(result.correction_gate_rejected, undefined);

    const records = readCorrections(project);
    assert.equal(records.length, 1, `expected one ACTIVE record, got: ${JSON.stringify(records)}`);
    const rec = records[0];
    assert.equal(rec.severity, "p0", "severity is computed on the rule sentence (never → p0)");
    assert.equal(rec.failure_class, "publish_gate");
    assert.deepEqual(rec.applies_when, VALID_STRUCTURED.applies_when, "applies_when must be persisted on the record");
    assert.ok(rec.context.includes(VALID_STRUCTURED.why), "the why/evidence must be persisted in context");
    for (const t of VALID_STRUCTURED.applies_when) {
      assert.ok(rec.tags.includes(t), `applies_when token "${t}" must be folded into tags for context matching`);
    }
    // Nothing pends on the valid path.
    assert.equal(listPendingCorrections(project).length, 0);
  });

  it("valid structured form FEEDS the alignment-log corrections field (watch_for stays reachable)", async () => {
    const project = "l1-structured-alignment";
    await check({
      goal: "ship the release",
      confidence: "high",
      human_correction: VALID_STRUCTURED,
      project,
    });
    const log = alignmentLog(project);
    assert.equal(log.length, 1);
    assert.deepEqual(log[0].corrections, [VALID_STRUCTURED.rule]);
  });

  it("severity is computed on the RULE only — a p0-marker in `why` cannot escalate", async () => {
    const project = "l1-severity-rule-only";
    await check({
      goal: "review deploy flow",
      confidence: "medium",
      human_correction: {
        rule: "You should not deploy without approval from the reviewer",
        why: "the user always got burned by unreviewed deploys — never again, they said",
        applies_when: ["deploy", "review"],
      },
      project,
    });
    const records = readCorrections(project);
    assert.equal(records.length, 1);
    assert.equal(records[0].severity, "p1",
      `severity must come from the rule sentence alone ('should not' is p1); the why's always/never must not leak in, got: ${JSON.stringify(records[0])}`);
  });

  it("incomplete structured (missing why) → staged pending + agent_instruction, never active", async () => {
    const project = "l1-structured-incomplete";
    const result = await check({
      goal: "ship the release",
      confidence: "high",
      human_correction: { rule: VALID_STRUCTURED.rule, why: "", applies_when: ["git"] },
      project,
    });
    assert.equal(readCorrections(project).length, 0, "incomplete structured input must never reach the active ledger");
    assert.ok(result.correction_gate_rejected, "rejection must be surfaced, never silent");
    assert.equal(result.correction_pending?.status, "invalid_structured");
    assert.ok(result.correction_pending?.id, "the incomplete capture must be staged (not dropped)");
    const instr = result.correction_pending?.agent_instruction ?? "";
    assert.ok(/why/.test(instr), `agent_instruction must name the missing piece, got: ${instr}`);
    const pending = listPendingCorrections(project);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].channel, "check_structured_incomplete");
  });

  it("fragment applies_when ([\"good,\",\"then\",\"don't\"]) fails completeness → staged pending", async () => {
    const project = "l1-fragment-applieswhen";
    const result = await check({
      goal: "capture a rule",
      confidence: "high",
      human_correction: {
        rule: VALID_STRUCTURED.rule,
        why: VALID_STRUCTURED.why,
        applies_when: ["good,", "then", "don't"],
      },
      project,
    });
    assert.equal(readCorrections(project).length, 0);
    assert.equal(result.correction_pending?.status, "invalid_structured");
    assert.ok(/applies_when/.test(result.correction_pending?.agent_instruction ?? ""));
    assert.equal(listPendingCorrections(project).length, 1);
  });

  it("E3: a business-question sentence cannot reach the active ledger (as p0 or at all) through EITHER form", async () => {
    const project = "e3-business-question";
    // String form → staged.
    await check({
      goal: "answer the operator question",
      confidence: "medium",
      human_correction: "需要确认一下这个产品是否有充值活动",
      project,
    });
    // Structured form with a QUESTION as the rule → rejected (not an imperative rule sentence).
    const r2 = await check({
      goal: "answer the operator question",
      confidence: "medium",
      human_correction: {
        rule: "这个产品是否有充值活动呢",
        why: "operator asked in the session",
        applies_when: ["充值", "活动"],
      },
      project,
    });
    assert.equal(readCorrections(project).length, 0, "the business question must never become an active correction");
    assert.equal(readP0Corrections(project).length, 0, "and can never be an active p0");
    assert.equal(r2.correction_pending?.status, "invalid_structured");
    assert.ok(/rule/.test(r2.correction_pending?.agent_instruction ?? ""));
  });

  it("E1: ×34 verbatim junk repeats gain NO proof_count — active empty, pending dedupes to one row", async () => {
    const project = "e1-recharge-34";
    for (let i = 0; i < 34; i++) {
      await check({
        goal: "operator follow-up",
        confidence: "medium",
        human_correction: "需要确认一下这个产品是否有充值活动",
        project,
      });
    }
    const active = readCorrections(project);
    assert.equal(active.length, 0, "34 repeats must leave the active ledger EMPTY");
    assert.ok(!active.some((r) => (r.proof_count ?? 1) > 1), "no proof_count can accrue from repeats");
    const pending = listPendingCorrections(project);
    assert.equal(pending.length, 1, "the pending store must dedupe verbatim repeats to a single row");
    assert.equal(pending[0].seen_count, 34, "the dedupe must still COUNT the repeats (visible, not amplified)");
  });
});

// ---------------------------------------------------------------------------
// Promote / reject — the review loop
// ---------------------------------------------------------------------------

describe("pending review loop: promote by id → active; reject → _pending/_rejected", () => {
  it("check() structured with pending_id promotes the staged item to the active ledger", async () => {
    const project = "promote-flow";
    const staged = await check({
      goal: "capture correction",
      confidence: "high",
      human_correction: "Never commit directly to the main branch without review",
      project,
    });
    const pendingId = staged.correction_pending?.id;
    assert.ok(pendingId, "staging must return the pending id");

    const promoted = await check({
      goal: "confirm the staged correction",
      confidence: "high",
      human_correction: {
        rule: "Never commit directly to the main branch without review",
        why: "human corrected this twice on 2026-09-11",
        applies_when: ["git", "commit", "review"],
        pending_id: pendingId,
      },
      project,
    });
    assert.equal(promoted.correction_pending?.status, "promoted");
    assert.equal(readCorrections(project).length, 1, "promotion must land the record in the active ledger");
    assert.equal(listPendingCorrections(project).length, 0, "the staged item must leave the pending store on promote");
  });

  it("check() structured {pending_id, resolution:'reject'} moves the staged item to _pending/_rejected.jsonl", async () => {
    const project = "reject-flow";
    const staged = await check({
      goal: "capture correction",
      confidence: "high",
      human_correction: "Never commit directly to the main branch without review",
      project,
    });
    const pendingId = staged.correction_pending?.id;
    assert.ok(pendingId);

    const rejected = await check({
      goal: "review the staged correction",
      confidence: "high",
      human_correction: { pending_id: pendingId, resolution: "reject", why: "one-off task redirect, not a durable rule" },
      project,
    });
    assert.equal(rejected.correction_pending?.status, "review_rejected");
    assert.equal(listPendingCorrections(project).length, 0);
    assert.equal(readCorrections(project).length, 0);
    const rej = rejectedLines(project);
    assert.ok(rej.some((l) => l.reason && /one-off/.test(l.reason)), `rejection must carry the reviewer's reason, got: ${JSON.stringify(rej)}`);
  });

  it("promote with an unknown pending_id reports not_found (still writes the valid structured rule)", async () => {
    const project = "promote-missing";
    const r = await check({
      goal: "confirm",
      confidence: "high",
      human_correction: { ...VALID_STRUCTURED, pending_id: "no-such-id" },
      project,
    });
    assert.equal(readCorrections(project).length, 1, "a valid structured rule still activates");
    assert.equal(r.correction_pending?.status, "not_found");
  });
});

// ---------------------------------------------------------------------------
// session_start surface — compact, count-only
// ---------------------------------------------------------------------------

describe("session_start pending surface", () => {
  it("surfaces pending_corrections {count, ids} when items await review; absent when none", async () => {
    const project = "ss-pending-surface";
    await check({ goal: "g1", confidence: "high", human_correction: "Never push to main without explicit owner approval", project });
    await check({ goal: "g2", confidence: "high", human_correction: "Always run the full test suite before declaring done", project });

    const result = await sessionStart({ project });
    assert.ok(result.pending_corrections, "pending_corrections must be surfaced");
    assert.equal(result.pending_corrections.count, 2);
    assert.ok(Array.isArray(result.pending_corrections.ids) && result.pending_corrections.ids.length <= 3);
    // Pending never impersonates active memory:
    assert.equal(result.corrections.length, 0, "pending items must NOT appear in the corrections section");
    assert.equal(result.watch_for.length, 0, "pending items must NOT appear in watch_for");

    const fresh = await sessionStart({ project: "ss-no-pending" });
    assert.equal(fresh.pending_corrections, undefined, "absent-when-empty convention");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle — cap + TTL, nothing silently dropped
// ---------------------------------------------------------------------------

describe("pending lifecycle: cap + TTL with provenance", () => {
  it("stage beyond PENDING_CAP evicts the oldest into _pending/_rejected.jsonl", () => {
    const project = "cap-evict";
    const dir = pendingDir(project);
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    for (let i = 0; i < PENDING_CAP + 10; i++) {
      const ts = new Date(now - (PENDING_CAP + 10 - i) * 60000).toISOString();
      const id = `fixture-${String(i).padStart(4, "0")}`;
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
        id, ts, last_seen: ts, seen_count: 1, project,
        kind: "correction", channel: "check_string",
        rule: `Never use fixture pattern number ${i} in production code`,
        context: `Never use fixture pattern number ${i} in production code`,
        severity: "p1", reason: "test fixture", provenance: { source: "test", mode: "told" },
      }, null, 2));
    }
    const res = stagePendingCorrection(project, {
      kind: "correction",
      channel: "check_string",
      text: "Never merge without a green CI run on the release branch",
      reason: "string-form capture",
    });
    assert.equal(res.staged, true);
    const pending = listPendingCorrections(project);
    assert.ok(pending.length <= PENDING_CAP, `pending store must be capped at ${PENDING_CAP}, got ${pending.length}`);
    const rej = rejectedLines(project);
    assert.ok(rej.length >= 10, "evicted rows must land in _rejected.jsonl (never silently dropped)");
    assert.ok(rej.some((l) => /cap/i.test(l.reason ?? "")), "eviction rows must say they were cap-evicted");
  });

  it("TTL-expired items are pruned on read into _pending/_rejected.jsonl", () => {
    const project = "ttl-expire";
    const dir = pendingDir(project);
    fs.mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - (PENDING_TTL_DAYS + 5) * 24 * 3600 * 1000).toISOString();
    fs.writeFileSync(path.join(dir, "stale-item.json"), JSON.stringify({
      id: "stale-item", ts: old, last_seen: old, seen_count: 1, project,
      kind: "correction", channel: "check_string",
      rule: "Never deploy the staging build to the production cluster",
      context: "Never deploy the staging build to the production cluster",
      severity: "p1", reason: "test fixture", provenance: { source: "test", mode: "told" },
    }, null, 2));

    const pending = listPendingCorrections(project);
    assert.equal(pending.length, 0, "expired items must not be listed");
    assert.ok(!fs.existsSync(path.join(dir, "stale-item.json")), "expired file must be physically pruned");
    const rej = rejectedLines(project);
    assert.ok(rej.some((l) => /ttl|expire/i.test(l.reason ?? "")), `expiry must be logged with provenance, got: ${JSON.stringify(rej)}`);
  });

  it("resolvePendingCorrection: unknown id → success:false, never throws", () => {
    const r = resolvePendingCorrection("resolve-missing", "nope", "reject", { reason: "n/a" });
    assert.equal(r.success, false);
    assert.ok(r.error);
  });
});

// ---------------------------------------------------------------------------
// Completeness validation — unit
// ---------------------------------------------------------------------------

describe("validateStructuredCorrection", () => {
  it("accepts the canonical valid shape", () => {
    assert.equal(validateStructuredCorrection(VALID_STRUCTURED).ok, true);
  });

  it("rejects a question/business sentence as the rule (EN + CJK)", () => {
    const en = validateStructuredCorrection({
      rule: "whether we have the recharge activity for this product",
      why: "operator asked",
      applies_when: ["recharge"],
    });
    assert.equal(en.ok, false);
    assert.ok(en.failures.some((f) => f.field === "rule"));
    const zh = validateStructuredCorrection({
      rule: "这个产品是否有充值活动呢",
      why: "运营在会话里问过",
      applies_when: ["充值"],
    });
    assert.equal(zh.ok, false);
    assert.ok(zh.failures.some((f) => f.field === "rule"));
  });

  it("rejects empty why and empty/fragment applies_when", () => {
    const noWhy = validateStructuredCorrection({ rule: VALID_STRUCTURED.rule, why: "   ", applies_when: ["git"] });
    assert.equal(noWhy.ok, false);
    assert.ok(noWhy.failures.some((f) => f.field === "why"));

    const frag = validateStructuredCorrection({ rule: VALID_STRUCTURED.rule, why: "evidence", applies_when: ["good,", "then", "don't"] });
    assert.equal(frag.ok, false);
    assert.ok(frag.failures.some((f) => f.field === "applies_when"));

    const empty = validateStructuredCorrection({ rule: VALID_STRUCTURED.rule, why: "evidence", applies_when: [] });
    assert.equal(empty.ok, false);
  });

  it("accepts real tokens including CJK compounds and multi-word phrases", () => {
    const r = validateStructuredCorrection({
      rule: VALID_STRUCTURED.rule,
      why: "evidence",
      applies_when: ["rate limiting", "api gateway", "版本决定"],
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    // Review fix (LOW): a CJK entry qualifies on Han content even with
    // trailing full-width punctuation.
    const cjkPunct = validateStructuredCorrection({
      rule: VALID_STRUCTURED.rule,
      why: "evidence",
      applies_when: ["版本决定。"],
    });
    assert.equal(cjkPunct.ok, true, JSON.stringify(cjkPunct));
  });

  it("always carries an agent_instruction on failure", () => {
    const r = validateStructuredCorrection({ rule: "", why: "", applies_when: [] });
    assert.equal(r.ok, false);
    assert.ok(r.agent_instruction && /rule/.test(r.agent_instruction) && /why/.test(r.agent_instruction) && /applies_when/.test(r.agent_instruction));
  });
});

// ---------------------------------------------------------------------------
// MERGE — distilled rule identity (CJK-aware), not verbatim text
// ---------------------------------------------------------------------------

describe("distilled rule identity merge", () => {
  it("distillRuleIdentity: punctuation/case/whitespace-invariant, CJK-aware", () => {
    assert.equal(
      distillRuleIdentity("Never skip the test suite before pushing."),
      distillRuleIdentity("never skip the test suite, before pushing!"),
    );
    assert.equal(
      distillRuleIdentity("永远不要在推送前跳过测试。"),
      distillRuleIdentity("永远不要在推送前跳过测试"),
    );
    assert.notEqual(
      distillRuleIdentity("use proxy.ts for the api layer"),
      distillRuleIdentity("use middleware.ts for the api layer"),
    );
  });

  it("HIGH-2 pin: non-Han/non-Latin scripts survive distillation — distinct hangul/kana rules never collide", () => {
    const ko1 = distillRuleIdentity("배포 전에 테스트를 실행하세요");
    const ko2 = distillRuleIdentity("배포 전에 백업을 만드세요");
    assert.ok(ko1.length > 0 && ko2.length > 0, "hangul rules must not distill to an empty identity");
    assert.notEqual(ko1, ko2, "two DIFFERENT Korean rules must have different identities");
    const ja1 = distillRuleIdentity("テストをスキップしないでください");
    const ja2 = distillRuleIdentity("バックアップを作成してください");
    assert.ok(ja1.length > 0 && ja2.length > 0, "kana rules must not distill to an empty identity");
    assert.notEqual(ja1, ja2);
  });

  it("HIGH-2 pin: an empty identity never merges — distinct symbol-only captures stay distinct pending rows", () => {
    const project = "empty-identity-no-merge";
    const a = stagePendingCorrection(project, {
      kind: "correction", channel: "check_string",
      text: "!!!!!!!!!!!! ????", reason: "test",
    });
    const b = stagePendingCorrection(project, {
      kind: "correction", channel: "check_string",
      text: "@@@@@@@@@@@@ ****", reason: "test",
    });
    // Whatever the hard-noise gate decides for these, they must NEVER fold
    // into one row via the empty identity.
    const rows = listPendingCorrections(project);
    if (a.staged && b.staged) {
      assert.equal(rows.length, 2, `distinct symbol-only captures must not merge, got: ${JSON.stringify(rows)}`);
      assert.ok(rows.every((r) => r.seen_count === 1));
    }
  });

  it("MEDIUM pin: cross-script interleaving is part of the identity — reordered mixed-script rules never merge", () => {
    const x = distillRuleIdentity("在 staging 测试 deploy");
    const y = distillRuleIdentity("在 staging deploy 测试");
    assert.notEqual(x, y, "token order across script boundaries must be preserved in the identity");
  });

  it("merge absorbs the incoming structured form's applies_when (union, like tags)", () => {
    const project = "merge-applies-when";
    writeCorrection(project, {
      id: "2026-09-11-aw-a", date: "2026-09-11", severity: "p0", project,
      rule: "Never skip the test suite before pushing.",
      context: "Never skip the test suite before pushing.",
      tags: [], applies_when: ["git"],
    });
    const b = writeCorrection(project, {
      id: "2026-09-11-aw-b", date: "2026-09-11", severity: "p0", project,
      rule: "never skip the test suite, before pushing!",
      context: "restated",
      tags: [], applies_when: ["deploy"],
    });
    assert.equal(b.merged, true);
    const rec = readCorrections(project)[0];
    assert.ok(rec.applies_when.includes("git") && rec.applies_when.includes("deploy"),
      `merged record must union applies_when, got: ${JSON.stringify(rec.applies_when)}`);
  });

  it("a reworded restatement of the SAME rule merges (proof_count++), via writeCorrection", () => {
    const project = "merge-reworded";
    const a = writeCorrection(project, {
      id: "2026-09-11-merge-a", date: "2026-09-11", severity: "p0", project,
      rule: "Never skip the test suite before pushing.",
      context: "Never skip the test suite before pushing.",
      tags: ["git"],
    });
    assert.equal(a.written, true);
    const b = writeCorrection(project, {
      id: "2026-09-11-merge-b", date: "2026-09-11", severity: "p0", project,
      rule: "never skip the test suite, before pushing!",
      context: "restated by the human today",
      tags: ["testing"],
    });
    assert.equal(b.written, true);
    assert.equal(b.merged, true, "the reworded restatement must MERGE, not create a second record");
    const records = readCorrections(project);
    assert.equal(records.length, 1);
    assert.equal(records[0].proof_count, 2);
  });

  it("CJK: full-width punctuation / internal-whitespace variants merge", () => {
    const project = "merge-cjk";
    writeCorrection(project, {
      id: "2026-09-11-cjk-a", date: "2026-09-11", severity: "p0", project,
      rule: "永远不要在推送前跳过测试。",
      context: "永远不要在推送前跳过测试。",
      tags: [],
    });
    const b = writeCorrection(project, {
      id: "2026-09-11-cjk-b", date: "2026-09-11", severity: "p0", project,
      rule: "永远不要在推送前跳过测试",
      context: "再次强调",
      tags: [],
    });
    assert.equal(b.merged, true);
    assert.equal(readCorrections(project).length, 1);
    assert.equal(readCorrections(project)[0].proof_count, 2);
  });

  it("DISTINCT rules still never merge (proxy.ts vs middleware.ts)", () => {
    const project = "merge-distinct";
    writeCorrection(project, {
      id: "2026-09-11-d-a", date: "2026-09-11", severity: "p1", project,
      rule: "use proxy.ts for the api layer",
      context: "use proxy.ts for the api layer",
      tags: [],
    });
    const b = writeCorrection(project, {
      id: "2026-09-11-d-b", date: "2026-09-11", severity: "p1", project,
      rule: "use middleware.ts for the api layer",
      context: "use middleware.ts for the api layer",
      tags: [],
    });
    assert.notEqual(b.merged, true, "distinct rules must NOT merge");
    assert.equal(readCorrections(project).length, 2, "distinct rules must remain distinct records");
  });
});
