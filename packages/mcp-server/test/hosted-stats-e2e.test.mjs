/**
 * hosted-stats-e2e.test.mjs — usage statistics and alerts through the real request
 * handler and the real CLI: what one day of traffic writes, that nothing personal
 * reaches the snapshot or the Telegram message (local mock), `stats` output, and the
 * shutdown flush (SIGTERM; skipped on Windows, which has no catchable SIGTERM).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (f) => pathToFileURL(path.join(here, "..", "dist", "http", f)).href;
const CLI = path.join(here, "..", "dist", "http", "cli.js");
const { startHttpServer } = await import(dist("serve.js"));
const { createToken } = await import(dist("tokens.js"));

const TG_TOKEN = "987654321:AAE_e2e-token-abcdefghijklmnopqrstuv";
const UID = "statsuser-77";
const root = fs.mkdtempSync(path.join(tmpdir(), "ar-stats-e2e-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const today = () => new Date().toISOString().slice(0, 10);
const snapFile = (dataDir) => path.join(dataDir, "_server", "stats", `${today()}.json`);
function cleanEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    !k.startsWith("CLAUDE_CODE_") && k !== "CLAUDECODE" && !k.startsWith("AGENT_RECALL_") && k !== "AR_HOST" && !k.startsWith("AR_ALERT_")));
  return { ...env, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"), ...extra };
}

describe("usage stats + alerts through the server", () => {
  let dataDir, server, base, token, tg;
  const logs = [];

  before(async () => {
    dataDir = path.join(root, "data");
    token = createToken(dataDir, UID, "laptop").token;
    tg = { calls: [] };
    tg.server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => { tg.calls.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf-8")) }); res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); });
    });
    await new Promise((r) => tg.server.listen(0, "127.0.0.1", r));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = await startHttpServer({
      dataDir, port, host: "127.0.0.1", full: false, log: (l) => logs.push(l),
      alerts: { token: TG_TOKEN, chatId: "4242" },
      alertsTesting: { apiBase: `http://127.0.0.1:${tg.server.address().port}` },
    });
  });

  after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    tg.server.closeAllConnections();
    await new Promise((r) => tg.server.close(r));
  });

  it("one day of traffic: counts land in today's snapshot, nothing personal does", async () => {
    const client = new Client({ name: "Stats Test Agent", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    await client.callTool({ name: "remember", arguments: { content: "zebra-private-memory-content-9134" } });
    await client.callTool({ name: "recall", arguments: { query: "zebra-private-query-5521" } });
    await client.close();
    const unauth = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    assert.equal(unauth.status, 401);
    const page = await fetch(base + "/privacy?ref=secret-query-value", { headers: { referer: "https://github.com/Goldentrii/AgentRecall-X?tab=secret-ref-query" } });
    assert.equal(page.status, 200);
    await page.text();
    assert.equal((await fetch(base + `/${UID}/nope`)).status, 404);

    server.flushActivity();
    const raw = fs.readFileSync(snapFile(dataDir), "utf-8");
    const d = JSON.parse(raw);
    assert.ok(d.mcp_requests >= 4, `mcp_requests ${d.mcp_requests}`);
    assert.equal(d.tool_calls.remember, 1);
    assert.equal(d.tool_calls.recall, 1);
    assert.equal(d.active_users, 1);
    assert.equal(d.new_agents, 1, "one credential seen for the first time");
    assert.equal(d.http_errors.mcp["401"], 1);
    assert.equal(d.http_errors.other["404"], 1);
    assert.equal(d.page_views["/privacy"], 1);
    assert.deepEqual(d.referrers, { "github.com": 1 });
    assert.ok(d.latency_ms.p50 > 0 && d.latency_ms.p95 >= d.latency_ms.p50);
    for (const needle of [UID, token, "zebra-private", "secret-query-value", "secret-ref-query", "Stats Test Agent", "laptop", "/nope"]) {
      assert.ok(!raw.includes(needle), `snapshot must not contain ${needle}`);
    }
  });

  it("an internal failure sends a Telegram alert with no personal data, and the request is unaffected", async () => {
    const tokensFile = path.join(dataDir, "_server", "tokens.json");
    const good = fs.readFileSync(tokensFile, "utf-8");
    fs.writeFileSync(tokensFile, "{corrupt");
    try {
      const r = await fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
      assert.equal(r.status, 503);
      assert.equal((await r.json()).error, "auth_unavailable");
    } finally {
      fs.writeFileSync(tokensFile, good);
    }
    const end = Date.now() + 3000;
    while (tg.calls.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    assert.equal(tg.calls.length, 1);
    const { url, body } = tg.calls[0];
    assert.equal(url, `/bot${TG_TOKEN}/sendMessage`);
    assert.equal(body.chat_id, "4242");
    assert.match(body.text, /token_store/);
    assert.match(body.text, /route: mcp/);
    for (const needle of [UID, token, dataDir, "tokens.json", "corrupt"]) assert.ok(!body.text.includes(needle), `alert must not contain ${needle}`);
    server.flushActivity();
    const d = JSON.parse(fs.readFileSync(snapFile(dataDir), "utf-8"));
    assert.equal(d.internal_errors.token_store, 1);
    assert.equal(d.http_errors.mcp["503"], 1);
  });

  it("a log line carries no token, body or query", () => {
    const all = logs.join("\n");
    for (const needle of [token, "zebra-private", "secret-query-value"]) assert.ok(!all.includes(needle), needle);
  });

  it("agent-recall-server stats prints today live and the breakdown; --json parses; no uid", () => {
    const r = spawnSync(process.execPath, [CLI, "stats", "--days", "2", "--data", dataDir], { env: cleanEnv(), encoding: "utf-8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`${today()}\\*`));
    assert.match(r.stdout, /recall 1/);
    assert.match(r.stdout, /github\.com 1/);
    assert.ok(!r.stdout.includes(UID));
    const j = spawnSync(process.execPath, [CLI, "stats", "--json", "--days", "1", "--data", dataDir], { env: cleanEnv(), encoding: "utf-8" });
    assert.equal(j.status, 0, j.stderr);
    const parsed = JSON.parse(j.stdout);
    assert.equal(parsed.days.length, 1);
    assert.equal(parsed.days[0].day, today());
    assert.equal(parsed.days[0].snapshot.tool_calls.recall, 1);
  });

  it("stats --days is validated", () => {
    for (const bad of ["0", "401", "abc", "-1"]) {
      const r = spawnSync(process.execPath, [CLI, "stats", "--days", bad, "--data", dataDir], { env: cleanEnv(), encoding: "utf-8" });
      assert.equal(r.status, 2, `--days ${bad}`);
    }
  });
});

describe("agent-recall-server alert test", () => {
  it("refuses when alerts are off or misconfigured, never printing the token", () => {
    const off = spawnSync(process.execPath, [CLI, "alert", "test"], { env: cleanEnv(), encoding: "utf-8" });
    assert.equal(off.status, 2);
    assert.match(off.stderr, /AR_ALERT_TELEGRAM_BOT_TOKEN/);
    const bad = "12345:not-a-valid token value";
    const mal = spawnSync(process.execPath, [CLI, "alert", "test"], { env: cleanEnv({ AR_ALERT_TELEGRAM_BOT_TOKEN: bad, AR_ALERT_TELEGRAM_CHAT_ID: "42" }), encoding: "utf-8" });
    assert.equal(mal.status, 2);
    assert.ok(!mal.stderr.includes(bad));
  });
});

describe("shutdown flush", { skip: process.platform === "win32" ? "no catchable SIGTERM on Windows" : false }, () => {
  it("SIGTERM writes today's counts before exit", async () => {
    const dir = path.join(root, "data-sigterm");
    fs.mkdirSync(dir, { recursive: true });
    const port = await freePort();
    const log = [];
    const proc = spawn(process.execPath, [CLI, "serve", "--port", String(port)], { env: cleanEnv({ AR_SERVER_DATA: dir }), stdio: ["ignore", "pipe", "pipe"] });
    proc.stderr.on("data", (d) => log.push(String(d)));
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("server did not start:\n" + log.join(""))), 30_000);
      proc.stderr.on("data", () => { if (log.join("").includes("listening on")) { clearTimeout(t); resolve(); } });
      proc.on("exit", (c) => { clearTimeout(t); reject(new Error(`server exited ${c}:\n${log.join("")}`)); });
    });
    assert.match(log.join(""), /alerts off/);
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: "{}" });
    assert.equal(r.status, 401);
    await r.text();
    assert.ok(!fs.existsSync(snapFile(dir)), "nothing written yet (write-behind)");
    const exited = new Promise((res) => proc.once("exit", (code) => res(code)));
    proc.kill("SIGTERM");
    assert.equal(await exited, 0);
    const d = JSON.parse(fs.readFileSync(snapFile(dir), "utf-8"));
    assert.equal(d.mcp_requests, 1);
    assert.equal(d.http_errors.mcp["401"], 1);
  });
});
