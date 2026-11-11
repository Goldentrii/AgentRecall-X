import { it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { register, formatTerse } from "../dist/tools/session-start.js";
import { renderSessionStart } from "agent-recall-core";

const strip = (t) => t.replace(/⟦\/?agentrecall:memory:[0-9a-f]{16}⟧/g, "");
const RECOGNITION = { who: { name: "unknown", role: null, owner: null, unknown: true }, can_do: { skills: [], permissions: [] }, project: { slug: "p", last_journal_date: null, status: "empty", trajectory: null, rooms: [] } };
const fixture = { project: "p", identity: "p", corrections: [{ id: "c", severity: "p0", rule: "Never push." }], insights: [{ title: "an insight", confirmed: 2, severity: "important" }], active_rooms: [], cross_project: [], recent: { today: null, yesterday: null, older_count: 0 }, recent_captures: [], watch_for: [], resume: null, behavior_rules: [], dream_health: null, store_doctor: null, pipeline: null, alignment: null, blind_spots: [], recognition: RECOGNITION };

it("schema: mode is an optional cards|full|lite (the handler defaults it); the description names the default and keeps the ENTRY lead tag", () => {
  let def;
  register({ registerTool: (_name, d) => { def = d; } });
  const mode = def.inputSchema.mode;
  assert.deepEqual([mode.safeParse(undefined).success, mode.parse(undefined), mode.safeParse("cards").success, mode.safeParse("full").success, mode.safeParse("lite").success, mode.safeParse("rich").success], [true, undefined, true, true, true, false]);
  for (const m of ["mode='cards'", "mode='full'", "mode='lite'", "verbose"]) assert.ok(def.description.includes(m), m);
  assert.ok(def.description.startsWith("[ENTRY — call FIRST, before acting]"));
});

it("formatTerse is the core renderer (hook-less tail included outside Claude Code)", () => {
  assert.equal(strip(formatTerse(fixture)), strip(renderSessionStart(fixture, { hooklessTail: !process.env.CLAUDE_CODE_HOOKS })));
  assert.equal(strip(formatTerse({ ...fixture, mode: "cards" })), strip(renderSessionStart({ ...fixture, mode: "cards" }, { hooklessTail: !process.env.CLAUDE_CODE_HOOKS })));
});

it("handler: no mode → cards text; verbose without a mode → full JSON; explicit cards + verbose → cards JSON; mode 'full' renders the journal brief", async () => {
  const core = await import("agent-recall-core"), root = fs.mkdtempSync(path.join(os.tmpdir(), "ar-mcp-mode-"));
  let handler;
  register({ registerTool: (_name, _d, h) => { handler = h; } });
  core.setRoot(root);
  try {
    const slug = "mcp-mode", dir = path.join(root, "projects", slug, "corrections");
    core.writeIdentityCard("# Owner\n- terse");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "2026-10-31-p0.json"), JSON.stringify({ id: "2026-10-31-p0", date: "2026-10-31", severity: "p0", project: slug, rule: "Never push.", tags: [], active: true, proof_count: 1, proof_confidence: 1 }));
    core.writeStateCard(slug, core.mergeStateCard({ previous: null, session: "s", state: { goal: "Ship" } }).card);
    await core.journalWrite({ content: "## Brief\nmcp mode fixture brief\n", project: slug });
    const text = async (args) => (await handler({ project: slug, verbose: false, ...args })).content[0].text;
    const cards = await text({});
    for (const s of ["Owner (identity card v1)", `AgentRecall — ${slug}`, "⛔ HARD RULES", "[P0] Never push.", "State (updated", "Goal: Ship"]) assert.ok(cards.includes(s), `cards payload lacks ${s}: ${cards}`);
    assert.doesNotMatch(cards, /📓|sessions: |Intention:/);
    const full = await text({ mode: "full" });
    assert.match(full, /📓 Today: mcp mode fixture brief/);
    assert.match(full, /sessions: 1/);
    const verboseDefault = await text({ verbose: true });
    assert.ok(verboseDefault.includes('"mode": "full"') && verboseDefault.includes('"today": "mcp mode fixture brief"'), verboseDefault.slice(0, 600));
    const verboseCards = await text({ mode: "cards", verbose: true });
    assert.ok(verboseCards.includes('"mode": "cards"') && verboseCards.includes("## ⛔ HARD RULES") && !verboseCards.includes("mcp mode fixture brief"), verboseCards.slice(0, 400));
  } finally { core.resetRoot(); fs.rmSync(root, { recursive: true, force: true }); }
});
