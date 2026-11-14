/**
 * hosted-review.test.mjs — the self-service review page: a hosted user approves or
 * rejects THEIR OWN staged corrections in the browser.
 *
 * Why it exists: since the owner gate (#51) an agent can only stage a correction, and
 * only the operator CLI could approve it. That does not scale with open sign-up and it
 * makes the operator read strangers' memory. The page lets the owner do it, and only
 * the owner: identity is proven by a fresh GitHub/Google sign-in in a browser session,
 * never by an MCP token (an agent holds those).
 *
 * Part 1 spawns the REAL `agent-recall-server` binary. A `node --import` preload
 * (lib/provider-mock-preload.mjs) sends the binary's provider calls to the in-process
 * mocks from lib/mock-providers.mjs; the test plays the browser (cookie jar, form posts).
 * Part 2 runs the real server code in-process where a clock or config must be controlled.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
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

const root = fs.mkdtempSync(path.join(tmpdir(), "ar-review-"));
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
const textOf = (res) => (res.content ?? []).map((c) => c.text ?? "").join("\n");
const tokenFrom = (out) => out.match(/\b(ar_[A-Za-z0-9_-]{43})\b/)[1];

function cleanEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    !k.startsWith("CLAUDE_CODE_") && k !== "CLAUDECODE" && !k.startsWith("AGENT_RECALL_") && k !== "AR_HOST" && !k.startsWith("AR_OAUTH_") && k !== "AR_PUBLIC_URL"));
  return { ...env, HOME: fakeHome, USERPROFILE: fakeHome, ...extra };
}

function cliIn(dataDir, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--data", dataDir], { env: cleanEnv(), encoding: "utf-8" });
  assert.equal(r.status, 0, `cli ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/** Spawn the real binary and wait for its "listening on" line. */
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

/**
 * A browser: a cookie jar that honours Path and Max-Age=0, form posts, and the
 * Sec-Fetch-Site header real browsers add (same-origin for our own forms).
 */
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

  async go(target, { method = "GET", body, headers = {}, site = "same-origin", cookie } = {}) {
    const url = new URL(target, this.base);
    const h = { connection: "close", ...(site ? { "sec-fetch-site": site } : {}), ...headers };
    const c = cookie ?? this.cookieFor(url.pathname);
    if (c) h.cookie = c;
    if (body !== undefined) h["content-type"] = "application/x-www-form-urlencoded";
    const res = await fetch(url, { method, redirect: "manual", headers: h, body: body === undefined ? undefined : form(body) });
    this.keep(res);
    const text = await res.text();
    return { status: res.status, text, headers: res.headers, location: res.headers.get("location") };
  }

  post(target, body, opts = {}) { return this.go(target, { ...opts, method: "POST", body }); }
}

const csrfOf = (html) => /name="csrf" value="([^"]+)"/.exec(html)?.[1];
/** [{id, project}] of every proposal the page offers to approve. */
function proposalsOn(html) {
  const out = [];
  const re = /<form method="post" action="\/review\/approve">([\s\S]*?)<\/form>/g;
  for (let m; (m = re.exec(html));) {
    out.push({ id: /name="id" value="([^"]+)"/.exec(m[1])?.[1], project: /name="project" value="([^"]+)"/.exec(m[1])?.[1] });
  }
  return out;
}
/** A decided post redirects to /review; the outcome is shown once, on the next GET (data-notice). */
async function decided(b, r) {
  assert.equal(r.status, 303, r.text);
  assert.equal(r.location, "/review");
  return /data-notice="([a-z_]+)"/.exec((await b.go("/review")).text)?.[1] ?? null;
}

