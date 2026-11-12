/**
 * hosted-import.test.mjs — "Import memory" on the /connect dashboard (the mirror of
 * "Download my memory").
 *
 * In-process server with the GitHub mock (as in hosted-site.test.mjs) so the clock, the
 * limits and the swap hooks can be injected; the test plays the browser. What must hold:
 * the round trip works; add never overwrites; replace keeps the old data in trash for 7
 * days; an agent token or a bad CSRF is refused before any byte is staged; one user never
 * touches another; and every hostile archive is refused or skipped with nothing written
 * outside the staging directory and the signer's own tenant.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startMock, b64url, sha256b64, GH } from "./lib/mock-providers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, "..", "dist", "http");
const readSrc = (f) => fs.readFileSync(path.join(here, "..", "src", "http", f), "utf8");
const load = (f) => import(pathToFileURL(path.join(DIST, f)).href);

const root = fs.mkdtempSync(path.join(tmpdir(), "ar-import-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

// ---- helpers ---------------------------------------------------------------------

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const form = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined)).toString();
const csrfOf = (html) => /name="csrf" value="([^"]+)"/.exec(html)?.[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  for (let t = 0; t < ms; t += 25) { if (await fn()) return true; await sleep(25); }
  return false;
}

/** Minimal ustar writer for test archives. e: {name, data, type, declared, magic, linkname}. */
function tarOf(entries, { end = true } = {}) {
  const out = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? "");
    const type = e.type ?? "0";
    const size = e.declared ?? (type === "0" ? data.length : 0);
    const h = Buffer.alloc(512, 0);
    let name = e.name;
    let prefix = "";
    if (Buffer.byteLength(name) > 100) {
      const i = name.lastIndexOf("/", name.length - 1 - 1);
      for (let k = name.lastIndexOf("/"); k > 0; k = name.lastIndexOf("/", k - 1)) {
        if (Buffer.byteLength(name.slice(k + 1)) <= 100 && Buffer.byteLength(name.slice(0, k)) <= 155) { prefix = name.slice(0, k); name = name.slice(k + 1); break; }
      }
      void i;
    }
    h.write(name, 0, "utf8");
    h.write("0000644\0", 100, "ascii");
    h.write("0000000\0", 108, "ascii");
    h.write("0000000\0", 116, "ascii");
    h.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii");
    h.write("00000000000\0", 136, "ascii");
    h.write("        ", 148, "ascii");
    h.write(type, 156, "ascii");
    if (e.linkname) h.write(e.linkname, 157, "utf8");
    h.write(e.magic ?? "ustar\0" + "00", 257, "latin1");
    h.write(prefix, 345, "utf8");
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    out.push(h);
    if (type === "0" && e.declared === undefined) {
      out.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
    } else if (e.declared !== undefined && e.data !== undefined) {
      out.push(data); // truncated on purpose: no padding
    }
  }
  if (end) out.push(Buffer.alloc(1024));
  return Buffer.concat(out);
}

/** Every regular file under dir, as sorted relative posix paths. */
function snapshot(dir) {
  const out = [];
  const walk = (d, rel) => {
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, "");
  return out.sort();
}

