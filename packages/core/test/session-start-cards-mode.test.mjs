import { it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { useTempCore } from "./helpers/temp-core.mjs";

const t = useTempCore("ar-ss-mode-");
const DAY = 86_400_000;
const FENCE = /⟦\/?agentrecall:memory:[0-9a-f]{16}⟧/g;
const p0 = (slug, id, rule) => {
  const dir = path.join(t.root, "projects", slug, "corrections");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, date: "2026-10-30", severity: "p0", project: slug, rule, tags: [], active: true, proof_count: 1, proof_confidence: 1 }));
};
const EMPTY_KEYS = ["insights", "active_rooms", "cross_project", "recent_captures", "watch_for", "blind_spots"];
const ABSENT_KEYS = ["continuity", "continuity_all_cross_project", "unclaimed_cards", "mirror_available", "predicted_risks"];

it("cards mode: owner, hard rules and state equal the full-mode values; every other section is empty, null or absent; mode is set", async () => {
  const { core } = t, slug = "mode-shape";
  core.writeIdentityCard("# Owner\n- terse");
  core.writeStateCard(slug, core.mergeStateCard({ previous: null, session: "s1", state: { goal: "Ship", blockers: ["CI red"] }, trajectory: "wire the renderer" }).card);
  p0(slug, "2026-10-30-push", "Never push without an explicit yes.");
  await core.journalWrite({ content: "## Brief\nA journal entry so full mode has recent/resume data\n## Next\nmeasure p95\n", project: slug });
  const full = await core.sessionStart({ project: slug, mode: "full" });
  const cards = await core.sessionStart({ project: slug, mode: "cards" });
  assert.deepEqual([full.mode, cards.mode, (await core.sessionStart({ project: slug })).mode], ["full", "cards", "full"], "core default stays full; entry points opt into cards");
  const slim = (r) => r.corrections.map(({ id, severity, rule }) => ({ id, severity, rule })); // tier is recomputed from last_retrieved, which the first call just wrote
  assert.deepEqual([cards.owner, cards.state, slim(cards)], [full.owner, full.state, slim(full)]);
  assert.equal(cards.identity, slug);
  for (const k of EMPTY_KEYS) assert.deepEqual(cards[k], [], k);
  for (const k of ABSENT_KEYS) assert.equal(cards[k], undefined, `${k} must be absent`); // the literal may carry the key with an undefined value, as full mode does today
  assert.deepEqual([cards.resume, cards.pipeline, cards.alignment, cards.recent, cards.behavior_rules, cards.pending_corrections], [null, null, null, { today: null, yesterday: null, older_count: 0 }, [], undefined]);
  assert.equal(cards.recognition.who.unknown, true);
  assert.ok(full.resume && full.recent.today, "control: full mode did read the journal");
  assert.deepEqual(Object.keys(cards).slice(0, 2), ["project", "mode"]);
});

it("cards mode keeps the side effects: unclaimed TTL archive, orphan WM rescue, P0 retrieved outcome once per session, telemetry row", async () => {
  const { core } = t, slug = "mode-effects";
  const staged = path.join(t.root, "_unclaimed", "sid-expired");
  fs.mkdirSync(staged, { recursive: true });
  fs.writeFileSync(path.join(staged, "card.md"), "staged");
  const old = (Date.now() - core.UNCLAIMED_TTL_MS - DAY) / 1000;
  fs.utimesSync(staged, old, old);
  core.wmAppend("sid-orphan-cards", { ts: new Date(Date.now() - 8 * 3_600_000).toISOString(), prompt: "CARDS_MODE_RESCUE_TERM fixing the renderer", cwd: path.join(t.root, "cwd", "mode-effects") });
  const wm = path.join(t.root, "working-memory", "sid-orphan-cards.jsonl");
  const past = (Date.now() - core.WM_LIVE_WINDOW_MS - 600_000) / 1000;
  fs.utimesSync(wm, past, past);
  p0(slug, "2026-10-30-p0", "Never delete without an explicit yes.");
  const before = core.lifecycleStats().byEvent.session_start;

  const r = await core.sessionStart({ project: slug, mode: "cards" });
  assert.equal(r.corrections.length, 1, "the P0 is rendered in cards mode");
  assert.ok(!fs.existsSync(staged) && fs.existsSync(path.join(t.root, "_unclaimed", "_archive", "sid-expired")), "expired unclaimed session archived");
  assert.ok(!fs.existsSync(wm), "orphaned WM file rescued");
  assert.ok(core.readRecentSessions(20).some((s) => s.title.includes("CARDS_MODE_RESCUE_TERM")), "rescue landed in the recency ledger");
  const rec = () => core.readCorrections(slug).find((c) => c.id === "2026-10-30-p0");
  assert.equal(rec().retrieved_count, 1, "retrieved outcome recorded");
  await core.sessionStart({ project: slug, mode: "cards" });
  assert.equal(rec().retrieved_count, 1, "repeat call in the same session does not re-record");
  assert.equal(core.lifecycleStats().byEvent.session_start, before + 2, "telemetry counts both calls");
});

