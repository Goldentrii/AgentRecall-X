/**
 * hosted-oauth.test.mjs — OAuth 2.1 (MCP authorization) for the hosted server, with
 * federated GitHub / Google sign-in (AgentRecall never sees a password).
 *
 * Runs the REAL server code from dist/ in-process against in-process MOCK GitHub and
 * Google endpoints (node:http). Never talks to the real providers. The real MCP SDK
 * client is used for /mcp. A few tests spawn the real `agent-recall-server` binary.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMock, b64url, sha256b64, GH, GG, jwt } from "./lib/mock-providers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, "..", "dist", "http");
const CLI = path.join(DIST, "cli.js");
const load = (f) => import(pathToFileURL(path.join(DIST, f)).href);
const { startHttpServer } = await load("serve.js");
const { loadOAuthConfig, OAuthConfigError } = await load("oauth-config.js");
const { isAllowedRedirect } = await load("redirect-policy.js");
const { ipKey } = await load("oauth-app.js");
const { formActionOrigins, DEFAULT_PROVIDER_URLS, validateProviderUrls } = await load("federation.js");

// spawnSync (CLI calls) blocks this process, and with it the in-process server, for seconds; pooled keep-alive
// sockets then die under the client. One connection per request keeps the tests deterministic.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => {
  const headers = new Headers(init.headers ?? (url instanceof Request ? url.headers : undefined));
  headers.set("connection", "close");
  return realFetch(url, { ...init, headers });
};

const root = fs.mkdtempSync(path.join(tmpdir(), "ar-oauth-"));
const fakeHome = path.join(root, "home");
fs.mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
after(() => fs.rmSync(root, { recursive: true, force: true }));

// ---- helpers ---------------------------------------------------------------

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function makePkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: sha256b64(verifier) };
}
const textOf = (res) => (res.content ?? []).map((c) => c.text ?? "").join("\n");
const form = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined)).toString();
const walkFiles = (d) => !fs.existsSync(d) ? [] : fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => e.isDirectory() ? walkFiles(path.join(d, e.name)) : [path.join(d, e.name)]);


/** Start an in-process hosted server (OAuth on unless `oauth: false`) + mock providers. */
async function startEnv({ oauth = true, providers = ["github", "google"], loginLimits = { perIp: 1000, global: 10000, windowMs: 600000 }, providerTimeoutMs, maxPending, maxPendingPerKey, env = {}, seed, signup = "open" } = {}) {
  const dataDir = fs.mkdtempSync(path.join(root, "data-"));
  const mock = await startMock();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  mock.state.base = base;
  const clock = { offset: 0 };
  const logs = [];
  // Most tests exercise the flow itself, so they opt into open sign-up; invite-only (the default) has its own tests.
  const penv = { ...(signup ? { AR_OAUTH_SIGNUP: signup } : {}), ...env };
  if (providers.includes("github")) { penv.AR_OAUTH_GITHUB_CLIENT_ID = GH.id; penv.AR_OAUTH_GITHUB_CLIENT_SECRET = GH.secret; }
  if (providers.includes("google")) { penv.AR_OAUTH_GOOGLE_CLIENT_ID = GG.id; penv.AR_OAUTH_GOOGLE_CLIENT_SECRET = GG.secret; }
  const config = oauth ? loadOAuthConfig({ publicUrl: base }, penv) : null;
  let server;
  try {
    seed?.(dataDir, base);
    server = await startHttpServer({
      dataDir, port, host: "127.0.0.1", full: false, oauth: config, log: (l) => logs.push(l),
      oauthTesting: { now: () => Date.now() + clock.offset, loginLimits, providerUrls: mock.urls, providerTimeoutMs, maxPending, maxPendingPerKey },
    });
  } catch (err) {
    await mock.close();
    throw err;
  }
  return {
    base, dataDir, mock, clock, logs, config, server,
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      await mock.close();
    },
  };
}

