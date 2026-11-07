/**
 * hosted-server.test.mjs — end-to-end benchmark for hosted AgentRecall.
 *
 * Spawns the REAL `agent-recall-server` binary and talks to it with the REAL MCP
 * SDK client over Streamable HTTP. Success benchmark (target doc §1):
 *   1. a user gets a token once (admin CLI)
 *   2. any MCP client adds URL + token
 *   3. a DIFFERENT client of the same user sees the same memory, no local install, no hooks
 *   4. user A can never read or write user B's data
 * Plus: auth failures, stateless method handling, body cap, and the server OS
 * user's legacy ~/.claude/projects never leaking into any tenant.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "dist", "http", "cli.js");

let base, dataDir, fakeHome, port, serverProc, baseUrl;
let tokenAlice, tokenBob;
const serverLog = [];

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function cleanEnv(extra = {}) {
  // Strip host signals so the test proves the hosted tier is forced, not inherited.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    !k.startsWith("CLAUDE_CODE_") && k !== "CLAUDECODE" && !k.startsWith("AGENT_RECALL_") && k !== "AR_HOST"));
  return { ...env, HOME: fakeHome, USERPROFILE: fakeHome, AR_SERVER_DATA: dataDir, ...extra };
}

function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: cleanEnv(), encoding: "utf-8" });
  assert.equal(r.status, 0, `cli ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

const tokenFrom = (out) => out.match(/\b(ar_[A-Za-z0-9_-]{43})\b/)[1];

async function connect(token, name) {
  const client = new Client({ name, version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl + "/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

const textOf = (res) => (res.content ?? []).map((c) => c.text ?? "").join("\n");

function walkFiles(d) {
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walkFiles(path.join(d, e.name)) : [path.join(d, e.name)]);
}
const treeContains = (d, needle) => walkFiles(d).some((f) => fs.readFileSync(f, "utf-8").includes(needle));

before(async () => {
  base = fs.mkdtempSync(path.join(tmpdir(), "ar-hosted-"));
  dataDir = path.join(base, "data");
  fakeHome = path.join(base, "home");
  // The server OS user's legacy store — must never reach any tenant.
  const legacyJournal = path.join(fakeHome, ".claude", "projects", "main", "memory", "journal");
  fs.mkdirSync(legacyJournal, { recursive: true });
  fs.writeFileSync(path.join(legacyJournal, "2026-01-01.md"), "# Operator note\nlegacy-operator-secret-77 main\n");

  tokenAlice = tokenFrom(cli("token", "create", "--uid", "alice", "--label", "alice laptop"));
  tokenBob = tokenFrom(cli("token", "create", "--uid", "bob"));

  port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProc = spawn(process.execPath, [CLI, "serve", "--port", String(port)], { env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
  serverProc.stderr.on("data", (d) => serverLog.push(String(d)));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start:\n" + serverLog.join(""))), 30_000);
    serverProc.stderr.on("data", () => { if (serverLog.join("").includes("listening on")) { clearTimeout(t); resolve(); } });
    serverProc.on("exit", (c) => { clearTimeout(t); reject(new Error(`server exited ${c}:\n${serverLog.join("")}`)); });
  });
});

after(async () => {
  if (serverProc && serverProc.exitCode === null) {
    serverProc.kill();
    await new Promise((r) => serverProc.once("exit", r));
  }
  fs.rmSync(base, { recursive: true, force: true });
});

describe("hosted server — HTTP surface", () => {
  it("GET /healthz is public", async () => {
    const r = await fetch(baseUrl + "/healthz");
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
  });

  it("401 + agent_instruction for missing, malformed and unknown tokens", async () => {
    const init = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    for (const auth of [undefined, "Bearer nope", "Bearer ar_" + "x".repeat(43), `Basic ${tokenAlice}`]) {
      const r = await fetch(baseUrl + "/mcp", { method: "POST", headers: auth ? { ...init, authorization: auth } : init, body });
      assert.equal(r.status, 401, `auth=${auth}`);
      const j = await r.json();
      assert.equal(j.error, "unauthorized");
      assert.match(j.agent_instruction, /Authorization: Bearer/);
      assert.match(r.headers.get("www-authenticate") ?? "", /Bearer/);
    }
  });

  it("stateless: GET/DELETE /mcp → 405, unknown path → 404", async () => {
    for (const method of ["GET", "DELETE"]) {
      const r = await fetch(baseUrl + "/mcp", { method, headers: { authorization: `Bearer ${tokenAlice}` } });
      assert.equal(r.status, 405);
      assert.equal(r.headers.get("allow"), "POST");
    }
    assert.equal((await fetch(baseUrl + "/nope")).status, 404);
  });

  it("body over the cap → a delivered 413 with agent_instruction (not a socket reset)", async () => {
    const r = await fetch(baseUrl + "/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenAlice}`, "content-type": "application/json" },
      body: "x".repeat(4 * 1024 * 1024 + 10),
    });
    assert.equal(r.status, 413);
    const j = await r.json();
    assert.equal(j.error, "payload_too_large");
    assert.match(j.agent_instruction, /smaller/);
  });

  it("an unreadable token store → 503 auth_unavailable, then recovers", async () => {
    const tokensFile = path.join(dataDir, "_server", "tokens.json");
    const good = fs.readFileSync(tokensFile, "utf-8");
    fs.writeFileSync(tokensFile, "{ half-written");
    try {
      const r = await fetch(baseUrl + "/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${tokenAlice}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(r.status, 503);
      assert.equal((await r.json()).error, "auth_unavailable");
    } finally {
      fs.writeFileSync(tokensFile, good);
    }
    const c = await connect(tokenAlice, "after-recovery");
    await c.close();
  });
});

describe("hosted server — success benchmark", () => {
  it("any client: tool surface + agent-driven (Tier B) instructions, no hooks assumed", async () => {
    const c = await connect(tokenAlice, "agent-one");
    try {
      const names = (await c.listTools()).tools.map((t) => t.name).sort();
      for (const n of ["check", "recall", "remember", "session_end", "session_start"]) assert.ok(names.includes(n), `missing ${n}`);
      const instructions = c.getInstructions() ?? "";
      assert.match(instructions, /YOU drive its lifecycle/);
      assert.doesNotMatch(instructions, /hooks call session_start automatically/);
    } finally {
      await c.close();
    }
  });

  it("memory written by one agent is recalled by a DIFFERENT agent of the same user; never by another user", async () => {
    const marker = "hosted-marker-" + Math.random().toString(16).slice(2);
    const agentOne = await connect(tokenAlice, "claude-code");
    try {
      const w = await agentOne.callTool({ name: "remember", arguments: { content: `Alice prefers tabs over spaces ${marker}` } });
      assert.notEqual(w.isError, true, textOf(w));
    } finally {
      await agentOne.close();
    }

    const agentTwo = await connect(tokenAlice, "cursor");
    const bob = await connect(tokenBob, "bob-agent");
    try {
      const a = await agentTwo.callTool({ name: "recall", arguments: { query: marker } });
      assert.match(textOf(a), new RegExp(marker), "a second agent of the same user must see the memory");

      const b = await bob.callTool({ name: "recall", arguments: { query: marker } });
      // The tool echoes the query ("No results for \"…\""), so require the explicit empty answer.
      assert.match(textOf(b), new RegExp(`^No results for "${marker}"`), "another user must get no results");

      const s = await agentTwo.callTool({ name: "session_start", arguments: {} });
      assert.notEqual(s.isError, true, textOf(s));
    } finally {
      await agentTwo.close();
      await bob.close();
    }

    assert.ok(treeContains(path.join(dataDir, "tenants", "alice"), marker), "stored in alice's tenant");
    assert.equal(treeContains(path.join(dataDir, "tenants", "bob"), marker), false, "never in bob's tenant");
    const outside = walkFiles(dataDir).filter((f) => !f.startsWith(path.join(dataDir, "tenants", "alice")));
    assert.ok(outside.every((f) => !fs.readFileSync(f, "utf-8").includes(marker)), "nowhere else in the data dir");
  });

  it("interleaved concurrent requests from two users stay isolated", async () => {
    const tag = Math.random().toString(16).slice(2);
    const run = async (token, who) => {
      const c = await connect(token, who);
      try {
        await Promise.all([0, 1, 2].map((i) =>
          c.callTool({ name: "remember", arguments: { content: `concurrency ${who} item ${i} ${tag}-${who}` } })));
        const own = textOf(await c.callTool({ name: "recall", arguments: { query: `${tag}-${who}` } }));
        const other = textOf(await c.callTool({ name: "recall", arguments: { query: `${tag}-${who === "alice" ? "bob" : "alice"}` } }));
        return { own, other };
      } finally {
        await c.close();
      }
    };
    const [alice, bob] = await Promise.all([run(tokenAlice, "alice"), run(tokenBob, "bob")]);
    // Non-vacuous: each user finds their own concurrent writes…
    assert.match(alice.own, new RegExp(`${tag}-alice`), "alice must recall her own concurrent writes");
    assert.match(bob.own, new RegExp(`${tag}-bob`), "bob must recall his own concurrent writes");
    // …and never the other user's.
    assert.match(alice.other, new RegExp(`^No results for "${tag}-bob"`));
    assert.match(bob.other, new RegExp(`^No results for "${tag}-alice"`));
  });

  it("hostile project arguments cannot escape the tenant root", async () => {
    const marker = "escape-attempt-" + Math.random().toString(16).slice(2);
    const bob = await connect(tokenBob, "bob-agent");
    try {
      for (const project of ["../alice", "..\\alice", "../../_server", "/etc", "C:\\Windows"]) {
        await bob.callTool({ name: "remember", arguments: { content: `${marker} via ${project}`, project } });
      }
    } finally {
      await bob.close();
    }
    const bobRoot = path.join(dataDir, "tenants", "bob");
    const leaked = walkFiles(base).filter((f) => !f.startsWith(bobRoot) && fs.readFileSync(f, "utf-8").includes(marker));
    assert.deepEqual(leaked, [], "no file outside bob's tenant may contain the marker");
  });

  it("the server OS user's legacy ~/.claude/projects never reaches a tenant", async () => {
    const c = await connect(tokenAlice, "agent-one");
    try {
      const r = await c.callTool({ name: "recall", arguments: { query: "legacy-operator-secret-77" } });
      assert.match(textOf(r), /^No results for "legacy-operator-secret-77"/);
    } finally {
      await c.close();
    }
  });

  it("a revoked token stops working immediately", async () => {
    const out = cli("token", "create", "--uid", "carol");
    const token = tokenFrom(out);
    const id = out.match(/Created token ([a-f0-9]{12})/)[1];
    const c = await connect(token, "carol-agent");
    await c.close();
    cli("token", "revoke", id);
    await assert.rejects(connect(token, "carol-agent"), /401|nauthorized/);
  });

  it("no request ran outside a tenant scope (strict mode never tripped)", () => {
    assert.doesNotMatch(serverLog.join(""), /outside a tenant scope|internal error/);
  });
});