it("cards mode renders behaviour policies and counts the load once per session; a later full call in the same session does not double count", async () => {
  const { core } = t, slug = "mode-policy";
  core.registerBehaviorRule({ project: slug, name: "gate", when: "a release is requested", do: "ask first" });
  const hits = () => core.readBehaviorPolicies(slug).rules[0].hits;
  const cards = await core.sessionStart({ project: slug, mode: "cards" });
  assert.deepEqual([cards.behavior_rules.length, cards.behavior_rules[0].name, hits()], [1, "gate", 1]);
  assert.match(core.renderSessionStart(cards), /📜 Behavior policies \(always follow\):\n {2}• \[gate\] WHEN a release is requested → DO ask first/);
  await core.sessionStart({ project: slug, mode: "cards" });
  assert.equal(hits(), 1, "a repeat call in the same session does not re-count");
  const full = await core.sessionStart({ project: slug, mode: "full" });
  assert.deepEqual([full.behavior_rules.length, hits()], [1, 1]);
});

it("cards mode surfaces the pending-review count (so the TTL sweep ran) and never the staged text", async () => {
  const { core } = t, slug = "mode-pending";
  await core.stagePendingCorrection(slug, { kind: "correction", channel: "check_string", text: "Never merge without a green CI run PENDING_STAGED_TEXT", reason: "string-form capture" });
  const r = await core.sessionStart({ project: slug, mode: "cards" });
  assert.equal(r.pending_corrections?.count, 1);
  const text = core.renderSessionStart(r);
  assert.ok(text.includes("⏳ 1 pending corrections await review") && !text.includes("PENDING_STAGED_TEXT"), text);
});

it("a repeat cards call in the same session returns the same owner, state and rules (only the write side is idempotent)", async () => {
  const { core } = t, slug = "mode-repeat";
  core.writeIdentityCard("# Owner\n- repeat");
  core.writeStateCard(slug, core.mergeStateCard({ previous: null, session: "s1", state: { goal: "Again" } }).card);
  p0(slug, "2026-10-30-r", "Never rebase main.");
  const slim = (r) => ({ owner: r.owner, state: r.state, rules: r.corrections.map(({ id, severity, rule }) => ({ id, severity, rule })) });
  const a = await core.sessionStart({ project: slug, mode: "cards" }), b = await core.sessionStart({ project: slug, mode: "cards" });
  assert.deepEqual(slim(b), slim(a));
  const untagged = (r) => core.renderSessionStart(r).replace(FENCE, "").replace(/ \[(gate|nudge|watch)\]/g, ""); // the tier tag is recomputed from last_retrieved, which the first call wrote
  assert.equal(untagged(b), untagged(a));
});

it("cards mode empty state: only when there is no owner card, no P0, no behaviour policy and no state content", async () => {
  const { core } = t;
  fs.rmSync(path.join(t.root, "identity-card.md"), { force: true });
  const bare = await core.sessionStart({ project: "mode-bare", mode: "cards" });
  assert.match(bare.empty_state ?? "", /No cards yet for mode-bare/);
  core.writeIdentityCard("# Owner\n- back");
  const ownerOnly = await core.sessionStart({ project: "mode-owner-only", mode: "cards" });
  assert.equal(ownerOnly.empty_state, undefined);
  fs.rmSync(path.join(t.root, "identity-card.md"), { force: true });
  p0("mode-p0-only", "2026-10-30-x", "Never force-push.");
  assert.equal((await core.sessionStart({ project: "mode-p0-only", mode: "cards" })).empty_state, undefined);
  core.registerBehaviorRule({ project: "mode-policy-only", name: "gate", when: "x", do: "y" });
  assert.equal((await core.sessionStart({ project: "mode-policy-only", mode: "cards" })).empty_state, undefined);
  fs.mkdirSync(path.dirname(core.stateCardPath("mode-fm-only")), { recursive: true });
  fs.writeFileSync(core.stateCardPath("mode-fm-only"), `---\nkind: state-card\nupdated: ${new Date().toISOString()}\nsession: s\n---\n`);
  assert.match((await core.sessionStart({ project: "mode-fm-only", mode: "cards" })).empty_state ?? "", /No cards yet/);
});