/** Decode the HTML entities esc() produces (for matching ids shown on the page against ids on disk). */
const unesc = (s) => s.replace(/&#39;/g, "'").replace(/&#96;/g, "`").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The browser signs in to /review with `provider` as `profile`; returns the review page after the redirect. */
async function signIn(b, mock, provider, profile) {
  const page = await b.go("/review");
  assert.equal(page.status, 200, page.text);
  const s = await b.post("/review/start", { provider });
  assert.equal(s.status, 302, `start: ${s.text}`);
  const up = new URL(s.location);
  const code = mock.issue(provider, { profile, challenge: up.searchParams.get("code_challenge"), nonce: up.searchParams.get("nonce") });
  const cb = await b.go(`/authorize/callback/${provider}?${form({ code, state: up.searchParams.get("state") })}`, { site: "cross-site" });
  assert.equal(cb.status, 302, `callback: ${cb.text}`);
  assert.equal(new URL(cb.location, b.base).pathname, "/review");
  const list = await b.go(cb.location);
  assert.equal(list.status, 200, list.text);
  assert.ok(csrfOf(list.text), "a signed-in page carries a CSRF token");
  return list;
}

async function mcp(base, token) {
  const c = new Client({ name: "agent", version: "0.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, Connection: "close" } },
  }));
  return c;
}

const propose = (client, rule, extra = {}) =>
  client.callTool({ name: "check", arguments: {
    goal: "record what the owner said",
    human_correction: { rule, why: "The owner said so in chat on the last deploy.", applies_when: ["git", "deploy"], ...extra },
  } });
const sessionStart = async (client) => textOf(await client.callTool({ name: "session_start", arguments: {} }));

/** The full MCP OAuth flow for `profile` → an aro_ access token (what an agent holds). */
async function mcpOAuthToken(base, mock, profile) {
  const CB = "http://127.0.0.1:53682/callback";
  const reg = await (await fetch(base + "/register", { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify({ client_name: "Agent", redirect_uris: [CB], token_endpoint_auth_method: "none" }) })).json();
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

const pendingDir = (dataDir, uid, project = "main") => path.join(dataDir, "tenants", uid, "projects", project, "corrections", "_pending");
const stagedIds = (dataDir, uid) => !fs.existsSync(pendingDir(dataDir, uid)) ? [] : fs.readdirSync(pendingDir(dataDir, uid))
  .filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(pendingDir(dataDir, uid), f), "utf-8")).id);

const ALICE = { id: 101 }; // GitHub 101, linked by the operator to the existing tenant "alice"
const BOB = { id: 202 }; // GitHub 202, open sign-up → tenant gh-202

// ---- part 1: the real binary -------------------------------------------------

