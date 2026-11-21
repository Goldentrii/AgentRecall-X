/**
 * hosted-alerts.test.mjs — Telegram error alerts (alerts.ts) against a LOCAL mock of
 * the Telegram Bot API. Never talks to api.telegram.org.
 *
 * Covers: off unless both env vars are set and well-formed; one message per kind per
 * window carrying the count; Telegram down or slow never throws and never blocks;
 * the message carries kind, count, route, version, time and an own-code frame, and
 * never a raw error message, uid, token or path parameter.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { Alerter, loadAlertConfig, topFrame, ALERT_KINDS } = await import(pathToFileURL(path.join(here, "..", "dist", "http", "alerts.js")).href);

const TOKEN = "123456789:AAH_test-token-0123456789abcdefghijk";
const CHAT = "-1001234567890";

/** Mock Telegram: records sendMessage calls; mode "ok" | "500" | "hang". */
async function startTelegram() {
  const state = { calls: [], mode: "ok" };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      state.calls.push({ method: req.method, url: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf-8") || "null") });
      if (state.mode === "hang") return; // never answers
      if (state.mode === "500") { res.writeHead(500, { "content-type": "application/json" }); return void res.end('{"ok":false}'); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true,"result":{}}');
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

const waitFor = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

let tg;
before(async () => { tg = await startTelegram(); });
after(async () => { await tg.close(); });

const make = (over = {}) => new Alerter({ config: { token: TOKEN, chatId: CHAT }, version: "9.9.9", apiBase: tg.url, log: () => {}, ...over });

describe("alerts — configuration", () => {
  it("off unless both variables are set; empty means unset", () => {
    assert.equal(loadAlertConfig({}).config, null);
    assert.equal(loadAlertConfig({}).problem, undefined);
    assert.equal(loadAlertConfig({ AR_ALERT_TELEGRAM_BOT_TOKEN: "", AR_ALERT_TELEGRAM_CHAT_ID: "" }).config, null);
    const half = loadAlertConfig({ AR_ALERT_TELEGRAM_BOT_TOKEN: TOKEN });
    assert.equal(half.config, null);
    assert.match(half.problem, /AR_ALERT_TELEGRAM_CHAT_ID/);
    assert.deepEqual(loadAlertConfig({ AR_ALERT_TELEGRAM_BOT_TOKEN: TOKEN, AR_ALERT_TELEGRAM_CHAT_ID: CHAT }).config, { token: TOKEN, chatId: CHAT });
    assert.deepEqual(loadAlertConfig({ AR_ALERT_TELEGRAM_BOT_TOKEN: ` ${TOKEN} `, AR_ALERT_TELEGRAM_CHAT_ID: "@my_alerts" }).config, { token: TOKEN, chatId: "@my_alerts" });
  });

  it("a malformed token or chat id turns alerts off and is never echoed", () => {
    for (const bad of ["nope", "123:short", `${TOKEN}/../x`, `${TOKEN}?a=b`, "123456789:AAH test with spaces 0123456789"]) {
      const r = loadAlertConfig({ AR_ALERT_TELEGRAM_BOT_TOKEN: bad, AR_ALERT_TELEGRAM_CHAT_ID: CHAT });
      assert.equal(r.config, null, bad);
      assert.ok(!r.problem.includes(bad), "the value is never printed");
    }
    const r = loadAlertConfig({ AR_ALERT_TELEGRAM_BOT_TOKEN: TOKEN, AR_ALERT_TELEGRAM_CHAT_ID: "12; rm" });
    assert.equal(r.config, null);
    assert.ok(!r.problem.includes(TOKEN));
  });
});

describe("alerts — sending", () => {
  it("one message to /bot<token>/sendMessage with kind, count, route, version, time and frame; no raw message", async () => {
    tg.state.calls.length = 0;
    tg.state.mode = "ok";
    const a = make({ now: () => Date.parse("2026-11-14T10:00:00Z") });
    const err = new Error("user alice-uid wrote: my-private-memory-text ar_secret-token /tenants/alice-uid/x");
    err.stack = `Error: ${err.message}\n    at handler (/app/packages/mcp-server/dist/http/serve.js:212:15)\n    at /app/node_modules/express/lib/router.js:10:3`;
    a.raise("mcp_internal", { route: "mcp", err });
    await a.idle();
    assert.equal(tg.state.calls.length, 1);
    const c = tg.state.calls[0];
    assert.equal(c.method, "POST");
    assert.equal(c.url, `/bot${TOKEN}/sendMessage`);
    assert.equal(c.body.chat_id, CHAT);
    const text = c.body.text;
    assert.match(text, /mcp_internal/);
    assert.match(text, /\b1\b/);
    assert.match(text, /route: mcp/);
    assert.match(text, /9\.9\.9/);
    assert.match(text, /2026-11-14T10:00:00/);
    assert.match(text, /mcp-server\/http\/serve\.js:212/);
    for (const needle of ["alice-uid", "my-private-memory-text", "ar_secret-token", "/tenants/", "/app/", TOKEN]) assert.ok(!text.includes(needle), `no ${needle}`);
    assert.equal(c.body.parse_mode, undefined, "plain text: nothing is interpreted as markup");
  });

  it("at most one message per kind per window, carrying the count since the last one", async () => {
    tg.state.calls.length = 0;
    tg.state.mode = "ok";
    const a = make({ windowMs: 150 });
    for (let i = 0; i < 5; i++) a.raise("mcp_internal", { route: "mcp" });
    a.raise("token_store", { route: "mcp" });
    await a.idle();
    assert.equal(tg.state.calls.length, 2, "first mcp_internal + first token_store, immediately");
    await waitFor(() => tg.state.calls.length === 3);
    const later = tg.state.calls[2].body.text;
    assert.match(later, /mcp_internal/);
    assert.match(later, /4 since the last alert/);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(tg.state.calls.length, 3, "nothing pending: no further message");
  });

  it("Telegram down: raise never throws, the count is carried into the next message", async () => {
    tg.state.calls.length = 0;
    tg.state.mode = "500";
    const logs = [];
    const a = make({ windowMs: 100, log: (l) => logs.push(l) });
    assert.doesNotThrow(() => a.raise("oauth_internal", { route: "oauth" }));
    await a.idle();
    assert.equal(tg.state.calls.length, 1);
    tg.state.mode = "ok";
    a.raise("oauth_internal", { route: "oauth" });
    await waitFor(() => tg.state.calls.length === 2);
    assert.match(tg.state.calls[1].body.text, /2 since the last alert/);
    assert.ok(logs.some((l) => /telegram/i.test(l)));
    assert.ok(logs.every((l) => !l.includes(TOKEN)), "the token never reaches the log");
  });

  it("unreachable Telegram: no throw, logged without the token", async () => {
    const logs = [];
    const a = make({ apiBase: "http://127.0.0.1:1", log: (l) => logs.push(l) });
    a.raise("stats_write");
    await a.idle();
    assert.ok(logs.length >= 1);
    assert.ok(logs.every((l) => !l.includes(TOKEN)));
  });

  it("slow Telegram: raise returns at once and the call times out", async () => {
    tg.state.calls.length = 0;
    tg.state.mode = "hang";
    const logs = [];
    const a = make({ timeoutMs: 100, log: (l) => logs.push(l) });
    const t0 = performance.now();
    a.raise("http_5xx", { route: "connect" });
    assert.ok(performance.now() - t0 < 50, "raise is synchronous and does not wait for Telegram");
    await a.idle();
    assert.ok(logs.some((l) => /timed out/.test(l)));
    tg.state.mode = "ok";
  });

  it("unknown kinds are ignored", async () => {
    tg.state.calls.length = 0;
    const a = make();
    a.raise("made_up_kind");
    a.raise("__proto__");
    a.raise("mcp_internal", { route: "alice-uid-route" });
    await a.idle();
    assert.equal(tg.state.calls.length, 1);
    assert.ok(!tg.state.calls[0].body.text.includes("alice-uid-route"), "an unknown route class is never shown");
    tg.state.calls.length = 0;
    assert.ok(ALERT_KINDS.includes("mcp_internal"));
  });
});

describe("alerts — top frame", () => {
  it("first frame inside our own packages, as package/relative path:line", () => {
    const e = new Error("x");
    e.stack = "Error: x\n    at a (node:internal/x:1:1)\n    at b (/app/node_modules/express/lib/router.js:5:1)\n    at c (/app/packages/core/dist/storage/fs.js:88:9)\n    at d (/app/packages/mcp-server/dist/http/serve.js:1:1)";
    assert.equal(topFrame(e), "core/storage/fs.js:88");
    const w = new Error("y");
    w.stack = "Error: y\n    at F:\\Projects\\arx\\packages\\mcp-server\\dist\\http\\site.js:12:3";
    assert.equal(topFrame(w), "mcp-server/http/site.js:12");
    const npm = new Error("z");
    npm.stack = "Error: z\n    at file:///usr/lib/node_modules/agent-recall-mcp/dist/http/serve.js:40:2";
    assert.equal(topFrame(npm), "mcp-server/http/serve.js:40");
  });

  it("a frame-shaped line inside the error message is never used", () => {
    const e = new Error("boom\n    at evil (/app/packages/core/dist/secret-alice-uid.js:1:1)");
    e.stack = `Error: ${e.message}\n    at real (/app/node_modules/x/index.js:1:1)`;
    assert.equal(topFrame(e), undefined);
    assert.equal(topFrame("not an error"), undefined);
    assert.equal(topFrame({ name: "Error", message: "", stack: "Error\n    at x (/app/packages/core/dist/a.js:1:1)" }), undefined, "only real Error objects");
    assert.equal(topFrame(undefined), undefined);
  });
});
