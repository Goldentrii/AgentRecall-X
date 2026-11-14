/**
 * hosted-site.test.mjs — the hosted website: /, /connect (sign-in + dashboard), /local,
 * /connect.md, /local.md, /llms.txt, and the "download my memory" export.
 *
 * Same harness as hosted-review.test.mjs: part 1 spawns the REAL agent-recall-server
 * binary with GitHub/Google mocked by a preload, and the test plays the browser (cookie
 * jar, form posts). Part 2 runs the server in-process where invite mode or a clock is needed.
 * What must hold: pages carry a strict CSP whose hashes match the inline style/script;
 * an agent token never reaches a signed-in route; one user never sees or disconnects
 * another's connections; every post needs session + CSRF + same origin; the export holds
 * only the signer's own regular files.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMock, b64url, sha256b64, GH, GG } from "./lib/mock-providers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, "..", "dist", "http");
const CLI = path.join(DIST, "cli.js");
const PRELOAD = pathToFileURL(path.join(here, "lib", "provider-mock-preload.mjs")).href;
const load = (f) => import(pathToFileURL(path.join(DIST, f)).href);

const root = fs.mkdtempSync(path.join(tmpdir(), "ar-site-"));
const fakeHome = path.join(root, "home");
fs.mkdirSync(fakeHome, { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));

// ---- helpers ---------------------------------------------------------------

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

const form = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined)).toString();
const tokenFrom = (out) => out.match(/\b(ar_[A-Za-z0-9_-]{43})\b/)[1];

function cleanEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    !k.startsWith("CLAUDE_CODE_") && k !== "CLAUDECODE" && !k.startsWith("AGENT_RECALL_") && k !== "AR_HOST" && !k.startsWith("AR_OAUTH_") && k !== "AR_PUBLIC_URL" && k !== "AR_PRIVACY_URL"));
  return { ...env, HOME: fakeHome, USERPROFILE: fakeHome, ...extra };
}

function cliIn(dataDir, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--data", dataDir], { env: cleanEnv(), encoding: "utf-8" });
  assert.equal(r.status, 0, `cli ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

async function spawnServer(env, args = []) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const log = [];
  const proc = spawn(process.execPath, [...args, CLI, "serve", "--port", String(port)], {
    env: cleanEnv(typeof env === "function" ? env(base) : env), stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", (d) => log.push(String(d)));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start:\n" + log.join(""))), 30_000);
    proc.stderr.on("data", () => { if (log.join("").includes("listening on")) { clearTimeout(t); resolve(); } });
    proc.on("exit", (c) => { clearTimeout(t); reject(new Error(`server exited ${c}:\n${log.join("")}`)); });
  });
  return {
    base, log, proc,
    async stop() {
      if (proc.exitCode === null) { proc.kill(); await new Promise((r) => proc.once("exit", r)); }
    },
  };
}

/** A browser: cookie jar honouring Path and Max-Age=0, form posts, Sec-Fetch-Site. */
class Browser {
  constructor(base) { this.base = base; this.jar = new Map(); }

  cookieFor(pathname) {
    return [...this.jar.values()].filter((c) => pathname === c.path || pathname.startsWith(c.path.endsWith("/") ? c.path : c.path + "/"))
      .map((c) => `${c.name}=${c.value}`).join("; ");
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

  async raw(target, { method = "GET", body, headers = {}, site = "same-origin", cookie } = {}) {
    const url = new URL(target, this.base);
    const h = { connection: "close", ...(site ? { "sec-fetch-site": site } : {}), ...headers };
    const c = cookie ?? this.cookieFor(url.pathname);
    if (c) h.cookie = c;
    if (body !== undefined) h["content-type"] = "application/x-www-form-urlencoded";
    const res = await fetch(url, { method, redirect: "manual", headers: h, body: body === undefined ? undefined : form(body) });
    this.keep(res);
    return res;
  }

  async go(target, opts = {}) {
    const res = await this.raw(target, opts);
    const text = await res.text();
    return { status: res.status, text, headers: res.headers, location: res.headers.get("location") };
  }

  post(target, body, opts = {}) { return this.go(target, { ...opts, method: "POST", body }); }
}

const csrfOf = (html) => /name="csrf" value="([^"]+)"/.exec(html)?.[1];
const grantIdsOf = (html) => [...html.matchAll(/name="grant" value="([a-f0-9]{12})"/g)].map((m) => m[1]);

/** The browser signs in on /connect with GitHub as `profile`; returns the dashboard. */
async function signIn(b, mock, profile, provider = "github") {
  const page = await b.go("/connect");
  assert.equal(page.status, 200, page.text);
  const s = await b.post("/connect/start", { provider });
  assert.equal(s.status, 302, `start: ${s.text}`);
  const up = new URL(s.location);
  const code = mock.issue(provider, { profile, challenge: up.searchParams.get("code_challenge"), nonce: up.searchParams.get("nonce") });
  const cb = await b.go(`/authorize/callback/${provider}?${form({ code, state: up.searchParams.get("state") })}`, { site: "cross-site" });
  assert.equal(cb.status, 302, `callback: ${cb.text}`);
  assert.equal(new URL(cb.location, b.base).pathname, "/connect");
  const dash = await b.go(cb.location);
  assert.equal(dash.status, 200, dash.text);
  return dash;
}

/** MCP OAuth for `profile` as an app named `name` → an aro_ access token. */
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
  assert.match(t.access_token, /^aro_/);
  return t.access_token;
}

