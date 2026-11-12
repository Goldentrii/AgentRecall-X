/**
 * hosted-site-hardening.test.mjs — fixes from the security review of the website (PR #57):
 *  - an aborted or stalled "Download my memory" releases the per-account lock and closes every file handle
 *  - the tar exporter does not enter a directory (or read a file) that was swapped for a link after it was listed
 *  - pages that reflect the Host header are never cached
 * Same harness as hosted-site.test.mjs (mock GitHub, a cookie-jar browser).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startMock, GH } from "./lib/mock-providers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, "..", "dist", "http");
const CLI = path.join(DIST, "cli.js");
const load = (f) => import(pathToFileURL(path.join(DIST, f)).href);

const root = fs.mkdtempSync(path.join(tmpdir(), "ar-hard-"));
const fakeHome = path.join(root, "home");
fs.mkdirSync(fakeHome, { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const form = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined)).toString();
const csrfOf = (html) => /name="csrf" value="([^"]+)"/.exec(html)?.[1];

function cleanEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    !k.startsWith("CLAUDE_CODE_") && k !== "CLAUDECODE" && !k.startsWith("AGENT_RECALL_") && k !== "AR_HOST" && !k.startsWith("AR_OAUTH_") && k !== "AR_PUBLIC_URL" && k !== "AR_PRIVACY_URL"));
  return { ...env, HOME: fakeHome, USERPROFILE: fakeHome, ...extra };
}

async function spawnServer(env) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const log = [];
  const proc = spawn(process.execPath, [CLI, "serve", "--port", String(port)], { env: cleanEnv(env), stdio: ["ignore", "pipe", "pipe"] });
  proc.stderr.on("data", (d) => log.push(String(d)));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start:\n" + log.join(""))), 30_000);
    proc.stderr.on("data", () => { if (log.join("").includes("listening on")) { clearTimeout(t); resolve(); } });
    proc.on("exit", (c) => { clearTimeout(t); reject(new Error(`server exited ${c}:\n${log.join("")}`)); });
  });
  return { base, async stop() { if (proc.exitCode === null) { proc.kill(); await new Promise((r) => proc.once("exit", r)); } } };
}

class Browser {
  constructor(base) { this.base = base; this.jar = new Map(); }
  cookieFor(pathname) {
    return [...this.jar.values()].filter((c) => pathname === c.path || pathname.startsWith(c.path.endsWith("/") ? c.path : c.path + "/")).map((c) => `${c.name}=${c.value}`).join("; ");
  }
  keep(res) {
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = sc.split(";").map((s) => s.trim());
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      const attr = Object.fromEntries(attrs.map((a) => { const j = a.indexOf("="); return j < 0 ? [a.toLowerCase(), true] : [a.slice(0, j).toLowerCase(), a.slice(j + 1)]; }));
      if (attr["max-age"] === "0" || value === "") this.jar.delete(name);
      else this.jar.set(name, { name, value, path: attr.path ?? "/", raw: sc });
    }
  }
  async go(target, { method = "GET", body, headers = {}, site = "same-origin" } = {}) {
    const url = new URL(target, this.base);
    const h = { connection: "close", ...(site ? { "sec-fetch-site": site } : {}), ...headers };
    const c = this.cookieFor(url.pathname);
    if (c) h.cookie = c;
    if (body !== undefined) h["content-type"] = "application/x-www-form-urlencoded";
    const res = await fetch(url, { method, redirect: "manual", headers: h, body: body === undefined ? undefined : form(body) });
    this.keep(res);
    return { status: res.status, text: await res.text(), headers: res.headers, location: res.headers.get("location") };
  }
  post(target, body, opts = {}) { return this.go(target, { ...opts, method: "POST", body }); }
}

async function signIn(b, mock, profile) {
  await b.go("/connect");
  const s = await b.post("/connect/start", { provider: "github" });
  const up = new URL(s.location);
  const code = mock.issue("github", { profile, challenge: up.searchParams.get("code_challenge"), nonce: up.searchParams.get("nonce") });
  const cb = await b.go(`/authorize/callback/github?${form({ code, state: up.searchParams.get("state") })}`, { site: "cross-site" });
  assert.equal(cb.status, 302, cb.text);
  const dash = await b.go(cb.location);
  assert.equal(dash.status, 200);
  return dash;
}

/** A server in this process (so a test can count the file handles it opens). */
async function startInProc() {
  const { startHttpServer } = await load("serve.js");
  const { loadOAuthConfig } = await load("oauth-config.js");
  const dataDir = fs.mkdtempSync(path.join(root, "data-abort-"));
  const mock = await startMock();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  mock.state.base = base;
  const config = loadOAuthConfig({ publicUrl: base }, { AR_OAUTH_SIGNUP: "open", AR_OAUTH_GITHUB_CLIENT_ID: GH.id, AR_OAUTH_GITHUB_CLIENT_SECRET: GH.secret });
  const logs = [];
  const server = await startHttpServer({ dataDir, port, host: "127.0.0.1", full: false, oauth: config, log: (l) => logs.push(l), oauthTesting: { providerUrls: mock.urls, loginLimits: { perIp: 1000, global: 10000, windowMs: 600000 } } });
  return { base, port, dataDir, mock, logs, async close() { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); await mock.close(); } };
}

