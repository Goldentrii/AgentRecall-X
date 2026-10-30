/**
 * ledger-trace-tool.test.mjs — spec SW-7. Drives the COMPILED MCP server
 * (dist/index.js) over stdio: the read-only `trace` tool, the lifecycle line in
 * session_start, and via=mcp provenance set at server startup.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(__dirname, "..", "dist", "index.js");
const LIFECYCLE_MODULE = pathToFileURL(path.join(__dirname, "..", "dist", "lib", "lifecycle-line.js")).href;

const tmpDirs = [];
/** Fresh private parent; the store root is a child so "../x" escapes stay inside the parent. */
function freshParent() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-ledger-trace-test-"));
  tmpDirs.push(dir);
  const root = path.join(dir, "store");
  fs.mkdirSync(root);
  return { dir, root };
}

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function withClient(parent, fn) {
  const home = path.join(parent.dir, "home");
  fs.mkdirSync(home, { recursive: true });
  const transport = new StdioClientTransport({
    command: "node",
    args: [ENTRY],
    env: { AGENT_RECALL_ROOT: parent.root, AGENT_CRAFT_HOME: path.join(parent.dir, "craft"), HOME: home, USERPROFILE: home },
  });
  const client = new Client({ name: "ledger-trace-test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

const textOf = (result, i = 0) => result.content[i].text;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    out.push(e.name);
    if (e.isDirectory()) walk(path.join(dir, e.name), out);
  }
  return out;
}

describe("SW-7 trace tool + lifecycle line", () => {
  it("a. listTools includes trace", async () => {
    await withClient(freshParent(), async (client) => {
      const { tools } = await client.listTools();
      assert.ok(tools.some((t) => t.name === "trace"), tools.map((t) => t.name).join(","));
    });
  });

  it("b. a write via MCP is traced with via=mcp (journal_write is not registered; remember is the write path)", async () => {
    await withClient(freshParent(), async (client) => {
      const w = await client.callTool({ name: "remember", arguments: { project: "trace-probe", content: "hello ledger" } });
      assert.ok(!w.isError, textOf(w));
      const r = await client.callTool({ name: "trace", arguments: { project: "trace-probe" } });
      assert.ok(!r.isError, textOf(r));
      const lines = textOf(r).split("\n");
      const summary = lines[lines.length - 1];
      assert.match(summary, /^\d+ events for trace-probe \(oldest first; head [0-9A-Z]{8}\)$/);
      const eventLines = lines.slice(0, -1);
      assert.ok(eventLines.length >= 2);
      for (const l of eventLines) {
        const f = l.split(" ");
        assert.equal(f.length, 5, l);
        assert.equal(f[2], "mcp", l);
        assert.equal(f[4].length, 26, l);
      }
      const types = eventLines.map((l) => l.split(" ")[1]);
      assert.ok(types.includes("journal.capture"), types.join(","));
      const parsed = JSON.parse(textOf(r, 1));
      assert.equal(parsed.project, "trace-probe");
      assert.equal(parsed.events.length, eventLines.length);
      assert.ok(summary.startsWith(`${eventLines.length} events for trace-probe`));
    });
  });

  it("c. session_start appends a lifecycle line", async () => {
    await withClient(freshParent(), async (client) => {
      await client.callTool({ name: "remember", arguments: { project: "trace-probe", content: "hello ledger" } });
      const r = await client.callTool({ name: "session_start", arguments: { project: "trace-probe" } });
      const text = textOf(r);
      const m = text.match(/^lifecycle: born \d{4}-\d{2}-\d{2} · (\d+) events · last session\.start .+ via mcp · verify: clean$/m);
      assert.ok(m, text);
      assert.ok(Number(m[1]) >= 2);
      const lite = await client.callTool({ name: "session_start", arguments: { project: "trace-probe", mode: "lite" } });
      assert.match(textOf(lite), /^lifecycle: born /m);
    });
  });

  it("d. a project with no ledger events says how to backfill", async () => {
    // session_start itself appends session.start, so the no-events form is proven on the
    // library path (bare root) and on the read-only trace tool.
    const { lifecycleLine } = await import(LIFECYCLE_MODULE);
    const { root } = freshParent();
    assert.equal(
      lifecycleLine("empty-probe", root),
      "lifecycle: no ledger events yet (run: ar ledger backfill --project empty-probe)",
    );
    await withClient(freshParent(), async (client) => {
      const r = await client.callTool({ name: "trace", arguments: { project: "empty-probe" } });
      assert.equal(textOf(r), "No ledger events for empty-probe. Run: ar ledger backfill --project empty-probe");
    });
  });

  it("e. invalid since is rejected by schema; server stays alive", async () => {
    await withClient(freshParent(), async (client) => {
      await client.callTool({ name: "remember", arguments: { project: "trace-probe", content: "hello ledger" } });
      let rejected = false;
      try {
        const r = await client.callTool({ name: "trace", arguments: { project: "trace-probe", since: "garbage" } });
        rejected = r.isError === true;
      } catch {
        rejected = true;
      }
      assert.ok(rejected, "since: garbage must be rejected");
      const ok = await client.callTool({ name: "trace", arguments: { project: "trace-probe" } });
      assert.ok(!ok.isError, textOf(ok));
    });
  });

  it("f. path-traversal project is refused and creates nothing", async () => {
    const parent = freshParent();
    await withClient(parent, async (client) => {
      try {
        const r = await client.callTool({ name: "trace", arguments: { project: "../escape" } });
        assert.ok(r.isError === true || textOf(r).startsWith("trace failed"), textOf(r));
      } catch {
        // schema-level rejection is also acceptable
      }
      const { tools } = await client.listTools();
      assert.ok(tools.length > 0);
    });
    const names = walk(parent.dir);
    assert.ok(!names.includes("escape"), names.join(","));
    assert.ok(!names.includes(".."), names.join(","));
  });

  it("g. lifecycleLine never throws on a corrupt heads.json", async () => {
    const { lifecycleLine } = await import(LIFECYCLE_MODULE);
    const { root } = freshParent();
    fs.mkdirSync(path.join(root, "ledger"), { recursive: true });
    fs.writeFileSync(path.join(root, "ledger", "heads.json"), "{not json");
    fs.writeFileSync(path.join(root, "ledger", "events.jsonl"), "garbage line\n");
    assert.match(lifecycleLine("some-project", root), /^lifecycle: /);
  });
});