describe("review page — real agent-recall-server binary", () => {
  // One signed-in owner browser for most tests: sign-ins are rate limited per IP (10 per 10 min).
  let dataDir, mock, srv, tokenAlice, aroAlice, owner, ownerCsrf;

  before(async () => {
    dataDir = path.join(root, "data-bin");
    cliIn(dataDir, "identity", "link", "--github-id", String(ALICE.id), "--uid", "alice");
    tokenAlice = tokenFrom(cliIn(dataDir, "token", "create", "--uid", "alice"));
    mock = await startMock();
    srv = await spawnServer((base) => {
      mock.state.base = base;
      return {
        AR_SERVER_DATA: dataDir, AR_PUBLIC_URL: base, AR_OAUTH_SIGNUP: "open", AR_TEST_PROVIDER_MOCK: mock.url,
        AR_OAUTH_GITHUB_CLIENT_ID: GH.id, AR_OAUTH_GITHUB_CLIENT_SECRET: GH.secret,
        AR_OAUTH_GOOGLE_CLIENT_ID: GG.id, AR_OAUTH_GOOGLE_CLIENT_SECRET: GG.secret,
      };
    }, ["--import", PRELOAD]);
    aroAlice = await mcpOAuthToken(srv.base, mock, ALICE);
    owner = new Browser(srv.base);
    ownerCsrf = csrfOf((await signIn(owner, mock, "github", ALICE)).text);
  });

  after(async () => {
    await srv?.stop();
    await mock?.close();
  });

  it("signed out, /review offers only the provider buttons, with strict page headers", async () => {
    const b = new Browser(srv.base);
    const r = await b.go("/review");
    assert.equal(r.status, 200);
    assert.match(r.text, /Continue with GitHub/);
    assert.match(r.text, /Continue with Google/);
    assert.match(r.text, /<form method="post" action="\/review\/start">/);
    assert.equal(csrfOf(r.text), undefined, "no session, no CSRF token, no proposals");
    const csp = r.headers.get("content-security-policy");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /form-action 'self' https:\/\/github\.com https:\/\/accounts\.google\.com/);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  });

  it("the owner sees an agent's proposal, escaped, and approving it makes it a HARD RULE", async () => {
    const agent = await mcp(srv.base, tokenAlice);
    const rule = `Never paste <script>alert("x")</script> & 'tokens' into deploy logs without asking the owner.`;
    const staged = textOf(await propose(agent, rule));
    assert.match(staged, /"status":\s*"staged"/);
    assert.ok(staged.includes(`${srv.base}/review`), "the agent is told where the owner approves it");
    assert.ok((await sessionStart(agent)).includes(`${srv.base}/review`), "and so is the next session_start");

    const b = owner;
    const page = await b.go("/review");
    assert.ok(!page.text.includes("<script>"), "proposal text is never live markup");
    assert.ok(page.text.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;tokens&#39;"), "it is shown, escaped, in full");
    assert.match(page.text, /The owner said so in chat on the last deploy\./, "the why is shown");
    assert.match(page.text, /git/);
    const csp = page.headers.get("content-security-policy");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /form-action 'self';/, "signed-in forms may only post to this server");
    assert.equal(page.headers.get("cache-control"), "no-store");
    const session = b.jar.get("ar_review");
    assert.ok(session, "the session cookie");
    assert.match(session.raw, /HttpOnly/i);
    assert.match(session.raw, /SameSite=Lax/i);
    assert.match(session.raw, /Path=\/review/);

    const [p] = proposalsOn(page.text);
    assert.equal(p.project, "main");
    assert.deepEqual([unesc(p.id)], stagedIds(dataDir, "alice"), "the page offers exactly the staged row");
    const r = await b.post("/review/approve", { id: unesc(p.id), project: "main", csrf: csrfOf(page.text) });
    assert.equal(await decided(b, r), "approved");
    assert.equal((await b.go("/review")).text.includes("data-notice"), false, "the outcome is shown once");
    assert.doesNotMatch((await b.go("/review?done=approved")).text, /data-notice|Approved\./, "a link cannot fake an outcome");

    const start = await sessionStart(agent);
    assert.match(start, /HARD RULES/);
    assert.ok(start.includes("into deploy logs"), "active from the next session_start");
    assert.deepEqual(stagedIds(dataDir, "alice"), []);
    await agent.close();
  });

  it("an MCP token (ar_ or aro_) can neither see nor approve, even with a valid CSRF token", async () => {
    const agent = await mcp(srv.base, tokenAlice);
    await propose(agent, "Never rotate the signing keys without asking the owner.");
    const [id] = stagedIds(dataDir, "alice");
    const b = owner;
    const csrf = ownerCsrf;

    for (const token of [tokenAlice, aroAlice]) {
      const auth = { authorization: `Bearer ${token}` };
      const view = await b.go("/review", { headers: auth, cookie: "" });
      assert.equal(view.status, 403, "a bearer token is refused outright");
      assert.ok(!view.text.includes("signing keys"));
      const bare = await b.post("/review/approve", { id, project: "main", csrf }, { headers: auth, cookie: "" });
      assert.equal(bare.status, 403, bare.text);
      const withSession = await b.post("/review/approve", { id, project: "main", csrf }, { headers: auth });
      assert.equal(withSession.status, 403, "not even next to a valid session cookie");
    }
    const none = await b.post("/review/approve", { id, project: "main", csrf }, { cookie: "" });
    assert.equal(none.status, 401, "no session, no approval");
    assert.deepEqual(stagedIds(dataDir, "alice"), [id], "still waiting");
    assert.ok(!(await sessionStart(agent)).includes("signing keys"));

    const tool = textOf(await agent.callTool({ name: "check", arguments: { goal: "g", human_correction: { pending_id: id, resolution: "promote", rule: "Never rotate the signing keys without asking the owner.", why: "x y z owner said", applies_when: ["keys"] } } }));
    assert.doesNotMatch(tool, /"status":\s*"promoted"/, "and the MCP path stays gated");
    assert.ok(!(await sessionStart(agent)).includes("signing keys"));
    // The re-submission (different why) is its own staged row; the owner clears both.
    for (const left of stagedIds(dataDir, "alice")) {
      assert.equal(await decided(b, await b.post("/review/reject", { id: left, project: "main", csrf })), "rejected");
    }
    assert.deepEqual(stagedIds(dataDir, "alice"), []);
    await agent.close();
  });

  it("user B never sees user A's proposals and cannot approve or reject them", async () => {
    const agent = await mcp(srv.base, tokenAlice);
    await propose(agent, "Never truncate the audit table without asking the owner.");
    const [id] = stagedIds(dataDir, "alice");
    // B has a "main" project of his own with a staged proposal, so only tenant isolation can refuse him.
    const bobAgent = await mcp(srv.base, await mcpOAuthToken(srv.base, mock, BOB));
    await propose(bobAgent, "Never rename the bucket without asking the owner.");
    await bobAgent.callTool({ name: "check", arguments: { goal: "g", human_correction: "never reindex the search cluster without asking me" } });
    const bob = new Browser(srv.base);
    const page = await signIn(bob, mock, "github", BOB);
    assert.ok(!page.text.includes("audit table"), "B's page shows nothing of A's");
    assert.ok(page.text.includes("rename the bucket"), "only B's own");
    const offered = proposalsOn(page.text).map((p) => unesc(p.id));
    assert.equal(offered.length, 1);
    const bobsId = offered[0];
    assert.ok(stagedIds(dataDir, "gh-202").includes(bobsId));
    assert.match(page.text, /1 other capture cannot be approved/, "B's partial capture is counted, not offered");
    const csrf = csrfOf(page.text);
    for (const action of ["approve", "reject"]) {
      assert.equal(await decided(bob, await bob.post(`/review/${action}`, { id, project: "main", csrf })), "gone", `${action}: A's id does not exist for B`);
    }
    assert.deepEqual(stagedIds(dataDir, "alice"), [id], "A's row is untouched");
    assert.equal(await decided(bob, await bob.post("/review/reject", { id: bobsId, project: "main", csrf })), "rejected");
    await bobAgent.close();
    assert.ok(!(await sessionStart(agent)).includes("audit table"));
    assert.ok(!fs.existsSync(path.join(dataDir, "tenants", "gh-202", "projects", "main", "corrections")) ||
      fs.readdirSync(path.join(dataDir, "tenants", "gh-202", "projects", "main", "corrections")).every((f) => f === "_pending"), "nothing landed in B's ledger");

    const mine = await owner.go("/review");
    assert.equal(proposalsOn(mine.text).length, 1);
    await owner.post("/review/reject", { id, project: "main", csrf: ownerCsrf });
    await agent.close();
  });

  it("a tampered id or digest is refused and activates nothing", async () => {
    const agent = await mcp(srv.base, tokenAlice);
    await propose(agent, "Never disable the firewall without asking the owner.");
    const [id] = stagedIds(dataDir, "alice");
    const b = owner;
    const csrf = ownerCsrf;
    const digest = id.slice(-32);
    const flipped = id.slice(0, -1) + (id.endsWith("0") ? "1" : "0");
    for (const bad of [flipped, id.slice(0, -32) + "0".repeat(32), id.slice(0, -33), `${id}-${digest}`]) {
      assert.equal(await decided(b, await b.post("/review/approve", { id: bad, project: "main", csrf })), "gone", `refused: ${bad}`);
    }
    for (const project of ["../main", "nope", ""]) {
      assert.equal((await b.post("/review/approve", { id, project, csrf })).status, 400, `project "${project}" refused`);
    }

    // The row's text is changed on disk after staging: its digest no longer names it.
    const file = fs.readdirSync(pendingDir(dataDir, "alice")).find((f) => f.endsWith(".json"));
    const full = path.join(pendingDir(dataDir, "alice"), file);
    const row = JSON.parse(fs.readFileSync(full, "utf-8"));
    row.context = row.context.replace("disable the firewall", "enable the firewall");
    fs.writeFileSync(full, JSON.stringify(row));
    const page = await b.go("/review");
    assert.deepEqual(proposalsOn(page.text), [], "an altered row is not offered for approval");
    assert.equal(await decided(b, await b.post("/review/approve", { id, project: "main", csrf })), "gone");
    const start = await sessionStart(agent);
    assert.ok(!start.includes("firewall"), "nothing was activated");
    fs.rmSync(full);
    await agent.close();
  });

  it("approve and reject need this session's CSRF token and a same-origin request", async () => {
    const agent = await mcp(srv.base, tokenAlice);
    await propose(agent, "Never drop the replica without asking the owner.");
    const [id] = stagedIds(dataDir, "alice");
    const a = owner;
    const csrfA = ownerCsrf;
    const other = new Browser(srv.base);
    const csrfOther = csrfOf((await signIn(other, mock, "github", ALICE)).text);
    assert.notEqual(csrfA, csrfOther, "a token per session");

    for (const action of ["approve", "reject"]) {
      assert.equal((await a.post(`/review/${action}`, { id, project: "main" })).status, 403, `${action}: missing CSRF`);
      assert.equal((await a.post(`/review/${action}`, { id, project: "main", csrf: "" })).status, 403, `${action}: empty CSRF`);
      assert.equal((await a.post(`/review/${action}`, { id, project: "main", csrf: csrfA.slice(0, -2) + "xx" })).status, 403, `${action}: wrong CSRF`);
      assert.equal((await a.post(`/review/${action}`, { id, project: "main", csrf: csrfOther })).status, 403, `${action}: another session's CSRF`);
      assert.equal((await a.post(`/review/${action}`, { id, project: "main", csrf: csrfA }, { site: "cross-site" })).status, 403, `${action}: cross-site`);
      assert.equal((await a.post(`/review/${action}`, { id, project: "main", csrf: csrfA }, { site: "same-site" })).status, 403, `${action}: same-site is not same-origin`);
      assert.equal((await a.post(`/review/${action}`, { id, project: "main", csrf: csrfA }, { site: null, headers: { origin: "https://evil.example" } })).status, 403, `${action}: a foreign Origin, even without Sec-Fetch-Site`);
    }
    assert.equal((await a.post("/review/logout", { csrf: "nope" })).status, 403, "logout needs it too");
    assert.deepEqual(stagedIds(dataDir, "alice"), [id], "still waiting");
    assert.ok(!(await sessionStart(agent)).includes("drop the replica"));

    const r = await a.post("/review/reject", { id, project: "main", csrf: csrfA }, { headers: { origin: srv.base } });
    assert.equal(await decided(a, r), "rejected", "our own Origin is fine");
    assert.deepEqual(stagedIds(dataDir, "alice"), []);
    assert.ok(!(await sessionStart(agent)).includes("drop the replica"), "a rejected proposal never activates");
    await agent.close();
  });

  it("the sign-in is bound to the browser that started it and is single use", async () => {
    const b = new Browser(srv.base);
    await b.go("/review");
    const s = await b.post("/review/start", { provider: "github" });
    const up = new URL(s.location);
    const q = () => form({ code: mock.issue("github", { profile: ALICE, challenge: up.searchParams.get("code_challenge"), nonce: up.searchParams.get("nonce") }), state: up.searchParams.get("state") });

    const stranger = new Browser(srv.base);
    const hijack = await stranger.go(`/authorize/callback/github?${q()}`, { site: "cross-site" });
    assert.equal(hijack.status, 400, "another browser (no binding cookie) cannot finish it");
    assert.equal(stranger.jar.get("ar_review"), undefined);
    const replay = await b.go(`/authorize/callback/github?${q()}`, { site: "cross-site" });
    assert.equal(replay.status, 400, "the state was spent");
    assert.equal(b.jar.get("ar_review"), undefined);

    assert.equal((await b.post("/review/start", { provider: "gitlab" })).status, 400, "unknown provider");
    assert.equal((await b.post("/review/start", { provider: "github" }, { site: "cross-site" })).status, 403, "a cross-site form cannot start one");
  });

  it("signing out ends the session at once", async () => {
    const b = new Browser(srv.base);
    const page = await signIn(b, mock, "github", ALICE);
    const cookie = b.cookieFor("/review");
    const r = await b.post("/review/logout", { csrf: csrfOf(page.text) });
    assert.equal(r.status, 303);
    assert.equal(b.jar.get("ar_review"), undefined, "the cookie is cleared");
    const after = await b.go("/review", { cookie });
    assert.equal(csrfOf(after.text), undefined, "the old cookie is dead server-side");
    assert.equal((await b.post("/review/approve", { id: "x", project: "main", csrf: csrfOf(page.text) }, { cookie })).status, 401);
  });

  it("the operator CLI keeps working, and lists applies_when as JSON", async () => {
    const agent = await mcp(srv.base, tokenAlice);
    await propose(agent, "Never resize the volume without asking the owner.", { applies_when: ["disk, volume", "ops"] });
    const out = cliIn(dataDir, "corrections", "list", "--uid", "alice");
    assert.ok(out.includes('when: ["disk, volume","ops"]'), `one entry with a comma stays one entry:\n${out}`);
    const id = out.split("\n").find((l) => l.includes("uid=alice")).split("  ")[0];
    assert.match(cliIn(dataDir, "corrections", "approve", id, "--uid", "alice"), /approved for uid "alice"/);
    assert.ok((await sessionStart(agent)).includes("resize the volume"));
    await agent.close();
  });
});

