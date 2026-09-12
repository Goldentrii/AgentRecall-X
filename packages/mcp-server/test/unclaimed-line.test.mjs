/**
 * fix5 (2026-09-11) — the "unclaimed session cards await claim" line.
 *
 * Pure unit test against the exported `formatTerse` formatter (same
 * convention as session-start-continuity.test.mjs: no I/O, no subprocess).
 * Pins the surface contract from the fix5 brief: session_start surfaces AT
 * MOST ONE line for staged sessions, count-only (never staged CONTENT), and
 * nothing at all when the count is absent/zero (absent-when-empty).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatTerse } from "../dist/tools/session-start.js";

/** Minimal valid SessionStartResult — only the fields formatTerse reads. */
function baseResult(overrides = {}) {
  return {
    project: "test-project",
    identity: "",
    insights: [],
    active_rooms: [],
    cross_project: [],
    recent: { today: null, yesterday: null, older_count: 0 },
    recent_captures: [],
    watch_for: [],
    corrections: [],
    resume: null,
    behavior_rules: [],
    dream_health: null,
    store_doctor: null,
    pipeline: null,
    alignment: null,
    blind_spots: [],
    recognition: {
      who: { name: "unknown", role: null, owner: null, unknown: true },
      can_do: { skills: [], permissions: [] },
      project: { slug: "test-project", last_journal_date: null, status: "empty", trajectory: null, rooms: [] },
    },
    ...overrides,
  };
}

describe("fix5 — formatTerse unclaimed line", () => {
  it("renders EXACTLY ONE line when unclaimed_cards > 0, count-only", () => {
    const text = formatTerse(baseResult({ unclaimed_cards: 3 }));
    const matching = text.split("\n").filter((l) => l.includes("unclaimed session card"));
    assert.equal(matching.length, 1, `must be exactly one line, got: ${JSON.stringify(matching)}`);
    assert.ok(matching[0].includes("3 unclaimed session cards await claim"), matching[0]);
    assert.ok(matching[0].includes("ar claim"), "the line must point at the claim op");
  });

  it("singular form for exactly one staged card", () => {
    const text = formatTerse(baseResult({ unclaimed_cards: 1 }));
    assert.ok(text.includes("1 unclaimed session card await claim") || text.includes("1 unclaimed session card awaits claim") || /1 unclaimed session card\b/.test(text));
  });

  it("absent-when-empty: no line at all when the field is undefined or 0", () => {
    for (const v of [undefined, 0]) {
      const text = formatTerse(baseResult({ unclaimed_cards: v }));
      assert.ok(!text.includes("unclaimed"), `no unclaimed line may render for ${v}`);
    }
  });
});