function cliEnv() { return { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome }; }
function cli(env, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--data", env.dataDir], { env: cliEnv(), encoding: "utf-8" });
  assert.equal(r.status, 0, `cli ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

async function register(env, body) {
  const r = await fetch(env.base + "/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

const CB = "http://127.0.0.1:53682/callback";
async function newClient(env, over = {}) {
  const r = await register(env, { client_name: "Test Agent", redirect_uris: [CB], token_endpoint_auth_method: "none", ...over });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

/** GET /authorize → sign-in page + the browser-binding cookie. */
async function authorize(env, client, { pkce = makePkce(), state = "st-" + b64url(randomBytes(6)), resource, redirect_uri = CB } = {}) {
  const q = new URLSearchParams({
    response_type: "code", client_id: client.client_id, redirect_uri, code_challenge: pkce.challenge,
    code_challenge_method: "S256", state, ...(resource ? { resource } : {}),
  });
  const r = await fetch(`${env.base}/authorize?${q}`, { redirect: "manual" });
  const html = await r.text().catch(() => "");
  const setCookie = r.headers.getSetCookie?.()[0] ?? "";
  return {
    res: r, status: r.status, html, pkce, state, setCookie,
    cookie: /^(ar_oauth_[a-f0-9]{12}=[^;]+)/.exec(setCookie)?.[1],
    requestId: /name="request_id" value="([^"]+)"/.exec(html)?.[1],
  };
}

/** POST /authorize/start (the "Continue with …" button). */
async function start(env, a, provider, { cookie = a.cookie, requestId = a.requestId } = {}) {
  const r = await fetch(env.base + "/authorize/start", {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
    body: form({ request_id: requestId, provider }),
  });
  const location = r.headers.get("location");
  const url = location ? new URL(location) : null;
  return { status: r.status, text: r.status === 302 ? "" : await r.text(), location, url, headers: r.headers };
}

/** GET /authorize/callback/:provider as the provider's redirect would hit it. */
async function callback(env, provider, params, cookie, headers = {}) {
  const r = await fetch(`${env.base}/authorize/callback/${provider}?${form(params)}`, {
    redirect: "manual", headers: { ...(cookie ? { cookie } : {}), ...headers },
  });
  const loc = r.headers.get("location");
  const u = loc ? new URL(loc) : null;
  return {
    status: r.status, text: r.status === 302 ? "" : await r.text(), headers: r.headers, location: loc,
    code: u?.searchParams.get("code") ?? null, state: u?.searchParams.get("state") ?? null, error: u?.searchParams.get("error") ?? null,
  };
}

const PROFILE = { github: { id: 101 }, google: { sub: "1000000000000000101" } };

/** One provider round trip for an existing authorize page `a`: start → provider "login" → callback. */
async function attempt(env, a, provider = "github", { profile = PROFILE[provider], claims, stateOverride, cookie = a.cookie } = {}) {
  const s = await start(env, a, provider);
  assert.equal(s.status, 302, `start: ${s.text}`);
  const upstreamCode = env.mock.issue(provider, { profile, challenge: s.url.searchParams.get("code_challenge"), nonce: s.url.searchParams.get("nonce"), claims });
  const cb = await callback(env, provider, { code: upstreamCode, state: stateOverride ?? s.url.searchParams.get("state") }, cookie);
  return { s, cb, upstreamCode };
}

/** Full sign-in → our authorization code (asserting success). */
async function getCode(env, client, { provider = "github", profile, claims, pkce = makePkce(), resource } = {}) {
  const a = await authorize(env, client, { pkce, resource });
  assert.equal(a.status, 200, `authorize: ${a.html}`);
  const { cb } = await attempt(env, a, provider, { profile, claims });
  assert.equal(cb.status, 302, `callback: ${cb.text}`);
  assert.equal(cb.state, a.state);
  assert.ok(cb.code);
  return { code: cb.code, pkce, state: a.state };
}

async function tokenReq(env, client, params) {
  const r = await fetch(env.base + "/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ client_id: client.client_id, ...params }),
  });
  return { status: r.status, body: await r.json() };
}

async function getTokens(env, client, who, extra = {}) {
  const { code, pkce } = await getCode(env, client, who);
  const t = await tokenReq(env, client, { grant_type: "authorization_code", code, code_verifier: pkce.verifier, redirect_uri: CB, ...extra });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  return t.body;
}

async function mcpClient(env, token) {
  const c = new Client({ name: "oauth-test", version: "0.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(env.base + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}

async function mcpStatus(env, token) {
  const r = await fetch(env.base + "/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  await r.text();
  return r.status;
}

// ---- pure units ------------------------------------------------------------

describe("oauth config + redirect policy + ipKey (units)", () => {
  const GHENV = { AR_OAUTH_GITHUB_CLIENT_ID: "i", AR_OAUTH_GITHUB_CLIENT_SECRET: "s" };
  it("OAuth is off with nothing configured; any half-configuration fails closed", () => {
    assert.equal(loadOAuthConfig({}, {}), null);
    assert.equal(loadOAuthConfig({}, { AR_PUBLIC_URL: " ", AR_OAUTH_GITHUB_CLIENT_ID: "", AR_OAUTH_GOOGLE_CLIENT_SECRET: "" }), null);
    assert.throws(() => loadOAuthConfig({}, { AR_PUBLIC_URL: "https://r.example.com" }), /at least one provider/);
    assert.throws(() => loadOAuthConfig({}, GHENV), /AR_PUBLIC_URL/);
    assert.throws(() => loadOAuthConfig({}, { AR_PUBLIC_URL: "https://r.example.com", AR_OAUTH_GITHUB_CLIENT_ID: "i" }), /CLIENT_SECRET/);
    assert.throws(() => loadOAuthConfig({}, { AR_PUBLIC_URL: "https://r.example.com", ...GHENV, AR_OAUTH_GOOGLE_CLIENT_SECRET: "s" }), /AR_OAUTH_GOOGLE_CLIENT_ID/);
    assert.throws(() => loadOAuthConfig({}, { AR_PUBLIC_URL: "http://r.example.com", ...GHENV }), /https/);
    assert.throws(() => loadOAuthConfig({}, { AR_PUBLIC_URL: "https://r.example.com/x", ...GHENV }), /origin only/);
    const c = loadOAuthConfig({ publicUrl: "https://r.example.com" }, { ...GHENV, AR_OAUTH_REDIRECT_ALLOW: "cursor://a/, https://app.example.com ", AR_TRUST_PROXY: "1" });
    assert.equal(c.resourceUrl.href, "https://r.example.com/mcp");
    assert.deepEqual(Object.keys(c.providers), ["github"]);
    assert.deepEqual(c.redirectAllow, ["cursor://a/", "https://app.example.com"]);
    assert.equal(c.trustProxy, true);
  });

  it("provider URL overrides must be https or http on localhost; defaults are github.com / google", () => {
    assert.throws(() => validateProviderUrls({ ...DEFAULT_PROVIDER_URLS, githubToken: "http://evil.example/token" }), /https/);
    assert.doesNotThrow(() => validateProviderUrls({ ...DEFAULT_PROVIDER_URLS, githubToken: "http://127.0.0.1:9/token" }));
    assert.deepEqual(formActionOrigins(DEFAULT_PROVIDER_URLS, ["github", "google"]), ["https://github.com", "https://accounts.google.com"]);
    assert.deepEqual(formActionOrigins(DEFAULT_PROVIDER_URLS, ["google"]), ["https://accounts.google.com"]);
  });

  it("redirect policy: allows ChatGPT's two documented MCP callbacks (developers.openai.com/apps-sdk/build/auth) and nothing near them", () => {
    for (const u of ["https://chatgpt.com/connector_platform_oauth_redirect", "https://chatgpt.com/connector/oauth/abc123_-XYZ"]) {
      assert.equal(isAllowedRedirect(u, []), true, u);
    }
    for (const u of ["http://chatgpt.com/connector_platform_oauth_redirect", "https://chatgpt.com/connector_platform_oauth_redirect?x=1",
      "https://chatgpt.com/connector_platform_oauth_redirect/x", "https://chatgpt.com/connector/oauth/", "https://chatgpt.com/connector/oauth/a/b",
      "https://chatgpt.com/connector/oauth/a?x=1", "https://chatgpt.com/connector/oauth/%2e%2e", "https://chatgpt.com/connector/oauth/..",
      "https://chatgpt.com/connector/oauth/a#f", "https://chatgpt.com.evil.net/connector_platform_oauth_redirect",
      "https://chatgpt.com@evil.net/connector/oauth/a", "https://www.chatgpt.com/connector/oauth/a", "https://chatgpt.com/oauth/a"]) {
      assert.equal(isAllowedRedirect(u, []), false, u);
    }
  });

  it("redirect policy: allows loopback + claude callbacks + boundary-safe extra prefixes, rejects the rest", () => {
    const ok = ["http://127.0.0.1:1234/cb", "http://localhost:80/x?y=1", "http://[::1]:9/cb", "http://127.0.0.1/cb",
      "https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];
    for (const u of ok) assert.equal(isAllowedRedirect(u, []), true, u);
    const bad = ["https://evil.example/cb", "http://claude.ai/api/mcp/auth_callback", "https://claude.ai/api/mcp/auth_callback/x",
      "https://claude.ai/api/mcp/auth_callback?x=1", "https://claude.ai.evil.com/api/mcp/auth_callback", "https://claude.ai/api/mcp/auth_callback#f",
      "http://127.0.0.1@evil.com/cb", "http://user:pw@127.0.0.1:1/cb", "http://localhost.evil.com/cb", "https://127.0.0.1/cb",
      "javascript:alert(1)", "data:text/html,x", "myapp://cb", "", "not a url", "http://127.0.0.1:1/cb#frag", "http://127.0.0.1:1/c\\b", 42, null];
    for (const u of bad) assert.equal(isAllowedRedirect(u, []), false, String(u));
    const extra = ["cursor://anysphere.cursor-mcp/", "https://app.example.com", "https://app2.example.com/cb"];
    assert.equal(isAllowedRedirect("cursor://anysphere.cursor-mcp/oauth/callback", extra), true);
    assert.equal(isAllowedRedirect("https://app.example.com/cb", extra), true);
    assert.equal(isAllowedRedirect("https://app.example.com.evil.net/cb", extra), false);
    assert.equal(isAllowedRedirect("https://app.example.com@evil.net/cb", extra), false);
    assert.equal(isAllowedRedirect("https://app2.example.com/cbx", extra), false);
    assert.equal(isAllowedRedirect("javascript:alert(1)", ["javascript:"]), false);
  });

  it("M2: prefix matching uses the normalized URL and refuses encoded/dot-segment paths", () => {
    const extra = ["https://app.example.com/cb"];
    assert.equal(isAllowedRedirect("https://app.example.com/cb/ok", extra), true);
    for (const bad of ["https://app.example.com/cb/%2e%2e/admin", "https://app.example.com/cb/%2E%2e/admin", "https://app.example.com/cb/..%2fadmin",
      "https://app.example.com/cb/../admin", "https://app.example.com/cb/./x", "https://app.example.com/cb%2f..%2fadmin", "https://app.example.com/cb/%5c"]) {
      assert.equal(isAllowedRedirect(bad, extra), false, bad);
    }
  });

  it("Cursor's callback is allowed by default; other custom schemes still need AR_OAUTH_REDIRECT_ALLOW", () => {
    assert.equal(isAllowedRedirect("cursor://anysphere.cursor-retrieval/oauth/user-agentrecall/callback", []), true);
    assert.equal(isAllowedRedirect("cursor://anysphere.cursor-retrieval.evil/x", []), false);
    assert.equal(isAllowedRedirect("https://vscode.dev/redirect", []), false);
    assert.equal(isAllowedRedirect("https://vscode.dev/redirect", ["https://vscode.dev/redirect"]), true);
  });

  it("H1/N2: ipKey collapses IPv6 to /64, unmaps ::ffff:a.b.c.d, and maps non-IP input to one 'invalid' bucket", () => {
    assert.equal(ipKey("203.0.113.9"), "203.0.113.9");
    assert.equal(ipKey("::ffff:203.0.113.9"), "203.0.113.9");
    assert.equal(ipKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), ipKey("2001:DB8:1:2::7"));
    assert.notEqual(ipKey("2001:db8:1:2::1"), ipKey("2001:db8:1:3::1"));
    assert.equal(ipKey("::1"), ipKey("0:0:0:0:1::5"));
    assert.equal(ipKey(undefined), "unknown");
    for (const v of ["not-an-ip", "1.2.3.4, 5.6.7.8", "999.1.1.1", "<script>"]) assert.equal(ipKey(v), "invalid", v);
  });
});

// ---- discovery + registration ---------------------------------------------

describe("oauth — discovery and registration", () => {
  let env;
  before(async () => { env = await startEnv(); });
  after(async () => { await env.close(); });

  it("serves protected-resource and authorization-server metadata with correct URLs", async () => {
    for (const p of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const prm = await (await fetch(env.base + p)).json();
      assert.equal(prm.resource, `${env.base}/mcp`);
      assert.deepEqual(prm.authorization_servers.map((s) => new URL(s).origin), [env.base]);
      assert.deepEqual(prm.scopes_supported, ["memory"]);
    }
    const as = await (await fetch(env.base + "/.well-known/oauth-authorization-server")).json();
    assert.equal(new URL(as.issuer).origin, env.base);
    assert.equal(as.authorization_endpoint, `${env.base}/authorize`);
    assert.equal(as.token_endpoint, `${env.base}/token`);
    assert.equal(as.registration_endpoint, `${env.base}/register`);
    assert.equal(as.revocation_endpoint, `${env.base}/revoke`);
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  });

  it("/mcp 401 carries resource_metadata and an OAuth-aware agent_instruction", async () => {
    const r = await fetch(env.base + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("www-authenticate"),
      `Bearer realm="agent-recall", resource_metadata="${env.base}/.well-known/oauth-protected-resource/mcp"`);
    const j = await r.json();
    assert.match(j.agent_instruction, /OAuth/);
    assert.match(j.agent_instruction, /ar_/);
  });

  it("register: loopback and claude callbacks ok; everything else invalid_redirect_uri", async () => {
    for (const uris of [[CB], ["http://localhost:8123/cb"], ["http://[::1]:8123/cb"], ["https://claude.ai/api/mcp/auth_callback"], ["https://claude.com/api/mcp/auth_callback", CB]]) {
      const r = await register(env, { client_name: "ok", redirect_uris: uris });
      assert.equal(r.status, 201, JSON.stringify(uris) + JSON.stringify(r.body));
      assert.equal(r.body.token_endpoint_auth_method, "none");
      assert.equal(r.body.client_secret, undefined);
    }
    for (const uris of [["https://evil.example/cb"], [CB, "https://evil.example/cb"], ["http://claude.ai/api/mcp/auth_callback"],
      ["http://127.0.0.1@evil.example/cb"], ["javascript:alert(1)"], ["http://127.0.0.1:1/cb#x"], []]) {
      const r = await register(env, { client_name: "evil", redirect_uris: uris });
      assert.equal(r.status, 400, JSON.stringify(uris));
      assert.match(r.body.error, /invalid_redirect_uri|invalid_client_metadata/);
    }
    const none = await register(env, { client_name: "evil", redirect_uris: ["https://evil.example/cb"] });
    assert.equal(none.body.error, "invalid_redirect_uri");
  });

  it("register forces a public client: a requested client_secret_post is overridden", async () => {
    const r = await register(env, { client_name: "wants secret", redirect_uris: [CB], token_endpoint_auth_method: "client_secret_post", logo_uri: "https://evil.example/x.png" });
    assert.equal(r.status, 201);
    assert.equal(r.body.token_endpoint_auth_method, "none");
    assert.equal(r.body.client_secret, undefined);
    assert.equal(r.body.logo_uri, undefined);
  });
});

// ---- the federated sign-in flow -----------------------------------------------

describe("oauth — federated sign-in", () => {
  let env, client;
  before(async () => { env = await startEnv(); client = await newClient(env); });
  after(async () => { await env.close(); });

  it("keyboard focus ring follows each element's own radius (pill buttons stay pills)", async () => {
    const a = await authorize(env, client);
    const rule = /:focus-visible{([^}]*)}/.exec(a.html);
    assert.ok(rule, "has a :focus-visible rule");
    assert.doesNotMatch(rule[1], /border-radius/);
    assert.match(rule[1], /outline-offset:3px/);
  });

  for (const [provider, uid, authorizeHost] of [["github", "gh-101", "/gh/authorize"], ["google", "gg-1000000000000000101", "/gg/authorize"]]) {
    it(`happy path (${provider}): authorize → provider → callback → code+state → token (PKCE) → /mcp → tenant ${uid}`, async () => {
      const a = await authorize(env, client);
      assert.equal(a.status, 200);
      assert.ok(a.requestId && a.requestId.length >= 43);
      assert.match(a.html, /Test Agent/);
      assert.match(a.html, /127\.0\.0\.1:53682/);
      assert.match(a.html, /Continue with GitHub/);
      assert.match(a.html, /Continue with Google/);
      assert.ok(!/type="password"|name="email"/.test(a.html), "no credential fields");
      // hardening headers + cookie
      const h = a.res.headers;
      const csp = h.get("content-security-policy");
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.ok(csp.includes(`form-action 'self' ${env.mock.url}`), csp);
      assert.equal(h.get("x-frame-options"), "DENY");
      assert.equal(h.get("referrer-policy"), "no-referrer");
      assert.match(h.get("cache-control"), /no-store/);
      assert.match(a.setCookie, /^ar_oauth_[a-f0-9]{12}=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=\/authorize; Max-Age=600$/);

      const s = await start(env, a, provider);
      assert.equal(s.status, 302);
      assert.ok(s.location.startsWith(env.mock.url + authorizeHost + "?"), s.location);
      const q = s.url.searchParams;
      assert.equal(q.get("client_id"), provider === "github" ? GH.id : GG.id);
      assert.equal(q.get("redirect_uri"), `${env.base}/authorize/callback/${provider}`);
      assert.equal(q.get("code_challenge_method"), "S256");
      assert.match(q.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
      assert.match(q.get("state"), /^[A-Za-z0-9_-]{43}$/);
      if (provider === "google") {
        assert.equal(q.get("response_type"), "code");
        assert.equal(q.get("scope"), "openid");
        assert.equal(q.get("prompt"), "select_account");
        assert.ok(q.get("nonce"));
      }
      assert.ok(!s.location.includes(GH.secret) && !s.location.includes(GG.secret), "secrets never in the browser redirect");

      const code = env.mock.issue(provider, { profile: PROFILE[provider], challenge: q.get("code_challenge"), nonce: q.get("nonce") });
      const cb = await callback(env, provider, { code, state: q.get("state") }, a.cookie);
      assert.equal(cb.status, 302);
      assert.ok(cb.location.startsWith(CB + "?"));
      assert.equal(cb.state, a.state);
      assert.ok(cb.code);
      assert.equal(cb.headers.get("referrer-policy"), "no-referrer");
      assert.match(cb.headers.get("set-cookie"), new RegExp("^" + a.cookie.split("=")[0] + "=; .*Max-Age=0"));

      const t = await tokenReq(env, client, { grant_type: "authorization_code", code: cb.code, code_verifier: a.pkce.verifier, redirect_uri: CB });
      assert.equal(t.status, 200, JSON.stringify(t.body));
      assert.match(t.body.access_token, /^aro_[A-Za-z0-9_-]{43}$/);
      assert.match(t.body.refresh_token, /^arr_[A-Za-z0-9_-]{43}$/);
      assert.equal(t.body.expires_in, 3600);

      const marker = `oauth-${provider}-` + b64url(randomBytes(5));
      const c = await mcpClient(env, t.body.access_token);
      assert.ok((await c.listTools()).tools.some((x) => x.name === "remember"));
      const w = await c.callTool({ name: "remember", arguments: { content: `OAuth user note ${marker}` } });
      assert.ok(!w.isError, textOf(w));
      await c.close();
      const tenant = path.join(env.dataDir, "tenants", uid);
      assert.ok(walkFiles(tenant).some((f) => fs.readFileSync(f, "utf-8").includes(marker)), `memory landed in ${uid}`);
      assert.equal(env.logs.filter((x) => x.includes(`oauth login ${provider}=`) && x.includes(`uid=${uid}`)).length, 1);

      // the upstream exchange carried PKCE + the secret server-side (the mock verifies both)
      const up = env.mock.state.calls.find((x) => x.path === (provider === "github" ? "/gh/token" : "/gg/token") && x.body.code === code);
      assert.ok(up.body.code_verifier && up.body.client_secret);
    });
  }

  it("secrets never persisted or logged: grants file holds hashes only; no provider secret/token/code in logs", async () => {
    const a = await authorize(env, client);
    const { s, cb, upstreamCode } = await attempt(env, a, "github");
    const t = await tokenReq(env, client, { grant_type: "authorization_code", code: cb.code, code_verifier: a.pkce.verifier, redirect_uri: CB });
    const tokens = t.body;
    const files = walkFiles(path.join(env.dataDir, "_server")).map((f) => fs.readFileSync(f, "utf-8")).join("\n");
    assert.ok(!files.includes(tokens.access_token) && !files.includes(tokens.refresh_token), "no plaintext tokens on disk");
    for (const secret of [GH.secret, GG.secret, upstreamCode, s.url.searchParams.get("state")]) {
      assert.ok(!files.includes(secret), "not on disk");
      assert.ok(!env.logs.join("\n").includes(secret), "not in logs");
    }
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(path.join(env.dataDir, "_server", "oauth-grants.json")).mode & 0o777, 0o600);
    }
  });

  it("identity link maps a GitHub / Google account onto an existing tenant", async () => {
    assert.match(cli(env, "identity", "link", "--github-id", "104", "--uid", "alice-existing"), /linked github 104/);
    assert.match(cli(env, "identity", "link", "--google-sub", "5550001", "--uid", "bob-existing"), /linked google 5550001/);
    const list = cli(env, "identity", "list");
    assert.match(list, /github=104\s+uid=alice-existing/);
    assert.match(list, /google=5550001\s+uid=bob-existing/);
    for (const [provider, profile, uid] of [["github", { id: 104 }, "alice-existing"], ["google", { sub: "5550001" }, "bob-existing"]]) {
      const tokens = await getTokens(env, client, { provider, profile });
      const marker = "link-marker-" + b64url(randomBytes(5));
      const c = await mcpClient(env, tokens.access_token);
      await c.callTool({ name: "remember", arguments: { content: marker } });
      await c.close();
      assert.ok(walkFiles(path.join(env.dataDir, "tenants", uid)).some((f) => fs.readFileSync(f, "utf-8").includes(marker)));
    }
    assert.ok(!fs.existsSync(path.join(env.dataDir, "tenants", "gh-104")));
  });

  it("browser binding: start and callback are refused without the matching cookie", async () => {
    const a = await authorize(env, client);
    const other = await authorize(env, client);
    const noCookie = await start(env, a, "github", { cookie: "" });
    assert.equal(noCookie.status, 400);
    const wrong = await start(env, a, "github", { cookie: other.cookie });
    assert.equal(wrong.status, 400);
    assert.match(wrong.text, /same browser/);

    // callback with no cookie / someone else's cookie: no code, even though state + provider code are valid
    for (const cookie of [undefined, other.cookie]) {
      const x = await authorize(env, client);
      const s = await start(env, x, "github");
      const code = env.mock.issue("github", { profile: PROFILE.github, challenge: s.url.searchParams.get("code_challenge") });
      const cb = await callback(env, "github", { code, state: s.url.searchParams.get("state") }, cookie);
      assert.equal(cb.status, 400, `cookie=${cookie}`);
      assert.equal(cb.code, null);
      assert.ok(!env.mock.state.calls.some((c) => c.body.code === code), "the provider code was never redeemed");
    }
  });

  it("state is single use, bound to its provider, and unknown states are refused", async () => {
    const a = await authorize(env, client);
    const { s, cb } = await attempt(env, a, "github");
    assert.equal(cb.status, 302);
    const replay = await callback(env, "github", { code: "x", state: s.url.searchParams.get("state") }, a.cookie);
    assert.equal(replay.status, 400);
    assert.equal(replay.code, null);

    const b = await authorize(env, client);
    const sb = await start(env, b, "github");
    const code = env.mock.issue("github", { profile: PROFILE.github, challenge: sb.url.searchParams.get("code_challenge") });
    const wrongProvider = await callback(env, "google", { code, state: sb.url.searchParams.get("state") }, b.cookie);
    assert.equal(wrongProvider.status, 400);
    assert.equal(wrongProvider.code, null);

    // a state consumed by a FAILED attempt cannot be replayed with a good provider code
    const c = await authorize(env, client);
    const sc = await start(env, c, "google");
    const badCode = env.mock.issue("google", { profile: PROFILE.google, challenge: sc.url.searchParams.get("code_challenge"), nonce: sc.url.searchParams.get("nonce"), claims: { aud: "other" } });
    assert.equal((await callback(env, "google", { code: badCode, state: sc.url.searchParams.get("state") }, c.cookie)).status, 401);
    const goodCode = env.mock.issue("google", { profile: PROFILE.google, challenge: sc.url.searchParams.get("code_challenge"), nonce: sc.url.searchParams.get("nonce") });
    const replayAfterFail = await callback(env, "google", { code: goodCode, state: sc.url.searchParams.get("state") }, c.cookie);
    assert.equal(replayAfterFail.status, 400);
    assert.equal(replayAfterFail.code, null);

    const unknown = await callback(env, "github", { code: "x", state: "nope" }, b.cookie);
    assert.equal(unknown.status, 400);
    const missing = await callback(env, "github", {}, b.cookie);
    assert.equal(missing.status, 400);
  });

  it("the user denying at the provider returns error=access_denied with the client's state", async () => {
    const a = await authorize(env, client);
    const s = await start(env, a, "google");
    const cb = await callback(env, "google", { error: "access_denied", state: s.url.searchParams.get("state") }, a.cookie);
    assert.equal(cb.status, 302);
    assert.ok(cb.location.startsWith(CB + "?"));
    assert.equal(cb.error, "access_denied");
    assert.equal(cb.state, a.state);
    assert.equal(cb.code, null);
    // a forged error without our cookie does not redirect anywhere
    const b = await authorize(env, client);
    const sb = await start(env, b, "google");
    const forged = await callback(env, "google", { error: "access_denied", state: sb.url.searchParams.get("state") }, undefined);
    assert.equal(forged.status, 400);
    assert.equal(forged.location, null);
  });

  for (const [name, claims] of [
    ["bad aud", { aud: "someone-elses-client" }],
    ["bad iss", { iss: "https://evil.example" }],
    ["expired", { exp: Math.floor(Date.now() / 1000) - 60 }],
    ["nonce mismatch", { nonce: "not-ours" }],
    ["non-numeric sub", { sub: "abc" }],
  ]) {
    it(`Google id_token with ${name} is refused, and the request can be retried`, async () => {
      const a = await authorize(env, client);
      const bad = await attempt(env, a, "google", { claims });
      assert.equal(bad.cb.status, 401);
      assert.equal(bad.cb.code, null);
      assert.match(bad.cb.text, /Sign-in failed/);
      assert.match(bad.cb.text, /Continue with Google/, "sign-in page offered again");
      assert.ok(!/id_token|eyJ|gg-client-secret/.test(bad.cb.text));
      const good = await attempt(env, a, "google");
      assert.equal(good.cb.status, 302);
      assert.ok(good.cb.code);
    });
  }

  it("GitHub: a non-numeric user id and a 500 give a generic error page without leaks; the request stays retryable", async () => {
    const a = await authorize(env, client);
    env.mock.state.ghUserMode = "nonnumeric";
    const nn = await attempt(env, a, "github");
    assert.equal(nn.cb.status, 401);
    assert.equal(nn.cb.code, null);
    env.mock.state.ghUserMode = "500";
    const boom = await attempt(env, a, "github");
    assert.equal(boom.cb.status, 503);
    assert.match(boom.cb.text, /temporarily unavailable/);
    for (const re of [/secret\.go/, /boom/, /gho_/, /gh-client-secret/, /127\.0\.0\.1:\d+\/gh/, /\bat \S+ \(/]) assert.ok(!re.test(boom.cb.text), `leaked ${re}`);
    for (const l of env.logs) assert.ok(!/secret\.go|gho_|gh-client-secret/.test(l));
    env.mock.state.ghUserMode = "ok";
    const ok = await attempt(env, a, "github");
    assert.equal(ok.cb.status, 302);
  });

  it("a bad upstream code (provider refuses the exchange) is a generic failure; Google token endpoint down is 'unavailable'", async () => {
    const a = await authorize(env, client);
    const s = await start(env, a, "github");
    const cb = await callback(env, "github", { code: "never-issued", state: s.url.searchParams.get("state") }, a.cookie);
    assert.equal(cb.status, 401);
    env.mock.state.ggTokenMode = "down";
    try {
      const down = await attempt(env, a, "google");
      assert.equal(down.cb.status, 503);
      assert.ok(!/ECONN|fetch failed/i.test(down.cb.text));
    } finally { env.mock.state.ggTokenMode = "ok"; }
  });

  it("start refuses unknown or unconfigured providers and a changed mind supersedes the older state", async () => {
    const a = await authorize(env, client);
    const bad = await start(env, a, "gitlab");
    assert.equal(bad.status, 400);
    assert.match(bad.text, /Choose one of/);
    const first = await start(env, a, "github");
    const second = await start(env, a, "google");
    const code = env.mock.issue("github", { profile: PROFILE.github, challenge: first.url.searchParams.get("code_challenge") });
    const old = await callback(env, "github", { code, state: first.url.searchParams.get("state") }, a.cookie);
    assert.equal(old.status, 400, "older state is dead");
    const code2 = env.mock.issue("google", { profile: PROFILE.google, challenge: second.url.searchParams.get("code_challenge"), nonce: second.url.searchParams.get("nonce") });
    const cur = await callback(env, "google", { code: code2, state: second.url.searchParams.get("state") }, a.cookie);
    assert.equal(cur.status, 302);
  });

  it("unknown, malformed and expired request ids are dead; pending requests expire after 10 minutes", async () => {
    for (const requestId of ["nope", "", "x".repeat(500)]) {
      const a = await authorize(env, client);
      const r = await start(env, a, "github", { requestId });
      assert.equal(r.status, 400);
    }
    const a = await authorize(env, client);
    env.clock.offset += 10 * 60 * 1000 + 1000;
    try {
      const r = await start(env, a, "github");
      assert.equal(r.status, 400);
    } finally { env.clock.offset -= 10 * 60 * 1000 + 1000; }
  });

  it("PKCE verifier mismatch → invalid_grant", async () => {
    const { code } = await getCode(env, client);
    const bad = await tokenReq(env, client, { grant_type: "authorization_code", code, code_verifier: makePkce().verifier, redirect_uri: CB });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "invalid_grant");
  });

  it("code is single use; reuse → invalid_grant", async () => {
    const { code, pkce } = await getCode(env, client);
    const first = await tokenReq(env, client, { grant_type: "authorization_code", code, code_verifier: pkce.verifier, redirect_uri: CB });
    assert.equal(first.status, 200);
    const again = await tokenReq(env, client, { grant_type: "authorization_code", code, code_verifier: pkce.verifier, redirect_uri: CB });
    assert.equal(again.body.error, "invalid_grant");
  });

  it("code expires after 60 s", async () => {
    const { code, pkce } = await getCode(env, client);
    env.clock.offset += 61_000;
    try {
      const r = await tokenReq(env, client, { grant_type: "authorization_code", code, code_verifier: pkce.verifier, redirect_uri: CB });
      assert.equal(r.body.error, "invalid_grant");
    } finally { env.clock.offset -= 61_000; }
  });

  it("code is bound to client and redirect_uri; the token request may omit redirect_uri", async () => {
    const other = await newClient(env, { client_name: "Other" });
    const a = await getCode(env, client);
    const wrongClient = await tokenReq(env, other, { grant_type: "authorization_code", code: a.code, code_verifier: a.pkce.verifier, redirect_uri: CB });
    assert.equal(wrongClient.body.error, "invalid_grant");
    const b = await getCode(env, client);
    const wrongRedirect = await tokenReq(env, client, { grant_type: "authorization_code", code: b.code, code_verifier: b.pkce.verifier, redirect_uri: "http://127.0.0.1:1/other" });
    assert.equal(wrongRedirect.body.error, "invalid_grant");
    const retry = await tokenReq(env, client, { grant_type: "authorization_code", code: b.code, code_verifier: b.pkce.verifier, redirect_uri: CB });
    assert.equal(retry.body.error, "invalid_grant", "a mismatching attempt burns the code");
    const c = await getCode(env, client);
    const omitted = await tokenReq(env, client, { grant_type: "authorization_code", code: c.code, code_verifier: c.pkce.verifier });
    assert.equal(omitted.status, 200, JSON.stringify(omitted.body));
  });

  it("resource mismatch is rejected at /authorize and /token; the exact resource is accepted", async () => {
    const a = await authorize(env, client, { resource: "https://evil.example/mcp" });
    assert.equal(a.status, 302);
    const loc = new URL(a.res.headers.get("location"));
    assert.equal(loc.searchParams.get("error"), "invalid_target");
    assert.equal(loc.searchParams.get("code"), null);
    const { code, pkce } = await getCode(env, client, { resource: `${env.base}/mcp` });
    const bad = await tokenReq(env, client, { grant_type: "authorization_code", code, code_verifier: pkce.verifier, redirect_uri: CB, resource: "https://evil.example/mcp" });
    assert.equal(bad.body.error, "invalid_target");
    const ok = await getTokens(env, client, { resource: `${env.base}/mcp` });
    assert.match(ok.access_token, /^aro_/);
  });

  it("authorize rejects plain PKCE, unknown clients and unregistered redirect URIs without redirecting", async () => {
    const q = (o) => `${env.base}/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: CB, code_challenge: makePkce().challenge, code_challenge_method: "S256", ...o })}`;
    const plain = await fetch(q({ code_challenge_method: "plain" }), { redirect: "manual" });
    assert.equal(plain.status, 302);
    assert.equal(new URL(plain.headers.get("location")).searchParams.get("error"), "invalid_request");
    assert.equal((await fetch(q({ client_id: "nope" }), { redirect: "manual" })).status, 400);
    const unreg = await fetch(q({ redirect_uri: "https://evil.example/cb" }), { redirect: "manual" });
    assert.equal(unreg.status, 400);
    assert.equal(unreg.headers.get("location"), null);
  });

  it("refresh rotates; reuse of a rotated refresh token revokes the whole grant", async () => {
    const t1 = await getTokens(env, client, {});
    const r1 = await tokenReq(env, client, { grant_type: "refresh_token", refresh_token: t1.refresh_token });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.notEqual(r1.body.refresh_token, t1.refresh_token);
    assert.equal(await mcpStatus(env, r1.body.access_token), 200);
    const r2 = await tokenReq(env, client, { grant_type: "refresh_token", refresh_token: r1.body.refresh_token });
    assert.equal(r2.status, 200);
    const replay = await tokenReq(env, client, { grant_type: "refresh_token", refresh_token: t1.refresh_token });
    assert.equal(replay.body.error, "invalid_grant");
    assert.equal(await mcpStatus(env, r2.body.access_token), 401, "grant revoked → newest access token dead");
    assert.equal((await tokenReq(env, client, { grant_type: "refresh_token", refresh_token: r2.body.refresh_token })).body.error, "invalid_grant");
  });

  it("refresh tokens are bound to their client and unknown tokens fail", async () => {
    const other = await newClient(env, { client_name: "Other2" });
    const t = await getTokens(env, client, {});
    assert.equal((await tokenReq(env, other, { grant_type: "refresh_token", refresh_token: t.refresh_token })).body.error, "invalid_grant");
    assert.equal((await tokenReq(env, client, { grant_type: "refresh_token", refresh_token: "arr_" + "x".repeat(43) })).body.error, "invalid_grant");
    assert.equal((await tokenReq(env, client, { grant_type: "refresh_token", refresh_token: t.refresh_token })).status, 200);
  });

  it("access tokens expire after 1 h; refresh still works", async () => {
    const t = await getTokens(env, client, {});
    assert.equal(await mcpStatus(env, t.access_token), 200);
    env.clock.offset += 61 * 60 * 1000;
    try {
      assert.equal(await mcpStatus(env, t.access_token), 401);
      const r = await tokenReq(env, client, { grant_type: "refresh_token", refresh_token: t.refresh_token });
      assert.equal(r.status, 200);
      assert.equal(await mcpStatus(env, r.body.access_token), 200);
    } finally { env.clock.offset -= 61 * 60 * 1000; }
  });

  it("M3: a grant dies 90 days after sign-in however often it is refreshed", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    let t = await getTokens(env, client, {});
    try {
      for (const d of [29, 58, 87]) {
        env.clock.offset = d * DAY;
        const r = await tokenReq(env, client, { grant_type: "refresh_token", refresh_token: t.refresh_token });
        assert.equal(r.status, 200, `day ${d}: ${JSON.stringify(r.body)}`);
        t = r.body;
      }
      env.clock.offset = 91 * DAY;
      const late = await tokenReq(env, client, { grant_type: "refresh_token", refresh_token: t.refresh_token });
      assert.equal(late.body.error, "invalid_grant");
      assert.equal(await mcpStatus(env, t.access_token), 401);
    } finally { env.clock.offset = 0; }
  });

  it("POST /revoke kills a refresh token's grant", async () => {
    const t = await getTokens(env, client, {});
    const r = await fetch(env.base + "/revoke", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ client_id: client.client_id, token: t.refresh_token, token_type_hint: "refresh_token" }),
    });
    assert.equal(r.status, 200);
    assert.equal(await mcpStatus(env, t.access_token), 401);
    assert.equal((await tokenReq(env, client, { grant_type: "refresh_token", refresh_token: t.refresh_token })).status, 400);
  });

  it("operator: oauth list / revoke <grant-id> (flag first or last) / revoke --uid take effect on the next request", async () => {
    const who = { provider: "github", profile: { id: 105 } };
    const t1 = await getTokens(env, client, who);
    const t2 = await getTokens(env, client, who);
    assert.equal(await mcpStatus(env, t1.access_token), 200);
    const list = cli(env, "oauth", "list");
    const ids = [...list.matchAll(/^([0-9a-f]{12})\s+uid=gh-105/gm)].map((m) => m[1]);
    assert.equal(ids.length, 2, list);
    const r = spawnSync(process.execPath, [CLI, "oauth", "revoke", "--data", env.dataDir, ids[0]], { encoding: "utf-8", env: cliEnv() });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual([await mcpStatus(env, t1.access_token), await mcpStatus(env, t2.access_token)].sort(), [200, 401]);
    cli(env, "oauth", "revoke", "--uid", "gh-105");
    assert.equal(await mcpStatus(env, t1.access_token), 401);
    assert.equal(await mcpStatus(env, t2.access_token), 401);
    assert.match(cli(env, "oauth", "list"), /REVOKED\(operator\)/);
    const bad = spawnSync(process.execPath, [CLI, "oauth", "revoke", "deadbeef0000", "--data", env.dataDir], { encoding: "utf-8", env: cliEnv() });
    assert.notEqual(bad.status, 0);
    await new Promise((r2) => setTimeout(r2, 10));
    const fresh = await getTokens(env, client, who);
    assert.equal(await mcpStatus(env, fresh.access_token), 200, "a sign-in after the revocation works");
  });

  it("static ar_ tokens keep working with OAuth enabled; junk aro_/arr_ tokens do not", async () => {
    const out = cli(env, "token", "create", "--uid", "static-user");
    const token = /\b(ar_[A-Za-z0-9_-]{43})\b/.exec(out)[1];
    assert.equal(await mcpStatus(env, token), 200);
    assert.equal(await mcpStatus(env, "aro_" + "x".repeat(43)), 401);
    assert.equal(await mcpStatus(env, "arr_" + "x".repeat(43)), 401);
    const t = await getTokens(env, client, {});
    assert.equal(await mcpStatus(env, t.refresh_token), 401, "a refresh token is not an access token");
  });

  it("sign-in page escapes a hostile client_name; bidi/zero-width characters are stripped", async () => {
    const evil = await newClient(env, { client_name: `<script>alert(1)</script>"><img src=x onerror=alert(2)>` });
    const a = await authorize(env, evil);
    assert.equal(a.status, 200);
    assert.ok(!/<script/i.test(a.html) && !a.html.includes("<img src=x"));
    assert.ok(a.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    const bidi = await newClient(env, { client_name: "Good‮evil​⁦x" });
    assert.equal(bidi.client_name, "Goodevilx");
    const b = await authorize(env, bidi);
    assert.ok(!/[​-‏‪-‮⁦-⁩﻿]/.test(b.html));
  });

  it("M4: at most 3 redirect URIs of at most 1024 chars; client_name capped at 100", async () => {
    const four = await register(env, { client_name: "x", redirect_uris: [1, 2, 3, 4].map((n) => `http://127.0.0.1:${n}000/cb`) });
    assert.equal(four.status, 400);
    assert.equal((await register(env, { client_name: "x", redirect_uris: [1, 2, 3].map((n) => `http://127.0.0.1:${n}000/cb`) })).status, 201);
    assert.equal((await register(env, { client_name: "x", redirect_uris: ["http://127.0.0.1:1/" + "a".repeat(1100)] })).status, 400);
    assert.equal((await register(env, { client_name: "n".repeat(500), redirect_uris: [CB] })).body.client_name.length, 100);
  });

  it("M4: using a client does not rewrite oauth-clients.json more than once per hour", async () => {
    const c = await newClient(env, { client_name: "debounce" });
    const t = await getTokens(env, c, {});
    const file = path.join(env.dataDir, "_server", "oauth-clients.json");
    const snapshot = fs.readFileSync(file, "utf-8");
    env.clock.offset += 5 * 60 * 1000;
    try {
      const r = await tokenReq(env, c, { grant_type: "refresh_token", refresh_token: t.refresh_token });
      assert.equal(r.status, 200);
      assert.equal(fs.readFileSync(file, "utf-8"), snapshot, "no rewrite within the hour");
      env.clock.offset += 61 * 60 * 1000;
      assert.equal((await tokenReq(env, c, { grant_type: "refresh_token", refresh_token: r.body.refresh_token })).status, 200);
      assert.notEqual(fs.readFileSync(file, "utf-8"), snapshot, "persisted again after an hour");
    } finally { env.clock.offset = 0; }
  });

  it("L3: `token create --uid gh-…/gg-…` is refused; `identity link` only to the account's own gh-/gg- uid", () => {
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args, "--data", env.dataDir], { encoding: "utf-8", env: cliEnv() });
    for (const uid of ["gh-5", "gg-5"]) {
      const bad = run("token", "create", "--uid", uid);
      assert.notEqual(bad.status, 0);
      assert.match(bad.stderr, /reserved/);
    }
    assert.equal(run("token", "create", "--uid", "plain-user").status, 0);
    const foreign = run("identity", "link", "--github-id", "5", "--uid", "gh-9");
    assert.notEqual(foreign.status, 0, "gh-9 belongs to GitHub account 9, never to account 5");
    assert.match(foreign.stderr, /belongs to/);
    assert.equal(run("identity", "link", "--github-id", "5", "--uid", "gh-5").status, 0);
    assert.equal(run("identity", "link", "--google-sub", "6", "--uid", "gg-6").status, 0);
    assert.notEqual(run("identity", "link", "--google-sub", "6", "--uid", "gh-6").status, 0, "a Google account never maps onto a gh- uid");
    assert.notEqual(run("identity", "link", "--github-id", "5", "--google-sub", "6", "--uid", "x-user").status, 0);
    assert.notEqual(run("identity", "link", "--github-id", "abc", "--uid", "x-user").status, 0);
  });
});

