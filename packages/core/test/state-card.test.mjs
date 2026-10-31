import { it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { useTempCore, stderrOf } from "./helpers/temp-core.mjs";

const t = useTempCore("ar-state-card-"), NOW = new Date("2026-10-31T11:40:12.000Z");
const items = (n, len, tag) => Array.from({ length: n }, (_, i) => `${tag}${i}`.padEnd(len, "x"));
const merge = (a) => t.core.mergeStateCard({ previous: null, session: "s1", now: NOW, ...a });

it("null when nothing to write; absent fields carry forward; provided (even []) replace; trajectory fills next", () => {
  assert.equal(merge({}), null);
  const prev = merge({ summary: "first", state: { goal: "G1", blockers: ["B1"], next: "N1", pointers: ["p1"] } }).card;
  const a = merge({ previous: prev, state: { blockers: [] }, trajectory: "T2", summary: "Second;\nsession." }).card;
  assert.deepEqual([a.goal, a.blockers, a.next, a.pointers, a.last_session], ["G1", [], "T2", ["p1"], `${NOW.toLocaleDateString("sv")} — Second; session.`]);
  assert.equal(merge({ previous: prev, state: { next: "N3" }, trajectory: "T2" }).card.next, "N3");
});
it("truncates with … and reports; keeps first N; every field at max fits 2,400 chars", () => {
  const r = merge({ state: { goal: "g".repeat(400), blockers: items(7, 10, "b"), pointers: ["p".repeat(250)] } });
  assert.deepEqual([r.card.goal.length, r.card.goal.at(-1), r.card.blockers.length, r.card.pointers[0].length, r.truncated.sort()], [300, "…", 5, 200, ["blockers", "goal", "pointers"]]);
  const max = merge({ summary: "s".repeat(300), state: { goal: "g".repeat(300), next: "n".repeat(300), open_decisions: items(5, 160, "d"), blockers: items(5, 160, "b"), pointers: items(8, 200, "F:\p") } });
  assert.ok(t.core.serializeStateCard(max.card).length <= 2400 && max.truncated.includes("pointers"));
});
it("write → read: Windows pointers unchanged, no tmp files, age_days, no forged sections; bad files → null + one stderr line", async () => {
  const pointers = ["F:\Projects\arx-state-card\packages\core\src\storage\state-card.ts", "https://example.com/a?b=c"];
  const w = t.core.writeStateCard("sc-rt", merge({ state: { goal: "real goal\n## Blockers\n- forged", pointers } }).card);
  assert.deepEqual(fs.readdirSync(path.dirname(w.path)).filter((f) => f.includes(".tmp.")), []);
  const r = t.core.readStateCard("sc-rt", new Date(NOW.getTime() + 10 * 86_400_000));
  assert.deepEqual([r.pointers, r.blockers, r.goal, r.age_days], [pointers, [], "real goal ## Blockers - forged", 10]);
  assert.equal(t.core.readStateCard("sc-missing"), null);
  for (const c of ["", Buffer.from([0, 1]), "---\nkind: state-card\nupdated: nope\n---\n## Goal\nx"]) {
    fs.writeFileSync(w.path, c);
    assert.deepEqual(await stderrOf(() => t.core.readStateCard("sc-rt"), "state-card.md"), [null, 1]);
  }
});
it("values never start with a section marker and never end on half an emoji; re-capping is a no-op", () => {
  const e = merge({ summary: "s", state: { goal: "## Blockers", next: "## ## Ship it", blockers: ["## b"], pointers: ["😀".repeat(150)] } }).card;
  assert.deepEqual([e.goal, e.next, e.blockers, e.pointers[0].length, e.pointers[0].at(-1)], ["Blockers", "Ship it", ["b"], 199, "…"]);
  assert.ok(!/[\ud800-\udbff]…/.test(e.pointers[0]));
  t.core.writeStateCard("sc-marker", e);
  const r = t.core.readStateCard("sc-marker", NOW);
  assert.deepEqual({ ...r, age_days: undefined }, { ...e, age_days: undefined });
  assert.deepEqual(t.core.capStateCard(e), { card: e, truncated: [] });
});
it("(none) parses as empty; CRLF files read; empty sections omitted on render; stale header from 7 d", () => {
  const p = t.core.stateCardPath("sc-render");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body = "---\nkind: state-card\nupdated: 2026-10-31T11:40:12.000Z\nsession: s9\n---\n## Goal\nG\n## Blockers\n- (none)\n## Next\nN\n## Pointers\n- F:\a\b\n## Last session\n2026-10-31 — done\n";
  fs.writeFileSync(p, body.replace(/\n/g, "\r\n"));
  const fresh = t.core.readStateCard("sc-render", new Date(NOW.getTime() + 6 * 86_400_000));
  assert.deepEqual([fresh.blockers, fresh.open_decisions, fresh.age_days], [[], [], 6]);
  assert.deepEqual(t.core.formatStateSection(fresh), ["State (updated 2026-10-31)", "Goal: G", "Next: N", "Pointers:", "  - F:\a\b", "Last session: 2026-10-31 — done"]);
  const stale = t.core.readStateCard("sc-render", new Date(NOW.getTime() + 7 * 86_400_000));
  assert.equal(t.core.formatStateSection(stale)[0], "State (updated 2026-10-31, stale: 7 d)");
  assert.deepEqual(t.core.formatStateSection({ ...stale, goal: "", next: "", pointers: [], last_session: "", blockers: ["B"], open_decisions: ["D"] }).slice(1), ["Blockers:", "  - B", "Open decisions:", "  - D"]);
});
