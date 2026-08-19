/**
 * F2 — "⏪ Continuity" terse-render section (continuity wave, 2026-07-31).
 *
 * Pure unit test against the exported `formatTerse` formatter (no I/O, no
 * subprocess) — constructs a minimal SessionStartResult-shaped object and
 * asserts the rendered text. Covers: section present with entries, section
 * omitted entirely when `continuity` is absent/empty (no noise on a
 * fresh/solo-project store), next_step rendering, and placement relative
 * to the pre-existing top banners (dream_health / store_doctor / alignment
 * stay first-priority; continuity renders before the per-project header).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatTerse, formatLite } from "../dist/tools/session-start.js";

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
    recognition: { who: { name: "unknown", role: null, owner: null, unknown: true }, can_do: { skills: [], permissions: [] }, project: { slug: "test-project", last_journal_date: null, status: "empty", trajectory: null, rooms: [] } },
    ...overrides,
  };
}

describe("mcp-server session_start terse render — Continuity section", () => {
  it("omits the Continuity section entirely when `continuity` is absent (no noise)", () => {
    const text = formatTerse(baseResult());
    assert.ok(!text.includes("⏪ Continuity"), "must not render an empty/noisy Continuity header");
  });

  it("omits the Continuity section when `continuity` is an empty array", () => {
    const text = formatTerse(baseResult({ continuity: [] }));
    assert.ok(!text.includes("⏪ Continuity"));
  });

  it("renders a top Continuity section with entries, including cross-project slug and next_step", () => {
    const text = formatTerse(baseResult({
      continuity: [
        { ago: "5m ago", slug: "novada-mcp", title: "MCP page redesign spec locked", next_step: "implement app/mcp/page.tsx wizard" },
        { ago: "2h ago", slug: "AgentRecall", title: "continuity wave design doc written" },
      ],
    }));
    assert.ok(text.includes("⏪ Continuity"), "Continuity header must be present");
    assert.ok(text.includes("5m ago"));
    assert.ok(text.includes("[novada-mcp]"));
    assert.ok(text.includes("MCP page redesign spec locked"));
    assert.ok(text.includes("next: implement app/mcp/page.tsx wizard"));
    assert.ok(text.includes("2h ago"));
    assert.ok(text.includes("[AgentRecall]"));
  });

  it("renders the Continuity section before the per-project header line", () => {
    const text = formatTerse(baseResult({
      continuity: [{ ago: "1m ago", slug: "other-project", title: "some recent work" }],
    }));
    const continuityIdx = text.indexOf("⏪ Continuity");
    const headerIdx = text.indexOf("AgentRecall — test-project");
    assert.ok(continuityIdx >= 0 && headerIdx >= 0, "both sections must be present");
    assert.ok(continuityIdx < headerIdx, "Continuity must render before the project header (top section)");
  });

  it("renders after the alignment/store_doctor banners when they are present (alerts stay first)", () => {
    const text = formatTerse(baseResult({
      store_doctor: "🟡 Store-doctor: 2 warnings",
      continuity: [{ ago: "1m ago", slug: "other-project", title: "some recent work" }],
    }));
    const storeDoctorIdx = text.indexOf("Store-doctor");
    const continuityIdx = text.indexOf("⏪ Continuity");
    assert.ok(storeDoctorIdx >= 0 && continuityIdx >= 0);
    assert.ok(storeDoctorIdx < continuityIdx, "integrity/health banners must stay first-priority, above Continuity");
  });
});

/** Minimal valid SessionStartLiteResult — only the fields formatLite reads. */
function baseLiteResult(overrides = {}) {
  return {
    project: "test-project",
    identity_oneliner: "",
    last_session_date: null,
    active_phase: null,
    active_phase_goal: null,
    open_corrections_p0_count: 0,
    total_sessions: 0,
    total_skills: 0,
    store_doctor: null,
    continuity: null,
    hint: "Lite mode. Call recall(query) for memories.",
    ...overrides,
  };
}

describe("mcp-server session_start lite render — Continuity line", () => {
  it("omits the ⏪ line when continuity is null", () => {
    const text = formatLite(baseLiteResult());
    assert.ok(!text.includes("⏪"));
  });

  it("renders the ⏪ line right after the header, inside the P1 memory fence", () => {
    // P1 fence (TOW2-388): formatLite now wraps its memory-bearing body
    // (continuity/identity/active-phase) in a fenceMemory() block. The
    // header (structural, non-memory) stays at line[0]; line[1] is the
    // fence-open marker; the continuity content is the first line INSIDE
    // the fence, one line later than before this change.
    const text = formatLite(baseLiteResult({ continuity: "5m ago [novada-mcp] MCP page redesign spec locked" }));
    const lines = text.split("\n");
    assert.equal(lines[0].startsWith("AgentRecall (lite)"), true);
    assert.ok(lines[1].includes("retrieved memory"), "line[1] must be the fence-open marker");
    assert.equal(lines[2], "⏪ 5m ago [novada-mcp] MCP page redesign spec locked");
  });
});
