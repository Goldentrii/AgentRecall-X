import { it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
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
it("identity init never overwrites a card file that exists but cannot be read (empty, UTF-16)", async () => {
  const root = tmpDir("ar-cards-cli-"), card = path.join(root, "identity-card.md");
  for (const content of [Buffer.alloc(0), Buffer.from("\uFEFF---\nkind: identity-card\nversion: 4\n---\nhi", "utf16le")]) {
    fs.writeFileSync(card, content);
    const r = await runCli(root, ["identity", "init"]);
    assert.ok(r.code === 1 && /agent_instruction: the card file exists but could not be read; fix or remove .*identity-card\.md before running init/.test(r.stderr), `${r.code} ${r.stderr}`);
    assert.deepEqual(fs.readFileSync(card), content, "the owner's file is untouched");
  }
});
it("identity set strips a UTF-8 BOM from the input file (frontmatter and plain-body forms)", async () => {
  const root = tmpDir("ar-cards-cli-"), src = path.join(root, "card.md"), id = (...a) => runCli(root, ["identity", ...a]), BOM = "\uFEFF";
  fs.writeFileSync(src, BOM + "---\nkind: identity-card\nversion: 9\nupdated: x\n---\n# Owner\n- terse");
  assert.equal(JSON.parse((await id("set", src)).stdout).version, 1);
  fs.writeFileSync(src, BOM + "# Owner\n- plain body");
  assert.equal(JSON.parse((await id("set", src)).stdout).version, 2);
  const stored = fs.readFileSync(path.join(root, "identity-card.md"), "utf-8");
  assert.ok(!stored.includes(BOM) && /\n---\n# Owner\n- plain body\n$/.test(stored), JSON.stringify(stored));
  assert.match((await id("show")).stdout, /Owner \(identity card v2\)\n# Owner\n- plain body/);
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
it("ar saveall saves the journal but never writes a project state card", async () => {
  const root = tmpDir("ar-cards-cli-"), home = tmpDir("ar-cards-home-");
  const projects = path.join(home, ".claude", "projects", `-Users-${os.userInfo().username}`);
  fs.mkdirSync(projects, { recursive: true });
  const msg = { type: "user", message: { role: "user", content: "Please wire the saveall journal path into the new cards flow" } };
  fs.writeFileSync(path.join(projects, "11111111-2222-3333-4444-555555555555.jsonl"), JSON.stringify(msg) + "\n");
  const r = await runCli(root, ["saveall"], { env: { HOME: home, USERPROFILE: home } });
  assert.equal(r.code, 0, r.stderr);
  const files = fs.readdirSync(root, { recursive: true }).map(String); // an unguessable project is staged under <root>/_unclaimed/<id>/
  assert.ok(files.some((f) => /journal[\\/]\d{4}-\d{2}-\d{2}--arsave--.*\.md$/.test(f)), `the journal save still happens, named as an arsave: ${r.stdout} ${files.join(",")}`);
  assert.deepEqual(files.filter((f) => f.endsWith("state-card.md")), [], "saveall must not write a state card");
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
