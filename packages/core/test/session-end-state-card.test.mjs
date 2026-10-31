import { it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { useTempCore, stderrOf, DIST } from "./helpers/temp-core.mjs";

const t = useTempCore("ar-se-card-");
it("writes, carries forward, reports truncation", async () => {
  const { core } = t;
  const r1 = await core.sessionEnd({ summary: "First session: drafted the spec.", project: "se-card", state: { goal: "g".repeat(350), pointers: ["F:\\a.ts"] } });
  assert.deepEqual(r1.state_card, { written: true, truncated: ["goal"] });
  await core.sessionEnd({ summary: "Second session: built the parser.", project: "se-card", trajectory: "wire session_start" });
  const c = core.readStateCard("se-card");
  assert.deepEqual([c.goal.length, c.pointers, c.next, c.last_session.endsWith("Second session: built the parser.")], [300, ["F:\\a.ts"], "wire session_start", true]);
});
it("fingerprint includes state; identical repeat is a no-op; hook-end leaves the card alone", async () => {
  const { core } = t, base = { summary: "Fingerprint session summary.", project: "se-fp" };
  await core.sessionEnd({ ...base, state: { goal: "A" } });
  await core.sessionEnd({ ...base, state: { goal: "B" } });
  const before = fs.readFileSync(core.stateCardPath("se-fp"), "utf-8");
  await core.sessionEnd({ ...base, state: { goal: "B" } });
  assert.deepEqual([core.readStateCard("se-fp").goal, fs.readFileSync(core.stateCardPath("se-fp"), "utf-8")], ["B", before]);
  const h = await core.sessionEnd({ summary: "hook path summary text", project: "se-hook", saveType: "hook-end", deferConsolidation: true, state: { goal: "x" } });
  assert.deepEqual([h.state_card, core.readStateCard("se-hook")], [undefined, null]);
});
it("a failing card write never fails the save: reported as not written and recorded in hook-health", async () => {
  const { core } = t;
  fs.mkdirSync(core.stateCardPath("se-err"), { recursive: true }); // a directory where the card file should be → the atomic rename throws
  const [r, unreadableWarnings] = await stderrOf(() => core.sessionEnd({ summary: "Save survives a card write failure.", project: "se-err", state: { goal: "x" } }), "unreadable");
  assert.deepEqual([r.success, r.journal_written, r.state_card, core.readHookHealth().last_failure?.hook, unreadableWarnings], [true, true, { written: false, truncated: [] }, "session-end-state-card", 1]);
  assert.deepEqual(fs.readdirSync(path.dirname(core.stateCardPath("se-err"))).filter((f) => f.includes(".tmp.")), []);
});
it("two concurrent session_end processes: last writer wins, never torn, no exception", async () => {
  const run = (sid) => new Promise((resolve) => {
    const code = `const c = await import(${JSON.stringify(DIST)}); const r = await c.sessionEnd({ summary: "concurrent writer ${sid}", project: "se-race", state: { goal: "goal ${sid}" } }); if (!r.state_card?.written) process.exit(3);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, AGENT_RECALL_ROOT: t.root, CLAUDE_CODE_SESSION_ID: sid } });
    let err = ""; child.stderr.on("data", (d) => (err += d));
    child.on("close", (exit) => resolve({ exit, err }));
  });
  for (const { exit, err } of await Promise.all([run("sid-a"), run("sid-b")])) assert.equal(exit, 0, err);
  const c = t.core.readStateCard("se-race");
  assert.ok(c && ["sid-a", "sid-b"].includes(c.session) && c.goal === `goal ${c.session}`);
  assert.deepEqual(fs.readdirSync(path.dirname(t.core.stateCardPath("se-race"))).filter((f) => f.includes(".tmp.")), []);
});