/** What an agent's request to /mcp returns with this token (200 = accepted, 401 = refused). */
async function mcpStatus(base, token) {
  const r = await fetch(base + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, connection: "close" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  await r.text();
  return r.status;
}

/** Minimal ustar reader: [{name, type, data}]. Verifies every header checksum. */
function readTar(buf) {
  const out = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const field = (a, n) => h.subarray(a, a + n).toString("utf8").replace(/\0.*$/, "");
    const chk = parseInt(field(148, 8).trim(), 8);
    const sum = [...h].reduce((t, x, i) => t + (i >= 148 && i < 156 ? 32 : x), 0);
    assert.equal(sum, chk, "tar header checksum");
    const name = (field(345, 155) ? field(345, 155) + "/" : "") + field(0, 100);
    const size = parseInt(field(124, 12), 8);
    const type = field(156, 1);
    out.push({ name, type, data: buf.subarray(off + 512, off + 512 + size) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

const ALICE = { id: 101 }; // GitHub 101, linked by the operator to the existing tenant "alice" (has an operator token)
const BOB = { id: 202 }; // GitHub 202, open sign-up → gh-202
const CAROL = { id: 303 }; // GitHub 303 → gh-303

const baseUrlFor = (srv) => srv.base;

// ---- part 1: the real binary -------------------------------------------------

describe("website — real agent-recall-server binary", () => {
  let dataDir, mock, srv, tokenAlice, aliceB, bobB, aliceAro, bobAro;
  let aliceDash, bobDash;

  before(async () => {
    dataDir = path.join(root, "data-bin");
    cliIn(dataDir, "identity", "link", "--github-id", String(ALICE.id), "--uid", "alice");
    tokenAlice = tokenFrom(cliIn(dataDir, "token", "create", "--uid", "alice", "--label", "alice-laptop"));
    mock = await startMock();
    srv = await spawnServer((base) => {
      mock.state.base = base;
      return {
        AR_SERVER_DATA: dataDir, AR_PUBLIC_URL: base, AR_OAUTH_SIGNUP: "open", AR_TEST_PROVIDER_MOCK: mock.url,
        AR_PRIVACY_URL: "https://example.com/privacy",
        AR_OAUTH_GITHUB_CLIENT_ID: GH.id, AR_OAUTH_GITHUB_CLIENT_SECRET: GH.secret,
        AR_OAUTH_GOOGLE_CLIENT_ID: GG.id, AR_OAUTH_GOOGLE_CLIENT_SECRET: GG.secret,
      };
    }, ["--import", PRELOAD]);
    aliceAro = await mcpOAuthToken(srv.base, mock, ALICE, "Alice Claude Code");
    bobAro = await mcpOAuthToken(srv.base, mock, BOB, "Bob Cursor");
    aliceB = new Browser(srv.base);
    bobB = new Browser(srv.base);
    aliceDash = await signIn(aliceB, mock, ALICE);
    bobDash = await signIn(bobB, mock, BOB);
  });

  after(async () => {
    await srv?.stop();
    await mock?.close();
  });

  it("every page carries a strict CSP whose hashes match the inline style and script", async () => {
    const b = new Browser(srv.base);
    for (const p of ["/", "/local", "/connect"]) {
      const r = await b.go(p);
      assert.equal(r.status, 200, p);
      const csp = r.headers.get("content-security-policy");
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /img-src 'self' data:/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /base-uri 'none'/);
      assert.ok(!/unsafe-inline|unsafe-eval/.test(csp), `${p}: no unsafe-inline`);
      assert.ok(!/script-src[^;]*https?:/.test(csp), "no external script");
      const script = /<script>([\s\S]*?)<\/script>/.exec(r.text)?.[1];
      const style = /<style>([\s\S]*?)<\/style>/.exec(r.text)?.[1];
      assert.ok(script && style, `${p}: one inline script and one inline style`);
      const h = (s) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;
      assert.ok(csp.includes(`script-src ${h(script)}`), `${p}: script hash matches`);
      assert.ok(csp.includes(`style-src ${h(style)}`), `${p}: style hash matches`);
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
      assert.equal(r.headers.get("x-frame-options"), "DENY");
      assert.equal(r.headers.get("referrer-policy"), "no-referrer");
      // Nothing from anywhere else: no external scripts, stylesheets, fonts, images or imports.
      assert.ok(!/<script[^>]+src=/i.test(r.text));
      assert.ok(!/<link[^>]+rel="stylesheet"/i.test(r.text));
      assert.ok(!/@import|url\(\s*https?:|font-face/i.test(r.text));
      assert.ok(!/<img[^>]+src="https?:/i.test(r.text));
      assert.ok(!/\sstyle="/i.test(r.text), "no inline style attributes (the CSP would block them)");
    }
  });

  it("the home page offers both doors, with the footer links", async () => {
    const r = await new Browser(srv.base).go("/");
    assert.match(r.text, /<a class="btn" href="\/connect">Connect an agent<\/a>/);
    assert.match(r.text, /href="\/local"/);
    assert.match(r.text, /href="https:\/\/github\.com\/Goldentrii\/AgentRecall-X"/);
    assert.match(r.text, /href="https:\/\/example\.com\/privacy"/, "the operator's privacy URL");
    assert.match(r.text, /href="https:\/\/t\.me\/\+ywZwoHrg3AM0NDVi"/);
    assert.match(r.text, /<canvas id="stage" aria-hidden="true">/, "the hero is the film canvas");
    assert.match(r.text, /<title>[^<]*AgentRecall/);
  });

  it("/local has the paste-to-your-agent prompt and the manual commands", async () => {
    const r = await new Browser(srv.base).go("/local");
    assert.match(r.text, /claude mcp add --scope user agent-recall -- npx -y agent-recall-mcp/);
    assert.match(r.text, /codex mcp add agent-recall -- npx -y agent-recall-mcp/);
    assert.match(r.text, /SKILL\.md/);
    assert.match(r.text, /data-copy="lprompt"/);
  });

  it("signed out, /connect offers sign-in (GitHub and Google) and no account data", async () => {
    const r = await new Browser(srv.base).go("/connect");
    assert.match(r.text, /<form method="post" action="\/connect\/start">/);
    assert.match(r.text, /Sign in with GitHub/);
    assert.match(r.text, /Sign in with Google/);
    assert.equal(csrfOf(r.text), undefined);
    assert.match(r.headers.get("content-security-policy"), /form-action 'self' https:\/\/github\.com https:\/\/accounts\.google\.com/);
    assert.equal(r.headers.get("cache-control"), "no-store");
  });

  it("signing in with GitHub shows the account's ID, the connect commands and an agent prompt", async () => {
    assert.match(bobDash.text, />gh-202</);
    assert.match(bobDash.text, /no email is collected/i);
    const base = srv.base;
    assert.ok(bobDash.text.includes(`claude mcp add --scope user --transport http agent-recall ${base}/mcp`));
    assert.ok(bobDash.text.includes(`codex mcp add agent-recall --url ${base}/mcp`));
    assert.ok(bobDash.text.includes(`&quot;url&quot;: &quot;${base}/mcp&quot;`));
    assert.match(bobDash.text, /Settings, Connectors/);
    assert.match(bobDash.text, /data-copy="prompt"/);
    assert.match(bobDash.text, /Download my memory/);
    assert.match(bobDash.text, /href="\/review"/);
    assert.equal(bobDash.headers.get("cache-control"), "no-store");
    assert.match(aliceDash.text, />alice</, "an operator-linked account lands on its existing memory");
  });

  it("the session cookies are HttpOnly, SameSite=Lax and scoped to the site's own paths", async () => {
    const paths = [...bobB.jar.values()].filter((c) => c.name === "ar_site" || c.name === "ar_review");
    assert.equal(paths.length, 2);
    for (const c of paths) assert.match(c.raw, /HttpOnly/);
    for (const c of paths) assert.match(c.raw, /SameSite=Lax/);
    assert.match(bobB.jar.get("ar_site").raw, /Path=\/connect(;|$)/);
    assert.match(bobB.jar.get("ar_review").raw, /Path=\/review(;|$)/);
    assert.match(bobB.jar.get("ar_site").raw, /Max-Age=1800/);
    assert.equal(bobB.cookieFor("/mcp"), "", "no site cookie is ever sent to /mcp");
    assert.equal(bobB.cookieFor("/token"), "");
    assert.equal(bobB.cookieFor("/"), "");
  });

  it("the dashboard lists only this account's connections, and the operator's static tokens read-only", async () => {
    const a = await aliceB.go("/connect");
    const b = await bobB.go("/connect");
    assert.match(a.text, /Alice Claude Code/);
    assert.ok(!a.text.includes("Bob Cursor"));
    assert.match(b.text, /Bob Cursor/);
    assert.ok(!b.text.includes("Alice Claude Code"));
    assert.match(a.text, /self-reported name/);
    assert.match(a.text, /alice-laptop/, "the operator-issued token is listed by label");
    assert.ok(!/ar_[A-Za-z0-9_-]{43}/.test(a.text), "never a token value");
    assert.ok(!/aro_|arr_/.test(a.text + b.text));
    assert.equal(grantIdsOf(a.text).length, 1);
    assert.equal(grantIdsOf(b.text).length, 1);
    assert.ok(!b.text.includes("alice-laptop"));
  });

  it("an agent token (ar_ or aro_) is refused with 403 on every signed-in site route, even beside a valid session", async () => {
    const b = bobB;
    const csrf = csrfOf((await b.go("/connect")).text);
    for (const auth of [`Bearer ${tokenAlice}`, `Bearer ${aliceAro}`, "Bearer ar_nope"]) {
      const headers = { authorization: auth };
      const get = await b.go("/connect", { headers });
      assert.equal(get.status, 403, "GET /connect");
      assert.ok(!get.text.includes("gh-202"), "no account data in the refusal");
      assert.match(get.text, /does not accept API tokens/);
      const bare = await new Browser(srv.base).go("/connect", { headers });
      assert.equal(bare.status, 403, "also without a session");
      for (const [route, body] of [["/connect/disconnect", { grant: "aaaaaaaaaaaa", csrf }], ["/connect/download", { csrf }], ["/connect/logout", { csrf }], ["/connect/start", { provider: "github" }]]) {
        const r = await b.post(route, body, { headers });
        assert.equal(r.status, 403, `${route} with ${auth.slice(0, 12)}`);
      }
    }
    assert.equal((await b.go("/connect")).status, 200, "the session itself was not harmed");
  });

  it("user A can neither see nor disconnect user B's connection", async () => {
    const aliceCsrf = csrfOf((await aliceB.go("/connect")).text);
    const bobGrant = grantIdsOf((await bobB.go("/connect")).text)[0];
    const aliceGrant = grantIdsOf((await aliceB.go("/connect")).text)[0];
    assert.notEqual(bobGrant, aliceGrant);

    const steal = await aliceB.post("/connect/disconnect", { grant: bobGrant, csrf: aliceCsrf });
    assert.equal(steal.status, 303);
    assert.match((await aliceB.go("/connect")).text, /already gone, or is not yours/);
    assert.equal(await mcpStatus(srv.base, bobAro), 200, "Bob's agent is still connected");

    for (const grant of ["000000000000", "ffffffffffff"]) {
      const forged = await aliceB.post("/connect/disconnect", { grant, csrf: aliceCsrf });
      assert.equal(forged.status, 303);
      assert.match((await aliceB.go("/connect")).text, /already gone, or is not yours/);
    }
    for (const grant of ["../../x", "A".repeat(200), "", "not a grant"]) {
      const bad = await aliceB.post("/connect/disconnect", { grant, csrf: aliceCsrf });
      assert.equal(bad.status, 400, `malformed grant ${JSON.stringify(grant).slice(0, 20)}`);
    }
    assert.equal(await mcpStatus(srv.base, bobAro), 200);
    assert.equal(await mcpStatus(srv.base, aliceAro), 200);
  });

  it("every post is refused without CSRF, with a wrong CSRF, cross-site, and without a session", async () => {
    const b = bobB;
    const csrf = csrfOf((await b.go("/connect")).text);
    const grant = grantIdsOf((await b.go("/connect")).text)[0];
    for (const route of ["/connect/disconnect", "/connect/download", "/connect/logout"]) {
      const base = route === "/connect/disconnect" ? { grant } : {};
      assert.equal((await b.post(route, { ...base })).status, 403, `${route}: no csrf`);
      assert.equal((await b.post(route, { ...base, csrf: "wrong" })).status, 403, `${route}: wrong csrf`);
      assert.equal((await b.post(route, { ...base, csrf: csrfOf((await aliceB.go("/connect")).text) })).status, 403, `${route}: another session's csrf`);
      assert.equal((await b.post(route, { ...base, csrf }, { site: "cross-site" })).status, 403, `${route}: cross-site`);
      assert.equal((await b.post(route, { ...base, csrf }, { site: "same-site" })).status, 403, `${route}: same-site sibling`);
      assert.equal((await b.post(route, { ...base, csrf }, { site: undefined, headers: { origin: "https://evil.example" } })).status, 403, `${route}: foreign Origin`);
      assert.equal((await b.post(route, { ...base, csrf }, { cookie: "" })).status, 401, `${route}: no session`);
    }
    assert.equal(await mcpStatus(srv.base, bobAro), 200, "nothing was disconnected by the refused posts");
    assert.equal((await b.go("/connect")).status, 200, "still signed in");
  });

  it("disconnect revokes that grant: its aro_ token gets 401 on /mcp, other connections keep working", async () => {
    const carol = new Browser(srv.base);
    const carolAro1 = await mcpOAuthToken(srv.base, mock, CAROL, "Carol Codex");
    const carolAro2 = await mcpOAuthToken(srv.base, mock, CAROL, "Carol claude.ai");
    await signIn(carol, mock, CAROL);
    const dash = await carol.go("/connect");
    const ids = grantIdsOf(dash.text);
    assert.equal(ids.length, 2);
    assert.equal(await mcpStatus(srv.base, carolAro1), 200);
    // The grant that belongs to "Carol Codex": its form follows its name in the list.
    const rows = dash.text.split("<li>").filter((x) => x.includes('name="grant"'));
    const codexRow = rows.find((r) => r.includes("Carol Codex"));
    const codexId = /name="grant" value="([a-f0-9]{12})"/.exec(codexRow)[1];
    const r = await carol.post("/connect/disconnect", { grant: codexId, csrf: csrfOf(dash.text) });
    assert.equal(r.status, 303);
    assert.equal(r.location, "/connect");
    const after = await carol.go("/connect");
    assert.match(after.text, /Disconnected\. That agent can no longer/);
    assert.ok(!after.text.includes("Carol Codex"));
    assert.match(after.text, /Carol claude\.ai/);
    assert.equal(await mcpStatus(srv.base, carolAro1), 401, "the disconnected agent is refused at once");
    assert.equal(await mcpStatus(srv.base, carolAro2), 200, "the other agent is untouched");
    const again = await carol.go("/connect");
    assert.ok(!/Disconnected\. That agent/.test(again.text), "the notice is shown once");
  });

  it("'Download my memory' needs a session, streams a tar of only this account's regular files", async (t) => {
    const mine = path.join(dataDir, "tenants", "gh-202", "projects", "main", "journal");
    const theirs = path.join(dataDir, "tenants", "gh-303", "projects", "main");
    fs.mkdirSync(mine, { recursive: true });
    fs.mkdirSync(theirs, { recursive: true });
    fs.writeFileSync(path.join(mine, "2026-01-01.md"), "# my note\nhello bob\n");
    fs.writeFileSync(path.join(theirs, "secret.md"), "CAROLS-SECRET");
    const outside = path.join(root, "outside-secret.txt");
    fs.writeFileSync(outside, "OUTSIDE-SECRET");
    // A directory link (a junction needs no privilege on Windows) pointing at another tenant, and a file link pointing outside.
    fs.symlinkSync(path.join(dataDir, "tenants", "gh-303"), path.join(dataDir, "tenants", "gh-202", "projects", "linkdir"), "junction");
    try { fs.symlinkSync(outside, path.join(mine, "link.md")); } catch { t.diagnostic("file symlinks not permitted here; the directory link is still tested"); }

    const b = bobB;
    const csrf = csrfOf((await b.go("/connect")).text);
    const none = await b.post("/connect/download", { csrf }, { cookie: "" });
    assert.equal(none.status, 401, "no session, no download");

    const res = await b.raw("/connect/download", { method: "POST", body: { csrf } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/x-tar");
    assert.match(res.headers.get("content-disposition"), /^attachment; filename="agentrecall-gh-202-\d{4}-\d{2}-\d{2}\.tar"$/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const files = readTar(Buffer.from(await res.arrayBuffer()));
    const names = files.map((f) => f.name);
    assert.ok(names.every((n) => n.startsWith("agentrecall-gh-202/")), `only this account's tree: ${names}`);
    const note = files.find((f) => f.name.endsWith("journal/2026-01-01.md"));
    assert.equal(note?.type, "0");
    assert.equal(note.data.toString(), "# my note\nhello bob\n");
    const all = Buffer.concat(files.map((f) => f.data)).toString();
    assert.ok(!all.includes("CAROLS-SECRET"), "another account's file is never included");
    assert.ok(!all.includes("OUTSIDE-SECRET"), "a symlink is never followed");
    assert.ok(!names.some((n) => n.endsWith("link.md") || n.includes("linkdir")), "links are skipped");
    for (let i = 0; i < 40 && !srv.log.join("").includes("[connect] download uid=gh-202"); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(srv.log.join("").includes("[connect] download uid=gh-202"), "the download is logged (uid and counts, never content)");
  });

  it("sign out ends the shared session for /connect and /review", async () => {
    const b = new Browser(srv.base);
    const dash = await signIn(b, mock, { id: 404 });
    assert.equal(csrfOf((await b.go("/review")).text) !== undefined, true, "the same sign-in opens /review");
    const out = await b.post("/connect/logout", { csrf: csrfOf(dash.text) });
    assert.equal(out.status, 303);
    assert.equal(b.jar.get("ar_site"), undefined);
    assert.equal(b.jar.get("ar_review"), undefined);
    assert.equal(csrfOf((await b.go("/connect")).text), undefined);
  });

  it("/connect.md, /local.md and /llms.txt are text, need no session, and name this server", async () => {
    const b = new Browser(srv.base);
    for (const [p, needle] of [["/connect.md", `${srv.base}/mcp`], ["/local.md", "npx -y agent-recall-mcp"], ["/llms.txt", "/connect.md"]]) {
      const r = await b.go(p, { cookie: "" });
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get("content-type"), /^text\/plain; charset=utf-8$/);
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
      assert.ok(r.text.includes(needle), `${p} mentions ${needle}`);
      assert.ok(!r.text.includes("<html"));
    }
    assert.match((await b.go("/connect.md")).text, /claude mcp add --scope user --transport http agent-recall .*\/mcp/);
    // An agent can fetch them with its token header too: they are public text.
    assert.equal((await b.go("/connect.md", { headers: { authorization: `Bearer ${tokenAlice}` } })).status, 200);
    assert.equal((await b.go("/favicon.svg")).headers.get("content-type"), "image/svg+xml");
  });

  it("static pages answer GET and HEAD only; /mcp and the OAuth routes are unchanged", async () => {
    const b = new Browser(srv.base);
    assert.equal((await b.post("/", {})).status, 405);
    assert.equal((await b.go("/", { method: "HEAD" })).status, 200);
    assert.equal((await b.go("/nope")).status, 404);
    assert.equal(await mcpStatus(srv.base, "ar_" + "A".repeat(43)), 401);
    assert.equal((await b.go("/.well-known/oauth-authorization-server")).status, 200);
    assert.equal((await b.go("/healthz")).status, 200);
  });

  it("nothing is sent to a third party: no tracker, font or CDN host appears in any page", async () => {
    const b = new Browser(srv.base);
    const hosts = new Set();
    for (const p of ["/", "/local", "/connect"]) {
      const html = (await b.go(p)).text;
      for (const m of html.matchAll(/(?:href|src|action)="(https?:\/\/[^"/]+)/g)) hosts.add(m[1]);
    }
    assert.deepEqual([...hosts].sort(), ["https://example.com", "https://github.com", "https://t.me"]);
  });
});

// ---- part 2: OAuth off ---------------------------------------------------------

describe("website — OAuth off", () => {
  let srv;
  before(async () => {
    srv = await spawnServer(() => ({ AR_SERVER_DATA: path.join(root, "data-off") })); // no AR_PUBLIC_URL / providers: OAuth off
  });
  after(async () => { await srv?.stop(); });

  it("/, /local, the .md files and /llms.txt still work; /connect says sign-in is not set up", async () => {
    const b = new Browser(srv.base);
    for (const p of ["/", "/local", "/connect", "/connect.md", "/local.md", "/llms.txt"]) {
      const r = await b.go(p);
      assert.equal(r.status, 200, p);
    }
    const c = await b.go("/connect");
    assert.match(c.text, /Hosted sign-in is not set up here/);
    assert.ok(!/<form/.test(c.text), "no sign-in form without providers");
    assert.match(c.headers.get("content-security-policy"), /default-src 'none'/);
    assert.match((await b.go("/connect.md")).text, /Hosted sign-in is not configured/);
  });

  it("the signed-in routes and /review do not exist, and /mcp still wants a token", async () => {
    const b = new Browser(srv.base);
    assert.equal((await b.post("/connect/download", { csrf: "x" })).status, 404);
    assert.equal((await b.post("/connect", {})).status, 405);
    assert.equal((await b.go("/review")).status, 404);
    assert.equal(await mcpStatus(srv.base, "ar_" + "A".repeat(43)), 401);
  });
});

// ---- part 3: invite mode (in-process) ----------------------------------------------

describe("website — invite-only sign-up (in-process)", () => {
  let startHttpServer, loadOAuthConfig;
  before(async () => {
    ({ startHttpServer } = await load("serve.js"));
    ({ loadOAuthConfig } = await load("oauth-config.js"));
  });

  async function startEnv(signup) {
    const dataDir = fs.mkdtempSync(path.join(root, "data-ip-"));
    const mock = await startMock();
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    mock.state.base = base;
    const config = loadOAuthConfig({ publicUrl: base }, { AR_OAUTH_SIGNUP: signup, AR_OAUTH_GITHUB_CLIENT_ID: GH.id, AR_OAUTH_GITHUB_CLIENT_SECRET: GH.secret });
    const server = await startHttpServer({
      dataDir, port, host: "127.0.0.1", full: false, oauth: config, log: () => {},
      oauthTesting: { providerUrls: mock.urls, loginLimits: { perIp: 1000, global: 10000, windowMs: 600000 } },
    });
    return { base, dataDir, mock, async close() { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); await mock.close(); } };
  }

  it("an uninvited account gets the 'not invited' page and no dashboard, session or tenant", async () => {
    const env = await startEnv("invite");
    try {
      const b = new Browser(env.base);
      await b.go("/connect");
      const s = await b.post("/connect/start", { provider: "github" });
      const up = new URL(s.location);
      const code = env.mock.issue("github", { profile: { id: 555 }, challenge: up.searchParams.get("code_challenge"), nonce: up.searchParams.get("nonce") });
      const cb = await b.go(`/authorize/callback/github?${form({ code, state: up.searchParams.get("state") })}`, { site: "cross-site" });
      assert.equal(cb.status, 403);
      assert.match(cb.text, /not invited/);
      assert.match(cb.text, /github 555/, "it shows the id to send to the operator");
      assert.equal(csrfOf(cb.text), undefined);
      assert.equal(b.jar.get("ar_site"), undefined);
      assert.equal(b.jar.get("ar_review"), undefined);
      assert.match(cb.headers.get("content-security-policy"), /script-src 'sha256-/, "same strict site headers");
      const dash = await b.go("/connect");
      assert.equal(csrfOf(dash.text), undefined, "still just the sign-in page");
      assert.ok(!fs.existsSync(path.join(env.dataDir, "tenants", "gh-555")), "no tenant is created");
    } finally {
      await env.close();
    }
  });

  it("an invited (linked) account signs in and sees its dashboard", async () => {
    const env = await startEnv("invite");
    try {
      cliIn(env.dataDir, "identity", "link", "--github-id", "777", "--uid", "dora");
      const b = new Browser(env.base);
      const dash = await signIn(b, env.mock, { id: 777 });
      assert.match(dash.text, />dora</);
    } finally {
      await env.close();
    }
  });

  it("sign-in starts from /connect are limited per IP", async () => {
    const dataDir = fs.mkdtempSync(path.join(root, "data-lim-"));
    const mock = await startMock();
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    mock.state.base = base;
    const config = loadOAuthConfig({ publicUrl: base }, { AR_OAUTH_SIGNUP: "open", AR_OAUTH_GITHUB_CLIENT_ID: GH.id, AR_OAUTH_GITHUB_CLIENT_SECRET: GH.secret });
    const server = await startHttpServer({ dataDir, port, host: "127.0.0.1", full: false, oauth: config, log: () => {}, oauthTesting: { providerUrls: mock.urls, loginLimits: { perIp: 2, global: 10000, windowMs: 600000 } } });
    try {
      const b = new Browser(base);
      assert.equal((await b.post("/connect/start", { provider: "github" })).status, 302);
      assert.equal((await b.post("/connect/start", { provider: "github" })).status, 302);
      const third = await b.post("/connect/start", { provider: "github" });
      assert.equal(third.status, 429);
      assert.ok(Number(third.headers.get("retry-after")) > 0);
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      await mock.close();
    }
  });
});

// ---- part 4: the tar exporter ------------------------------------------------------

describe("website — export-tar unit", () => {
  it("writes regular files, skips links and odd names, and stays well formed for long paths", async (t) => {
    const { streamTenantTar } = await load("export-tar.js");
    const dir = path.join(root, "tar-unit");
    fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(dir, "a", "b", "note.md"), "x".repeat(1000));
    fs.writeFileSync(path.join(dir, "empty.md"), "");
    const long = "d".repeat(90);
    fs.mkdirSync(path.join(dir, long, long), { recursive: true });
    fs.writeFileSync(path.join(dir, long, long, "deep.md"), "deep");
    const outside = path.join(root, "tar-outside.txt");
    fs.writeFileSync(outside, "NOPE");
    try { fs.symlinkSync(outside, path.join(dir, "evil.md")); } catch { t.diagnostic("no file symlinks here"); }
    fs.mkdirSync(path.join(root, "tar-outside-dir"), { recursive: true });
    fs.writeFileSync(path.join(root, "tar-outside-dir", "x.md"), "NOPE");
    fs.symlinkSync(path.join(root, "tar-outside-dir"), path.join(dir, "evildir"), "junction");
    const chunks = [];
    const sink = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
    const stats = await streamTenantTar(dir, "top", sink);
    const files = readTar(Buffer.concat(chunks)).filter((f) => f.type === "0");
    const byName = Object.fromEntries(files.map((f) => [f.name, f.data.length]));
    assert.equal(byName["top/a/b/note.md"], 1000);
    assert.equal(byName["top/empty.md"], 0);
    assert.equal(byName[`top/${long}/${long}/deep.md`], 4);
    assert.ok(!files.some((f) => f.name.includes("evil")), "neither a file link nor a directory link is followed");
    assert.equal(stats.files, 3);
  });

  it("a missing or non-directory root exports an empty, well-formed archive", async () => {
    const { streamTenantTar } = await load("export-tar.js");
    const chunks = [];
    const sink = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
    const stats = await streamTenantTar(path.join(root, "does-not-exist"), "top", sink);
    assert.equal(stats.files, 0);
    assert.equal(readTar(Buffer.concat(chunks)).filter((f) => f.type === "0").length, 0);
  });
});

// ---- part 5: "Your agents": every agent that used this memory, however it signed in ----------

describe("website — your agents (activity)", () => {
  let startHttpServer, loadOAuthConfig, writeJsonAtomic;
  before(async () => {
    ({ startHttpServer } = await load("serve.js"));
    ({ loadOAuthConfig } = await load("oauth-config.js"));
    ({ writeJsonAtomic } = await load("jsonfile.js"));
  });

  const mcpPost = (base, token, body) => fetch(base + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, connection: "close" },
    body: JSON.stringify(body),
  }).then(async (r) => { await r.text(); return r.status; });
  const hello = (name) => ({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name, version: "1" } } });
  const callTool = (name) => ({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: { content: "hello" } } });

  async function startEnv(extra = {}) {
    const dataDir = fs.mkdtempSync(path.join(root, "data-act-"));
    cliIn(dataDir, "identity", "link", "--github-id", String(ALICE.id), "--uid", "alice");
    const tokenOut = cliIn(dataDir, "token", "create", "--uid", "alice", "--label", "alice-laptop");
    const token = tokenFrom(tokenOut);
    const tokenId = /Created token ([a-f0-9]{12})/.exec(tokenOut)[1];
    const mock = await startMock();
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    mock.state.base = base;
    const config = loadOAuthConfig({ publicUrl: base }, { AR_OAUTH_SIGNUP: "open", AR_OAUTH_GITHUB_CLIENT_ID: GH.id, AR_OAUTH_GITHUB_CLIENT_SECRET: GH.secret });
    const logs = [];
    const writes = [];
    const server = await startHttpServer({
      dataDir, port, host: "127.0.0.1", full: false, oauth: config, log: (l) => logs.push(l),
      oauthTesting: { providerUrls: mock.urls, loginLimits: { perIp: 1000, global: 10000, windowMs: 600000 } },
      activityTesting: { flushMs: 3_600_000, write: (f, d) => { writes.push(f); (extra.write ?? writeJsonAtomic)(f, d); } },
    });
    return {
      base, dataDir, mock, token, tokenId, logs, writes, server,
      async close() { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); await mock.close(); },
    };
  }

  it("a token client shows up with its self-reported name, 'token <label>' and last activity", async () => {
    const env = await startEnv();
    try {
      assert.equal(await mcpPost(env.base, env.token, hello("Claude Code")), 200);
      assert.equal(await mcpPost(env.base, env.token, callTool("remember")), 200);
      const b = new Browser(env.base);
      const dash = await signIn(b, env.mock, ALICE);
      assert.match(dash.text, /1 agent shares this memory/);
      assert.match(dash.text, /Claude Code/);
      assert.match(dash.text, /token alice-laptop/);
      assert.match(dash.text, /Last active <time[^>]*>just now<\/time>, last tool remember/);
      assert.equal(grantIdsOf(dash.text).length, 0, "token rows are read only");
    } finally { await env.close(); }
  });

  it("an OAuth client shows with its activity, can be disconnected, and then disappears", async () => {
    const env = await startEnv();
    try {
      const bobAro = await mcpOAuthToken(env.base, env.mock, BOB, "Registered Bob App");
      assert.equal(await mcpPost(env.base, bobAro, hello("Bob Cursor")), 200);
      assert.equal(await mcpPost(env.base, bobAro, callTool("recall")), 200);
      const b = new Browser(env.base);
      const dash = await signIn(b, env.mock, BOB);
      assert.match(dash.text, /Bob Cursor/);
      assert.match(dash.text, /OAuth sign-in/);
      assert.match(dash.text, /last tool recall/);
      const ids = grantIdsOf(dash.text);
      assert.equal(ids.length, 1);
      const out = await b.post("/connect/disconnect", { grant: ids[0], csrf: csrfOf(dash.text) });
      assert.equal(out.status, 303);
      const after = await b.go("/connect");
      assert.ok(!after.text.includes("Bob Cursor"), "a disconnected grant is not shown as connected");
      assert.match(after.text, /0 agents share this memory/);
    } finally { await env.close(); }
  });

  it("a grant that never made a request still appears: 'No activity yet'", async () => {
    const env = await startEnv();
    try {
      await mcpOAuthToken(env.base, env.mock, BOB, "Quiet App");
      const dash = await signIn(new Browser(env.base), env.mock, BOB);
      assert.match(dash.text, /Quiet App/);
      assert.match(dash.text, /No activity yet/);
    } finally { await env.close(); }
  });

  it("a revoked token is not listed", async () => {
    const env = await startEnv();
    try {
      await mcpPost(env.base, env.token, hello("Zed Agent"));
      cliIn(env.dataDir, "token", "revoke", env.tokenId);
      const dash = await signIn(new Browser(env.base), env.mock, ALICE);
      assert.ok(!dash.text.includes("Zed Agent"));
      assert.match(dash.text, /0 agents share this memory/);
    } finally { await env.close(); }
  });

  it("user A's dashboard never shows user B's agents", async () => {
    const env = await startEnv();
    try {
      const bobAro = await mcpOAuthToken(env.base, env.mock, BOB, "Bob Registered");
      await mcpPost(env.base, bobAro, hello("Bob Cursor"));
      await mcpPost(env.base, env.token, hello("Alice Claude Code"));
      const a = await signIn(new Browser(env.base), env.mock, ALICE);
      const bob = await signIn(new Browser(env.base), env.mock, BOB);
      assert.match(a.text, /Alice Claude Code/);
      assert.ok(!a.text.includes("Bob Cursor") && !a.text.includes("Bob Registered"));
      assert.match(bob.text, /Bob Cursor/);
      assert.ok(!bob.text.includes("Alice Claude Code") && !bob.text.includes("alice-laptop"));
    } finally { await env.close(); }
  });

  it("a hostile client name is stripped of control/bidi/zero-width characters, capped, and escaped", async () => {
    const env = await startEnv();
    try {
      const ch = (n) => String.fromCharCode(n);
      const evil = `<script>alert(1)</script>${ch(0)}${ch(7)}${ch(0x202e)}${ch(0x200b)}"><img src=x onerror=1>` + "A".repeat(500);
      await mcpPost(env.base, env.token, hello(evil));
      const dash = await signIn(new Browser(env.base), env.mock, ALICE);
      assert.ok(!dash.text.includes("<script>alert"), "no raw markup");
      assert.ok(!dash.text.includes("<img src=x"));
      assert.match(dash.text, /&lt;script&gt;alert/);
      for (const bad of [0, 7, 0x202e, 0x200b]) assert.ok(!dash.text.includes(ch(bad)), `char ${bad} removed`);
      assert.ok(!dash.text.includes("A".repeat(61)), "capped at 60 characters");
      env.server.closeAllConnections?.();
      await new Promise((r) => env.server.close(r));
      const file = JSON.parse(fs.readFileSync(path.join(env.dataDir, "_server", "activity", "alice.json"), "utf-8"));
      const [entry] = Object.values(file.entries);
      assert.ok(Array.from(entry.client).length <= 60);
    } finally { await env.close().catch(() => {}); }
  });

  it("activity is buffered: no write per request, one write per user at shutdown", async () => {
    const env = await startEnv();
    try {
      await mcpPost(env.base, env.token, hello("Claude Code"));
      for (let i = 0; i < 15; i++) await mcpPost(env.base, env.token, callTool("recall"));
      assert.equal(env.writes.length, 0, "nothing written while requests are flowing");
      env.server.closeAllConnections?.();
      await new Promise((r) => env.server.close(r));
      assert.equal(env.writes.length, 1, "flushed once on shutdown");
      const file = JSON.parse(fs.readFileSync(env.writes[0], "utf-8"));
      const [entry] = Object.values(file.entries);
      assert.equal(entry.calls, 15);
      assert.equal(entry.client, "Claude Code");
    } finally { await env.mock.close(); }
  });

  it("a failed write does not fail the request, and is logged once", async () => {
    const env = await startEnv({ write: () => { throw new Error("disk full"); } });
    try {
      assert.equal(await mcpPost(env.base, env.token, hello("Claude Code")), 200);
      assert.equal(await mcpPost(env.base, env.token, callTool("recall")), 200);
      env.server.closeAllConnections?.();
      await new Promise((r) => env.server.close(r)); // flush attempts the failing write
      assert.equal(env.logs.filter((l) => l.includes("agent activity not saved")).length, 1);
    } finally { await env.mock.close(); }
  });

  it("the activity file is outside the tenant directory and not in the memory download", async () => {
    const env = await startEnv();
    try {
      await mcpPost(env.base, env.token, hello("Claude Code"));
      const b = new Browser(env.base);
      const dash = await signIn(b, env.mock, ALICE);
      const res = await b.raw("/connect/download", { method: "POST", body: { csrf: csrfOf(dash.text) } });
      assert.equal(res.status, 200);
      const names = readTar(Buffer.from(await res.arrayBuffer())).map((f) => f.name);
      assert.ok(names.length > 0);
      assert.ok(!names.some((n) => /activity|alice\.json/.test(n)), `download holds only memory: ${names.join(",")}`);
      env.server.closeAllConnections?.();
      await new Promise((r) => env.server.close(r));
      const file = path.join(env.dataDir, "_server", "activity", "alice.json");
      assert.ok(fs.existsSync(file));
      assert.ok(path.relative(path.join(env.dataDir, "tenants", "alice"), file).startsWith(".."), "not inside the tenant dir");
    } finally { await env.mock.close(); }
  });
});