class Browser {
  constructor(base) { this.base = base; this.jar = new Map(); }
  cookieFor(p) { return [...this.jar.values()].filter((c) => p === c.path || p.startsWith(c.path + "/")).map((c) => `${c.name}=${c.value}`).join("; "); }
  keep(res) {
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = sc.split(";").map((s) => s.trim());
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      const attr = Object.fromEntries(attrs.map((a) => { const j = a.indexOf("="); return j < 0 ? [a.toLowerCase(), true] : [a.slice(0, j).toLowerCase(), a.slice(j + 1)]; }));
      if (attr["max-age"] === "0" || value === "") this.jar.delete(name);
      else this.jar.set(name, { name, value, path: attr.path ?? "/" });
    }
  }
  async go(target, { method = "GET", body, headers = {}, site = "same-origin", cookie, rawBody } = {}) {
    const url = new URL(target, this.base);
    const h = { connection: "close", ...(site ? { "sec-fetch-site": site } : {}), ...headers };
    const c = cookie ?? this.cookieFor(url.pathname);
    if (c) h.cookie = c;
    if (body !== undefined) h["content-type"] = "application/x-www-form-urlencoded";
    const res = await fetch(url, { method, redirect: "manual", headers: h, body: rawBody ?? (body === undefined ? undefined : form(body)) });
    this.keep(res);
    const text = await res.text();
    return { status: res.status, text, headers: res.headers, location: res.headers.get("location") };
  }
  post(target, body, opts = {}) { return this.go(target, { ...opts, method: "POST", body }); }

  /** A multipart upload as the browser's form sends it: text fields first (in the given order), the file last. */
  upload(fields, archive, opts = {}) {
    const b = "----arx" + randomBytes(8).toString("hex");
    const parts = [];
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    if (archive !== null) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="archive"; filename="m.tar"\r\nContent-Type: application/x-tar\r\n\r\n`), archive, Buffer.from("\r\n"));
    parts.push(Buffer.from(`--${b}--\r\n`));
    return this.go("/connect/import", { ...opts, method: "POST", rawBody: Buffer.concat(parts), headers: { ...(opts.headers ?? {}), "content-type": `multipart/form-data; boundary=${b}` } });
  }
}

async function signIn(b, mock, profile) {
  await b.go("/connect");
  const s = await b.post("/connect/start", { provider: "github" });
  assert.equal(s.status, 302, s.text);
  const up = new URL(s.location);
  const code = mock.issue("github", { profile, challenge: up.searchParams.get("code_challenge"), nonce: up.searchParams.get("nonce") });
  const cb = await b.go(`/authorize/callback/github?${form({ code, state: up.searchParams.get("state") })}`, { site: "cross-site" });
  assert.equal(cb.status, 302, cb.text);
  const dash = await b.go(cb.location);
  assert.equal(dash.status, 200, dash.text);
  return dash;
}

async function mcpOAuthToken(base, mock, profile, name) {
  const CB = "http://127.0.0.1:53682/callback";
  const reg = await (await fetch(base + "/register", { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify({ client_name: name, redirect_uris: [CB], token_endpoint_auth_method: "none" }) })).json();
  const verifier = b64url(randomBytes(32));
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: CB, code_challenge: sha256b64(verifier), code_challenge_method: "S256", state: "s1" });
  const a = await fetch(`${base}/authorize?${q}`, { redirect: "manual", headers: { connection: "close" } });
  const html = await a.text();
  const cookie = /^(ar_oauth_[a-f0-9]{12}=[^;]+)/.exec(a.headers.getSetCookie()[0])[1];
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)[1];
  const s = await fetch(base + "/authorize/start", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie, connection: "close" }, body: form({ request_id: requestId, provider: "github" }) });
  const up = new URL(s.headers.get("location"));
  const code = mock.issue("github", { profile, challenge: up.searchParams.get("code_challenge"), nonce: up.searchParams.get("nonce") });
  const cb = await fetch(`${base}/authorize/callback/github?${form({ code, state: up.searchParams.get("state") })}`, { redirect: "manual", headers: { cookie, connection: "close" } });
  const ours = new URL(cb.headers.get("location")).searchParams.get("code");
  const t = await (await fetch(base + "/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", connection: "close" }, body: form({ client_id: reg.client_id, grant_type: "authorization_code", code: ours, code_verifier: verifier, redirect_uri: CB }) })).json();
  return t.access_token;
}

async function tool(base, token, name, args) {
  const r = await fetch(base + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, connection: "close" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const j = await r.json();
  assert.ok(j.result, JSON.stringify(j));
  return j.result.content.map((c) => c.text).join("\n");
}

/** Reads a tar made by export-tar: [{name, type, data}]. */
function readTar(buf) {
  const out = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const field = (a, n) => h.subarray(a, a + n).toString("utf8").replace(/\0.*$/, "");
    const size = parseInt(field(124, 12), 8);
    out.push({ name: (field(345, 155) ? field(345, 155) + "/" : "") + field(0, 100), type: field(156, 1), data: buf.subarray(off + 512, off + 512 + size) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

let serverMod, oauthMod;
before(async () => {
  serverMod = await load("serve.js");
  oauthMod = await load("oauth-config.js");
});

/** An in-process server with open sign-up. */
async function startEnv({ quotaBytes, limits, hooks, perHour, clock } = {}) {
  const dataDir = fs.mkdtempSync(path.join(root, "data-"));
  const mock = await startMock();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  mock.state.base = base;
  const config = oauthMod.loadOAuthConfig({ publicUrl: base }, { AR_OAUTH_SIGNUP: "open", AR_OAUTH_GITHUB_CLIENT_ID: GH.id, AR_OAUTH_GITHUB_CLIENT_SECRET: GH.secret });
  const logs = [];
  const server = await serverMod.startHttpServer({
    dataDir, port, host: "127.0.0.1", full: false, oauth: config, quotaBytes, log: (l) => logs.push(l),
    oauthTesting: {
      providerUrls: mock.urls, loginLimits: { perIp: 10000, global: 100000, windowMs: 600000 },
      ...(clock ? { now: () => clock.t } : {}),
      importTesting: { limits, hooks, perHour },
    },
  });
  const tenants = (uid) => path.join(dataDir, "tenants", uid);
  const staging = path.join(dataDir, "_server", "import-staging");
  const trash = path.join(dataDir, "_server", "trash");
  return {
    base, dataDir, mock, logs, tenants, staging, trash,
    async user(id) {
      const b = new Browser(base);
      const dash = await signIn(b, mock, { id });
      return { b, csrf: csrfOf(dash.text), uid: `gh-${id}`, dash };
    },
    async close() { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); await mock.close(); },
  };
}

const GOOD = [
  { name: "projects/main/journal/2026-01-01.md", data: "# imported note\nhello\n" },
  { name: "projects/main/corrections/2026-01-01-never-force-push.json", data: JSON.stringify({ id: "2026-01-01-never-force-push", date: "2026-01-01", severity: "p0", project: "main", rule: "never force push", context: "x", tags: [] }) },
  { name: "awareness.md", data: "# awareness\n" },
];

const stagingEmpty = (env) => !fs.existsSync(env.staging) || fs.readdirSync(env.staging).length === 0;

// ---- units -------------------------------------------------------------------------

describe("import — units", () => {
  it("classifyPath: safe memory paths pass; unsafe or foreign ones do not", async () => {
    const { classifyPath } = await load("tar-import.js");
    const ok = (p, dir = false) => classifyPath(p, dir, undefined).ok === true;
    const why = (p, dir = false) => { const r = classifyPath(p, dir, undefined); return r.ok ? "ok" : r.why; };
    assert.ok(ok("projects/main/journal/2026-01-01.md"));
    assert.ok(ok("projects/my_proj-1/palace/rooms/a/b.JSON"));
    assert.ok(ok("awareness.md") && ok("identity-card.md") && ok("MANIFEST.md") && ok("feedback-log.json"));
    assert.ok(ok("agentrecall-gh-1/projects/main/x.md"), "the download's wrapper directory is stripped");
    for (const p of ["../x.md", "projects/../x.md", "/etc/x.md", "C:/x.md", "projects\\main\\x.md", "projects//main/x.md", "./projects/main/x.md", "projects/main/./x.md", "projects/main/x.md\0", "projects/main/\u0001.md", "projects/main/CON.md", "projects/main/nul", "projects/main/a.md.", "projects/main/a.md ", "projects/main/a:b.md", `projects/main/${"a".repeat(256)}.md`, "a/".repeat(20) + "x.md", "x".repeat(600), "projects/main/x.md/"]) {
      assert.equal(why(p), "path", JSON.stringify(p));
    }
    for (const p of ["config.json", "telemetry/x.json", "tmp/a.md", "working-memory/a.md", "_unclaimed/s/a.md", "hook-health.json", "sync-errors.log", ".lock-x", "recent-sessions.jsonl", "embeddings/index.bin", "projects/Bad Slug/a.md", "projects/UPPER/a.md", "projects/main/a.bin", "projects/main/noext", "projects/main/.hidden.md", "projects/main/.git/x.md", "projects/x.md", "projects/main"]) {
      assert.equal(why(p), "type", p);
    }
    assert.equal(classifyPath("agentrecall-a/projects/main/x.md", false, "agentrecall-b").ok, false, "a second wrapper is refused");
    assert.equal(classifyPath("projects/main/x.md", false, "agentrecall-b").ok, false, "unwrapped entry in a wrapped archive");
  });

  it("the multipart reader gives the same result however the body is cut into chunks", async () => {
    const { MultipartParser } = await load("multipart.js");
    const b = "XyZ-boundary";
    const body = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\nabc\r\n--${b}\r\nContent-Disposition: form-data; name="archive"; filename="a.tar"\r\n\r\nDATA\r\n--XyZ-boundarX\r\nMORE\r\n--${b}--\r\n`);
    for (let cut = 1; cut < body.length; cut++) {
      const parts = [];
      const p = new MultipartParser(b, { start: (i) => parts.push({ name: i.name, data: "" }), data: (c) => { parts[parts.length - 1].data += c.toString(); }, end: () => undefined });
      await p.write(body.subarray(0, cut));
      await p.write(body.subarray(cut));
      p.finish();
      assert.deepEqual(parts, [{ name: "csrf", data: "abc" }, { name: "archive", data: "DATA\r\n--XyZ-boundarX\r\nMORE" }], `cut ${cut}`);
    }
    const p = new MultipartParser(b, { start() {}, data() {}, end() {} });
    await p.write(body.subarray(0, 60));
    assert.throws(() => p.finish(), /cut off/);
    await assert.rejects(new MultipartParser(b, { start() {}, data() {}, end() {} }).write(Buffer.from("junk before\r\n--" + b + "\r\n")), /before the first boundary/);
  });

  it("sweepTrash removes entries older than 7 days by the timestamp in their name, and leaves what it cannot date", async () => {
    const { sweepTrash } = await load("import-memory.js");
    const data = fs.mkdtempSync(path.join(root, "sweep-"));
    const trash = path.join(data, "_server", "trash");
    const now = Date.UTC(2026, 10, 12, 12, 0, 0);
    const iso = (ms) => new Date(ms).toISOString().replace(/[:.]/g, "-");
    const day = 86400000;
    for (const n of [`gh-1-${iso(now - 8 * day)}`, `gh-2-${iso(now - 6 * day)}`, `gh-3-${iso(now - 9 * day)}-late`, "mystery-dir"]) {
      fs.mkdirSync(path.join(trash, n, "projects"), { recursive: true });
      fs.writeFileSync(path.join(trash, n, "projects", "a.md"), "x");
    }
    assert.equal(await sweepTrash(data, now), 2);
    assert.deepEqual(fs.readdirSync(trash).sort(), [`gh-2-${iso(now - 6 * day)}`, "mystery-dir"].sort());
  });
});

