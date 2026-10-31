import { it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { runCli, tmpDir, cleanupTmp } from "./helpers/run-cli.mjs";

after(cleanupTmp);
const lock = (root, f) => fs.readFileSync(path.join(root, f), "utf-8").trim();
const hook = (root, name, stdin, sid) => runCli(root, ["--project", "hsid", name], { stdin, env: sid ? { CLAUDE_CODE_SESSION_ID: sid } : {} });

it("hook-start: stdin session_id beats env; two sessions in one hour both get context", async () => {
  const root = tmpDir("ar-hsid-");
  await hook(root, "hook-start", '{"session_id":"stdin-sid"}', "env-sid");
  assert.equal(lock(root, ".hook-start-lock"), "stdin-sid");
  for (const s of ["sess-a", "sess-b"]) assert.match((await hook(root, "hook-start", undefined, s)).stdout, /Session context loaded/, s);
});
it("hook-end lock and hook-ambient working memory use CLAUDE_CODE_SESSION_ID", async () => {
  const root = tmpDir("ar-hsid-");
  await hook(root, "hook-end", "{}", "end-sid");
  await hook(root, "hook-ambient", JSON.stringify({ prompt: "how do I fix the checkout bug in the payment service" }), "amb-sid");
  assert.equal(lock(root, ".hook-end-lock"), "end-sid-end");
  assert.ok(fs.existsSync(path.join(root, "working-memory", "amb-sid.jsonl")));
});
it("hook-ambient: non-JSON stdin is still the prompt text; the id comes from CLAUDE_CODE_SESSION_ID", async () => {
  const root = tmpDir("ar-hsid-");
  await hook(root, "hook-ambient", "how do I fix the checkout bug in the payment service", "plain-sid");
  const wm = path.join(root, "working-memory", "plain-sid.jsonl");
  assert.ok(fs.existsSync(wm));
  assert.match(fs.readFileSync(wm, "utf-8"), /checkout bug in the payment service/);
});
