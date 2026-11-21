/**
 * hosted-limits-e2e.test.mjs — per-user limits against the REAL agent-recall-server binary.
 *
 *   storage quota: over quota, write tools return a tool error with an agent
 *                  instruction; reads keep working; other users are unaffected.
 *   rate limit:    over the per-minute budget → 429 + retry-after + agent_instruction;
 *                  other users are unaffected.
 *   usage CLI:     lists each tenant's bytes against the quota.
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
const servers = [];

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function env(base, extra = {}) {
  const e = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    !k.startsWith("CLAUDE_CODE_") && k !== "CLAUDECODE" && !k.startsWith("AGENT_RECALL_") && !k.startsWith("AR_")));
  const home = path.join(base, "home");
  fs.mkdirSync(home, { recursive: true });
  return { ...e, HOME: home, USERPROFILE: home, AR_SERVER_DATA: path.join(base, "data"), ...extra };
}

function cli(base, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: env(base), encoding: "utf-8" });
  assert.equal(r.status, 0, `cli ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}
const token = (base, uid) => cli(base, "token", "create", "--uid", uid).match(/\b(ar_[A-Za-z0-9_-]{43})\b/)[1];

async function startServer(extraArgs, extraEnv = {}) {
  const base = fs.mkdtempSync(path.join(tmpdir(), "ar-limits-e2e-"));
  const port = await freePort();
  const tokens = { alice: token(base, "alice"), bob: token(base, "bob") };
  const log = [];
  const proc = spawn(process.execPath, [CLI, "serve", "--port", String(port), ...extraArgs], { env: env(base, extraEnv), stdio: ["ignore", "pipe", "pipe"] });
  proc.stderr.on("data", (d) => log.push(String(d)));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start:\n" + log.join(""))), 30_000);
    proc.stderr.on("data", () => { if (log.join("").includes("listening on")) { clearTimeout(t); resolve(); } });
    proc.on("exit", (c) => { clearTimeout(t); reject(new Error(`server exited ${c}:\n${log.join("")}`)); });
  });
  const s = { base, url: `http://127.0.0.1:${port}`, tokens, log, proc };
  servers.push(s);
  return s;
}

after(async () => {
  for (const s of servers) {
    if (s.proc.exitCode === null) { s.proc.kill(); await new Promise((r) => s.proc.once("exit", r)); }
    fs.rmSync(s.base, { recursive: true, force: true });
  }
});

async function connect(s, who) {
  const client = new Client({ name: who, version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(s.url + "/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${s.tokens[who]}` } },
  }));
  return client;
}
const textOf = (r) => (r.content ?? []).map((c) => c.text ?? "").join("\n");

describe("storage quota", () => {
  let s;
  before(async () => { s = await startServer(["--quota-mb", "0.05", "--rate-per-min", "0"]); });

  it("over quota: writes get a tool error with an instruction, reads still work, other users unaffected", async () => {
    const c = await connect(s, "alice");
    let blocked = null;
    try {
      for (let i = 0; i < 30 && !blocked; i++) {
        const r = await c.callTool({ name: "remember", arguments: { content: `quota filler ${i} ` + "lorem ipsum ".repeat(700) } });
        if (r.isError) blocked = textOf(r);
      }
      assert.ok(blocked, "alice must hit the quota");
      assert.match(blocked, /storage quota/i);
      assert.match(blocked, /recall|read/i, "the instruction says reading still works");

      const read = await c.callTool({ name: "recall", arguments: { query: "quota filler" } });
      assert.notEqual(read.isError, true, textOf(read));
      const start = await c.callTool({ name: "session_start", arguments: {} });
      assert.notEqual(start.isError, true, textOf(start));
    } finally {
      await c.close();
    }

    const b = await connect(s, "bob");
    try {
      const r = await b.callTool({ name: "remember", arguments: { content: "bob is under quota" } });
      assert.notEqual(r.isError, true, textOf(r));
    } finally {
      await b.close();
    }
  });

  it("usage CLI reports per-tenant bytes against the quota", () => {
    const out = cli(s.base, "usage", "--quota-mb", "0.05");
    assert.match(out, /^alice\s+\d+ bytes\s+\d+% of /m);
    assert.match(out, /^bob\s+\d+ bytes/m);
  });
});

describe("rate limit", () => {
  let s;
  before(async () => { s = await startServer(["--rate-per-min", "5", "--quota-mb", "0"]); });

  it("over the per-minute budget → 429 + retry-after + agent_instruction; other users unaffected", async () => {
    const post = (who) => fetch(s.url + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${s.tokens[who]}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    for (let i = 0; i < 5; i++) {
      const r = await post("alice");
      assert.equal(r.status, 200, `request ${i + 1}`);
      await r.arrayBuffer();
    }
    const limited = await post("alice");
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    const j = await limited.json();
    assert.equal(j.error, "rate_limited");
    assert.match(j.agent_instruction, /retry/i);

    const other = await post("bob");
    assert.equal(other.status, 200, "bob has his own budget");
    await other.arrayBuffer();
  });

  it("bad tokens get 401, not 429 (auth runs first; nothing to rate-limit)", async () => {
    const r = await fetch(s.url + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer nope" }, body: "{}" });
    assert.equal(r.status, 401);
  });
});

describe("limits are on by default and fail closed on bad settings", () => {
  it("serve with no limit flags logs the default quota and rate", async () => {
    const s = await startServer([]);
    assert.match(s.log.join(""), /quota 100 MB\/user/);
    assert.match(s.log.join(""), /rate 120 req\/min\/user/);
  });

  it("an EMPTY env var (VAR= in .env/compose) means default, never off", async () => {
    const s = await startServer([], { AR_SERVER_QUOTA_MB: "", AR_SERVER_RATE_PER_MIN: " " });
    assert.match(s.log.join(""), /quota 100 MB\/user/);
    assert.match(s.log.join(""), /rate 120 req\/min\/user/);
  });

  it("junk or rounds-to-zero values refuse to start instead of disabling the limit", () => {
    const base = fs.mkdtempSync(path.join(tmpdir(), "ar-limits-bad-"));
    try {
      const bad = [["--quota-mb", ""], ["--quota-mb", "abc"], ["--quota-mb", "-1"], ["--quota-mb", "1e309"],
        ["--quota-mb", "0.0000001"], ["--rate-per-min", "abc"], ["--rate-per-min", "1.5"], ["--rate-per-min", "-3"]];
      for (const args of bad) {
        const r = spawnSync(process.execPath, [CLI, "serve", "--port", "1", ...args], { env: env(base), encoding: "utf-8" });
        assert.equal(r.status, 2, `${args.join(" ")} → exit ${r.status}: ${r.stderr}`);
      }
      const r = spawnSync(process.execPath, [CLI, "serve", "--port", "1"], { env: env(base, { AR_SERVER_QUOTA_MB: "lots" }), encoding: "utf-8" });
      assert.equal(r.status, 2, "junk env value");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