// ---- the dashboard -------------------------------------------------------------------

describe("import — dashboard and instructions", () => {
  let env;
  before(async () => { env = await startEnv(); });
  after(async () => { await env.close(); });

  it("the dashboard has the import card: warning, both modes, pack commands, agent prompt; csrf comes before the file", async () => {
    const u = await env.user(1);
    const html = u.dash.text;
    assert.match(html, /<form method="post" action="\/connect\/import" enctype="multipart\/form-data">/);
    assert.match(html, /Only import an archive you made yourself\./);
    assert.match(html, /Its rules become active for all your agents\./);
    assert.match(html, /name="mode" value="add" checked/);
    assert.match(html, /name="mode" value="replace"/);
    assert.match(html, /agent-recall-memory\.tar/);
    assert.match(html, /tar --format=ustar/);
    assert.match(html, /AGENT_RECALL_ROOT/);
    const f = html.slice(html.indexOf('action="/connect/import"'));
    assert.ok(f.indexOf('name="csrf"') < f.indexOf('name="mode"') && f.indexOf('name="mode"') < f.indexOf('name="confirm"') && f.indexOf('name="confirm"') < f.indexOf('name="archive"'), "fields precede the file");
    const csp = (await u.b.go("/connect")).headers.get("content-security-policy");
    assert.match(csp, /form-action 'self'/);
    assert.match(csp, /script-src 'sha256-/);
  });

  it("/connect.md tells an agent how to pack, and that only the human can upload", async () => {
    const md = (await new Browser(env.base).go("/connect.md")).text;
    assert.match(md, /## Import a local memory/);
    assert.match(md, /tar --format=ustar/);
    assert.match(md, /cannot upload/);
    assert.match(md, /REPLACE/);
  });
});

// ---- happy paths ---------------------------------------------------------------------

describe("import — round trip, add, replace", () => {
  it("memory written through MCP, downloaded as .tar, imports into ANOTHER account: recall finds it and session_start shows the state card", async () => {
    const env = await startEnv();
    try {
      const alice = await env.user(101);
      const tokA = await mcpOAuthToken(env.base, env.mock, { id: 101 }, "Alice agent");
      await tool(env.base, tokA, "remember", { content: "ZEBRAPELICAN-FACT: the deploy key rotates on Tuesdays" });
      await tool(env.base, tokA, "session_end", { summary: "Round trip session", insights: [], trajectory: "next: ship", state: { goal: "ROUNDTRIP-GOAL-XYZ", next: "ship the import" } });
      const dl = await alice.b.go("/connect/download", { method: "POST", body: { csrf: alice.csrf } });
      assert.equal(dl.status, 200);
      const res = await fetch(env.base + "/connect/download", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: alice.b.cookieFor("/connect"), "sec-fetch-site": "same-origin", connection: "close" }, body: form({ csrf: alice.csrf }) });
      const archive = Buffer.from(await res.arrayBuffer());
      assert.ok(readTar(archive).some((e) => e.name.startsWith("agentrecall-gh-101/projects/")), "the export has the wrapper directory");

      const bob = await env.user(202);
      const tokB = await mcpOAuthToken(env.base, env.mock, { id: 202 }, "Bob agent");
      assert.ok(!/rotates on Tuesdays/.test(await tool(env.base, tokB, "recall", { query: "ZEBRAPELICAN deploy key" })), "bob starts empty");
      const r = await bob.b.upload({ csrf: bob.csrf, mode: "add" }, archive);
      assert.equal(r.status, 200, r.text);
      assert.match(r.text, /Memory imported/);
      assert.match(r.headers.get("content-security-policy"), /script-src 'sha256-/);
      assert.ok(/rotates on Tuesdays/.test(await tool(env.base, tokB, "recall", { query: "ZEBRAPELICAN deploy key" })), "recall finds the imported fact");
      const start = await tool(env.base, tokB, "session_start", { project: "auto" });
      assert.match(start, /ROUNDTRIP-GOAL-XYZ/, "the state card came along");
      assert.ok(stagingEmpty(env), "staging is gone");
      assert.ok(snapshot(env.tenants("gh-101")).length > 0, "alice still has hers");
    } finally { await env.close(); }
  });

  it("an archive made with the system tar and the pack command's selection imports; junk in the store never does", async (t) => {
    const probe = spawnSync("tar", ["--version"], { encoding: "utf8" });
    if (probe.status !== 0) return void t.skip("no tar on PATH");
    const env = await startEnv();
    try {
      const store = fs.mkdtempSync(path.join(root, "store-"));
      const w = (rel, content) => { fs.mkdirSync(path.dirname(path.join(store, rel)), { recursive: true }); fs.writeFileSync(path.join(store, rel), content); };
      w("projects/demo/journal/2026-02-02.md", "# from my pc\n");
      w("projects/demo/corrections/2026-02-02-x.json", JSON.stringify({ severity: "p0", rule: "r", active: true }));
      w("projects/demo/.lock-x", "lock");
      w("projects/demo/vectors.bin", "binary");
      w("awareness.md", "# aw\n");
      w("config.json", JSON.stringify({ supabase_key: "SECRET-KEY" }));
      w("telemetry/t.jsonl", "{}");
      fs.writeFileSync(path.join(store, "list.txt"), ["awareness.md", "projects/demo/journal/2026-02-02.md", "projects/demo/corrections/2026-02-02-x.json", "projects/demo/vectors.bin", "config.json", "telemetry/t.jsonl"].join("\n") + "\n");
      const made = spawnSync("tar", ["--format=ustar", "-cf", "out.tar", "-T", "list.txt"], { cwd: store, encoding: "utf8" });
      assert.equal(made.status, 0, made.stderr);
      const u = await env.user(5);
      const r = await u.b.upload({ csrf: u.csrf }, fs.readFileSync(path.join(store, "out.tar")));
      assert.equal(r.status, 200, r.text);
      const got = snapshot(env.tenants("gh-5"));
      assert.deepEqual(got, ["awareness.md", "projects/demo/corrections/2026-02-02-x.json", "projects/demo/journal/2026-02-02.md"]);
      assert.match(r.text, /<strong>1<\/strong> always-follow correction is now active/);
    } finally { await env.close(); }
  });

  it("add mode never overwrites an existing file; new files are added", async () => {
    const env = await startEnv();
    try {
      const u = await env.user(11);
      const dir = path.join(env.tenants("gh-11"), "projects", "main", "journal");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "2026-01-01.md"), "MINE-ORIGINAL");
      const r = await u.b.upload({ csrf: u.csrf, mode: "add" }, tarOf(GOOD));
      assert.equal(r.status, 200, r.text);
      assert.equal(fs.readFileSync(path.join(dir, "2026-01-01.md"), "utf8"), "MINE-ORIGINAL");
      assert.ok(fs.existsSync(path.join(env.tenants("gh-11"), "awareness.md")));
      assert.ok(fs.existsSync(path.join(env.tenants("gh-11"), "projects", "main", "corrections", "2026-01-01-never-force-push.json")));
      assert.match(r.text, /left as they were/);
    } finally { await env.close(); }
  });

  it("replace needs the typed word REPLACE, swaps the memory, and keeps the old data in trash", async () => {
    const clock = { t: Date.now() };
    const env = await startEnv({ clock });
    try {
      const u = await env.user(12);
      const old = path.join(env.tenants("gh-12"), "projects", "old");
      fs.mkdirSync(old, { recursive: true });
      fs.writeFileSync(path.join(old, "keep.md"), "OLD-MEMORY");
      const no = await u.b.upload({ csrf: u.csrf, mode: "replace", confirm: "replace please" }, tarOf(GOOD));
      assert.equal(no.status, 400);
      assert.ok(fs.existsSync(path.join(old, "keep.md")), "nothing changed without the confirmation");
      assert.ok(stagingEmpty(env));
      const ok = await u.b.upload({ csrf: u.csrf, mode: "replace", confirm: "REPLACE" }, tarOf(GOOD));
      assert.equal(ok.status, 200, ok.text);
      assert.deepEqual(snapshot(env.tenants("gh-12")), ["awareness.md", "projects/main/corrections/2026-01-01-never-force-push.json", "projects/main/journal/2026-01-01.md"]);
      const kept = fs.readdirSync(env.trash);
      assert.equal(kept.length, 1);
      assert.match(kept[0], /^gh-12-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
      assert.equal(fs.readFileSync(path.join(env.trash, kept[0], "projects", "old", "keep.md"), "utf8"), "OLD-MEMORY");
      assert.ok(stagingEmpty(env));

      // 7 days later any import sweeps the trash.
      clock.t += 8 * 86400000;
      const again = await env.user(13);
      const r = await again.b.upload({ csrf: again.csrf }, tarOf(GOOD));
      assert.equal(r.status, 200, r.text);
      assert.ok(await until(() => !fs.existsSync(env.trash) || fs.readdirSync(env.trash).length === 0), "trash older than 7 days is deleted");
    } finally { await env.close(); }
  });

  it("replace with an archive that holds no memory files changes nothing", async () => {
    const env = await startEnv();
    try {
      const u = await env.user(14);
      fs.mkdirSync(path.join(env.tenants("gh-14"), "projects", "keep"), { recursive: true });
      fs.writeFileSync(path.join(env.tenants("gh-14"), "projects", "keep", "a.md"), "KEEP");
      const r = await u.b.upload({ csrf: u.csrf, mode: "replace", confirm: "REPLACE" }, tarOf([{ name: "config.json", data: "{}" }]));
      assert.equal(r.status, 422);
      assert.equal(fs.readFileSync(path.join(env.tenants("gh-14"), "projects", "keep", "a.md"), "utf8"), "KEEP");
      assert.ok(!fs.existsSync(env.trash) || fs.readdirSync(env.trash).length === 0);
    } finally { await env.close(); }
  });

  it("an archive that would create thousands of folders (or free empty files) is refused: inodes are charged", async () => {
    const env = await startEnv();
    try {
      const u = await env.user(16);
      const many = Array.from({ length: 2100 }, (_, i) => ({ name: `projects/main/d${i}/x.md`, data: "" }));
      const r = await u.b.upload({ csrf: u.csrf }, tarOf(many));
      assert.equal(r.status, 413, r.text.slice(0, 200));
      assert.deepEqual(snapshot(env.tenants("gh-16")), []);
      assert.ok(stagingEmpty(env));
    } finally { await env.close(); }
  });

  it("only the most recent replaced memory is kept in trash per account", async () => {
    const env = await startEnv();
    try {
      const u = await env.user(17);
      for (const n of ["ONE", "TWO", "THREE"]) {
        fs.mkdirSync(path.join(env.tenants("gh-17"), "projects", "main"), { recursive: true });
        fs.writeFileSync(path.join(env.tenants("gh-17"), "projects", "main", "marker.md"), n);
        const r = await u.b.upload({ csrf: u.csrf, mode: "replace", confirm: "REPLACE" }, tarOf(GOOD));
        assert.equal(r.status, 200, r.text);
        await sleep(5);
      }
      const kept = fs.readdirSync(env.trash);
      assert.equal(kept.length, 1);
      assert.equal(fs.readFileSync(path.join(env.trash, kept[0], "projects", "main", "marker.md"), "utf8"), "THREE");
    } finally { await env.close(); }
  });

  it("the cached usage figure is dropped after an import (UsageTracker.invalidate)", async () => {
    const { UsageTracker } = await load("limits.js");
    let scans = 0;
    const ut = new UsageTracker({ quotaBytes: 1000, ttlMs: 60_000 });
    ut.scan = async () => ++scans * 100;
    assert.equal(await ut.usage("gh-1", "/x"), 100);
    assert.equal(await ut.usage("gh-1", "/x"), 100, "cached");
    ut.invalidate("gh-1");
    assert.equal(await ut.usage("gh-1", "/x"), 200, "re-scanned after invalidate");
    assert.ok(readSrc("serve.ts").includes("onTenantChanged: (u) => usage?.invalidate(u)"), "serve.ts wires the import to the tracker");
  });
});