describe("review page — off unless OAuth is configured", () => {
  it("a server without OAuth has no /review routes", async () => {
    const dataDir = path.join(root, "data-nooauth");
    const srv = await spawnServer({ AR_SERVER_DATA: dataDir });
    try {
      for (const [method, p] of [["GET", "/review"], ["POST", "/review/start"], ["POST", "/review/approve"]]) {
        const r = await fetch(srv.base + p, { method, headers: { connection: "close" } });
        assert.equal(r.status, 404, `${method} ${p}`);
      }
    } finally {
      await srv.stop();
    }
  });
});

// ---- part 2: in-process, where a clock or config is needed ------------------

describe("review page — sessions and invites (in-process)", () => {
  let startHttpServer, loadOAuthConfig;
  before(async () => {
    ({ startHttpServer } = await load("serve.js"));
    ({ loadOAuthConfig } = await load("oauth-config.js"));
  });

  async function startEnv({ signup = "open", loginLimits = { perIp: 1000, global: 10000, windowMs: 600000 }, fetchImpl } = {}) {
    const dataDir = fs.mkdtempSync(path.join(root, "data-ip-"));
    const mock = await startMock();
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    mock.state.base = base;
    const clock = { offset: 0 };
    const config = loadOAuthConfig({ publicUrl: base }, { AR_OAUTH_SIGNUP: signup, AR_OAUTH_GITHUB_CLIENT_ID: GH.id, AR_OAUTH_GITHUB_CLIENT_SECRET: GH.secret });
    const logs = [];
    const server = await startHttpServer({
      dataDir, port, host: "127.0.0.1", full: false, oauth: config, log: (l) => logs.push(l),
      oauthTesting: { now: () => Date.now() + clock.offset, providerUrls: mock.urls, loginLimits, fetchImpl },
    });
    return {
      base, dataDir, mock, clock, logs,
      async close() { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); await mock.close(); },
    };
  }

  it("invite-only: an account the operator has not linked gets no session", async () => {
    const env = await startEnv({ signup: "invite" });
    try {
      const b = new Browser(env.base);
      await b.go("/review");
      const s = await b.post("/review/start", { provider: "github" });
      const up = new URL(s.location);
      const code = env.mock.issue("github", { profile: { id: 555 }, challenge: up.searchParams.get("code_challenge"), nonce: up.searchParams.get("nonce") });
      const cb = await b.go(`/authorize/callback/github?${form({ code, state: up.searchParams.get("state") })}`, { site: "cross-site" });
      assert.equal(cb.status, 403);
      assert.match(cb.text, /not invited/);
      assert.equal(b.jar.get("ar_review"), undefined);
      assert.ok(!fs.existsSync(path.join(env.dataDir, "tenants", "gh-555")), "no tenant is created");
    } finally {
      await env.close();
    }
  });

  it("a first website sign-in counts one sign-up (usage stats); signing in again does not", async () => {
    const env = await startEnv();
    try {
      await signIn(new Browser(env.base), env.mock, "github", { id: 4321 });
      assert.ok(fs.existsSync(path.join(env.dataDir, "tenants", "gh-4321")));
      await signIn(new Browser(env.base), env.mock, "github", { id: 4321 });
    } finally {
      await env.close(); // closing the server writes today's counts
    }
    const day = new Date().toISOString().slice(0, 10);
    const s = JSON.parse(fs.readFileSync(path.join(env.dataDir, "_server", "stats", `${day}.json`), "utf-8"));
    assert.equal(s.signups, 1);
    assert.ok(!JSON.stringify(s).includes("4321"));
  });

  it("a session expires after 30 minutes, and ends when the operator unlinks the account", async () => {
    const env = await startEnv({ signup: "invite" });
    try {
      cliIn(env.dataDir, "identity", "link", "--github-id", "777", "--uid", "carol");
      const b = new Browser(env.base);
      const page = await signIn(b, env.mock, "github", { id: 777 });
      assert.match(page.text, /carol/, "the page names the memory it is for");
      env.clock.offset = 31 * 60 * 1000;
      assert.equal(csrfOf((await b.go("/review")).text), undefined, "expired");
      env.clock.offset = 0;

      const again = await signIn(b, env.mock, "github", { id: 777 });
      cliIn(env.dataDir, "identity", "unlink", "--github-id", "777");
      const r = await b.post("/review/approve", { id: "x", project: "main", csrf: csrfOf(again.text) });
      assert.equal(r.status, 401, "an unlinked account's session is over");
    } finally {
      await env.close();
    }
  });

  it("sign-in starts are limited per IP, in a bucket of their own", async () => {
    const env = await startEnv({ loginLimits: { perIp: 2, global: 10000, windowMs: 600000 } });
    try {
      const b = new Browser(env.base);
      assert.equal((await b.post("/review/start", { provider: "github" })).status, 302);
      assert.equal((await b.post("/review/start", { provider: "github" })).status, 302);
      const third = await b.post("/review/start", { provider: "github" });
      assert.equal(third.status, 429);
      assert.ok(Number(third.headers.get("retry-after")) > 0);
      const mcpStart = await fetch(env.base + "/authorize/start", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", connection: "close" }, body: "request_id=x&provider=github" });
      assert.notEqual(mcpStart.status, 429, "MCP sign-ins keep their own budget");
    } finally {
      await env.close();
    }
  });

  it("approve/reject posts are capped per session", async () => {
    const env = await startEnv();
    try {
      const b = new Browser(env.base);
      const csrf = csrfOf((await signIn(b, env.mock, "github", { id: 4242 })).text);
      for (let i = 0; i < 120; i++) assert.equal((await b.post("/review/reject", { id: `x${i}`, project: "main", csrf })).status, 400);
      const over = await b.post("/review/reject", { id: "x", project: "main", csrf });
      assert.equal(over.status, 429);
      assert.equal(over.headers.get("retry-after"), "60");
    } finally {
      await env.close();
    }
  });

  it("an unexpected provider error is a page, the state is spent and the browser binding cleared", async () => {
    let explode = false;
    const fetchImpl = (url, init) => explode
      ? Promise.resolve({ get status() { throw new TypeError("weird response"); }, text: async () => "{}" })
      : fetch(url, init);
    const env = await startEnv({ fetchImpl });
    try {
      const b = new Browser(env.base);
      await b.go("/review");
      const s = await b.post("/review/start", { provider: "github" });
      const up = new URL(s.location);
      const q = form({ code: env.mock.issue("github", { profile: { id: 31 }, challenge: up.searchParams.get("code_challenge"), nonce: up.searchParams.get("nonce") }), state: up.searchParams.get("state") });
      assert.ok([...b.jar.keys()].some((k) => k.startsWith("ar_review_login_")));
      explode = true;
      const cb = await b.go(`/authorize/callback/github?${q}`, { site: "cross-site" });
      assert.equal(cb.status, 500);
      assert.match(cb.headers.get("content-type"), /text\/html/);
      assert.ok(!cb.text.includes("weird response"), "the error text is never shown");
      assert.ok(![...b.jar.keys()].some((k) => k.startsWith("ar_review_login_")), "the binding cookie is cleared");
      explode = false;
      assert.equal((await b.go(`/authorize/callback/github?${q}`, { site: "cross-site" })).status, 400, "the state was spent");
      assert.ok(env.logs.some((l) => /\[review\] github: unexpected TypeError/.test(l)));
    } finally {
      await env.close();
    }
  });

  it("a read failure says so instead of \"nothing is waiting\", and decides nothing", async () => {
    const env = await startEnv();
    try {
      const b = new Browser(env.base);
      const csrf = csrfOf((await signIn(b, env.mock, "github", { id: 5151 })).text);
      const corr = path.join(env.dataDir, "tenants", "gh-5151", "projects", "main", "corrections");
      fs.mkdirSync(corr, { recursive: true });
      fs.writeFileSync(path.join(corr, "_pending"), "a file where the staging directory should be");
      const r = await b.go("/review");
      assert.equal(r.status, 503);
      assert.doesNotMatch(r.text, /Nothing is waiting/);
      assert.match(r.text, /could not be read/);
      assert.equal(await decided(b, await b.post("/review/approve", { id: "2026-11-11--x-" + "0".repeat(32), project: "main", csrf })), null,
        "the outcome page itself cannot be read either");
      assert.ok(env.logs.some((l) => /\[review\] approve uid=gh-5151 project=main result=unavailable/.test(l)));
      fs.rmSync(path.join(corr, "_pending"));
      const back = await b.go("/review");
      assert.equal(back.status, 200);
      assert.match(back.text, /data-notice="unavailable"/, "the outcome was kept until it could be shown");
      assert.doesNotMatch((await b.go("/review")).text, /data-notice/, "and is shown once");
    } finally {
      await env.close();
    }
  });

  it("signing in and approving is logged without proposal text", async () => {
    const env = await startEnv();
    try {
      const b = new Browser(env.base);
      await signIn(b, env.mock, "github", { id: 888 });
      assert.ok(env.logs.some((l) => /\[review\] signed in github=888 uid=gh-888/.test(l)), env.logs.join("\n"));
    } finally {
      await env.close();
    }
  });
});

