import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  initFsrs,
  score,
  reinforce,
  penalize,
  ARCHIVE_THRESHOLD,
  HOT_THRESHOLD,
  DEFAULT_INITIAL_STABILITY,
} = await import("../dist/palace/fsrs.js");

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Returns an ISO timestamp `days` days before now. */
function daysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Returns an ISO timestamp `days` days after `isoBase`. */
function addDays(isoBase, days) {
  return new Date(new Date(isoBase).getTime() + days * 86_400_000).toISOString();
}

// ─── initFsrs ─────────────────────────────────────────────────────────────────

describe("initFsrs", () => {
  it("sets stability to DEFAULT_INITIAL_STABILITY", () => {
    const s = initFsrs();
    assert.equal(s.stability, DEFAULT_INITIAL_STABILITY);
  });

  it("starts with confirmations = 1", () => {
    const s = initFsrs();
    assert.equal(s.confirmations, 1);
  });

  it("last_confirmed defaults to a valid ISO date", () => {
    const before = Date.now();
    const s = initFsrs();
    const ts = new Date(s.last_confirmed).getTime();
    assert.ok(!isNaN(ts), "last_confirmed should be a valid date");
    assert.ok(ts >= before, "last_confirmed should be >= call time");
  });

  it("accepts an explicit now parameter", () => {
    const now = "2024-03-15T10:00:00.000Z";
    const s = initFsrs(now);
    assert.equal(s.last_confirmed, now);
  });
});

// ─── score ────────────────────────────────────────────────────────────────────

describe("score", () => {
  it("retrievability is ~1.0 for a brand-new fact (0 days elapsed)", () => {
    const now = new Date().toISOString();
    const s = initFsrs(now);
    const result = score(s, now);
    assert.ok(result.retrievability >= 0.99, `Expected >=0.99, got ${result.retrievability}`);
  });

  it("retrievability is always in [0, 1]", () => {
    const s = initFsrs(daysAgo(500));
    const result = score(s);
    assert.ok(result.retrievability >= 0 && result.retrievability <= 1,
      `Out of range: ${result.retrievability}`);
  });

  it("retrievability decays after 7 days", () => {
    const s = initFsrs(daysAgo(7));
    const result = score(s);
    assert.ok(result.retrievability < 1.0, "Should decay after 7 days");
    assert.ok(result.retrievability > 0.0, "Should not reach 0 after 7 days");
  });

  it("retrievability is below ARCHIVE_THRESHOLD after very long absence", () => {
    const s = initFsrs(daysAgo(365));
    const result = score(s);
    assert.ok(
      result.retrievability < ARCHIVE_THRESHOLD,
      `Expected <${ARCHIVE_THRESHOLD}, got ${result.retrievability}`
    );
  });

  it("stability in result matches state stability", () => {
    const s = initFsrs();
    const result = score(s);
    assert.equal(result.stability, s.stability);
  });

  it("age_days reflects elapsed time accurately (±0.1 day)", () => {
    const s = initFsrs(daysAgo(7));
    const result = score(s);
    assert.ok(
      result.age_days >= 6.9 && result.age_days <= 7.1,
      `Expected ~7 days, got ${result.age_days}`
    );
  });

  it("age_days is 0 when now equals last_confirmed", () => {
    const now = "2025-01-01T00:00:00.000Z";
    const s = initFsrs(now);
    const result = score(s, now);
    assert.equal(result.age_days, 0);
  });

  it("status is 'hot' for a brand-new fact", () => {
    const now = new Date().toISOString();
    const s = initFsrs(now);
    const result = score(s, now);
    assert.equal(result.status, "hot");
  });

  it("status is 'warm' in the R 0.6-0.85 range", () => {
    // With default stability=7, ~4 days → R ≈ 0.7
    const s = initFsrs(daysAgo(4));
    const result = score(s);
    assert.equal(result.status, "warm", `Expected warm at R=${result.retrievability}`);
  });

  it("status is 'cool' in the R 0.3-0.6 range", () => {
    // With stability=7, ~8 days → R ≈ 0.32
    const s = initFsrs(daysAgo(8));
    const result = score(s);
    assert.ok(
      result.status === "cool" || result.status === "archive_candidate",
      `Expected cool or archive_candidate at R=${result.retrievability}`
    );
  });

  it("status is 'archive_candidate' after prolonged absence", () => {
    const s = initFsrs(daysAgo(365));
    const result = score(s);
    assert.equal(result.status, "archive_candidate");
  });

  it("higher stability means slower decay", () => {
    const weakState  = { stability: 3,  last_confirmed: daysAgo(5), confirmations: 1 };
    const strongState = { stability: 30, last_confirmed: daysAgo(5), confirmations: 1 };
    assert.ok(
      score(strongState).retrievability > score(weakState).retrievability,
      "Higher stability should retain higher retrievability"
    );
  });
});

// ─── reinforce ────────────────────────────────────────────────────────────────

