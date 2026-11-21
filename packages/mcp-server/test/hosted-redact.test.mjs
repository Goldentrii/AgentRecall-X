/**
 * hosted-redact.test.mjs — the hosted backstop scrubs the tenant root from
 * handler results AND thrown error messages, for tools, resources and prompts.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { withTenant } from "agent-recall-core";
import { installHostedRedaction, deepRedact } from "../dist/lib/hosted-redact.js";

let base, root;
before(() => { base = fs.mkdtempSync(path.join(tmpdir(), "ar-redact-")); root = path.join(base, "tenants", "alice"); fs.mkdirSync(root, { recursive: true }); });
after(() => fs.rmSync(base, { recursive: true, force: true }));
const inTenant = (fn) => withTenant({ root, sid: "abcdef12", defaultProject: "main" }, fn);

function fakeServer() {
  const captured = {};
  const rec = (kind) => (...args) => { captured[kind] = args[args.length - 1]; };
  const s = { registerTool: rec("tool"), registerResource: rec("resource"), registerPrompt: rec("prompt") };
  installHostedRedaction(s);
  return { s, captured };
}

describe("hosted redaction backstop", () => {
  it("redacts strings nested in tool results, leaves non-strings alone", async () => {
    const { s, captured } = fakeServer();
    const file = path.join(root, "projects", "main", "x.md");
    s.registerTool("t", {}, async () => ({ content: [{ type: "text", text: `Saved → ${file}` }], structuredContent: { file_path: file, n: 3, ok: true } }));
    const out = await inTenant(() => captured.tool({}, {}));
    const flat = JSON.stringify(out);
    assert.ok(!flat.includes(JSON.stringify(base).slice(1, -1)) && !flat.includes(base.split(path.sep).join("/")), flat);
    assert.match(out.content[0].text, /^Saved → hosted:/);
    assert.equal(out.structuredContent.n, 3);
    assert.equal(out.structuredContent.ok, true);
  });

  it("error path: a thrown error's message is scrubbed before the SDK sees it", async () => {
    const { s, captured } = fakeServer();
    s.registerTool("t", {}, async () => { throw new Error(`EACCES: permission denied, open '${path.join(root, "p.md")}'`); });
    await assert.rejects(inTenant(() => captured.tool({}, {})), (err) => {
      assert.ok(!err.message.includes(base), err.message);
      assert.match(err.message, /hosted:/);
      return true;
    });
  });

  it("error path: non-Error throws and McpError-style data are scrubbed too", async () => {
    const { s, captured } = fakeServer();
    s.registerTool("str", {}, async () => { throw `failed at ${root}`; });
    await assert.rejects(inTenant(() => captured.tool({}, {})), (err) => {
      assert.ok(err instanceof Error && !err.message.includes(base) && err.message.includes("hosted:"), String(err));
      return true;
    });
    s.registerTool("data", {}, async () => {
      const e = new Error("resource read failed");
      e.data = { path: path.join(root, "x.md") };
      throw e;
    });
    await assert.rejects(inTenant(() => captured.tool({}, {})), (err) => {
      assert.match(err.data.path, /^hosted:/);
      return true;
    });
  });

  it("handles null-prototype objects and cycles without hanging", () => {
    const np = Object.assign(Object.create(null), { p: root });
    const cyc = { p: root };
    cyc.self = cyc;
    inTenant(() => {
      assert.equal(deepRedact(np).p, "hosted:");
      assert.equal(deepRedact(cyc).p, "hosted:");
    });
  });

  it("wraps resource and prompt handlers too", async () => {
    const { s, captured } = fakeServer();
    s.registerResource("r", "agentrecall://x", {}, async (uri) => ({ contents: [{ uri: String(uri), text: root }] }));
    s.registerPrompt("p", {}, () => ({ messages: [{ role: "user", content: { type: "text", text: `scan ${root}` } }] }));
    const r = await inTenant(() => captured.resource("agentrecall://x"));
    const p = await inTenant(() => captured.prompt({}));
    assert.equal(r.contents[0].text, "hosted:");
    assert.equal(r.contents[0].uri, "agentrecall://x");
    assert.equal(p.messages[0].content.text, "scan hosted:");
  });

  it("outside a tenant it is the identity (stdio never installs it anyway)", () => {
    const v = { a: [root, 1, null], b: "x" };
    assert.deepEqual(deepRedact(v), v);
  });
});
