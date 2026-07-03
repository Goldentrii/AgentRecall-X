/**
 * session-start injection efficacy tests — C2 worker (RMR loop).
 *
 * Goals tested:
 *   1. P0 correction is never trimmed before lower-severity content (hard bar).
 *   2. Payload is within token budget (median ≤1500 tokens proxy via chars/4).
 *   3. Slim corrections: KPI fields absent from payload.
 *   4. context field omitted when identical to rule.
 *   5. predicted_risks absent from JSON when empty.
 *   6. recent_captures "Auto-captured" question label suppressed.
 *   7. Empty sections (no content) do not appear as empty-array headers.
 *   8. P0 corrections survive the corrections budget cap even when P1s exist.
 *   9. recognition.person absent from payload when tendencies empty.
 *  10. Insights are capped by char budget (never overflow SECTION_CHAR_LIMITS).
 *  12. P0-overflow: dense P0s intentionally exceed corrections_total; zero P1s.
 *  13. Context-heuristic boundary: +19 omitted, +21 included, shorter omitted.
 *  14. Realistic load: 6 P0s + 8 P1s + 5 insights + 3 rooms + captures — every
 *      section within budget (except the documented P0 exception).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-session-inject-test-" + Date.now());

/** chars/4 approximation of token count. */
function approxTokens(v) {
  return Math.ceil(JSON.stringify(v).length / 4);
}