// ---- providers configured ---------------------------------------------------

describe("oauth — only configured providers are offered", () => {
  it("a GitHub-only server shows one button and refuses Google", async () => {
    const env = await startEnv({ providers: ["github"] });
    try {
      const client = await newClient(env);
      const a = await authorize(env, client);
      assert.match(a.html, /Continue with GitHub/);
      assert.ok(!/Continue with Google/.test(a.html));
      assert.equal((await start(env, a, "google")).status, 400);
      assert.ok(env.mock.urls.githubAuthorize && (await start(env, a, "github")).status === 302);
    } finally { await env.close(); }
  });
});

// ---- limits -----------------------------------------------------------------

describe("oauth — rate limits and proxy handling", () => {
  it("per-IP limit on /authorize/start: the next hit gets 429 with retry-after", async () => {
    const env = await startEnv({ loginLimits: { perIp: 3, global: 1000, windowMs: 600000 } });
    try {
      const client = await newClient(env);
      const a = await authorize(env, client);
      for (let i = 0; i < 3; i++) await start(env, a, "github");
      const r = await start(env, a, "github");
      assert.equal(r.status, 429);
      assert.ok(Number(r.headers.get("retry-after")) >= 1);
    } finally { await env.close(); }
  });

  it("per-IP limit on the callback too", async () => {
    const env = await startEnv({ loginLimits: { perIp: 2, global: 1000, windowMs: 600000 } });
    try {
      for (let i = 0; i < 2; i++) await callback(env, "github", { state: "x" });
      assert.equal((await callback(env, "github", { state: "x" })).status, 429);
    } finally { await env.close(); }
  });

  it("global budget is spent only by live request ids / states", async () => {
    const env = await startEnv({ loginLimits: { perIp: 1000, global: 2, windowMs: 600000 } });
    try {
      const client = await newClient(env);
      for (let i = 0; i < 12; i++) {
        assert.equal((await start(env, { cookie: "ar_oauth=x" }, "github", { requestId: "garbage-" + i })).status, 400);
        assert.equal((await callback(env, "github", { state: "garbage-" + i })).status, 400);
      }
      const a = await authorize(env, client);
      assert.equal((await start(env, a, "github")).status, 302);
      assert.equal((await start(env, a, "github")).status, 302);
      assert.equal((await start(env, a, "github")).status, 429, "live requests do spend it");
    } finally { await env.close(); }
  });

  it("L1: X-Forwarded-For without AR_TRUST_PROXY logs one warning", async () => {
    const env = await startEnv();
    try {
      await fetch(env.base + "/.well-known/oauth-authorization-server");
      assert.equal(env.logs.filter((l) => /X-Forwarded-For/.test(l)).length, 0);
      for (let i = 0; i < 3; i++) await fetch(env.base + "/.well-known/oauth-authorization-server", { headers: { "x-forwarded-for": "198.51.100.7" } });
      assert.equal(env.logs.filter((l) => /X-Forwarded-For.*AR_TRUST_PROXY/.test(l)).length, 1);
    } finally { await env.close(); }
  });
});