describe("website — your agents (real binary)", () => {
  it("a static-token agent appears on the dashboard of the real server", async () => {
    const dataDir = path.join(root, "data-act-bin");
    cliIn(dataDir, "identity", "link", "--github-id", String(ALICE.id), "--uid", "alice");
    const token = tokenFrom(cliIn(dataDir, "token", "create", "--uid", "alice", "--label", "bin-token"));
    const mock = await startMock();
    const srv = await spawnServer((base) => {
      mock.state.base = base;
      return { AR_SERVER_DATA: dataDir, AR_PUBLIC_URL: base, AR_OAUTH_SIGNUP: "open", AR_TEST_PROVIDER_MOCK: mock.url, AR_OAUTH_GITHUB_CLIENT_ID: GH.id, AR_OAUTH_GITHUB_CLIENT_SECRET: GH.secret };
    }, ["--import", PRELOAD]);
    try {
      const r = await fetch(srv.base + "/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, connection: "close" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "Claude Code", version: "1" } } }),
      });
      await r.text();
      assert.equal(r.status, 200);
      const dash = await signIn(new Browser(srv.base), mock, ALICE);
      assert.match(dash.text, /Claude Code/);
      assert.match(dash.text, /token bin-token/);
    } finally {
      await srv.stop();
      await mock.close();
    }
  });
});