/** POST without reading the body: resolves with the live request/response so a test can stall or kill the client. */
function rawPost(env, pathname, cookie, body) {
  return new Promise((resolve, reject) => {
    const data = form(body);
    const req = http.request({
      host: "127.0.0.1", port: env.port, path: pathname, method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(data), "sec-fetch-site": "same-origin", connection: "close" },
    }, (res) => resolve({ req, res }));
    req.on("error", reject);
    req.end(data);
  });
}

/** Counts fs.promises.open / FileHandle.close while a test runs. */
function countHandles() {
  const realOpen = fs.promises.open;
  const c = { opened: 0, closed: 0, restore() { fs.promises.open = realOpen; } };
  fs.promises.open = async (...a) => {
    const h = await realOpen(...a);
    c.opened++;
    const close = h.close.bind(h);
    h.close = async () => { c.closed++; return close(); };
    return h;
  };
  return c;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("an aborted download releases its lock and its file handles", () => {
  it("destroying the client mid-stream (under backpressure) frees the account for the next download and closes every fd", async () => {
    const env = await startInProc();
    const h = countHandles();
    try {
      const b = new Browser(env.base);
      const dash = await signIn(b, env.mock, { id: 909 });
      const csrf = csrfOf(dash.text);
      const cookie = b.cookieFor("/connect");
      const dir = path.join(env.dataDir, "tenants", "gh-909", "projects", "main");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(96 * 1024 * 1024, 7));

      // Start a download and never read it: the server ends up waiting for the socket to drain. Then the client dies.
      const first = await rawPost(env, "/connect/download", cookie, { csrf });
      assert.equal(first.res.statusCode, 200);
      first.res.pause();
      await sleep(600);
      first.res.destroy();
      first.req.destroy();

      // Soon after, the same account can download again (a stuck lock would answer 303 "busy").
      let status = 0;
      for (let i = 0; i < 30 && status !== 200; i++) {
        await sleep(200);
        const second = await rawPost(env, "/connect/download", cookie, { csrf });
        status = second.res.statusCode;
        second.res.destroy();
        second.req.destroy();
      }
      assert.equal(status, 200, "the lock was released after the client disconnected");

      for (let i = 0; i < 50 && (h.opened === 0 || h.opened !== h.closed); i++) await sleep(100);
      assert.ok(h.opened >= 1, `files were opened (${h.opened})`);
      assert.equal(h.closed, h.opened, `every opened file handle was closed (opened ${h.opened}, closed ${h.closed})`);
      assert.ok(env.logs.some((l) => l.includes("[connect] download aborted")), "the abort is logged");
    } finally {
      h.restore();
      await env.close();
    }
  });
});

