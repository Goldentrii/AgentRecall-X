import { it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { register, stateInputSchema as S, STATE_HARD_LIMITS as L } from "../dist/tools/session-end.js";

it("schema accepts overflow up to the hard limits, rejects beyond; the handler passes state through", async () => {
  assert.deepEqual([S.safeParse({ goal: "g".repeat(L.text), blockers: Array(L.items).fill("b") }).success, S.safeParse({ goal: "g".repeat(L.text + 1) }).success, S.safeParse({ pointers: Array(L.items + 1).fill("p") }).success], [true, false, false]);
  const core = await import("agent-recall-core"), root = fs.mkdtempSync(path.join(os.tmpdir(), "ar-mcp-state-"));
  let handler, def;
  register({ registerTool: (_name, d, h) => { def = d; handler = h; } });
  // Wiring guard: calling the captured handler bypasses the schema, so assert the field is really registered.
  assert.equal(def.inputSchema.state, S, "state must stay in the session_end inputSchema");
  assert.equal(def.inputSchema.state.safeParse({ goal: "g".repeat(L.text + 1) }).success, false, "the registered field enforces the hard limits");
  // An agent only sees the description: it must state the hard limits, not just the soft caps.
  assert.match(S.description, /hard limit/i);
  for (const n of [L.text, L.item, L.pointer, L.items]) assert.match(S.description, new RegExp(`\\b${n}\\b`), `description lacks hard limit ${n}`);
  core.setRoot(root);
  try {
    const res = await handler({ summary: "MCP state card wiring test.", project: "mcp-state", state: { goal: "Ship" } });
    assert.deepEqual(JSON.parse(res.content.at(-1).text).state_card, { written: true, truncated: [] });
  } finally { core.resetRoot(); fs.rmSync(root, { recursive: true, force: true }); }
});