// ---- the guided trial card ("See it work") ---------------------------------------

describe("website: guided trial card", () => {
  let startHttpServer, loadOAuthConfig, env, alice, bob, tokA, tokB, tokBob;
  let skew = 0; // the server clock runs ahead by this much, so the 10 s per-account scan cache can be expired on demand
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const RULE = "Always answer me in one short paragraph.";
  const trialOf = (html) => /<section class="panel trial"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
  const countOf = (html) => Number(/data-trial-count="(\d)"/.exec(trialOf(html))?.[1] ?? -1);
  const doneSteps = (html) => [...trialOf(html).matchAll(/data-step="(\d)" data-done="true"/g)].map((m) => Number(m[1]));
  /** The dashboard text; the scan cache is expired first so each look sees the current disk. */
  const view = async (b) => { skew += 11_000; return (await b.go("/connect")).text; };
  const agent = async (base, token) => {
    const c = new Client({ name: "trial-agent", version: "0.0.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}`, Connection: "close" } } }));
    return c;
  };
  const propose = (c, rule) => c.callTool({ name: "check", arguments: { goal: "record the rule", human_correction: { rule, why: "The owner said so in chat just now.", applies_when: ["answers", "style"] } } });
  const unesc = (x) => x.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const approveAll = async (b) => {
    const page = await b.go("/review");
    for (const m of page.text.matchAll(/<form method="post" action="\/review\/approve">([\s\S]*?)<\/form>/g)) {
      const r = await b.post("/review/approve", { id: unesc(/name="id" value="([^"]+)"/.exec(m[1])[1]), project: "main", csrf: csrfOf(page.text) });
      assert.equal(r.status, 303);
    }
  };

  before(async () => {
    ({ startHttpServer } = await load("serve.js"));
    ({ loadOAuthConfig } = await load("oauth-config.js"));
    const dataDir = fs.mkdtempSync(path.join(root, "data-trial-"));
    cliIn(dataDir, "identity", "link", "--github-id", String(ALICE.id), "--uid", "alice");
    tokA = tokenFrom(cliIn(dataDir, "token", "create", "--uid", "alice", "--label", "first"));
    tokB = tokenFrom(cliIn(dataDir, "token", "create", "--uid", "alice", "--label", "second"));
    cliIn(dataDir, "identity", "link", "--github-id", "909", "--uid", "bobby");
    tokBob = tokenFrom(cliIn(dataDir, "token", "create", "--uid", "bobby", "--label", "bobs"));
    const mock = await startMock();
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    mock.state.base = base;
    const config = loadOAuthConfig({ publicUrl: base }, { AR_OAUTH_SIGNUP: "open", AR_OAUTH_GITHUB_CLIENT_ID: GH.id, AR_OAUTH_GITHUB_CLIENT_SECRET: GH.secret });
    const server = await startHttpServer({
      dataDir, port, host: "127.0.0.1", full: false, oauth: config, log: () => {},
      oauthTesting: { now: () => Date.now() + skew, providerUrls: mock.urls, loginLimits: { perIp: 1000, global: 10000, windowMs: 600000 } },
      activityTesting: { flushMs: 3_600_000 },
    });
    env = { dataDir, base, mock, server };
    alice = new Browser(base);
    bob = new Browser(base);
    await signIn(alice, mock, ALICE);
    await signIn(bob, mock, { id: 909 });
  });
  after(async () => {
    env.server.closeAllConnections?.();
    await new Promise((r) => env.server.close(r));
    await env.mock.close();
  });

  it("a fresh account is at 0 of 3, with step 1 next and the two copyable sentences", async () => {
    const html = await view(alice);
    assert.equal(countOf(html), 0);
    assert.deepEqual(doneSteps(html), []);
    assert.match(trialOf(html), /See it work/);
    assert.ok(trialOf(html).includes("Remember this rule: always answer me in one short paragraph."));
    assert.ok(trialOf(html).includes("What rules do I have?"));
    assert.match(trialOf(html), /Next: connect an agent/i);
  });

  it("after one agent has made a request, step 1 is done (1 of 3)", async () => {
    const a = await agent(env.base, tokA);
    await a.callTool({ name: "session_start", arguments: {} });
    const html = await view(alice);
    assert.equal(countOf(html), 1);
    assert.deepEqual(doneSteps(html), [1]);
    await a.close();
  });

  it("a staged rule completes step 2, says it is waiting for approval and links /review", async () => {
    const a = await agent(env.base, tokA);
    await propose(a, RULE);
    await a.close();
    const html = await view(alice);
    assert.equal(countOf(html), 2);
    assert.deepEqual(doneSteps(html), [1, 2]);
    assert.match(trialOf(html), /waiting for (your )?approval/i);
    assert.match(trialOf(html), /href="\/review"/);
    assert.ok(!/Two of your agents/.test(html));
  });

  it("step 3 needs TWO distinct credentials active after the rule went live; one re-issued credential is not enough", async () => {
    await approveAll(alice);
    let html = await view(alice);
    assert.equal(countOf(html), 2, "approved but nobody has been active since");
    assert.ok(!/waiting for (your )?approval/i.test(trialOf(html)));
    assert.match(trialOf(html), /Next: connect a second agent/i);
    assert.match(trialOf(html), /A second agent connected after your rule went live/);
    await sleep(40);
    // The author signs in again with a new credential: one credential after the rule is not two.
    const tokC = tokenFrom(cliIn(env.dataDir, "token", "create", "--uid", "alice", "--label", "reissued"));
    const c = await agent(env.base, tokC);
    await c.callTool({ name: "session_start", arguments: {} });
    await c.close();
    html = await view(alice);
    assert.equal(countOf(html), 2, "one credential active after the rule: step 3 not done");
    assert.ok(!doneSteps(html).includes(3));
    const b = await agent(env.base, tokB);
    await b.callTool({ name: "recall", arguments: { query: "rules" } });
    await b.close();
    html = await view(alice);
    assert.equal(countOf(html), 3);
    assert.deepEqual(doneSteps(html), [1, 2, 3]);
    assert.match(html, /Two of your agents have been active since your rule went live: each one loads it at session start\./);
    assert.ok(!/It works/.test(html), "no claim that the rule was read");
  });

  it("tenant isolation: both accounts have their own rule and agents, and neither page shows the other's state", async () => {
    const a = await agent(env.base, tokBob);
    await a.callTool({ name: "session_start", arguments: {} });
    await propose(a, "Never reply to me in French without asking.");
    await a.close();
    const bobHtml = await view(bob);
    const aliceHtml = await view(alice);
    assert.equal(countOf(bobHtml), 2, "bob: his agent and his waiting rule, nothing of alice's");
    assert.deepEqual(doneSteps(bobHtml), [1, 2]);
    assert.match(trialOf(bobHtml), /waiting for (your )?approval/i);
    assert.ok(!/Two of your agents/.test(bobHtml));
    assert.ok(!/token (first|second|reissued)/.test(bobHtml));
    assert.equal(countOf(aliceHtml), 3, "alice is unchanged by bob's activity");
    assert.ok(!/waiting for (your )?approval/i.test(trialOf(aliceHtml)), "bob's staged rule is not alice's");
    assert.ok(!/token bobs/.test(aliceHtml));
    await approveAll(bob);
    assert.equal(countOf(await view(bob)), 2, "bob has one agent only: step 3 not done");
    assert.equal(countOf(await view(alice)), 3);
  });

  it("a request with an Authorization header still gets 403 on /connect", async () => {
    const r = await alice.go("/connect", { headers: { authorization: `Bearer ${tokA}` } });
    assert.equal(r.status, 403);
    assert.ok(!r.text.includes("See it work"));
  });

  it("an unreadable corrections store degrades the card, the dashboard still renders", async () => {
    const c = new Browser(env.base);
    await signIn(c, env.mock, { id: 910 });
    const dir = path.join(env.dataDir, "tenants", "gh-910", "projects", "main");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "corrections"), "not a directory");
    const html = await view(c);
    assert.match(trialOf(html), /could not be checked/i);
    assert.match(html, /Your agents/);
  });

  it("the card adds no inline style attribute and keeps one inline style and script", async () => {
    const html = await view(alice);
    assert.ok(!/\sstyle="/i.test(html));
    assert.equal((html.match(/<style>/g) ?? []).length, 1);
    assert.equal((html.match(/<script>/g) ?? []).length, 1);
  });
});

describe("website: guided trial (rules scan and state, unit)", () => {
  let T, dataDir, n = 0;
  before(async () => { T = await load("trial.js"); dataDir = fs.mkdtempSync(path.join(root, "data-trial-unit-")); });

  const DAY = 86_400_000;
  const MON = Date.parse("2026-03-02T09:00:00Z");
  const FRI = Date.parse("2026-03-06T09:00:00Z");
  /** A fresh tenant "unit-N" with a corrections dir for project `proj`; returns helpers. */
  function tenant(proj = "main") {
    const uid = `unit-${++n}`;
    const cdir = path.join(dataDir, "tenants", uid, "projects", proj, "corrections");
    fs.mkdirSync(path.join(cdir, "_pending"), { recursive: true });
    return {
      uid, cdir,
      rule(file, rec, mtime) {
        const p = path.join(cdir, file);
        fs.writeFileSync(p, JSON.stringify({ rule: "Do the thing.", ...rec }));
        if (mtime !== undefined) fs.utimesSync(p, mtime / 1000, mtime / 1000);
        return p;
      },
      promoted(rows) { fs.writeFileSync(path.join(cdir, "_pending", "_resolved.jsonl"), rows.map(([id, ts]) => JSON.stringify({ ts: new Date(ts).toISOString(), action: "promoted", correction_id: id })).join("\n") + "\n"); },
      scan() { return T.scanRules(dataDir, uid); },
    };
  }

  it("a retracted rule never sets the time: only promotion rows of still-active rules count, the latest wins", () => {
    const t = tenant();
    t.rule("2026-03-02-a.json", { id: "2026-03-02-a", active: false, retracted_at: "2026-03-03T00:00:00Z" }, MON);
    t.rule("2026-03-06-b.json", { id: "2026-03-06-b" }, FRI + DAY);
    t.promoted([["2026-03-02-a", MON], ["2026-03-06-b", FRI]]);
    const s = t.scan();
    assert.equal(s.active, 1);
    assert.equal(s.activatedAt, FRI, "B went live Friday, not Monday");
    const both = tenant();
    both.rule("2026-03-02-a.json", { id: "2026-03-02-a" }, MON);
    both.rule("2026-03-06-b.json", { id: "2026-03-06-b" }, FRI);
    both.promoted([["2026-03-02-a", MON], ["2026-03-06-b", FRI]]);
    assert.equal(both.scan().activatedAt, FRI, "with two active rules, the newest go-live");
  });

  it("an imported rule with no promotion row is dated by its file's modification time", () => {
    const t = tenant();
    t.rule("2026-03-02-imp.json", { id: "2026-03-02-imp" }, MON);
    const s = t.scan();
    assert.equal(s.active, 1);
    assert.ok(Math.abs(s.activatedAt - MON) < 2000, `mtime used: ${s.activatedAt}`);
  });

  it("symlinks, a directory named x.json and an oversized file are never counted or followed", (tc) => {
    const t = tenant();
    t.rule("2026-03-01-ok.json", { id: "ok" }, MON);
    fs.mkdirSync(path.join(t.cdir, "x.json"));
    t.rule("2026-03-03-big.json", { id: "big", pad: "x".repeat(70 * 1024) });
    const outside = path.join(dataDir, `outside-${n}.json`);
    fs.writeFileSync(outside, JSON.stringify({ rule: "Outside rule.", id: "out" }));
    let linked = true;
    try { fs.symlinkSync(outside, path.join(t.cdir, "2026-03-04-link.json")); } catch { linked = false; tc.diagnostic("file symlinks not permitted here; the other cases still run"); }
    assert.equal(t.scan().active, 1, linked ? "only the regular, small file" : "only the regular, small file (no symlink created)");
    // The promotion log as a link is not opened either: the rule falls back to its mtime.
    const u = tenant();
    u.rule("2026-03-01-ok.json", { id: "ok" }, MON);
    const real = path.join(dataDir, `log-${n}.jsonl`);
    fs.writeFileSync(real, JSON.stringify({ ts: new Date(FRI).toISOString(), action: "promoted", correction_id: "ok" }) + "\n");
    let logLinked = true;
    try { fs.symlinkSync(real, path.join(u.cdir, "_pending", "_resolved.jsonl")); } catch { logLinked = false; }
    if (logLinked) assert.ok(Math.abs(u.scan().activatedAt - MON) < 2000, "a linked log is ignored");
  });

  it("a cut scan says so: more than 20 rule files, or more than 8 projects", () => {
    const t = tenant();
    for (let i = 10; i < 35; i++) t.rule(`2026-03-${i}-r.json`, { id: `r${i}` });
    const s = t.scan();
    assert.equal(s.active, 20, "the 20 newest");
    assert.equal(s.capped, true);
    const m = tenant();
    for (let i = 0; i < 9; i++) fs.mkdirSync(path.join(dataDir, "tenants", m.uid, "projects", `p${i}`, "corrections"), { recursive: true });
    assert.equal(m.scan().capped, true);
    assert.equal(tenant().scan().capped, false);
  });

  it("a missing tenant scans as none; a corrections path that is a file throws (the page degrades)", () => {
    assert.deepEqual(T.scanRules(dataDir, "nobody-here"), { active: 0, capped: false });
    const t = tenant();
    fs.rmSync(t.cdir, { recursive: true });
    fs.writeFileSync(t.cdir, "x");
    assert.throws(() => t.scan());
  });

  it("computeTrial: two distinct credentials with calls after the rule; fewer, or no calls, is not enough", () => {
    const rules = { ready: 0, active: 1, activatedAt: 1_000_000, capped: false };
    const at = (ms) => new Date(ms).toISOString();
    const cred = (last, calls = 3, first = 1) => ({ firstSeen: at(first), lastSeen: at(last), calls });
    assert.equal(T.computeTrial([cred(500_000), cred(2_000_000)], rules).done[2], false, "one before, one after");
    assert.equal(T.computeTrial([cred(2_000_000, 3, 1_500_000)], rules).done[2], false, "a single new credential");
    assert.equal(T.computeTrial([cred(2_000_000), cred(2_500_000)], rules).done[2], true);
    assert.equal(T.computeTrial([cred(2_000_000), cred(2_500_000, 0)], rules).done[2], false, "no tool call recorded");
    assert.equal(T.computeTrial([cred(2_000_000), cred(2_500_000)], { ...rules, active: 0 }).done[2], false, "no active rule");
    assert.equal(T.computeTrial([cred(2_000_000), cred(2_500_000)], null).degraded, true);
  });

  it("the scan cache serves one read per account per 10 s and re-reads after", () => {
    const t = tenant();
    let now = 0;
    const cache = new T.RuleScanCache(() => now);
    assert.equal(cache.get(dataDir, t.uid).active, 0);
    t.rule("2026-03-01-ok.json", { id: "ok" });
    now = 9_000;
    assert.equal(cache.get(dataDir, t.uid).active, 0, "still cached");
    now = 10_001;
    assert.equal(cache.get(dataDir, t.uid).active, 1, "expired, re-read");
  });
});
