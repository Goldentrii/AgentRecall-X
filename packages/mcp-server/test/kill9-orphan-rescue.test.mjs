/**
 * kill9-orphan-rescue.test.mjs — the mandatory kill-9 e2e round trip (Train
 * C, 2026-08-12 wave, compiled SOP 06174bb2's fixture-class list).
 *
 * SIGKILL is, by construction, uncatchable — NEITHER C-1's ambient capture
 * NOR C-3's graceful-exit handler can run in response to it. This test
 * proves durability falls all the way through to C-2's orphan-rescue sweep
 * instead: a session that gets `kill -9`'d mid-work leaves its working
 * memory on disk untouched, and the NEXT MCP `session_start` tool call
 * (potentially from a completely different process/window) rescues it into
 * a searchable session card + recency entry — exactly the design doc's
 * acceptance flow.
 *
 * Uses a raw `child_process.spawn` (not the SDK's StdioClientTransport,
 * whose `close()` would gracefully end stdin and defeat the point of this
 * test) so the test controls the exact moment SIGKILL is sent.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(__dirname, "..", "dist", "index.js");

const tmpDirs = [];
function isolatedRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-kill9-e2e-test-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * H1 fix (Train C review, 2026-08-12 wave) — server #1 below ("the victim")
 * must actually run C-1 ambient capture so its `recall` tool calls populate
 * working memory for the rescue to find. The new `isHookOwnedHost()` gate
 * (host-profile.ts) skips installing C-1 on a hook-owned host; naively
 * spreading `...process.env` leaks THIS test process's OWN Claude Code
 * signals (CLAUDECODE / CLAUDE_CODE_*) into the spawned child whenever the
 * suite happens to be run from inside a Claude Code session (e.g. `npm test`
 * invoked by a Claude Code agent, not just CI), which would make the gate
 * correctly, but wrongly for this test's intent, skip C-1 for the victim —
 * the precondition assertion (exactly one WM file before the kill) then
 * fails, defeating the entire point of this e2e. Strip those keys (and any
 * `AR_HOST` override) so the child deterministically resolves to Tier B —
 * the MCP-only, no-hooks host this suite's own header comment says it is
 * testing — regardless of what environment the suite itself runs under.
 */
function stripHookSignals(env) {
  const out = { ...env };
  delete out.AR_HOST;
  delete out.CLAUDECODE;
  for (const key of Object.keys(out)) {
    if (key.startsWith("CLAUDE_CODE_")) delete out[key];
  }
  return out;
}

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Minimal hand-rolled JSON-RPC client over a raw child process's stdio. */
function rawJsonRpcClient(child) {
  let buf = "";
  const pending = new Map();
  let nextId = 1;
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  function send(method, params) {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  return { send, notify };
}

/** Back-date a WM file's mtime beyond WM_ORPHAN_WINDOW_MS (1h), matching the CLI suite's convention. */
function backdateOrphan(wmFilePath, extraMs = 10 * 60 * 1000) {
  const past = (Date.now() - (60 * 60 * 1000 + extraMs)) / 1000;
  fs.utimesSync(wmFilePath, past, past);
}

describe("kill -9 e2e round trip — orphan-rescue sweep reaches an MCP-only session, no hooks involved", () => {
  it("a SIGKILL'd MCP server's working memory is rescued into a card by the NEXT session's session_start tool call", async () => {
    const root = isolatedRoot();

    // 1. Spawn server #1, make real tool calls over stdio (populates WM).
    const child1 = spawn("node", [ENTRY], {
      env: { ...stripHookSignals(process.env), AGENT_RECALL_ROOT: root },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const rpc1 = rawJsonRpcClient(child1);
    await rpc1.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "kill9-e2e-victim", version: "1.0.0" },
    });
    rpc1.notify("notifications/initialized", {});
    await rpc1.send("tools/call", { name: "recall", arguments: { query: "starting investigation of the KILL9_E2E_UNIQUE_TERM issue" } });
    await rpc1.send("tools/call", { name: "recall", arguments: { query: "found the root cause for KILL9_E2E_UNIQUE_TERM, writing the fix now" } });

    // Confirm WM was actually captured before we kill the process.
    const wmDir = path.join(root, "working-memory");
    const wmFilesBefore = fs.readdirSync(wmDir).filter((f) => f.endsWith(".jsonl"));
    assert.equal(wmFilesBefore.length, 1, "precondition: exactly one WM file must exist before the kill");
    const wmFilePath = path.join(wmDir, wmFilesBefore[0]);

    // 2. SIGKILL — uncatchable. Neither C-1 (already ran, fine) nor C-3
    // (graceful-exit handler) gets a chance to run.
    const exitPromise = new Promise((resolve) => child1.once("exit", (code, signal) => resolve({ code, signal })));
    child1.kill("SIGKILL");
    const { signal } = await exitPromise;
    assert.equal(signal, "SIGKILL", "sanity: the process must have actually been killed by SIGKILL");

    // WM file must survive the kill untouched (no graceful-exit distillation ran).
    assert.ok(fs.existsSync(wmFilePath), "WM file must survive an uncatchable SIGKILL");

    // Simulate "it's been over an hour" — the orphan-rescue sweep's age gate.
    backdateOrphan(wmFilePath);

    // 3. A fresh MCP server process (a completely different "window"),
    // calling session_start — this is core's sessionStart() invoking
    // rescueOrphanedWorkingMemory() (C-2), reached via the MCP tool surface
    // on a host with NO Claude Code hooks at all (this is the whole point
    // of Train C).
    const transport2 = new StdioClientTransport({ command: "node", args: [ENTRY], env: { AGENT_RECALL_ROOT: root } });
    const client2 = new Client({ name: "kill9-e2e-rescuer", version: "1.0.0" }, { capabilities: {} });
    await client2.connect(transport2);
    let sessionStartResult;
    try {
      sessionStartResult = await client2.callTool({ name: "session_start", arguments: {} });
    } finally {
      await client2.close();
    }
    assert.ok(!sessionStartResult.isError, `session_start must not error: ${JSON.stringify(sessionStartResult)}`);

    // 4. Assert the orphan was rescued: WM gone, a card exists carrying the
    // captured content, and a recency entry exists.
    assert.ok(!fs.existsSync(wmFilePath), "the orphaned WM file must be deleted once rescued");

    const projectsDir = path.join(root, "projects");
    assert.ok(fs.existsSync(projectsDir), "a project dir should exist after rescue");
    let rescuedCard = null;
    for (const slug of fs.readdirSync(projectsDir)) {
      const journalDir = path.join(projectsDir, slug, "journal");
      if (!fs.existsSync(journalDir)) continue;
      for (const f of fs.readdirSync(journalDir)) {
        if (!f.endsWith(".md")) continue;
        const body = fs.readFileSync(path.join(journalDir, f), "utf-8");
        if (body.includes("KILL9_E2E_UNIQUE_TERM")) rescuedCard = { slug, file: f, body };
      }
    }
    assert.ok(rescuedCard, "expected a rescued session card carrying the killed session's gist content");
    assert.ok(rescuedCard.body.includes("working-memory-rescue"), "rescued card frontmatter must carry source: working-memory-rescue");

    const recencyPath = path.join(root, "recent-sessions.jsonl");
    assert.ok(fs.existsSync(recencyPath), "recency index should have a new entry from the rescue");
    const recencyLines = fs
      .readFileSync(recencyPath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.ok(recencyLines.some((e) => e.slug === rescuedCard.slug), "recency entry must exist for the rescued session's guessed slug");
  });
});
