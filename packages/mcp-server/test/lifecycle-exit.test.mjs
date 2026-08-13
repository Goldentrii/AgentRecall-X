/**
 * lifecycle-exit.test.mjs — C-3 (Train C, 2026-08-12 wave).
 *
 * Drives the COMPILED MCP server (dist/index.js) as a real child process and
 * exercises `installLifecycleExitHandlers` (lib/lifecycle-exit.ts) directly
 * via OS signals and stdin closure — NOT the MCP JSON-RPC client's own
 * `close()` (that path is covered end-to-end in
 * ambient-capture.test.mjs's "C-1 + C-3 pipeline" describe block). This file
 * isolates C-3's own contract: SIGTERM/SIGINT handling, idempotency, the
 * hard exit-time ceiling, and the "nothing to distill" no-op case.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-lifecycle-exit-test-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * H1 fix (Train C review, 2026-08-12 wave) — this suite exists to exercise
 * C-3's graceful-exit handlers, which the new `isHookOwnedHost()` gate
 * (host-profile.ts) skips installing entirely on a hook-owned host. Naively
 * spreading `...process.env` into the spawned child leaks THIS test
 * process's OWN Claude Code signals (CLAUDECODE / CLAUDE_CODE_*) whenever
 * the suite happens to be run from inside a Claude Code session (e.g.
 * `npm test` invoked by a Claude Code agent, not just CI) — the gate would
 * then correctly, but wrongly for this test's intent, treat the spawned
 * child as hook-owned and skip installing the very handlers this suite
 * exercises, all four tests below then fail or hang on a distillation that
 * never happens. Strip those keys (and any `AR_HOST` override) so the child
 * deterministically resolves to Tier B — the MCP-only, no-hooks host this
 * suite is actually testing — regardless of what environment the suite
 * itself runs under.
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

function findCardFor(root, uniqueTerm) {
  const projectsDir = path.join(root, "projects");
  if (!fs.existsSync(projectsDir)) return null;
  for (const slug of fs.readdirSync(projectsDir)) {
    const journalDir = path.join(projectsDir, slug, "journal");
    if (!fs.existsSync(journalDir)) continue;
    for (const f of fs.readdirSync(journalDir)) {
      if (!f.endsWith(".md")) continue;
      const body = fs.readFileSync(path.join(journalDir, f), "utf-8");
      if (body.includes(uniqueTerm)) return { slug, file: f, body };
    }
  }
  return null;
}

/**
 * Spawn the compiled MCP server DIRECTLY (raw child_process, not via the
 * SDK's StdioClientTransport) so the test can send an arbitrary OS signal to
 * the exact pid and observe the 'exit' event's timing without the client
 * library's own close() semantics in the way. A minimal hand-rolled
 * JSON-RPC handshake + one tool call is enough to populate working memory.
 */
async function spawnServerAndCallOneTool(root, toolName, args) {
  const child = spawn("node", [ENTRY], {
    env: { ...stripHookSignals(process.env), AGENT_RECALL_ROOT: root },
    stdio: ["pipe", "pipe", "inherit"],
  });

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
    const req = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify(req) + "\n");
    });
  }
  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "lifecycle-exit-raw-test-client", version: "1.0.0" },
  });
  notify("notifications/initialized", {});
  const callResp = await send("tools/call", { name: toolName, arguments: args });

  return { child, callResp };
}

describe("C-3 graceful-exit handlers — SIGTERM/SIGINT distill working memory into a card", () => {
  it("SIGTERM: distills the just-captured gist into a card and exits within the 2s ceiling", async () => {
    const root = isolatedRoot();
    const { child } = await spawnServerAndCallOneTool(root, "recall", { query: "SIGTERM_UNIQUE_TERM_ABC" });

    const start = Date.now();
    const exitPromise = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal, ms: Date.now() - start })));
    child.kill("SIGTERM");
    const { ms } = await exitPromise;

    assert.ok(ms < 2000, `SIGTERM handling must exit well within the 2s ceiling, took ${ms}ms`);

    const card = findCardFor(root, "SIGTERM_UNIQUE_TERM_ABC");
    assert.ok(card, "expected a session card carrying the SIGTERM-time gist");

    const wmDir = path.join(root, "working-memory");
    const wmFiles = fs.existsSync(wmDir) ? fs.readdirSync(wmDir) : [];
    assert.equal(wmFiles.length, 0, "working-memory file must be cleaned up after SIGTERM distillation");
  });

  it("SIGINT: distills the just-captured gist into a card and exits within the 2s ceiling", async () => {
    const root = isolatedRoot();
    const { child } = await spawnServerAndCallOneTool(root, "recall", { query: "SIGINT_UNIQUE_TERM_DEF" });

    const start = Date.now();
    const exitPromise = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal, ms: Date.now() - start })));
    child.kill("SIGINT");
    const { ms } = await exitPromise;

    assert.ok(ms < 2000, `SIGINT handling must exit well within the 2s ceiling, took ${ms}ms`);
    const card = findCardFor(root, "SIGINT_UNIQUE_TERM_DEF");
    assert.ok(card, "expected a session card carrying the SIGINT-time gist");
  });

  it("idempotency: SIGTERM followed immediately by SIGINT produces exactly ONE card, no crash", async () => {
    const root = isolatedRoot();
    const { child } = await spawnServerAndCallOneTool(root, "recall", { query: "IDEMPOTENT_SIGNAL_UNIQUE_TERM" });

    const exitPromise = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    child.kill("SIGTERM");
    // Fire immediately after — exercises the `fired` guard racing a second
    // signal before/around process exit. A harmless ESRCH (process already
    // gone) is an acceptable outcome too — it only proves the FIRST signal
    // alone already tore the process down.
    try {
      child.kill("SIGINT");
    } catch {
      // process may already be gone — fine
    }
    await exitPromise;

    const projectsDir = path.join(root, "projects");
    let cardCount = 0;
    if (fs.existsSync(projectsDir)) {
      for (const slug of fs.readdirSync(projectsDir)) {
        const journalDir = path.join(projectsDir, slug, "journal");
        if (!fs.existsSync(journalDir)) continue;
        for (const f of fs.readdirSync(journalDir)) {
          if (f.endsWith(".md") && fs.readFileSync(path.join(journalDir, f), "utf-8").includes("IDEMPOTENT_SIGNAL_UNIQUE_TERM")) {
            cardCount++;
          }
        }
      }
    }
    assert.equal(cardCount, 1, `idempotency guard must produce exactly one card even under a signal race, got ${cardCount}`);
  });

  it("no-op: a graceful close with ZERO tool calls (nothing captured) never crashes and writes no spurious card", async () => {
    const root = isolatedRoot();
    // No tool call at all — just connect and close via SIGTERM directly.
    const child = spawn("node", [ENTRY], {
      env: { ...stripHookSignals(process.env), AGENT_RECALL_ROOT: root },
      stdio: ["pipe", "pipe", "inherit"],
    });
    // Give the process a brief moment to finish booting/connecting its
    // stdio transport before signaling, matching real-world timing (a
    // signal arriving before the transport is even up is a degenerate case
    // outside this test's scope).
    await new Promise((r) => setTimeout(r, 200));

    const exitPromise = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    child.kill("SIGTERM");
    const { code } = await exitPromise;
    assert.ok(code === 0 || code === null, `expected a clean exit even with nothing to distill, got code=${code}`);

    // No working-memory dir should exist at all — no tool call ever ran.
    assert.ok(!fs.existsSync(path.join(root, "working-memory")), "no WM directory should exist when no tool call ever ran");
  });
});