describe("review page — rendering (units)", () => {
  it("escapes every proposal field and never emits a script or event handler", async () => {
    const { reviewListPage } = await load("review-pages.js");
    const evil = `"><img src=x onerror=alert(1)>‮<script>x</script>'\``;
    const html = reviewListPage({
      account: "GitHub 1", uid: "alice", csrf: "tok", notice: undefined, incomplete: 2, hidden: 0,
      items: [{ id: evil, project: "main", severity: "p0", seenCount: 1, firstSeen: evil, lastSeen: evil, rule: evil, why: evil, appliesWhen: [evil, "git"] }],
    });
    assert.ok(!html.includes("<img") && !html.includes("<script"), "no live markup from proposal fields");
    assert.ok(!html.includes("‮"), "no bidi override reaches the page");
    assert.ok(html.includes(`name="id" value="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;`), "attribute values cannot be broken out of");
    assert.ok(html.includes("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"), "the text is still shown, escaped");
    assert.match(html, /2 other captures/);
  });

  it("says how many ready proposals are not shown", async () => {
    const { reviewListPage } = await load("review-pages.js");
    const html = reviewListPage({ account: "GitHub 1", uid: "alice", csrf: "tok", incomplete: 0, hidden: 3, items: [] });
    assert.match(html, /3 more waiting/);
  });

  it("an unknown notice is ignored rather than echoed", async () => {
    const { reviewListPage } = await load("review-pages.js");
    const html = reviewListPage({ account: "GitHub 1", uid: "alice", csrf: "tok", notice: "<b>pwn</b>", incomplete: 0, hidden: 0, items: [] });
    assert.ok(!html.includes("pwn"));
    assert.match(html, /Nothing is waiting for your review/);
  });
});
