import { it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { useTempCore, stderrOf } from "./helpers/temp-core.mjs";

const t = useTempCore("ar-ss-cards-");
it("owner and state sit right after project, before identity; absent cards add no keys", async () => {
  const { core } = t;
  assert.ok(!("owner" in (await core.sessionStart({ project: "ssc-none" }))));
  core.writeIdentityCard("# Owner\n- terse");
  core.writeStateCard("ssc-order", core.mergeStateCard({ previous: null, session: "s1", state: { goal: "Ship" } }).card);
  const r = await core.sessionStart({ project: "ssc-order" });
  assert.deepEqual([Object.keys(r).slice(0, 4), r.owner, r.state.goal, r.state.age_days], [["project", "owner", "state", "identity"], { version: 1, body: "# Owner\n- terse" }, "Ship", 0]);
});
it("broken identity and binary state card: still returns, one stderr line each", async () => {
  const { core } = t;
  fs.writeFileSync(path.join(t.root, "identity-card.md"), "no frontmatter");
  fs.mkdirSync(path.dirname(core.stateCardPath("ssc-broken")), { recursive: true });
  fs.writeFileSync(core.stateCardPath("ssc-broken"), Buffer.from([0, 1, 2]));
  const [r, ownerLines, stateLines] = await stderrOf(() => core.sessionStart({ project: "ssc-broken" }), "identity-card.md", "state-card.md");
  assert.deepEqual([r.owner.body, r.state, ownerLines, stateLines], ["no frontmatter", undefined, 1, 1]);
});
it("a project whose only memory is a state card is not empty; a frontmatter-only card still is", async () => {
  const { core } = t;
  core.writeStateCard("ssc-only", core.mergeStateCard({ previous: null, session: "s1", state: { goal: "Only a card" } }).card);
  const r = await core.sessionStart({ project: "ssc-only" });
  assert.deepEqual([r.state.goal, r.empty_state], ["Only a card", undefined]);
  fs.mkdirSync(path.dirname(core.stateCardPath("ssc-fm")), { recursive: true });
  fs.writeFileSync(core.stateCardPath("ssc-fm"), `---\nkind: state-card\nupdated: ${new Date().toISOString()}\nsession: s\n---\n`);
  const e = await core.sessionStart({ project: "ssc-fm" });
  assert.ok(e.state && e.state.goal === "" && typeof e.empty_state === "string", JSON.stringify([e.state, e.empty_state]));
});
