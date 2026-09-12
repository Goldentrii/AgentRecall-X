// packages/mcp-server/test/pending-review-surface.test.mjs
//
// Fix #2 (plan-v2, 2026-09-11) — RIDER R2(b): pending is an injection
// surface, so every egress path that renders pending-derived content must be
// covered by the fence discipline. This file VERIFIES (not assumes) that:
//
//   1. The two surfaces that emit pending-derived content — the `check` tool
//      (correction_pending / agent_instruction) and `session_start` (the
//      pending-review line) — are classified "fenced" in the P1 fence
//      manifest AND their source actually calls fenceMemory (AST-checked via
//      the same fence-ast helpers the completeness harness uses). A NEW
//      surface would be caught by fence-completeness.test.mjs's live
//      discovery; this file pins the two EXISTING surfaces the pending
//      feature rides on.
//   2. Functionally, a check() call that stages a pending correction returns
//      its correction_pending payload INSIDE the fence markers (stdio
//      JSON-RPC against the real compiled server).
//   3. The session_start terse render adds AT MOST 2 lines for pending
//      review, and renders COUNT ONLY — never staged rule content.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { MANIFEST } from "./fence-manifest.mjs";
import { textCallsFence } from "./lib/fence-ast.mjs";
import { formatTerse } from "../dist/tools/session-start.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(__dirname, "..", "dist", "index.js");
const REPO_ROOT = path.join(__dirname, "..", "..", "..");

const tmpDirs = [];
function isolatedRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-pending-review-"));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function withClient(root, fn) {
  const transport = new StdioClientTransport({
    command: "node",
    args: [ENTRY],
    env: { ...process.env, AGENT_RECALL_ROOT: root },
  });
  const client = new Client({ name: "pending-review-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function textOf(result) {
  assert.ok(result && Array.isArray(result.content) && result.content[0], `unexpected tool result shape: ${JSON.stringify(result)}`);
  return result.content[0].text;
}

describe("R2b(1): the pending egress surfaces are fence-manifested AND fence-backed", () => {
  for (const id of ["check", "session_start"]) {
    it(`mcp_tool '${id}' is classified fenced in the manifest and its source calls fenceMemory`, () => {
      const entry = MANIFEST.find((e) => e.channel === "mcp_tool" && e.id === id);
      assert.ok(entry, `fence manifest must contain mcp_tool '${id}'`);
      assert.equal(entry.status, "fenced", `'${id}' renders pending-derived content and must stay fenced`);
      const src = fs.readFileSync(path.join(REPO_ROOT, entry.file), "utf-8");
      assert.ok(textCallsFence(src), `${entry.file} must actually call fenceMemory`);
    });
  }

  it("cli_subcommand 'hook-start' (which renders the pending line) stays classified fenced", () => {
    const entry = MANIFEST.find((e) => e.channel === "cli_subcommand" && e.id === "hook-start");
    assert.ok(entry, "fence manifest must contain cli_subcommand 'hook-start'");
    assert.equal(entry.status, "fenced");
  });
});

describe("R2b(2): check()'s pending payload rides INSIDE the fence (real server, stdio)", () => {
  it("staging a string human_correction returns correction_pending fenced", async () => {
    const root = isolatedRoot();
    await withClient(root, async (client) => {
      const res = await client.callTool({
        name: "check",
        arguments: {
          goal: "ship the release",
          confidence: "high",
          human_correction: "Never push to the main branch without explicit owner approval",
          project: "pending-fence-proj",
        },
      });
      const text = textOf(res);
      assert.ok(text.includes("correction_pending"), `expected correction_pending in the payload, got: ${text.slice(0, 400)}`);
      const openIdx = text.indexOf("retrieved memory");
      const pendIdx = text.indexOf("correction_pending");
      const closeIdx = text.lastIndexOf("⟦/");
      assert.ok(openIdx >= 0 && openIdx < pendIdx, "fence-open must precede the pending payload");
      assert.ok(closeIdx > pendIdx, "fence-close must follow the pending payload");
    });
  });

  it("the check tool schema teaches the structured form on first read (agent-first)", async () => {
    const root = isolatedRoot();
    await withClient(root, async (client) => {
      const tools = await client.listTools();
      const check = tools.tools.find((t) => t.name === "check");
      assert.ok(check, "check tool must be registered");
      const schemaStr = JSON.stringify(check.inputSchema);
      for (const needle of ["rule", "why", "applies_when", "pending_id"]) {
        assert.ok(schemaStr.includes(needle), `check inputSchema must teach '${needle}' — an agent must learn the structured form without trial and error`);
      }
    });
  });
});

describe("R2b(3): session_start terse render — ≤2 lines, count only, no pending content", () => {
  const baseResult = {
    project: "render-proj",
    identity: "tester",
    insights: [],
    active_rooms: [],
    cross_project: [],
    recent: { today: null, yesterday: null, older_count: 0 },
    recent_captures: [],
    watch_for: [],
    corrections: [],
    resume: null,
    behavior_rules: [],
    dream_health: null,
    store_doctor: null,
    pipeline: null,
    alignment: null,
    blind_spots: [],
    recognition: { who: "unknown", capabilities: [], project_line: "", person: undefined },
  };

  it("adds at most 2 lines when pending items exist, and renders no staged rule text", () => {
    const without = formatTerse({ ...baseResult });
    const withPending = formatTerse({
      ...baseResult,
      pending_corrections: { count: 3, ids: ["2026-09-11--never-change-main-abc123"] },
    });
    const addedLines = withPending.split("\n").length - without.split("\n").length;
    assert.ok(addedLines >= 1, "the pending line must be rendered");
    assert.ok(addedLines <= 2, `the pending surface must stay ≤2 lines, got ${addedLines} added lines`);
    assert.ok(/3 pending/.test(withPending), "the line must carry the count");
    assert.ok(/check\(/.test(withPending), "the line must point at check() for review");
    assert.ok(!withPending.includes("never-change-main"), "no staged content/ids in the terse render — count only");
  });

  it("renders nothing when there is no pending", () => {
    const out = formatTerse({ ...baseResult });
    assert.ok(!/pending correction/i.test(out));
  });
});
