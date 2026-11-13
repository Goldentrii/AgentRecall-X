// Every tool on every surface must tell the client whether it only reads or
// also writes. Directories (Claude connectors, ChatGPT apps) require it, and
// without annotations a client must assume the worst case: a destructive,
// open-world write. A new tool without an entry in EXPECTED fails this test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/build-server.js";

const READ = { readOnlyHint: true, openWorldHint: false };
const ADD = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const OVERWRITE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

// Why each write tool is not read-only is documented in src/tools/annotations.ts.
const EXPECTED = {
  session_start: ADD,
  session_end: OVERWRITE,
  remember: ADD,
  recall: ADD,
  check: ADD,
  check_action: ADD,
  pipeline_open: ADD,
  pipeline_close: ADD,
  pipeline_list: READ,
  pipeline_current: READ,
  pipeline_show: READ,
  register_rule: ADD,
  digest: OVERWRITE,
};

async function listTools(opts) {
  const server = buildServer({ tier: "B", ambientCapture: false, ...opts });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "annotations-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

for (const [label, opts, count] of [
  ["default", { full: false, extras: false }, 5],
  ["--full", { full: true, extras: false }, 6],
  ["AR_EXTRAS=1 --full", { full: true, extras: true }, 13],
]) {
  test(`${label} surface: every tool is annotated as expected`, async () => {
    const tools = await listTools(opts);
    assert.equal(tools.length, count);
    for (const tool of tools) {
      const want = EXPECTED[tool.name];
      assert.ok(want, `${tool.name} has no entry in EXPECTED: decide read or write and add it`);
      assert.ok(tool.title && tool.title.length > 0, `${tool.name} has no title`);
      assert.ok(tool.name.length <= 64, `${tool.name} is longer than 64 characters`);
      assert.deepEqual(tool.annotations, want, `${tool.name} annotations`);
    }
  });
}

test("a read-only tool never also claims to be destructive", async () => {
  for (const tool of await listTools({ full: true, extras: true })) {
    if (tool.annotations.readOnlyHint) assert.equal(tool.annotations.destructiveHint, undefined, tool.name);
    else assert.equal(typeof tool.annotations.destructiveHint, "boolean", tool.name);
  }
});