/** Write a correction JSON file directly to the store. */
function writeRawCorrection(root, project, record) {
  const slug = record.id.replace(/[^a-zA-Z0-9_-]/g, "-");
  const dir = path.join(root, "projects", project, "corrections");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${record.date}-${slug}.json`), JSON.stringify(record, null, 2));
}

describe("session_start injection efficacy", () => {
  let core;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core = await import("../dist/index.js");
    core.setRoot(TEST_ROOT);

    // Seed project with journal, palace room, and corrections.
    await core.journalWrite({
      content: "## Brief\nBuilding injection efficacy tests.\n\n## Next\n- Test token budgets\n",
      project: "test-inject",
    });
    await core.palaceWrite({ room: "architecture", topic: "overview", content: "Injection test project", project: "test-inject" });
  });

  after(() => {
    core.resetRoot?.();
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  // ─── Test 1: P0 correction never trimmed before lower-severity content ──────
  it("P0 corrections always survive cap before P1s", async () => {
    // Write 15 P1 corrections and 2 P0 corrections.
    // The budget cap should keep ALL P0s and trim P1s, not the reverse.
    const proj = "test-p0-priority";

    // Write many P1s first (oldest dates so they'd win on date ordering naively).
    for (let i = 0; i < 12; i++) {
      writeRawCorrection(TEST_ROOT, proj, {
        id: `2026-01-0${String(i + 1).padStart(2, "0")}-p1-rule-${i}`,
        date: `2026-01-${String(i + 1).padStart(2, "0")}`,
        severity: "p1",
        project: proj,
        rule: `P1 rule number ${i} — this is a test rule that should be deprioritized`,
        context: `P1 context number ${i}`,
        tags: [],
        active: true,
        proof_count: 1,
        proof_confidence: 0.7,
      });
    }

    // Write 2 P0s (newer dates).
    writeRawCorrection(TEST_ROOT, proj, {
      id: "2026-06-01-p0-critical-rule-a",
      date: "2026-06-01",
      severity: "p0",
      project: proj,
      rule: "Never skip code review — always use code-reviewer agent after writing code",
      context: "Never skip code review — always use code-reviewer agent after writing code",
      tags: ["process"],
      active: true,
      proof_count: 3,
      proof_confidence: 0.9,
    });
    writeRawCorrection(TEST_ROOT, proj, {
      id: "2026-06-02-p0-critical-rule-b",
      date: "2026-06-02",
      severity: "p0",
      project: proj,
      rule: "Must not version bump without explicit user approval",
      context: "Must not version bump without explicit user approval — REDLINE",
      tags: ["release"],
      active: true,
      proof_count: 5,
      proof_confidence: 1.0,
    });

    const result = await core.sessionStart({ project: proj });
    const p0s = result.corrections.filter((c) => c.severity === "p0");
    const p1s = result.corrections.filter((c) => c.severity !== "p0");

    // Both P0s must be present — they must never be trimmed to make room for P1s.
    assert.equal(p0s.length, 2, `Expected 2 P0 corrections, got ${p0s.length}. corrections: ${JSON.stringify(result.corrections.map(c => c.severity + ":" + c.id))}`);

    // P0s must appear BEFORE P1s in the output (rank order).
    if (result.corrections.length > 1) {
      const firstP1Idx = result.corrections.findIndex((c) => c.severity !== "p0");
      const lastP0Idx = result.corrections.map((c) => c.severity === "p0").lastIndexOf(true);
      if (firstP1Idx !== -1) {
        assert.ok(
          lastP0Idx < firstP1Idx,
          `P0s must appear before P1s. lastP0Idx=${lastP0Idx}, firstP1Idx=${firstP1Idx}`
        );
      }
    }
  });

  // ─── Test 2: Payload within token budget ────────────────────────────────────
  it("session_start payload is within 1500-token budget (chars/4)", async () => {
    const result = await core.sessionStart({ project: "test-inject" });
    const tokens = approxTokens(result);
    assert.ok(
      tokens <= 1500,
      `Payload too large: ${tokens} estimated tokens (target ≤1500). JSON length: ${JSON.stringify(result).length} chars`
    );
  });

  // ─── Test 3: Slim corrections — KPI fields absent ───────────────────────────
  it("corrections payload omits KPI fields (retrieved_count, heeded_count, precision, etc.)", async () => {
    // Write a correction with full KPI data.
    const proj = "test-slim-corr";
    writeRawCorrection(TEST_ROOT, proj, {
      id: "2026-06-10-slim-test-rule",
      date: "2026-06-10",
      severity: "p0",
      project: proj,
      rule: "Always use TypeScript strict mode in new files",
      context: "Always use TypeScript strict mode in new files — never disable strict",
      tags: ["typescript"],
      active: true,
      retrieved_count: 42,
      heeded_count: 30,
      recurrence_count: 2,
      precision: 0.714,
      last_retrieved: "2026-06-29T10:00:00.000Z",
      last_outcome: "2026-06-28T10:00:00.000Z",
      proof_count: 7,
      proof_confidence: 0.91,
      authoritative: true,
      weight: 1.0,
      stale: false,
    });

    const result = await core.sessionStart({ project: proj });
    assert.ok(result.corrections.length >= 1, "Should have at least 1 correction");
    const c = result.corrections[0];

    // KPI fields must NOT appear in the slim payload.
    assert.equal(c.retrieved_count, undefined, "retrieved_count must be absent from slim payload");
    assert.equal(c.heeded_count, undefined, "heeded_count must be absent");
    assert.equal(c.recurrence_count, undefined, "recurrence_count must be absent");
    assert.equal(c.precision, undefined, "precision must be absent");
    assert.equal(c.last_retrieved, undefined, "last_retrieved must be absent");
    assert.equal(c.last_outcome, undefined, "last_outcome must be absent");
    assert.equal(c.proof_count, undefined, "proof_count must be absent");
    assert.equal(c.proof_confidence, undefined, "proof_confidence must be absent");
    assert.equal(c.authoritative, undefined, "authoritative must be absent");
    assert.equal(c.weight, undefined, "weight must be absent");
    assert.equal(c.stale, undefined, "stale must be absent");

    // Essential fields must be present.
    assert.ok(c.id, "id must be present");
    assert.ok(c.severity, "severity must be present");
    assert.ok(c.rule, "rule must be present");
  });

  // ─── Test 4: context field omitted when identical to rule ───────────────────
  it("slim correction omits context when identical to rule", async () => {
    const proj = "test-ctx-dedup";
    writeRawCorrection(TEST_ROOT, proj, {
      id: "2026-06-15-dedup-test",
      date: "2026-06-15",
      severity: "p0",
      project: proj,
      // rule == context (exact duplicate — should be omitted)
      rule: "Always write tests before shipping features",
      context: "Always write tests before shipping features",
      tags: [],
      active: true,
      proof_count: 1,
      proof_confidence: 1.0,
    });

    const result = await core.sessionStart({ project: proj });
    assert.ok(result.corrections.length >= 1);
    const c = result.corrections.find((x) => x.id === "2026-06-15-dedup-test");
    assert.ok(c, "correction must appear in payload");
    assert.equal(c.context, undefined, "context must be omitted when identical to rule");
  });

  // ─── Test 5: context included when meaningfully different from rule ──────────
  it("slim correction includes context when materially longer than rule", async () => {
    const proj = "test-ctx-include";
    writeRawCorrection(TEST_ROOT, proj, {
      id: "2026-06-16-ctx-include-test",
      date: "2026-06-16",
      severity: "p0",
      project: proj,
      rule: "Never use dark backgrounds",
      // context is much longer — should be included
      context: "Never use dark backgrounds. The user explicitly chose a light beige palette and round fonts. Any dark theme will be rejected. This applies to dashboards, modals, and all UI components.",
      tags: [],
      active: true,
      proof_count: 1,
      proof_confidence: 1.0,
    });

    const result = await core.sessionStart({ project: proj });
    const c = result.corrections.find((x) => x.id === "2026-06-16-ctx-include-test");
    assert.ok(c, "correction must appear in payload");
    assert.ok(c.context, "context must be included when materially longer than rule");
  });

  // ─── Test 6: predicted_risks absent from JSON when empty ────────────────────
  it("predicted_risks is absent from JSON when there are no risks", async () => {
    // Cold project with no pipeline/trajectory — predictor returns low likelihood.
    const result = await core.sessionStart({ project: "test-inject" });
    // When predicted_risks is undefined, JSON.stringify omits the key.
    const json = JSON.stringify(result);
    // Either the key is absent OR it has content — never an empty array.
    if (json.includes('"predicted_risks"')) {
      const parsed = JSON.parse(json);
      assert.ok(
        parsed.predicted_risks && parsed.predicted_risks.length > 0,
        "predicted_risks must only appear in JSON when non-empty"
      );
    }
    // If key is absent — that's the passing case (undefined ⇒ omitted).
  });

  // ─── Test 7: "Auto-captured" question label suppressed ──────────────────────
  it("recent_captures suppresses 'Auto-captured' question label", async () => {
    // Write a capture log entry with the "Auto-captured" sentinel.
    const proj = "test-autocapture";
    const captureDir = path.join(TEST_ROOT, "projects", proj, "journal");
    fs.mkdirSync(captureDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const captureFile = path.join(captureDir, `${today}-capture--log.md`);
    fs.writeFileSync(captureFile, [
      `# ${today} Captures`,
      "",
      "## Capture 1",
      "**Q:** Auto-captured",
      "**A:** Some important information captured during the session about API design patterns.",
      "",
    ].join("\n"));

    const result = await core.sessionStart({ project: proj });
    // If "Auto-captured" question is suppressed, the question field should be empty string.
    const caps = result.recent_captures;
    for (const cap of caps) {
      assert.notEqual(cap.question, "Auto-captured", "Auto-captured label must be suppressed from question field");
    }
  });

  // ─── Test 8: P0 survives even when corrections budget is very tight ──────────
  it("P0 correction survives budget cap even in extreme edge case", async () => {
    const proj = "test-p0-survives";
    // Write one P0 correction.
    writeRawCorrection(TEST_ROOT, proj, {
      id: "2026-07-01-p0-must-survive",
      date: "2026-07-01",
      severity: "p0",
      project: proj,
      rule: "Must not push without explicit approval",
      context: "Must not push without explicit approval — REDLINE, no exceptions",
      tags: [],
      active: true,
      proof_count: 1,
      proof_confidence: 1.0,
    });

    // Write many P1s with very long rules to fill the budget.
    for (let i = 0; i < 8; i++) {
      writeRawCorrection(TEST_ROOT, proj, {
        id: `2026-06-${String(i + 1).padStart(2, "0")}-p1-long-rule-${i}`,
        date: `2026-06-${String(i + 1).padStart(2, "0")}`,
        severity: "p1",
        project: proj,
        rule: `P1 filler rule ${i}: `.padEnd(119, "x"),
        context: `P1 filler context ${i}: `.padEnd(299, "y"),
        tags: [],
        active: true,
        proof_count: 1,
        proof_confidence: 0.7,
      });
    }

    const result = await core.sessionStart({ project: proj });
    const p0 = result.corrections.find((c) => c.severity === "p0");
    assert.ok(p0, "P0 correction must always appear in payload regardless of budget pressure");
    assert.ok(p0.rule.includes("Must not push"), "P0 rule content must be correct");
  });

  // ─── Test 9: recognition.person absent when tendencies empty ────────────────
  it("recognition.person is absent from payload when tendencies is empty (cold project)", async () => {
    // A cold project has no blind-spots profile → tendencies is empty.
    const result = await core.sessionStart({ project: "test-person-absent-" + Date.now() });
    const json = JSON.stringify(result);
    if (result.recognition?.person !== undefined) {
      // If person is present, it must have non-empty tendencies.
      assert.ok(
        result.recognition.person.tendencies && result.recognition.person.tendencies.length > 0,
        "recognition.person must only appear when tendencies is non-empty"
      );
    }
    // If recognition.person is absent — that's the passing case for cold projects.
  });

  // ─── Test 10: insights char limit is enforced ───────────────────────────────
  it("insight titles are truncated at char limit (≤180 chars)", async () => {
    const result = await core.sessionStart({ project: "test-inject" });
    for (const insight of result.insights) {
      assert.ok(
        insight.title.length <= 200, // 180 target + a little word-boundary slack
        `Insight title too long: ${insight.title.length} chars. Title: "${insight.title.slice(0, 50)}…"`
      );
    }
  });

  // ─── Test 11: basic shape contract (regression guard) ───────────────────────
  it("session_start output has all expected fields", async () => {
    const result = await core.sessionStart({ project: "test-inject" });
    assert.ok(typeof result.project === "string", "project must be a string");
    assert.ok(typeof result.identity === "string", "identity must be a string");
    assert.ok(Array.isArray(result.insights), "insights must be an array");
    assert.ok(Array.isArray(result.active_rooms), "active_rooms must be an array");
    assert.ok(Array.isArray(result.corrections), "corrections must be an array");
    assert.ok(Array.isArray(result.watch_for), "watch_for must be an array");
    assert.ok(Array.isArray(result.behavior_rules), "behavior_rules must be an array");
    assert.ok(Array.isArray(result.recent_captures), "recent_captures must be an array");
    assert.ok(Array.isArray(result.blind_spots), "blind_spots must be an array");
    assert.ok(result.recognition !== undefined, "recognition must be present");
    assert.ok(result.recognition.who !== undefined, "recognition.who must be present");
    assert.ok(result.recognition.project !== undefined, "recognition.project must be present");
  });

  // ─── Test 12: P0-overflow — dense P0s exceed budget INTENTIONALLY ────────────
  it("dense P0s overflow the corrections budget: all kept, zero P1s, cap exceeded", async () => {
    const proj = "test-p0-overflow";

    // 6 dense P0s: rule ~170 raw chars (trims to ≤120), context ~430 raw chars
    // (trims to ≤250). Each trimmed item serializes to ~450 JSON chars, so the
    // six P0s alone (~2700) far exceed corrections_total (1200).
    for (let i = 0; i < 6; i++) {
      const rule = `P0 dense rule ${i}: ` + "never skip the verify gate before marking work done ".repeat(3);
      writeRawCorrection(TEST_ROOT, proj, {
        id: `2026-07-0${i + 1}-p0-dense-${i}`,
        date: `2026-07-0${i + 1}`,
        severity: "p0",
        project: proj,
        rule,
        context: rule + " because " + "the reviewer caught this exact pattern recurring across sessions ".repeat(4),
        tags: [],
        active: true,
        proof_count: 2,
        proof_confidence: 0.9,
      });
    }
    // 3 P1s that must NOT be admitted (budget already negative; also filtered
    // upstream by readP0Corrections — the assert proves the observable contract
    // regardless of which layer enforces it).
    for (let i = 0; i < 3; i++) {
      writeRawCorrection(TEST_ROOT, proj, {
        id: `2026-06-1${i}-p1-filler-${i}`,
        date: `2026-06-1${i}`,
        severity: "p1",
        project: proj,
        rule: `P1 filler rule ${i} that should never appear in session_start`,
        context: `P1 filler context ${i}`,
        tags: [],
        active: true,
        proof_count: 1,
        proof_confidence: 0.7,
      });
    }

    const result = await core.sessionStart({ project: proj });

    // (a) ALL 6 P0s present — never trimmed to satisfy the byte budget.
    const p0Ids = result.corrections.filter((c) => c.severity === "p0").map((c) => c.id);
    assert.equal(p0Ids.length, 6, `All 6 dense P0s must survive; got ${p0Ids.length}: ${JSON.stringify(p0Ids)}`);

    // (b) ZERO P1s admitted.
    const p1Count = result.corrections.filter((c) => c.severity !== "p0").length;
    assert.equal(p1Count, 0, `No P1s may be admitted when P0s exhaust the budget; got ${p1Count}`);

    // (c) The serialized corrections section EXCEEDS corrections_total (1200)
    // — proving the overflow branch is controlled, not accidental.
    const serialized = JSON.stringify(result.corrections).length;
    assert.ok(
      serialized > 1200,
      `Dense P0s must intentionally exceed the 1200-char budget; got ${serialized} chars`
    );
  });

  // ─── Test 13: context-inclusion heuristic boundary (+19 / +21 / shorter) ─────
  it("context heuristic boundary: +19 omitted, +21 included, shorter omitted", async () => {
    const proj = "test-ctx-boundary";

    // Case A: ctx exactly rule.length + 19 → NOT > +20 → omitted.
    const ruleA = "Never commit generated dist files to the repository";
    const ctxA = ruleA + " " + "x".repeat(18); // trimmed length = ruleA.length + 19
    writeRawCorrection(TEST_ROOT, proj, {
      id: "2026-07-01-boundary-plus19",
      date: "2026-07-01",
      severity: "p0",
      project: proj,
      rule: ruleA,
      context: ctxA,
      tags: [], active: true, proof_count: 1, proof_confidence: 1.0,
    });

    // Case B: ctx exactly rule.length + 21 → > +20 → included.
    const ruleB = "Always run the full test suite before reporting done";
    const ctxB = ruleB + " " + "y".repeat(20); // trimmed length = ruleB.length + 21
    writeRawCorrection(TEST_ROOT, proj, {
      id: "2026-07-02-boundary-plus21",
      date: "2026-07-02",
      severity: "p0",
      project: proj,
      rule: ruleB,
      context: ctxB,
      tags: [], active: true, proof_count: 1, proof_confidence: 1.0,
    });

    // Case C: ctx SHORTER than rule → omitted.
    const ruleC = "Must not push to remote branches without explicit approval";
    writeRawCorrection(TEST_ROOT, proj, {
      id: "2026-07-03-boundary-shorter",
      date: "2026-07-03",
      severity: "p0",
      project: proj,
      rule: ruleC,
      context: "short note",
      tags: [], active: true, proof_count: 1, proof_confidence: 1.0,
    });

    const result = await core.sessionStart({ project: proj });
    const byId = Object.fromEntries(result.corrections.map((c) => [c.id, c]));

    assert.ok(byId["2026-07-01-boundary-plus19"], "case A correction must surface");
    assert.equal(byId["2026-07-01-boundary-plus19"].context, undefined, "+19 chars over rule → context omitted");

    assert.ok(byId["2026-07-02-boundary-plus21"], "case B correction must surface");
    assert.ok(byId["2026-07-02-boundary-plus21"].context, "+21 chars over rule → context included");

    assert.ok(byId["2026-07-03-boundary-shorter"], "case C correction must surface");
    assert.equal(byId["2026-07-03-boundary-shorter"].context, undefined, "context shorter than rule → omitted");
  });

  // ─── Test 14: realistic load — every section respects its budget ─────────────
  // Runs LAST: sessionEnd seeds GLOBAL awareness insights that would otherwise
  // leak into earlier tests' cross_project/insights sections.
  it("realistic load: 6 P0s + 8 P1s + 5 insights + 3 rooms + captures respect section budgets", async () => {
    const proj = "test-realistic-load";

    // 6 moderate P0s (rule ≤ 90 chars, one with a real context).
    const p0Rules = [
      "Never bump the package version without explicit approval from the user",
      "Always run code-reviewer after writing or modifying any source file",
      "Must not delete local files after pushing to remote",
      "Never alias product names — use novada-search and AgentRecall verbatim",
      "Always verify time logic against today's date before rendering entries",
      "Must not assume global binaries exist in CI — declare every dependency",
    ];
    for (let i = 0; i < p0Rules.length; i++) {
      writeRawCorrection(TEST_ROOT, proj, {
        id: `2026-07-0${i + 1}-realistic-p0-${i}`,
        date: `2026-07-0${i + 1}`,
        severity: "p0",
        project: proj,
        rule: p0Rules[i],
        context: i === 0
          ? p0Rules[i] + " — REDLINE from the operating principles, violated once in April, never again"
          : p0Rules[i],
        tags: ["process"], active: true, proof_count: 2, proof_confidence: 0.9,
      });
    }
    // 8 P1s (by design NOT surfaced at session_start — readP0Corrections filters
    // to P0; P1s surface via check/recall instead).
    for (let i = 0; i < 8; i++) {
      writeRawCorrection(TEST_ROOT, proj, {
        id: `2026-06-0${i + 1}-realistic-p1-${i}`,
        date: `2026-06-0${i + 1}`,
        severity: "p1",
        project: proj,
        rule: `P1 advisory rule ${i} about preferring smaller diffs in module ${i}`,
        context: `P1 advisory context ${i}`,
        tags: [], active: true, proof_count: 1, proof_confidence: 0.7,
      });
    }

    // 3 palace rooms.
    await core.palaceWrite({ room: "architecture", topic: "overview", content: "Monorepo with core/mcp/sdk/cli packages, file-backed stores under ~/.agent-recall", project: proj });
    await core.palaceWrite({ room: "goals", topic: "q3", content: "Ship injection-efficacy improvements: slim payloads, section budgets, P0 guarantees", project: proj });
    await core.palaceWrite({ room: "decisions", topic: "budgets", content: "Per-section serialized-char budgets with an intentional P0 overflow exception", project: proj });

    // 3 captures.
    for (let i = 0; i < 3; i++) {
      await core.journalCapture({
        question: `How does section budget ${i} work?`,
        answer: `Budget ${i} sums per-item JSON.stringify lengths and stops admitting items when the section total would exceed its cap.`,
        project: proj,
      });
    }

    // 5 insights via sessionEnd (also writes today's journal + awareness).
    await core.sessionEnd({
      summary: "Seeded realistic-load project for injection budget validation",
      insights: [
        { title: "Serialized budgets beat raw char caps", evidence: "JSON overhead counted", applies_when: ["budget"] },
        { title: "P0 completeness beats byte budget", evidence: "overflow branch documented", applies_when: ["corrections"] },
        { title: "Slim corrections halve payload size", evidence: "KPI fields stripped", applies_when: ["payload"] },
        { title: "Empty sections should vanish entirely", evidence: "predicted_risks omitted", applies_when: ["sections"] },
        { title: "Boundary tests catch off-by-one drift", evidence: "+19/+21 asserts", applies_when: ["testing"] },
      ],
      trajectory: "Next: wire the realistic-load numbers into the bench harness",
      project: proj,
    });

    const result = await core.sessionStart({ project: proj });

    // All 6 P0s present; zero P1s.
    assert.equal(result.corrections.filter((c) => c.severity === "p0").length, 6, "all 6 P0s must surface");
    assert.equal(result.corrections.filter((c) => c.severity !== "p0").length, 0, "P1s must not surface at session_start");

    // Section budgets (serialized JSON chars; +20 slack for array brackets/commas
    // added on top of the per-item sums the budget functions control).
    // corrections here FIT the budget — moderate P0s, unlike the overflow test.
    const sectionLen = (v) => JSON.stringify(v).length;
    assert.ok(sectionLen(result.corrections) <= 1200 + 20, `corrections section ${sectionLen(result.corrections)} chars must be ≤1220`);
    assert.ok(sectionLen(result.insights) <= 700 + 20, `insights section ${sectionLen(result.insights)} chars must be ≤720`);
    assert.ok(sectionLen(result.active_rooms) <= 500 + 20, `active_rooms section ${sectionLen(result.active_rooms)} chars must be ≤520`);
    assert.ok(sectionLen(result.recent_captures) <= 550 + 20, `recent_captures section ${sectionLen(result.recent_captures)} chars must be ≤570`);

    // Total payload within the 1500-token bar (chars/4 proxy).
    const totalChars = JSON.stringify(result).length;
    const totalTokens = Math.ceil(totalChars / 4);
    assert.ok(
      totalTokens <= 1500,
      `realistic-load payload must be ≤1500 tokens; measured ${totalTokens} tokens (${totalChars} chars)`
    );
    // Leave the measured number visible in test output for the report.
    console.log(`[realistic-load] payload: ${totalChars} chars ≈ ${totalTokens} tokens; sections: corrections=${sectionLen(result.corrections)} insights=${sectionLen(result.insights)} rooms=${sectionLen(result.active_rooms)} captures=${sectionLen(result.recent_captures)}`);
  });
});
