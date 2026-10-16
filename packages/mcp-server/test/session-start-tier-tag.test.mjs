/**
 * Evolution p4 (2026-09-17) — session_start's additive tier-tag render.
 *
 * ASSERT_INVARIANT under test: the tag is PRESENTATION ONLY. This file
 * proves it the way the brief's constraint demands — "byte-identical apart
 * from the tag" — by rendering the SAME `corrections` array twice (once
 * with `tier` populated, once with it stripped) and diffing the two
 * renders after mechanically removing the tag pattern from the first. If
 * the tag touched anything else (ordering, truncation, budget, severity
 * bracket), this diff would NOT come out empty.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatTerse, formatVerbose } from "../dist/tools/session-start.js";

/** Minimal valid SessionStartResult — only the fields these formatters read. */
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
    recognition: { who: { name: "unknown", role: null, owner: null, unknown: true }, can_do: { skills: [], permissions: [] }, project: { slug: "test-project", last_journal_date: null, status: "empty", trajectory: null, rooms: [] } },
    ...overrides,
  };
}

/** Strips a trailing " [gate]"/" [nudge]"/" [watch]" tag from every line. */
function stripTierTags(text) {
  return text.replace(/ \[(gate|nudge|watch)\]/g, "");
}

/**
 * Normalizes the per-render fence nonce (fix 3.5.2, content-guard.ts) so two
 * independent renders can be diffed byte-for-byte. The nonce is DELIBERATELY
 * fresh per render — it is presentation-security, not content — so the
 * additivity proofs below compare renders modulo the nonce.
 */
function normalizeFenceNonce(text) {
  return text.replace(/⟦(\/?)agentrecall:memory:[0-9a-f]{4}⟧/g, "⟦$1agentrecall:memory:0000⟧");
}

const CORRECTIONS_WITH_TIER = [
  { id: "c1", severity: "p0", rule: "Never push without explicit approval.", tier: "gate" },
  { id: "c2", severity: "p0", rule: "Always run tests before merging.", tier: "nudge" },
  { id: "c3", severity: "p1", rule: "Prefer descriptive variable names.", context: "extra context text that is materially longer than the rule text itself, so it renders in verbose mode too", tier: "watch" },
];

const CORRECTIONS_WITHOUT_TIER = CORRECTIONS_WITH_TIER.map(({ tier, ...rest }) => rest);

describe("session_start render — evolution p4 tier tag (additive-only proof)", () => {
  describe("formatTerse", () => {
    it("renders the [gate]/[nudge]/[watch] tag suffix on each P0/P1 rule line", () => {
      const text = formatTerse(baseResult({ corrections: CORRECTIONS_WITH_TIER }));
      assert.ok(text.includes("[P0] Never push without explicit approval. [gate]"));
      assert.ok(text.includes("[P0] Always run tests before merging. [nudge]"));
      assert.ok(text.includes("[P1] Prefer descriptive variable names. [watch]"));
    });

    it("omits the tag entirely when `tier` is absent (pre-p4 fixture / back-compat)", () => {
      const text = formatTerse(baseResult({ corrections: CORRECTIONS_WITHOUT_TIER }));
      assert.ok(!/\[(gate|nudge|watch)\]/.test(text), "no tier bracket should appear anywhere");
      assert.ok(text.includes("[P0] Never push without explicit approval."));
    });

    it("ADDITIVITY PROOF: stripping the tier tag from the tagged render reproduces the untagged render byte-for-byte", () => {
      const tagged = formatTerse(baseResult({ corrections: CORRECTIONS_WITH_TIER }));
      const untagged = formatTerse(baseResult({ corrections: CORRECTIONS_WITHOUT_TIER }));
      assert.equal(normalizeFenceNonce(stripTierTags(tagged)), normalizeFenceNonce(untagged));
    });

    it("does not reorder or drop any correction — same count, same order, same severity brackets, regardless of tier", () => {
      const tagged = formatTerse(baseResult({ corrections: CORRECTIONS_WITH_TIER }));
      const untagged = formatTerse(baseResult({ corrections: CORRECTIONS_WITHOUT_TIER }));
      const extractOrder = (text) =>
        [...text.matchAll(/\[(P0|P1)\]/g)].map((m) => m[1]);
      assert.deepEqual(extractOrder(tagged), extractOrder(untagged));
      assert.deepEqual(extractOrder(tagged), ["P0", "P0", "P1"]);
    });
  });

  describe("formatVerbose", () => {
    it("renders the tag suffix on the rule line, before the ctx: line", () => {
      const text = formatVerbose(baseResult({ corrections: CORRECTIONS_WITH_TIER }));
      assert.ok(text.includes("[P1] Prefer descriptive variable names. [watch]"));
      const tagLineIdx = text.indexOf("[P1] Prefer descriptive variable names. [watch]");
      const ctxIdx = text.indexOf("ctx: extra context text");
      assert.ok(tagLineIdx >= 0 && ctxIdx >= 0 && tagLineIdx < ctxIdx);
    });

    it("ADDITIVITY PROOF: stripping the tier tag reproduces the untagged verbose render byte-for-byte", () => {
      const tagged = formatVerbose(baseResult({ corrections: CORRECTIONS_WITH_TIER }));
      const untagged = formatVerbose(baseResult({ corrections: CORRECTIONS_WITHOUT_TIER }));
      assert.equal(normalizeFenceNonce(stripTierTags(tagged)), normalizeFenceNonce(untagged));
    });
  });
});