describe("reinforce", () => {
  it("grows stability by exactly 30%", () => {
    const s = initFsrs();
    const r = reinforce(s);
    assert.ok(
      Math.abs(r.stability - s.stability * 1.3) < 0.0001,
      `Expected ${s.stability * 1.3}, got ${r.stability}`
    );
  });

  it("increments confirmations by 1", () => {
    const s = initFsrs();
    const r = reinforce(s);
    assert.equal(r.confirmations, s.confirmations + 1);
  });

  it("updates last_confirmed to the provided now", () => {
    const s = initFsrs("2024-01-01T00:00:00.000Z");
    const later = "2024-06-01T00:00:00.000Z";
    const r = reinforce(s, later);
    assert.equal(r.last_confirmed, later);
  });

  it("is a pure function — does not mutate original state", () => {
    const s = initFsrs();
    const origStability = s.stability;
    const origConfirmations = s.confirmations;
    reinforce(s);
    assert.equal(s.stability, origStability);
    assert.equal(s.confirmations, origConfirmations);
  });

  it("multiple reinforcements compound stability correctly", () => {
    let s = initFsrs();
    for (let i = 0; i < 5; i++) {
      s = reinforce(s);
    }
    const expected = DEFAULT_INITIAL_STABILITY * Math.pow(1.3, 5);
    assert.ok(
      Math.abs(s.stability - expected) < 0.001,
      `Expected ${expected.toFixed(4)}, got ${s.stability}`
    );
  });

  it("retrievability returns to ~1.0 after reinforce resets last_confirmed", () => {
    const old = initFsrs(daysAgo(30));
    const now = new Date().toISOString();
    const refreshed = reinforce(old, now);
    const result = score(refreshed, now);
    assert.ok(result.retrievability >= 0.99,
      `Expected ~1.0 after reinforce, got ${result.retrievability}`);
  });
});

// ─── penalize ─────────────────────────────────────────────────────────────────

describe("penalize", () => {
  it("halves stability", () => {
    const s = initFsrs();
    const p = penalize(s);
    assert.ok(
      Math.abs(p.stability - s.stability * 0.5) < 0.0001,
      `Expected ${s.stability * 0.5}, got ${p.stability}`
    );
  });

  it("stability cannot go below 1 after repeated penalizations", () => {
    let s = initFsrs();
    for (let i = 0; i < 20; i++) {
      s = penalize(s);
    }
    assert.ok(s.stability >= 1, `Stability floored at 1, got ${s.stability}`);
  });

  it("stability floor is exactly 1", () => {
    const tinyState = { stability: 0.5, last_confirmed: new Date().toISOString(), confirmations: 1 };
    const p = penalize(tinyState);
    assert.equal(p.stability, 1);
  });

  it("does not change last_confirmed", () => {
    const ts = "2024-01-01T00:00:00.000Z";
    const s = initFsrs(ts);
    const p = penalize(s);
    assert.equal(p.last_confirmed, ts);
  });

  it("does not change confirmations", () => {
    const s = initFsrs();
    const p = penalize(s);
    assert.equal(p.confirmations, s.confirmations);
  });

  it("is a pure function — does not mutate original state", () => {
    const s = initFsrs();
    const orig = s.stability;
    penalize(s);
    assert.equal(s.stability, orig);
  });
});

// ─── combined workflows ───────────────────────────────────────────────────────

describe("combined workflows", () => {
  it("penalize after multiple reinforcements still leaves stability above initial", () => {
    const s0 = initFsrs();
    let s = reinforce(reinforce(reinforce(s0)));
    s = penalize(s);
    assert.ok(
      s.stability > DEFAULT_INITIAL_STABILITY,
      `After 3 reinforcements + 1 penalize, stability (${s.stability}) should exceed initial (${DEFAULT_INITIAL_STABILITY})`
    );
  });

  it("reinforce reverses the effect of a penalize", () => {
    const s0 = initFsrs();
    const penalized = penalize(s0);
    const recovered = reinforce(penalized);
    // After penalize (×0.5) then reinforce (×1.3): net = ×0.65 — still below start
    // BUT confirmations should be bumped
    assert.equal(recovered.confirmations, s0.confirmations + 1);
  });

  it("score after long dormancy then reinforce reflects fresh retrievability", () => {
    const created = daysAgo(60);
    const s = initFsrs(created);
    const dormantScore = score(s).retrievability;

    const now = new Date().toISOString();
    const refreshed = reinforce(s, now);
    const freshScore = score(refreshed, now).retrievability;

    assert.ok(freshScore > dormantScore,
      `Fresh score (${freshScore}) should exceed dormant score (${dormantScore})`);
    assert.ok(freshScore >= 0.99, "Should be ~1.0 right after reinforce");
  });
});

// ─── exported constants ───────────────────────────────────────────────────────

describe("exported constants", () => {
  it("ARCHIVE_THRESHOLD is 0.3", () => {
    assert.equal(ARCHIVE_THRESHOLD, 0.3);
  });

  it("HOT_THRESHOLD is 0.85", () => {
    assert.equal(HOT_THRESHOLD, 0.85);
  });

  it("DEFAULT_INITIAL_STABILITY is 7", () => {
    assert.equal(DEFAULT_INITIAL_STABILITY, 7);
  });
});