// ---- who may import ---------------------------------------------------------------------

describe("import — who may import", () => {
  let env, alice, bob, aroAlice;
  before(async () => {
    env = await startEnv();
    alice = await env.user(21);
    bob = await env.user(22);
    aroAlice = await mcpOAuthToken(env.base, env.mock, { id: 21 }, "Alice agent");
  });
  after(async () => { await env.close(); });

  it("an agent token (ar_ / aro_) gets 403, even beside a valid session and a valid csrf; nothing is staged or written", async () => {
    const before = snapshot(env.dataDir);
    for (const auth of [`Bearer ${aroAlice}`, "Bearer ar_nope"]) {
      const r = await alice.b.upload({ csrf: alice.csrf }, tarOf(GOOD), { headers: { authorization: auth } });
      assert.equal(r.status, 403);
      assert.match(r.text, /does not accept API tokens/);
      const bare = await new Browser(env.base).upload({ csrf: "x" }, tarOf(GOOD), { headers: { authorization: auth } });
      assert.equal(bare.status, 403);
    }
    assert.deepEqual(snapshot(env.dataDir).filter((f) => !before.includes(f) && !f.startsWith("_server/activity")), []);
    assert.ok(!fs.existsSync(env.staging));
  });

  it("missing, wrong, foreign or cross-site CSRF is refused before any byte is staged; no session is 401", async () => {
    const big = tarOf([{ name: "projects/main/a.md", data: "z".repeat(200_000) }]);
    const cases = [
      ["no csrf", { mode: "add" }, {}, 403],
      ["wrong csrf", { csrf: "wrong", mode: "add" }, {}, 403],
      ["another session's csrf", { csrf: bob.csrf, mode: "add" }, {}, 403],
      ["csrf after the file", null, {}, 403],
      ["cross-site", { csrf: alice.csrf }, { site: "cross-site" }, 403],
      ["same-site sibling", { csrf: alice.csrf }, { site: "same-site" }, 403],
      ["foreign Origin", { csrf: alice.csrf }, { site: undefined, headers: { origin: "https://evil.example" } }, 403],
      ["no session", { csrf: alice.csrf }, { cookie: "" }, 401],
    ];
    for (const [label, fields, opts, status] of cases) {
      let r;
      if (fields === null) {
        // The file first, the token after it: the file must never be taken.
        const b = "----late";
        const body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="archive"; filename="m.tar"\r\n\r\n`), big, Buffer.from(`\r\n--${b}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\n${alice.csrf}\r\n--${b}--\r\n`)]);
        r = await alice.b.go("/connect/import", { method: "POST", rawBody: body, headers: { "content-type": `multipart/form-data; boundary=${b}` } });
      } else {
        r = await alice.b.upload(fields, big, opts);
      }
      assert.equal(r.status, status, `${label}: ${r.text.slice(0, 200)}`);
      assert.ok(!fs.existsSync(env.staging), `${label}: staging was never even created`);
      assert.ok(!fs.existsSync(env.tenants("gh-21")), `${label}: nothing in the tenant`);
    }
  });

  it("user A's import never touches user B, even when the archive is full of B's name", async () => {
    fs.mkdirSync(path.join(env.tenants("gh-22"), "projects", "main"), { recursive: true });
    fs.writeFileSync(path.join(env.tenants("gh-22"), "projects", "main", "b.md"), "BOB-ONLY");
    const bBefore = snapshot(env.tenants("gh-22"));
    const r = await alice.b.upload({ csrf: alice.csrf, mode: "replace", confirm: "REPLACE" }, tarOf([
      ...GOOD.map((e) => ({ ...e, name: "agentrecall-gh-22/" + e.name })),
      { name: "../gh-22/projects/main/b.md", data: "OVERWRITTEN" },
      { name: "agentrecall-gh-22/../../tenants/gh-22/projects/main/b.md", data: "OVERWRITTEN" },
    ]));
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(snapshot(env.tenants("gh-22")), bBefore);
    assert.equal(fs.readFileSync(path.join(env.tenants("gh-22"), "projects", "main", "b.md"), "utf8"), "BOB-ONLY");
    assert.ok(fs.existsSync(path.join(env.tenants("gh-21"), "awareness.md")), "A got her own import");
  });
});

// ---- hostile archives ------------------------------------------------------------------------

describe("import — hostile archives", () => {
  const outsideDirs = [];
  const check = async ({ label, entries, tarOpts, limits, quotaBytes, hooks, expect }) => {
    const env = await startEnv({ limits, quotaBytes, hooks: typeof hooks === "function" ? hooks(root) : hooks });
    try {
      const u = await env.user(31);
      const sentinel = path.join(root, `sentinel-${randomBytes(4).toString("hex")}`);
      fs.mkdirSync(sentinel);
      outsideDirs.push(sentinel);
      const before = snapshot(root).filter((f) => !f.startsWith("data-"));
      const r = await u.b.upload({ csrf: u.csrf, mode: "add" }, entries instanceof Buffer ? entries : tarOf(entries, tarOpts));
      await expect(r, env, u);
      assert.ok(stagingEmpty(env), `${label}: staging removed`);
      assert.deepEqual(snapshot(root).filter((f) => !f.startsWith("data-")), before, `${label}: nothing written outside the data directory`);
      const written = snapshot(env.dataDir).filter((f) => !f.startsWith("_server/"));
      assert.ok(written.every((f) => f.startsWith("tenants/gh-31/")), `${label}: only the signer's tenant was written: ${written}`);
      assert.deepEqual(fs.readdirSync(sentinel), [], `${label}: the outside directory is empty`);
      return { r, env, files: snapshot(env.tenants("gh-31")) };
    } finally { await env.close(); }
  };

  const importedOnly = (names) => async (r, env) => {
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(snapshot(env.tenants("gh-31")), names);
  };
  const good1 = { name: "projects/main/journal/ok.md", data: "ok" };

  const skipCases = {
    "../ traversal": [{ name: "../evil.md", data: "x" }, { name: "projects/../../evil.md", data: "x" }, { name: "projects/main/../../../evil.md", data: "x" }],
    "absolute paths": [{ name: "/etc/evil.md", data: "x" }, { name: "/projects/main/evil.md", data: "x" }],
    "drive letters": [{ name: "C:/evil.md", data: "x" }, { name: "c:projects/main/evil.md", data: "x" }],
    "backslashes": [{ name: "projects\\main\\evil.md", data: "x" }, { name: "..\\evil.md", data: "x" }],
    "symlink entries": [{ name: "projects/main/link.md", type: "2", linkname: "/etc/passwd" }, { name: "projects/main/link2.md", type: "2", linkname: "../../x" }],
    "hardlink entries": [{ name: "projects/main/hard.md", type: "1", linkname: "projects/main/journal/ok.md" }],
    "device and fifo entries": [{ name: "projects/main/dev.md", type: "3" }, { name: "projects/main/fifo.md", type: "6" }],
    "config.json at the root": [{ name: "config.json", data: JSON.stringify({ supabase_key: "k" }) }],
    "a bad project slug": [{ name: "projects/Bad Slug/a.md", data: "x" }, { name: "projects/UP/a.md", data: "x" }, { name: "projects/-x/a.md", data: "x" }],
    "disallowed extensions": [{ name: "projects/main/run.sh", data: "x" }, { name: "projects/main/a.bin", data: "x" }, { name: "projects/main/noext", data: "x" }, { name: "projects/main/.hidden.md", data: "x" }],
    "not-memory roots": [{ name: "telemetry/x.json", data: "x" }, { name: "tmp/x.md", data: "x" }, { name: "working-memory/x.md", data: "x" }, { name: "_unclaimed/s/x.md", data: "x" }, { name: "hook-health.json", data: "x" }, { name: "sync-errors.log", data: "x" }, { name: ".lock-1", data: "x" }, { name: "recent-sessions.jsonl", data: "x" }],
    "duplicate entries": [{ name: "projects/main/dup.md", data: "FIRST" }, { name: "projects/main/dup.md", data: "SECOND" }],
    "case-fold collisions": [{ name: "projects/main/Case.md", data: "FIRST" }, { name: "projects/main/case.md", data: "SECOND" }],
    "Windows-reserved names": [{ name: "projects/main/CON.md", data: "x" }, { name: "projects/main/aux", data: "x" }, { name: "projects/main/trail.md.", data: "x" }],
  };
  for (const [label, evil] of Object.entries(skipCases)) {
    it(`${label}: skipped and counted, the good entry still imports`, async () => {
      const expected = ["projects/main/journal/ok.md"];
      if (label === "duplicate entries") expected.unshift("projects/main/dup.md");
      if (label === "case-fold collisions") expected.unshift("projects/main/Case.md");
      expected.sort();
      const { r } = await check({ label, entries: [good1, ...evil], expect: importedOnly(expected) });
      assert.match(r.text, /left out/);
    });
  }

  it("a file over the size cap is refused and skipped", async () => {
    await check({ label: "oversize", entries: [good1, { name: "projects/main/huge.md", data: "x".repeat(5000) }], limits: { maxFileBytes: 1000 }, expect: async (r, env) => {
      assert.equal(r.status, 200, r.text);
      assert.match(r.text, /too large/);
      assert.deepEqual(snapshot(env.tenants("gh-31")), ["projects/main/journal/ok.md"]);
    } });
  });

  it("a declared size larger than the data (cut-off archive) imports nothing", async () => {
    await check({ label: "truncated", entries: [good1, { name: "projects/main/cut.md", declared: 5000, data: "y".repeat(100) }], expect: async (r, env) => {
      assert.equal(r.status, 400, r.text);
      assert.deepEqual(snapshot(env.tenants("gh-31")), [], "nothing, not even the good file before it");
    } });
    await check({ label: "no end marker", entries: [good1], tarOpts: { end: false }, expect: async (r, env) => {
      assert.equal(r.status, 400, r.text);
      assert.deepEqual(snapshot(env.tenants("gh-31")), []);
    } });
  });

  it("too many entries aborts the import", async () => {
    await check({ label: "entries", entries: Array.from({ length: 9 }, (_, i) => ({ name: `projects/main/n${i}.md`, data: "x" })), limits: { maxEntries: 5 }, expect: async (r, env) => {
      assert.equal(r.status, 400, r.text);
      assert.match(r.text, /too many entries/);
      assert.deepEqual(snapshot(env.tenants("gh-31")), []);
    } });
  });

  it("an archive over the quota aborts while streaming, nothing is imported", async () => {
    await check({ label: "quota", entries: [good1, { name: "projects/main/a.md", data: "x".repeat(30_000) }, { name: "projects/main/b.md", data: "x".repeat(30_000) }], quotaBytes: 40_000, expect: async (r, env) => {
      assert.equal(r.status, 413, r.text);
      assert.deepEqual(snapshot(env.tenants("gh-31")), []);
    } });
  });

  it("pax and GNU extension headers, v7/GNU magic, and a bad checksum abort the import", async () => {
    for (const [label, bad] of [
      ["pax x", { name: "pax", type: "x", data: "" }],
      ["pax g", { name: "pax", type: "g", data: "" }],
      ["GNU long name", { name: "././@LongLink", type: "L", data: "" }],
      ["GNU magic", { name: "projects/main/a.md", data: "x", magic: "ustar  \0" }],
    ]) {
      await check({ label, entries: [good1, bad], expect: async (r, env) => {
        assert.equal(r.status, 400, `${label}: ${r.text}`);
        assert.deepEqual(snapshot(env.tenants("gh-31")), [], label);
      } });
    }
    const corrupt = tarOf([good1]);
    corrupt[10] ^= 0xff;
    await check({ label: "checksum", entries: corrupt, expect: async (r) => assert.equal(r.status, 400, r.text) });
    await check({ label: "garbage", entries: Buffer.from("this is not a tar archive at all".repeat(40)), expect: async (r) => assert.equal(r.status, 400, r.text) });
  });

  it("a parent directory swapped for a link mid-import writes nothing outside", async (t) => {
    const outside = path.join(root, "swap-outside");
    fs.mkdirSync(outside, { recursive: true });
    for (const point of ["beforeFile", "beforeOpen"]) {
      let swapped = false;
      const hooks = () => ({
        [point]: async (abs) => {
          if (swapped || !abs.endsWith("swap.md")) return;
          swapped = true;
          const parent = path.dirname(abs);
          fs.rmSync(parent, { recursive: true, force: true });
          try { fs.symlinkSync(outside, parent, "junction"); } catch { t.diagnostic("links not permitted here"); }
        },
      });
      await check({ label: `swap at ${point}`, entries: [good1, { name: "projects/main/swapdir/swap.md", data: "ESCAPED" }], hooks, expect: async (r, env) => {
        assert.equal(r.status, 400, `${point}: ${r.text}`);
        assert.deepEqual(snapshot(env.tenants("gh-31")), [], "the whole import was abandoned");
      } });
      assert.deepEqual(fs.readdirSync(outside), [], `${point}: nothing landed in the link's target`);
    }
  });

  it("a tenant directory swapped for a link while adding is never followed", async (t) => {
    const outside = path.join(root, "commit-outside");
    fs.mkdirSync(outside, { recursive: true });
    let swapped = false;
    const hooks = () => ({
      beforeCommitFile: async (dest) => {
        if (swapped || !dest.endsWith("late.md")) return;
        swapped = true;
        const parent = path.dirname(dest);
        fs.rmSync(parent, { recursive: true, force: true });
        try { fs.symlinkSync(outside, parent, "junction"); } catch { t.diagnostic("links not permitted here"); }
      },
    });
    await check({ label: "commit swap", entries: [{ name: "projects/main/late/late.md", data: "ESCAPED" }], hooks, expect: async (r) => { assert.equal(r.status, 400, r.text); } });
    assert.deepEqual(fs.readdirSync(outside), [], "nothing landed in the link's target");
  });
});

// ---- disconnects, locks, rate ---------------------------------------------------------------------

describe("import — disconnects, one at a time, rate limit", () => {
  /** Starts an upload and sends only its beginning; returns controls. */
  function slowUpload(env, u, firstBytes) {
    const b = "----slow" + randomBytes(4).toString("hex");
    const url = new URL("/connect/import", env.base);
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: {
      "content-type": `multipart/form-data; boundary=${b}`, cookie: u.b.cookieFor("/connect"), "sec-fetch-site": "same-origin", "transfer-encoding": "chunked", connection: "close",
    } });
    req.on("error", () => undefined);
    const resp = new Promise((resolve) => req.on("response", (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(c).toString() })); }));
    req.write(`--${b}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\n${u.csrf}\r\n--${b}\r\nContent-Disposition: form-data; name="archive"; filename="m.tar"\r\n\r\n`);
    req.write(firstBytes);
    return { req, resp, finish(rest) { req.write(rest); req.end(`\r\n--${b}--\r\n`); } };
  }

  it("a client that disconnects mid-upload leaves no staging directory and frees the per-user lock", async () => {
    const env = await startEnv();
    try {
      const u = await env.user(41);
      const full = tarOf(GOOD);
      const s = slowUpload(env, u, full.subarray(0, 700));
      assert.ok(await until(() => fs.existsSync(env.staging) && fs.readdirSync(env.staging).length === 1), "staging exists while the upload is open");
      s.req.destroy();
      assert.ok(await until(() => stagingEmpty(env)), "staging removed after the disconnect");
      assert.ok(env.logs.some((l) => l.includes("import aborted uid=gh-41")), "logged as aborted");
      const r = await u.b.upload({ csrf: u.csrf }, full);
      assert.equal(r.status, 200, "the lock was released: " + r.text);
      assert.deepEqual(snapshot(env.tenants("gh-41")).length > 0, true);
    } finally { await env.close(); }
  });

  it("a second concurrent import is refused while the first runs; the first still completes", async () => {
    const env = await startEnv();
    try {
      const u = await env.user(42);
      const full = tarOf(GOOD);
      const s = slowUpload(env, u, full.subarray(0, 700));
      assert.ok(await until(() => fs.existsSync(env.staging) && fs.readdirSync(env.staging).length === 1));
      const second = await u.b.upload({ csrf: u.csrf }, full);
      assert.equal(second.status, 409, second.text);
      s.finish(full.subarray(700));
      const first = await s.resp;
      assert.equal(first.status, 200, first.text);
      assert.match(first.text, /Memory imported/);
    } finally { await env.close(); }
  });

  it("an upload that stalls is dropped after the idle timeout and its staging removed", async () => {
    const env = await startEnv({ limits: { idleMs: 300 } });
    try {
      const u = await env.user(43);
      const s = slowUpload(env, u, tarOf(GOOD).subarray(0, 600));
      assert.ok(await until(() => fs.existsSync(env.staging)));
      assert.ok(await until(() => stagingEmpty(env), 3000), "idle timeout cleans up");
      s.req.destroy();
      const r = await u.b.upload({ csrf: u.csrf }, tarOf(GOOD));
      assert.equal(r.status, 200, r.text);
    } finally { await env.close(); }
  });

  it("only a few imports per hour per user", async () => {
    const env = await startEnv({ perHour: 2 });
    try {
      const u = await env.user(44);
      assert.equal((await u.b.upload({ csrf: u.csrf }, tarOf(GOOD))).status, 200);
      assert.equal((await u.b.upload({ csrf: u.csrf }, tarOf(GOOD))).status, 200);
      assert.equal((await u.b.upload({ csrf: u.csrf }, tarOf(GOOD))).status, 429);
      const other = await env.user(45);
      assert.equal((await other.b.upload({ csrf: other.csrf }, tarOf(GOOD))).status, 200, "another user is not limited");
    } finally { await env.close(); }
  });
});