// ---- authorize re-checks the policy ------------------------------------------

describe("oauth — startup and policy re-checks", () => {
  it("a stored client whose redirect is no longer allowed gets a direct 400, never a redirect", async () => {
    const env = await startEnv({
      seed(dataDir) {
        fs.mkdirSync(path.join(dataDir, "_server"), { recursive: true });
        fs.writeFileSync(path.join(dataDir, "_server", "oauth-clients.json"), JSON.stringify({
          version: 1,
          clients: [{ client_id: "legacy", client_id_issued_at: 1, redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" }],
        }));
      },
    });
    try {
      const q = new URLSearchParams({ response_type: "code", client_id: "legacy", redirect_uri: "https://evil.example/cb", code_challenge: makePkce().challenge, code_challenge_method: "S256", state: "s" });
      const r = await fetch(`${env.base}/authorize?${q}`, { redirect: "manual" });
      assert.equal(r.status, 400);
      assert.equal(r.headers.get("location"), null);
    } finally { await env.close(); }
  });

  it("a corrupt oauth-grants.json stops the server from starting instead of discarding grants", async () => {
    await assert.rejects(startEnv({
      seed(dataDir) {
        fs.mkdirSync(path.join(dataDir, "_server"), { recursive: true });
        fs.writeFileSync(path.join(dataDir, "_server", "oauth-grants.json"), "{not json");
      },
    }));
  });
});

// ---- OAuth disabled = v1 -----------------------------------------------------

describe("oauth disabled — behaviour is v1", () => {
  let env;
  before(async () => { env = await startEnv({ oauth: false }); });
  after(async () => { await env.close(); });

  it("OAuth routes 404 and the 401 header is exactly the v1 header", async () => {
    for (const [method, p] of [["POST", "/register"], ["GET", "/authorize"], ["POST", "/authorize/start"], ["GET", "/authorize/callback/github"],
      ["POST", "/token"], ["GET", "/.well-known/oauth-authorization-server"], ["GET", "/.well-known/oauth-protected-resource/mcp"]]) {
      const r = await fetch(env.base + p, { method, redirect: "manual" });
      assert.equal(r.status, 404, `${method} ${p}`);
    }
    const r = await fetch(env.base + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("www-authenticate"), 'Bearer realm="agent-recall"');
    assert.equal((await r.json()).agent_instruction, "Send header 'Authorization: Bearer <your AgentRecall token>'. Tokens start with 'ar_'. Ask the server operator for a token if you do not have one.");
  });

  it("aro_ tokens are never accepted when OAuth is off", async () => {
    assert.equal(await mcpStatus(env, "aro_" + "x".repeat(43)), 401);
  });
});

// ---- real binary -------------------------------------------------------------

describe("oauth — real agent-recall-server binary", () => {
  it("serve reads AR_PUBLIC_URL + provider env and exposes discovery; half-configurations exit 2", async () => {
    const dataDir = fs.mkdtempSync(path.join(root, "bin-"));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const baseEnv = { ...cliEnv(), AR_SERVER_DATA: dataDir };
    for (const k of Object.keys(baseEnv)) if (k.startsWith("AR_OAUTH_") || k === "AR_PUBLIC_URL") delete baseEnv[k];

    const run = (extra) => spawnSync(process.execPath, [CLI, "serve", "--port", String(port)], { env: { ...baseEnv, ...extra }, encoding: "utf-8", timeout: 20000 });
    const urlOnly = run({ AR_PUBLIC_URL: base });
    assert.equal(urlOnly.status, 2);
    assert.match(urlOnly.stderr, /at least one provider/);
    const half = run({ AR_PUBLIC_URL: base, AR_OAUTH_GITHUB_CLIENT_ID: "x" });
    assert.equal(half.status, 2);
    assert.match(half.stderr, /CLIENT_SECRET/);

    const proc = spawn(process.execPath, [CLI, "serve", "--port", String(port)], {
      env: { ...baseEnv, AR_PUBLIC_URL: base, AR_OAUTH_GITHUB_CLIENT_ID: "x", AR_OAUTH_GITHUB_CLIENT_SECRET: "y", AR_TRUST_PROXY: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    proc.stderr.on("data", (d) => { err += d; });
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("no start: " + err)), 30_000);
        proc.stderr.on("data", () => { if (err.includes("listening on")) { clearTimeout(t); resolve(); } });
        proc.on("exit", (c) => { clearTimeout(t); reject(new Error(`exit ${c}: ${err}`)); });
      });
      assert.match(err, /oauth on.*login: github/);
      assert.ok(!err.includes("y\n") || !/client_secret/.test(err));
      const prm = await (await fetch(base + "/.well-known/oauth-protected-resource/mcp")).json();
      assert.equal(prm.resource, `${base}/mcp`);
      const r = await fetch(base + "/mcp", { method: "POST", body: "{}" });
      assert.match(r.headers.get("www-authenticate"), /resource_metadata=/);
    } finally {
      proc.kill();
      await new Promise((r) => proc.once("exit", r));
    }
  });
});

