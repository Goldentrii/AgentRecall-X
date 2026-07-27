/**
 * Equivalence tests for the session_start single-scan perf refactor
 * (2026-07-27, corrections.ts / predict-correction.ts / recognition-builder.ts).
 *
 * The refactor gave four functions an optional `preloaded`/`preloadedCorrections`
 * parameter so session_start can read corrections/*.json ONCE and reuse the
 * in-memory array instead of each function independently re-scanning the
 * directory:
 *   - readActiveCorrections(project, preloaded?)
 *   - readP0Corrections(project, preloaded?)
 *   - getCorrectionKPIs(project, preloaded?)
 *   - predictCorrection({ ..., preloadedCorrections? }) (+ its lazy
 *     recomputeBlindSpots(project, preloaded?) fallback)
 *   - buildRecognition(project, { ..., preloadedCorrections? }) -> readCapabilities
 *
 * This is a PURE refactor: passing the preloaded array must produce output
 * BYTE-IDENTICAL to the original (no-arg) call for the same on-disk data.
 * These tests seed one store and assert deepEqual between the "new" call
 * (preloaded array threaded through, mirroring exactly what session-start.ts
 * now does) and the "old" call (no second argument — the pre-fix calling
 * convention, still fully supported and exercised by every OTHER caller in
 * the codebase that was not touched by this refactor).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-preloaded-equiv-" + Date.now());
const PROJECT = "equiv-proj";

function writeRawCorrection(root, project, record) {
  const dir = path.join(root, "projects", project, "corrections");
  fs.mkdirSync(dir, { recursive: true });
  const slug = record.id.replace(/[^a-zA-Z0-9_-]/g, "-");
  fs.writeFileSync(path.join(dir, `${record.date}--${slug}.json`), JSON.stringify(record, null, 2));
}

describe("corrections preloaded-array equivalence (session_start single-scan fix)", () => {
  let core;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core = await import("../dist/index.js");
    core.setRoot(TEST_ROOT);

    // Seed a varied store: P0s (with outcome counters), P1s, retracted, and a
    // permission-flavored rule (trips recognition-builder's PERMISSION_RE) —
    // enough real data for every derivation path to have something to chew on.
    writeRawCorrection(TEST_ROOT, PROJECT, {
      id: "2026-03-01-p0-approval",
      date: "2026-03-01",
      severity: "p0",
      project: PROJECT,
      rule: "Never deploy without explicit approval from the owner",
      context: "Never deploy without explicit approval from the owner",
      tags: ["gate"],
      active: true,
      retrieved_count: 5,
      heeded_count: 4,
      recurrence_count: 1,
    });
    writeRawCorrection(TEST_ROOT, PROJECT, {
      id: "2026-03-02-p0-secrets",
      date: "2026-03-02",
      severity: "p0",
      project: PROJECT,
      rule: "Never paste credentials into chat or commits",
      context: "Never paste credentials into chat or commits",
      tags: ["security"],
      active: true,
      retrieved_count: 3,
      heeded_count: 3,
    });
    for (let i = 0; i < 5; i++) {
      writeRawCorrection(TEST_ROOT, PROJECT, {
        id: `2026-03-1${i}-p1-style-${i}`,
        date: `2026-03-1${i}`,
        severity: "p1",
        project: PROJECT,
        rule: `Prefer descriptive variable names in module ${i}`,
        context: `Prefer descriptive variable names in module ${i}`,
        tags: [],
        active: i % 2 === 0,
      });
    }
    // A retracted P0 — must be excluded from active/P0 derivations either way.
    writeRawCorrection(TEST_ROOT, PROJECT, {
      id: "2026-03-20-p0-retracted",
      date: "2026-03-20",
      severity: "p0",
      project: PROJECT,
      rule: "Never use the retracted legacy API",
      context: "Never use the retracted legacy API",
      tags: [],
      active: false,
      retracted_at: "2026-03-21T00:00:00.000Z",
    });
  });

  after(() => {
    core.resetRoot?.();
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("readActiveCorrections(project, preloaded) === readActiveCorrections(project)", () => {
    const all = core.readCorrections(PROJECT);
    const oldStyle = core.readActiveCorrections(PROJECT);
    const newStyle = core.readActiveCorrections(PROJECT, all);
    assert.deepEqual(newStyle, oldStyle);
    assert.ok(oldStyle.length > 0, "sanity: fixture has active corrections");
    assert.ok(!oldStyle.some((c) => c.id === "2026-03-20-p0-retracted"), "retracted record excluded");
  });

  it("readP0Corrections(project, preloaded) === readP0Corrections(project)", () => {
    const all = core.readCorrections(PROJECT);
    const oldStyle = core.readP0Corrections(PROJECT);
    const newStyle = core.readP0Corrections(PROJECT, all);
    assert.deepEqual(newStyle, oldStyle);
    assert.deepEqual(
      oldStyle.map((r) => r.id).sort(),
      ["2026-03-01-p0-approval", "2026-03-02-p0-secrets"],
      "only the two ACTIVE p0s, retracted p0 excluded",
    );
  });

  it("getCorrectionKPIs(project, preloaded) === getCorrectionKPIs(project)", () => {
    const all = core.readCorrections(PROJECT);
    const oldStyle = core.getCorrectionKPIs(PROJECT);
    const newStyle = core.getCorrectionKPIs(PROJECT, all);
    assert.deepEqual(newStyle, oldStyle);
    assert.equal(oldStyle.retrieved, 8); // 5 + 3 seeded retrieved_count
    assert.equal(oldStyle.heeded, 7); // 4 + 3 seeded heeded_count
  });

  it("predictCorrection({ preloadedCorrections }) === predictCorrection({}) for the same plan", async () => {
    // Use a project the P0-B/predicted-outcome instrumentation never touches
    // (no session_start call against it) so calling predictCorrection twice
    // here is side-effect-neutral between the two invocations being compared.
    const proj = "equiv-predict-proj";
    writeRawCorrection(TEST_ROOT, proj, {
      id: "2026-04-01-p0-review",
      date: "2026-04-01",
      severity: "p0",
      project: proj,
      rule: "Never skip code review before merging",
      context: "Never skip code review before merging",
      tags: [],
      active: true,
    });
    const active = core.readActiveCorrections(proj);

    const oldStyle = await core.predictCorrection({
      plan: "Skip code review and merge directly to main",
      project: proj,
    });
    const newStyle = await core.predictCorrection({
      plan: "Skip code review and merge directly to main",
      project: proj,
      preloadedCorrections: active,
    });

    assert.deepEqual(newStyle, oldStyle);
  });

  it("buildRecognition(project, { preloadedCorrections }).can_do === buildRecognition(project).can_do", () => {
    const active = core.readActiveCorrections(PROJECT);
    const oldStyle = core.buildRecognition(PROJECT);
    const newStyle = core.buildRecognition(PROJECT, { preloadedCorrections: active });

    assert.deepEqual(newStyle.can_do, oldStyle.can_do);
    assert.ok(oldStyle.can_do.permissions.length > 0, "sanity: fixture trips PERMISSION_RE (never/approval/credential)");
    // The full payload (who/project/person too) is unaffected by this param.
    assert.deepEqual(newStyle, oldStyle);
  });
});
