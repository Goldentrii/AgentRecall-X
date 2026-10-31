import { it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { runCli, tmpDir, cleanupTmp } from "./helpers/run-cli.mjs";

after(cleanupTmp);
it("identity init → set → show; init never overwrites; bad bodies rejected, card unchanged", async () => {
  const root = tmpDir("ar-cards-cli-"), src = path.join(root, "card.md"), id = (...a) => runCli(root, ["identity", ...a]);
  assert.equal(JSON.parse((await id("init")).stdout).version, 1);
  assert.match((await id("init")).stderr, /already exists[\s\S]*agent_instruction/);
  fs.writeFileSync(src, "---\nkind: identity-card\nversion: 9\nupdated: x\n---\n# Owner\n- terse");
  assert.equal(JSON.parse((await id("set", src)).stdout).version, 2);
  for (const body of ["x".repeat(1601), "token " + "gh" + "p_" + "A".repeat(36)]) {
    fs.writeFileSync(src, body);
    const r = await id("set", src);
    assert.ok(r.code === 1 && /nothing written[\s\S]*agent_instruction/.test(r.stderr), r.stderr);
  }
  assert.match((await id("show")).stdout, /retrieved memory[\s\S]*Owner \(identity card v2\)\n# Owner\n- terse/);
});
it("identity error paths exit 1 with agent_instruction and never print the secret", async () => {
  const root = tmpDir("ar-cards-cli-"), src = path.join(root, "card.md"), id = (...a) => runCli(root, ["identity", ...a]);
  const expectFail = (r, re) => assert.ok(r.code === 1 && re.test(r.stderr) && /agent_instruction: /.test(r.stderr), `${r.code} ${r.stderr}`);
  expectFail(await id("show"), /No identity card at [\s\S]*agent_instruction: create one with `ar identity init`/);
  expectFail(await id("set"), /cannot read \(no file given\)/);
  expectFail(await id("set", path.join(root, "missing.md")), /cannot read .*missing\.md/);
  expectFail(await id("frobnicate"), /usage: ar identity init \| show \| set <file>/);
  fs.writeFileSync(src, "x".repeat(1601));
  expectFail(await id("set", src), /1601 chars; cap is 1600[\s\S]*agent_instruction: shorten the body to ≤1600 characters/);
  fs.writeFileSync(src, "  \n");
  expectFail(await id("set", src), /empty[\s\S]*agent_instruction: add at least one line/);
  const secret = "gh" + "p_" + "A".repeat(36);
  fs.writeFileSync(src, `token ${secret}`);
  const r = await id("set", src);
  expectFail(r, /contains a secret[\s\S]*agent_instruction: remove the secret/);
  assert.ok(!r.stderr.includes(secret) && !r.stdout.includes(secret), "secret value must never be printed");
  expectFail(await id("show"), /No identity card at /); // rejected writes leave no card behind
  // store root that is a file, not a directory: the write itself fails (I/O), still exit 1 + instruction
  const fileRoot = path.join(root, "not-a-dir");
  fs.writeFileSync(fileRoot, "x");
  expectFail(await runCli(fileRoot, ["identity", "init"]), /identity card write failed/);
});
it("state show with an invalid --project exits 1 with the slug rules and an agent_instruction", async () => {
  const r = await runCli(tmpDir("ar-cards-cli-"), ["--project", "123", "state", "show"]);
  assert.ok(r.code === 1 && /Invalid project slug "123"[\s\S]*agent_instruction: pass a valid --project <slug>/.test(r.stderr) && r.stdout === "", `${r.code} ${r.stderr}`);
});
it("state show: hint when absent, fenced card for --project; help lists the cards commands", async () => {
  const root = tmpDir("ar-cards-cli-"), show = () => runCli(root, ["--project", "cli-state", "state", "show"]);
  assert.match((await show()).stdout, /No state card for cli-state/);
  fs.mkdirSync(path.join(root, "projects", "cli-state"), { recursive: true });
  fs.writeFileSync(path.join(root, "projects", "cli-state", "state-card.md"), `---\nkind: state-card\nupdated: ${new Date().toISOString()}\nsession: s\n---\n## Goal\nShip\n`);
  assert.match((await show()).stdout, /retrieved memory[\s\S]*State \(updated [\d-]{10}\)\nGoal: Ship/);
  const help = (await runCli(root, ["--help"])).stdout;
  assert.ok(/ar identity init[\s\S]*ar state show \[--project <slug>\]/.test(help) && help.match(/ar state read\|write/g).length === 1);
});
