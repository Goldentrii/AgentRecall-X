import { it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { renderSessionStart, sessionStartSections, sessionStartMaxBytes } from "../dist/index.js";

const FULL = JSON.parse(fs.readFileSync(new URL("./fixtures/session-start-full-result.json", import.meta.url), "utf-8"));
const EXPECTED = fs.readFileSync(new URL("./fixtures/session-start-full-terse.txt", import.meta.url), "utf-8").replace(/\r\n/g, "\n");
const FENCE_LINE = /^⟦\/?agentrecall:memory:[0-9a-f]{16}⟧/;
const strip = (text) => text.split("\n").filter((l) => !FENCE_LINE.test(l)).join("\n") + "\n";
const nonEmpty = (r) => sessionStartSections(r).filter((s) => s.lines.some(Boolean));
const ids = (r) => nonEmpty(r).map((s) => s.id);
const UNTOUCHABLE = ["dream_health", "store_doctor", "hard_rules"];
const CARDS = {
  project: "p", mode: "cards", owner: { version: 1, body: "# Owner" }, identity: "p",
  corrections: [{ id: "c", severity: "p0", rule: "Never push." }], state: { ...FULL.state },
  insights: [], active_rooms: [], cross_project: [], recent: { today: null, yesterday: null, older_count: 0 }, recent_captures: [], watch_for: [],
  resume: null, behavior_rules: [], dream_health: null, store_doctor: null, pipeline: null, alignment: null, blind_spots: [], recognition: FULL.recognition,
};

it("full mode renders byte-for-byte what the pre-slice MCP formatTerse rendered (fence nonce lines aside); a missing mode reads as full", () => {
  assert.equal(strip(renderSessionStart(FULL, { hooklessTail: true })), EXPECTED);
});

it("the Trajectory line is dropped when the state card carries Next; nothing else moves", () => {
  const withNext = { ...FULL, state: { ...FULL.state, next: "Wire the consumer retry budget" } };
  const out = strip(renderSessionStart(withNext, { hooklessTail: true }));
  assert.ok(!out.includes("Trajectory:") && out.includes("\nNext: Wire the consumer retry budget\n"), out);
  assert.equal(out.replace("Next: Wire the consumer retry budget\n", ""), EXPECTED.replace("Trajectory: Wire the consumer retry budget and measure p95.\n", ""));
});

it("cards mode renders owner, header, hard rules and state only, in that order, inside one fence, with no tail unless asked", () => {
  assert.deepEqual(ids(CARDS), ["owner", "header", "hard_rules", "state"]);
  const text = renderSessionStart(CARDS);
  const close = text.search(/⟦\/agentrecall:memory:[0-9a-f]{16}⟧/);
  assert.ok(text.startsWith("⟦agentrecall:memory:") && close > 0 && text.slice(close).trimEnd().endsWith("⟧"), "fence first and last, no tail");
  const at = ["Owner (identity card v1)", "AgentRecall — p", "⛔ HARD RULES", "[P0] Never push.", "State (updated 2026-10-31"].map((s) => text.indexOf(s));
  assert.ok(at.every((x, i) => x > 0 && (i === 0 || x > at[i - 1])), JSON.stringify(at));
  assert.doesNotMatch(text, /sessions: |Intention:|Trajectory:|💡|⏪|📓|Hook-less/);
});

it("a bare cards payload is the header plus the empty line core sets; the full-mode header keeps the session counts", () => {
  const bare = { ...CARDS, corrections: [], empty_state: "No cards yet for p — session_end writes the state card; ar identity init creates the owner card." };
  delete bare.owner;
  delete bare.state;
  assert.deepEqual(ids(bare), ["header", "empty_state"]);
  assert.match(strip(renderSessionStart(bare)), /^AgentRecall — p\n\nNo cards yet for p — session_end writes the state card; ar identity init creates the owner card\.\n$/);
  assert.match(renderSessionStart(FULL), /AgentRecall — alpha-platform   sessions: 9   last: 2026-10-31\n/);
});

it("byte cap: whole sections go lowest priority first; untouchable sections never; the cut marker closes the fence", () => {
  const opts = { hooklessTail: true };
  const bytes = Buffer.byteLength(renderSessionStart(FULL, opts));
  assert.equal(strip(renderSessionStart(FULL, { ...opts, maxBytes: bytes })), strip(renderSessionStart(FULL, opts)), "a cap equal to the size changes nothing");
  const sections = nonEmpty(FULL), probe = (s) => s.lines.find(Boolean);
  const floor = Buffer.byteLength(renderSessionStart(FULL, { ...opts, maxBytes: 1 }));
  assert.ok(floor < bytes / 2, `floor ${floor} should be far below ${bytes}`);
  for (let cap = bytes - 1; cap > floor + 16; cap -= 53) {
    const text = renderSessionStart(FULL, { ...opts, maxBytes: cap });
    assert.ok(Buffer.byteLength(text) <= cap, `cap ${cap}: rendered ${Buffer.byteLength(text)} bytes`);
    const kept = sections.filter((s) => text.includes(probe(s)));
    const maxRank = Math.max(0, ...kept.filter((s) => s.rank > 0).map((s) => s.rank));
    for (const s of sections) {
      // while any droppable section is still shown, every lower rank and every rank-0 section must be intact
      const mustKeep = UNTOUCHABLE.includes(s.id) || (maxRank > 0 && (s.rank === 0 || s.rank < maxRank));
      if (mustKeep) assert.ok(kept.includes(s), `cap ${cap}: ${s.id} (rank ${s.rank}) missing while rank ${maxRank} is kept`);
    }
    assert.match(text, /\n… session_start payload cut to \d+ bytes \(set AGENT_RECALL_SESSION_START_MAX_BYTES to change\)\n⟦\/agentrecall:memory:/);
  }
  const tiny = renderSessionStart(FULL, { ...opts, maxBytes: 1 });
  for (const line of ["🔴 dream cron", "🩺 store-doctor", "⛔ HARD RULES (always follow, no exceptions):", "[P0] Never push, publish or version-bump without an explicit yes. [gate]", "[P1] Prefer modifying an existing module over a new one. [nudge]", "Owner (identity card v3)", "AgentRecall — alpha-platform", "payload cut to 1 bytes"]) assert.ok(tiny.includes(line), `tiny cap lost: ${line}`);
  assert.doesNotMatch(tiny, /Languages: reply|State \(updated|Goal: Ship|⚠ Watch|Intention:/);
  assert.ok(tiny.includes("Hook-less host? call brief()"), "the unfenced tail is guidance, never cut");
});

it("the cap counts UTF-8 bytes: an 800-char CJK owner body trips a cap an 800-char ASCII body fits", () => {
  const mk = (body) => ({ ...CARDS, owner: { version: 1, body } });
  assert.ok(!renderSessionStart(mk("a".repeat(800)), { maxBytes: 1700 }).includes("payload cut"));
  assert.ok(renderSessionStart(mk("字".repeat(800)), { maxBytes: 1700 }).includes("payload cut"));
});

it("sessionStartMaxBytes: env override from 1024 up, otherwise the 16384 default", () => {
  const env = (v) => ({ AGENT_RECALL_SESSION_START_MAX_BYTES: v });
  assert.deepEqual([sessionStartMaxBytes({}), sessionStartMaxBytes(env("4096")), sessionStartMaxBytes(env("1024")), sessionStartMaxBytes(env("lots")), sessionStartMaxBytes(env("0")), sessionStartMaxBytes(env("1000"))], [16384, 4096, 1024, 16384, 16384, 16384]);
});

it("preamble goes before the fence, extraLines inside it in full mode only, the hookless tail after it", () => {
  const text = renderSessionStart(FULL, { preamble: ["⚠️ AgentRecall: 1 hook failure (24h)"], extraLines: ["🔍 Pre-loaded semantic context:", "   [journal] x"], hooklessTail: true });
  assert.ok(text.startsWith("⚠️ AgentRecall: 1 hook failure (24h)\n⟦agentrecall:memory:"), text.slice(0, 120));
  const close = text.search(/⟦\/agentrecall:memory:[0-9a-f]{16}⟧/);
  assert.ok(text.indexOf("🔍 Pre-loaded semantic context:") < close && text.indexOf("Hook-less host? call brief()") > close);
  assert.ok(!renderSessionStart(CARDS, { extraLines: ["🔍 Pre-loaded semantic context:"] }).includes("🔍"), "extra lines are a full-mode affordance");
  assert.equal((text.match(/⟦agentrecall:memory:[0-9a-f]{16}⟧/g) ?? []).length, 1, "exactly one fence");
});