describe("oauth — CLI on corrupt files", () => {
  it("gives a friendly error, not a stack trace", () => {
    const dir = fs.mkdtempSync(path.join(root, "corrupt-"));
    fs.mkdirSync(path.join(dir, "_server"));
    fs.writeFileSync(path.join(dir, "_server", "oauth-revoked.json"), "{bad");
    fs.writeFileSync(path.join(dir, "_server", "identities.json"), "[]");
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args, "--data", dir], { encoding: "utf-8", env: cliEnv() });
    for (const args of [["oauth", "revoke", "--uid", "gh-1"], ["identity", "list"], ["identity", "link", "--github-id", "3", "--uid", "bob"]]) {
      const r = run(...args);
      assert.equal(r.status, 1, args.join(" "));
      assert.match(r.stderr, /fix it or remove it/);
      assert.ok(!/\n\s+at /.test(r.stderr), "no stack trace");
    }
  });
});

// ---- round 5 hardening -------------------------------------------------------------

describe("oauth round 5 — consent page, caps, cookies, Google claims", () => {
  let env, client;
  before(async () => { env = await startEnv(); client = await newClient(env); });
  after(async () => { await env.close(); });

  it("M1: the destination is the primary line; the name is labelled unverified; loopback gets a warning", async () => {
    const a = await authorize(env, client);
    const dest = a.html.indexOf("Sign-in result goes to: <strong>127.0.0.1:53682</strong>");
    const name = a.html.indexOf("self-reported name, not verified");
    assert.ok(dest > 0 && name > dest, "destination comes before the self-reported name");
    assert.match(a.html, /This connects a program running on this computer\. Only continue if you just started the connection yourself\./);
    assert.ok(!/This connects Claude/.test(a.html));
  });

  it("M1: claude.ai callbacks say so and carry no loopback warning", async () => {
    const CL = "https://claude.ai/api/mcp/auth_callback";
    const c = await newClient(env, { client_name: "Claude", redirect_uris: [CL] });
    const a = await authorize(env, c, { redirect_uri: CL });
    assert.match(a.html, /Sign-in result goes to: <strong>claude\.ai<\/strong>/);
    assert.match(a.html, /This connects Claude \(claude\.ai\)\./);
    assert.ok(!/running on this computer/.test(a.html));
  });

  it("M2: at most 3 provider redirects per request, and the 4th spends no global budget", async () => {
    const e = await startEnv({ loginLimits: { perIp: 1000, global: 4, windowMs: 600000 } });
    try {
      const c = await newClient(e);
      const a = await authorize(e, c);
      for (let k = 0; k < 3; k++) assert.equal((await start(e, a, "github")).status, 302);
      const fourth = await start(e, a, "github");
      assert.equal(fourth.status, 429);
      assert.match(fourth.text, /for this request/);
      // global budget is 4: three were spent above, the 4th start must not have cost one
      const b = await authorize(e, c);
      assert.equal((await start(e, b, "github")).status, 302);
    } finally { await e.close(); }
  });

  it("L3: a client state longer than 512 chars is refused with invalid_request; 512 is fine", async () => {
    const long = await authorize(env, client, { state: "s".repeat(513) });
    assert.equal(long.status, 302);
    const loc = new URL(long.res.headers.get("location"));
    assert.equal(loc.searchParams.get("error"), "invalid_request");
    assert.equal(loc.searchParams.get("code"), null);
    assert.equal((await authorize(env, client, { state: "s".repeat(512) })).status, 200);
  });

  it("L5: parallel sign-ins in one browser use separate cookies and do not clobber each other", async () => {
    const a = await authorize(env, client);
    const b = await authorize(env, client);
    assert.notEqual(a.cookie.split("=")[0], b.cookie.split("=")[0]);
    const jar = a.cookie + "; " + b.cookie;
    const sa = await start(env, a, "github", { cookie: jar });
    const sb = await start(env, b, "github", { cookie: jar });
    assert.equal(sa.status, 302);
    assert.equal(sb.status, 302);
    const issue = (s) => env.mock.issue("github", { profile: PROFILE.github, challenge: s.url.searchParams.get("code_challenge") });
    const cbB = await callback(env, "github", { code: issue(sb), state: sb.url.searchParams.get("state") }, jar);
    const cbA = await callback(env, "github", { code: issue(sa), state: sa.url.searchParams.get("state") }, jar);
    assert.equal(cbB.status, 302);
    assert.equal(cbA.status, 302);
    assert.equal(cbB.state, b.state);
    assert.equal(cbA.state, a.state);
    assert.ok(cbA.headers.get("set-cookie").startsWith(a.cookie.split("=")[0] + "="), "only its own cookie is cleared");
    assert.ok(cbB.headers.get("set-cookie").startsWith(b.cookie.split("=")[0] + "="));
  });

  for (const [name, claims, expected] of [
    ["aud array without azp", { aud: [GG.id, "other"] }, 401],
    ["aud array with azp", { aud: [GG.id, "other"], azp: GG.id }, 302],
    ["azp of another client", { azp: "other-client" }, 401],
    ["iat far in the future", { iat: Math.floor(Date.now() / 1000) + 600 }, 401],
    ["iat 2 minutes ahead (clock skew)", { iat: Math.floor(Date.now() / 1000) + 120 }, 302],
  ]) {
    it("L6: Google id_token with " + name + " -> " + expected, async () => {
      const a = await authorize(env, client);
      const { cb } = await attempt(env, a, "google", { claims });
      assert.equal(cb.status, expected);
    });
  }
});