describe("export-tar: stalled clients and swapped directories (unit)", () => {
  /** A writable that never drains. */
  const stuck = () => new Writable({ highWaterMark: 256 * 1024, write() { /* never calls back */ } });

  it("a client that stops reading is cut off after the idle timeout, and the file is closed", async () => {
    const { streamTenantTar } = await load("export-tar.js");
    const dir = path.join(root, "tar-stall");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.bin"), Buffer.alloc(4 * 1024 * 1024, 1));
    const h = countHandles();
    try {
      const t0 = Date.now();
      await assert.rejects(streamTenantTar(dir, "top", stuck(), { idleMs: 150 }), /stalled|went away/);
      assert.ok(Date.now() - t0 < 5000);
      assert.ok(h.opened >= 1);
      assert.equal(h.closed, h.opened);
    } finally {
      h.restore();
    }
  });

  it("a client that closes while the exporter waits for drain settles the wait at once and leaves no listener", async () => {
    const { streamTenantTar } = await load("export-tar.js");
    const dir = path.join(root, "tar-close");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.bin"), Buffer.alloc(4 * 1024 * 1024, 1));
    const sink = stuck();
    const h = countHandles();
    try {
      const done = streamTenantTar(dir, "top", sink, { idleMs: 60_000 });
      setTimeout(() => sink.destroy(), 100);
      const t0 = Date.now();
      await assert.rejects(done, /went away/);
      assert.ok(Date.now() - t0 < 3000, "did not wait for the 60 s idle timeout");
      assert.equal(sink.listenerCount("drain"), 0, "no drain listener is left behind");
      assert.equal(h.closed, h.opened);
    } finally {
      h.restore();
    }
  });

  it("a directory swapped for a link to somewhere else after it was listed is not entered", async (t) => {
    const { streamTenantTar } = await load("export-tar.js");
    const dir = path.join(root, "tar-swap");
    const outside = path.join(root, "tar-swap-outside");
    fs.mkdirSync(path.join(dir, "swap"), { recursive: true });
    fs.writeFileSync(path.join(dir, "swap", "inner.md"), "INNER");
    fs.writeFileSync(path.join(dir, "keep.md"), "KEEP");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.md"), "OUTSIDE-SECRET");
    fs.writeFileSync(path.join(outside, "inner.md"), "OUTSIDE-SECRET");
    const chunks = [];
    const sink = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
    let swapped = false;
    await streamTenantTar(dir, "top", sink, {
      hooks: {
        async beforeDir(abs) { // after the listing, before the exporter goes in
          if (path.basename(abs) !== "swap") return;
          fs.rmSync(abs, { recursive: true });
          try { fs.symlinkSync(outside, abs, "junction"); swapped = true; } catch { /* no links here */ }
        },
      },
    });
    if (!swapped) return void t.skip("cannot create a directory link here");
    const all = Buffer.concat(chunks).toString("latin1");
    assert.ok(!all.includes("OUTSIDE-SECRET"), "nothing from the link's target");
    assert.ok(all.includes("KEEP"), "the rest of the tree is still exported");
  });

  it("a parent directory swapped for a link after the listing does not let a file be read through it", async (t) => {
    const { streamTenantTar } = await load("export-tar.js");
    const dir = path.join(root, "tar-swap2");
    const outside = path.join(root, "tar-swap2-outside");
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "sub", "note.md"), "INNER");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "note.md"), "OUTSIDE-SECRET");
    const chunks = [];
    const sink = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
    let swapped = false;
    await streamTenantTar(dir, "top", sink, {
      hooks: {
        async beforeFile(abs) { // listed under sub/; now sub/ is a link outside
          if (path.basename(abs) !== "note.md") return;
          const parent = path.dirname(abs);
          fs.rmSync(parent, { recursive: true });
          try { fs.symlinkSync(outside, parent, "junction"); swapped = true; } catch { /* no links here */ }
        },
      },
    });
    if (!swapped) return void t.skip("cannot create a directory link here");
    assert.ok(!Buffer.concat(chunks).toString("latin1").includes("OUTSIDE-SECRET"));
  });
});

describe("pages built from the Host header are not cached", () => {
  let srv;
  before(async () => { srv = await spawnServer({ AR_SERVER_DATA: path.join(root, "data-host") }); });
  after(async () => { await srv?.stop(); });

  it("with OAuth off every public page that reflects Host is no-store and varies on Host", async () => {
    for (const p of ["/", "/local", "/connect", "/connect.md", "/local.md", "/llms.txt"]) {
      const r = await new Browser(srv.base).go(p);
      assert.equal(r.headers.get("cache-control"), "no-store", p);
      assert.match(r.headers.get("vary") ?? "", /host/i, p);
    }
  });

  it("a hostile Host header never reaches a page", async () => {
    const port = new URL(srv.base).port;
    const body = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/connect.md", headers: { host: "x\"><script>alert(1)</script>", connection: "close" } }, (res) => {
        let s = "";
        res.on("data", (d) => (s += d));
        res.on("end", () => resolve(s));
      });
      req.on("error", () => resolve(""));
      req.end();
    });
    assert.ok(!body.includes("<script>"));
  });

  it("with a configured public URL the public pages stay cacheable for 5 minutes", async () => {
    const env = await startInProc();
    try {
      for (const p of ["/", "/local", "/connect.md"]) {
        const r = await new Browser(env.base).go(p);
        assert.match(r.headers.get("cache-control"), /public, max-age=300/, p);
      }
    } finally {
      await env.close();
    }
  });
});