describe("oauth round 5 — pending cap (L4) and stored clients (L8)", () => {
  it("L4: a full pending table answers 503 instead of evicting live sign-ins; expired ones make room", async () => {
    const env = await startEnv({ maxPending: 3 });
    try {
      const client = await newClient(env);
      const live = [];
      for (let i = 0; i < 3; i++) { const a = await authorize(env, client); assert.equal(a.status, 200); live.push(a); }
      const busy = await authorize(env, client);
      assert.equal(busy.status, 503);
      assert.ok(busy.res.headers.get("retry-after"));
      assert.match(busy.html, /busy/);
      assert.equal((await start(env, live[0], "github")).status, 302, "the oldest live sign-in survived");
      env.clock.offset += 11 * 60 * 1000;
      try {
        assert.equal((await authorize(env, client)).status, 200, "expired entries are evicted");
      } finally { env.clock.offset -= 11 * 60 * 1000; }
    } finally { await env.close(); }
  });

  it("L8: stored redirect URIs that no longer pass the policy are dropped; a client left with none is unknown", async () => {
    const env = await startEnv({
      seed(dataDir) {
        fs.mkdirSync(path.join(dataDir, "_server"), { recursive: true });
        fs.writeFileSync(path.join(dataDir, "_server", "oauth-clients.json"), JSON.stringify({
          version: 1,
          clients: [
            { client_id: "mixed", client_id_issued_at: 1, redirect_uris: [CB, "https://evil.example/cb"], token_endpoint_auth_method: "none" },
            { client_id: "evilonly", client_id_issued_at: 1, redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" },
          ],
        }));
      },
    });
    try {
      const tok = async (client_id) => (await tokenReq(env, { client_id }, { grant_type: "refresh_token", refresh_token: "arr_" + "x".repeat(43) })).body.error;
      assert.equal(await tok("evilonly"), "invalid_client");
      assert.equal(await tok("mixed"), "invalid_grant");
      const q = new URLSearchParams({ response_type: "code", client_id: "mixed", redirect_uri: "https://evil.example/cb", code_challenge: makePkce().challenge, code_challenge_method: "S256", state: "s" });
      const r = await fetch(env.base + "/authorize?" + q, { redirect: "manual" });
      assert.equal(r.status, 400);
      assert.equal(r.headers.get("location"), null);
    } finally { await env.close(); }
  });
});

// ---- review round 6 (PR #50): invite-only, grant caps, write-then-commit, reserved uids ----

const { OAuthStore, MAX_GRANTS_PER_UID, REFRESH_GRACE_MS } = await load("oauth-store.js");

describe("oauth round 6 — invite-only sign-up (default)", () => {
  let env, client;
  before(async () => { env = await startEnv({ signup: null }); client = await newClient(env); });
  after(async () => env?.close());

  it("config: invite is the default; open must be explicit; anything else fails closed", () => {
    const base = { AR_PUBLIC_URL: "https://recall.example", AR_OAUTH_GITHUB_CLIENT_ID: "i", AR_OAUTH_GITHUB_CLIENT_SECRET: "s" };
    assert.equal(loadOAuthConfig({}, base).signup, "invite");
    assert.equal(loadOAuthConfig({}, { ...base, AR_OAUTH_SIGNUP: "" }).signup, "invite", "empty (compose default) = invite");
    assert.equal(loadOAuthConfig({}, { ...base, AR_OAUTH_SIGNUP: "open" }).signup, "open");
    assert.equal(loadOAuthConfig({}, { ...base, AR_OAUTH_SIGNUP: "INVITE" }).signup, "invite");
    assert.throws(() => loadOAuthConfig({}, { ...base, AR_OAUTH_SIGNUP: "yes" }), OAuthConfigError);
  });

  it("an account nobody invited gets a 403 page naming its id, no code, and no tenant", async () => {
    const a = await authorize(env, client);
    const { cb } = await attempt(env, a, "github", { profile: { id: 4242 } });
    assert.equal(cb.status, 403);
    assert.equal(cb.code, null);
    assert.match(cb.text, /not invited/i);
    assert.match(cb.text, /4242/, "the user can send their id to the operator");
    assert.ok(env.logs.some((l) => /not invited.*github=4242/.test(l)), env.logs.join("\n"));
    assert.ok(!fs.existsSync(path.join(env.dataDir, "tenants", "gh-4242")));
  });

  it("`identity link` without --uid invites the account at its own gh-/gg- uid; with --uid onto an existing tenant", async () => {
    assert.match(cli(env, "identity", "link", "--github-id", "4343"), /linked github 4343 -> uid "gh-4343"/);
    cli(env, "identity", "link", "--google-sub", "777000", "--uid", "carol-existing");
    for (const [provider, profile, uid] of [["github", { id: 4343 }, "gh-4343"], ["google", { sub: "777000" }, "carol-existing"]]) {
      const tokens = await getTokens(env, client, { provider, profile });
      const marker = "invite-" + b64url(randomBytes(5));
      const c = await mcpClient(env, tokens.access_token);
      await c.callTool({ name: "remember", arguments: { content: marker } });
      await c.close();
      assert.ok(walkFiles(path.join(env.dataDir, "tenants", uid)).some((f) => fs.readFileSync(f, "utf-8").includes(marker)), uid);
    }
  });
});

describe("oauth round 6 — grants are capped per user", () => {
  let env, client;
  before(async () => { env = await startEnv(); client = await newClient(env); });
  after(async () => env?.close());

  it("at most MAX_GRANTS_PER_UID live grants per uid: the oldest is evicted, the newest works", async () => {
    const first = await getTokens(env, client, { profile: { id: 555 } });
    let last;
    for (let i = 0; i < MAX_GRANTS_PER_UID; i++) last = await getTokens(env, client, { profile: { id: 555 } });
    const grants = JSON.parse(fs.readFileSync(path.join(env.dataDir, "_server", "oauth-grants.json"), "utf-8")).grants;
    assert.equal(grants.filter((g) => g.uid === "gh-555").length, MAX_GRANTS_PER_UID);
    assert.equal(await mcpStatus(env, first.access_token), 401, "evicted grant");
    assert.equal(await mcpStatus(env, last.access_token), 200);
    const other = await getTokens(env, client, { profile: { id: 556 } });
    assert.equal(await mcpStatus(env, other.access_token), 200, "another user is unaffected");
  });
});

describe("oauth round 6 — store writes to disk before changing memory", () => {
  const fresh = () => {
    const dir = fs.mkdtempSync(path.join(root, "store-"));
    fs.mkdirSync(path.join(dir, "_server"), { recursive: true });
    const clock = { t: 1_800_000_000_000 };
    let fail = false;
    const write = (file, data) => {
      if (fail) throw Object.assign(new Error("EPERM: rename (simulated antivirus lock)"), { code: "EPERM" });
      fs.writeFileSync(file, JSON.stringify(data));
    };
    const store = new OAuthStore(dir, () => clock.t, write);
    return { store, clock, setFail: (v) => { fail = v; } };
  };

  it("error path: a failed write during refresh changes nothing, so the client's retry with the same token works", () => {
    const { store, setFail } = fresh();
    const issued = store.createGrant({ uid: "alice", clientId: "c1", resource: "https://r/mcp" });
    setFail(true);
    assert.throws(() => store.rotateRefresh("c1", issued.refresh_token), /EPERM/);
    setFail(false);
    const retry = store.rotateRefresh("c1", issued.refresh_token);
    assert.equal(retry.type, "ok", "not treated as token theft");
    assert.ok(store.resolveAccess(retry.tokens.access_token));
  });

  it("error path: a failed write during sign-in leaves no half-created grant", () => {
    const { store, setFail } = fresh();
    setFail(true);
    assert.throws(() => store.createGrant({ uid: "bob", clientId: "c1", resource: "https://r/mcp" }), /EPERM/);
    setFail(false);
    assert.equal(store.hasGrantForUid("bob"), false);
  });

  it("a lost refresh response: the previous token still works inside the grace window, then reuse revokes the grant", () => {
    const { store, clock } = fresh();
    const r0 = store.createGrant({ uid: "carol", clientId: "c1", resource: "https://r/mcp" }).refresh_token;
    const first = store.rotateRefresh("c1", r0);
    assert.equal(first.type, "ok");
    clock.t += REFRESH_GRACE_MS - 1;
    assert.equal(store.rotateRefresh("c2", r0).type, "invalid", "another client never benefits from the grace");
    const again = store.rotateRefresh("c1", r0);
    assert.equal(again.type, "ok", "inside the grace window the client that lost the response gets new tokens");
    assert.equal(store.rotateRefresh("c1", r0).type, "reuse", "one retry only: a second replay is a theft signal");
    assert.equal(store.resolveAccess(again.tokens.access_token), null, "and the whole grant is revoked");
  });

  it("the grace window ends after REFRESH_GRACE_MS", () => {
    const { store, clock } = fresh();
    const r0 = store.createGrant({ uid: "dave", clientId: "c1", resource: "https://r/mcp" }).refresh_token;
    const first = store.rotateRefresh("c1", r0);
    clock.t += REFRESH_GRACE_MS + 1;
    assert.equal(store.rotateRefresh("c1", r0).type, "reuse");
    assert.equal(store.resolveAccess(first.tokens.access_token), null);
  });

  it("error path: a failed write while revoking on reuse leaves memory unchanged; the next attempt revokes", () => {
    const { store, clock, setFail } = fresh();
    const r0 = store.createGrant({ uid: "erin", clientId: "c1", resource: "https://r/mcp" }).refresh_token;
    const first = store.rotateRefresh("c1", r0);
    clock.t += REFRESH_GRACE_MS + 1;
    setFail(true);
    assert.throws(() => store.rotateRefresh("c1", r0), /EPERM/);
    assert.ok(store.resolveAccess(first.tokens.access_token), "nothing half-applied");
    setFail(false);
    assert.equal(store.rotateRefresh("c1", r0).type, "reuse");
    assert.equal(store.resolveAccess(first.tokens.access_token), null);
  });
});

describe("oauth round 6 — reserved gh-/gg- uids", () => {
  const legacyToken = (extra = {}) => (dataDir) => {
    fs.mkdirSync(path.join(dataDir, "_server"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "_server", "tokens.json"), JSON.stringify({ version: 1, tokens: [
      { id: "aaaaaaaaaaaa", uid: "gh-101", label: "legacy", hash: "0".repeat(64), created_at: "2026-01-01T00:00:00.000Z", ...extra },
    ] }));
  };

  it("OAuth refuses to start while tokens.json holds an active static token for a gh-/gg- uid; OAuth off is unaffected", async () => {
    await assert.rejects(startEnv({ seed: legacyToken() }), /gh-101[\s\S]*reserved/);
    const off = await startEnv({ oauth: false, seed: legacyToken() });
    await off.close();
  });

  it("a stored link onto someone else's gh- uid ends the sign-in (403, no retry offered, no code)", async () => {
    const env = await startEnv({
      signup: null,
      seed: (dataDir) => {
        fs.mkdirSync(path.join(dataDir, "_server"), { recursive: true });
        fs.writeFileSync(path.join(dataDir, "_server", "identities.json"), JSON.stringify({ version: 1, links: { "github:5": "gh-9" } }));
      },
    });
    try {
      const client = await newClient(env);
      const a = await authorize(env, client);
      const { cb } = await attempt(env, a, "github", { profile: { id: 5 } });
      assert.equal(cb.status, 403);
      assert.equal(cb.code, null);
      assert.match(cb.text, /configuration problem/);
      assert.doesNotMatch(cb.text, /name="request_id"/, "no retry form");
      assert.ok(!fs.existsSync(path.join(env.dataDir, "tenants", "gh-9")));
    } finally {
      await env.close();
    }
  });

  it("`identity unlink` un-invites an account", async () => {
    const env = await startEnv({ signup: null });
    try {
      const client = await newClient(env);
      cli(env, "identity", "link", "--github-id", "6161");
      await getTokens(env, client, { profile: { id: 6161 } });
      assert.match(cli(env, "identity", "unlink", "--github-id", "6161"), /unlinked github 6161 \(was uid "gh-6161"\)[\s\S]*oauth revoke --uid gh-6161/);
      const a = await authorize(env, client);
      const { cb } = await attempt(env, a, "github", { profile: { id: 6161 } });
      assert.equal(cb.status, 403);
      assert.match(cb.text, /not invited/i);
      const r = spawnSync(process.execPath, [CLI, "identity", "unlink", "--github-id", "6161", "--data", env.dataDir], { encoding: "utf-8", env: cliEnv() });
      assert.notEqual(r.status, 0, "unlinking twice reports there is no link");
    } finally {
      await env.close();
    }
  });

  it("a revoked legacy gh- token does not block startup", async () => {
    const env = await startEnv({ seed: legacyToken({ revoked_at: "2026-02-01T00:00:00.000Z" }) });
    await env.close();
  });
});

describe("oauth round 6 — small fixes", () => {
  it("a provider that never answers times out into the retry page; the request stays retryable", async () => {
    const env = await startEnv({ providerTimeoutMs: 100 });
    try {
      const client = await newClient(env);
      const a = await authorize(env, client);
      env.mock.state.ghTokenMode = "hang";
      const t0 = Date.now();
      const { cb } = await attempt(env, a, "github");
      assert.equal(cb.status, 503);
      assert.ok(Date.now() - t0 < 5000, "bounded by the timeout");
      assert.match(cb.text, /temporarily unavailable/i);
      env.mock.state.ghTokenMode = "ok";
      const { cb: ok } = await attempt(env, a, "github");
      assert.equal(ok.status, 302, "the same request can be retried");
      assert.ok(ok.code);
    } finally {
      await env.close();
    }
  });

  it("AR_TRUST_PROXY accepts the usual spellings and refuses unknown values", () => {
    const base = { AR_PUBLIC_URL: "https://recall.example", AR_OAUTH_GITHUB_CLIENT_ID: "i", AR_OAUTH_GITHUB_CLIENT_SECRET: "s" };
    for (const v of ["1", "true", "YES", "on"]) assert.equal(loadOAuthConfig({}, { ...base, AR_TRUST_PROXY: v }).trustProxy, true, v);
    for (const v of ["", "0", "false", "no", "OFF"]) assert.equal(loadOAuthConfig({}, { ...base, AR_TRUST_PROXY: v }).trustProxy, false, v);
    assert.throws(() => loadOAuthConfig({}, { ...base, AR_TRUST_PROXY: "maybe" }), OAuthConfigError);
  });

  it("AR_PUBLIC_URL errors never echo credentials", () => {
    const env = { AR_OAUTH_GITHUB_CLIENT_ID: "i", AR_OAUTH_GITHUB_CLIENT_SECRET: "s" };
    for (const url of ["http://user:hunter2@recall.example", "https://user:hunter2@recall.example/path", "ftp://user:hunter2@x"]) {
      try {
        loadOAuthConfig({}, { ...env, AR_PUBLIC_URL: url });
        assert.fail("should throw");
      } catch (err) {
        assert.ok(err instanceof OAuthConfigError, String(err));
        assert.doesNotMatch(err.message, /hunter2/);
      }
    }
  });

  it("one client address cannot fill the sign-in table for everyone (per-address pending cap)", async () => {
    const env = await startEnv({ maxPendingPerKey: 3 });
    try {
      const client = await newClient(env);
      for (let i = 0; i < 3; i++) assert.equal((await authorize(env, client)).status, 200);
      const capped = await authorize(env, client);
      assert.equal(capped.status, 429);
      assert.ok(capped.res.headers.get("retry-after"));
    } finally {
      await env.close();
    }
  });
});

describe("oauth — privacy policy link", () => {
  const base = { AR_PUBLIC_URL: "https://recall.example", AR_OAUTH_GITHUB_CLIENT_ID: "i", AR_OAUTH_GITHUB_CLIENT_SECRET: "s" };

  it("AR_PRIVACY_URL: https only, no credentials; empty = no link", () => {
    assert.equal(loadOAuthConfig({}, base).privacyUrl, undefined);
    assert.equal(loadOAuthConfig({}, { ...base, AR_PRIVACY_URL: "" }).privacyUrl, undefined);
    assert.equal(loadOAuthConfig({}, { ...base, AR_PRIVACY_URL: "https://github.com/o/r/blob/main/PRIVACY.md" }).privacyUrl.href, "https://github.com/o/r/blob/main/PRIVACY.md");
    for (const bad of ["http://example.com/p", "javascript:alert(1)", "https://u:pw@example.com/p", "not a url"]) {
      assert.throws(() => loadOAuthConfig({}, { ...base, AR_PRIVACY_URL: bad }), OAuthConfigError, bad);
    }
  });

  it("the sign-in page links the policy when configured, and not otherwise", async () => {
    const url = "https://example.org/privacy?a=1&b=<x>";
    const on = await startEnv({ env: { AR_PRIVACY_URL: url } });
    try {
      const a = await authorize(on, await newClient(on));
      assert.equal(a.status, 200);
      assert.match(a.html, /<a href="https:\/\/example\.org\/privacy\?a=1&amp;b=%3Cx%3E" rel="noopener noreferrer" target="_blank">Privacy policy<\/a>/);
    } finally {
      await on.close();
    }
    const off = await startEnv();
    try {
      const a = await authorize(off, await newClient(off));
      assert.doesNotMatch(a.html, /Privacy policy/);
    } finally {
      await off.close();
    }
  });
});

describe("oauth — usage stats: sign-ups", () => {
  const day = () => new Date().toISOString().slice(0, 10);
  const snap = (env) => {
    env.server.flushActivity();
    const f = path.join(env.dataDir, "_server", "stats", `${day()}.json`);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf-8")) : null;
  };

  it("the first sign-in of an account creates its memory space and counts one sign-up; repeats do not", async () => {
    const env = await startEnv();
    try {
      const client = await newClient(env);
      assert.ok(!fs.existsSync(path.join(env.dataDir, "tenants", "gh-5150")));
      await getTokens(env, client, { profile: { id: 5150 } });
      assert.ok(fs.existsSync(path.join(env.dataDir, "tenants", "gh-5150")), "the account's memory space exists after its first sign-in");
      await getTokens(env, client, { profile: { id: 5150 } });
      await getTokens(env, client, { provider: "google", profile: { sub: "1000000000000005150" } });
      const s = snap(env);
      assert.equal(s.signups, 2, "two accounts, three sign-ins");
      const raw = JSON.stringify(s);
      for (const needle of ["gh-5150", "gg-1000000000000005150", "1000000000000005150"]) assert.ok(!raw.includes(needle), needle);
    } finally {
      await env.close();
    }
  });

  it("a refused (not invited) sign-in creates nothing and counts nothing", async () => {
    const env = await startEnv({ signup: "invite" });
    try {
      const a = await authorize(env, await newClient(env));
      const { cb } = await attempt(env, a, "github", { profile: { id: 5151 } });
      assert.equal(cb.status, 403);
      assert.ok(!fs.existsSync(path.join(env.dataDir, "tenants", "gh-5151")));
      assert.equal(snap(env)?.signups ?? 0, 0);
    } finally {
      await env.close();
    }
  });
});
