// Tests for smoke.mjs: a fake server (node:http) that answers like the real one,
// and broken variants of it, so each check is shown to fail when it should.
//   node --test deploy/hosted/smoke.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { cspHash, runSmoke } from "./smoke.mjs";

const run = promisify(execFile);
const rawHash = (s) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;
const SMOKE = fileURLToPath(new URL("./smoke.mjs", import.meta.url));
const VERSION = "3.5.3";
const PLATES = ["human", "m0", "wrong", "m2", "m3"];
const CSS = "body{margin:0}\n";
const JS = "console.log(1);\n";

/** A fake server. `port` is read lazily: the metadata documents name their own origin. */
function fake(over = {}) {
  const o = { css: CSS, js: JS, eol: "\n", ...over };
  let origin = "";
  const csp = () =>
    `default-src 'none'; style-src ${o.cssHash ?? cspHash(o.css)}; script-src ${o.jsHash ?? cspHash(o.js)}; frame-ancestors 'none'`;
  const text = { "content-type": "text/plain; charset=utf-8" };
  const handler = (req, res) => {
    const send = (status, headers, body = "") => { res.writeHead(status, headers); res.end(body); };
    const path = req.url;
    if (o.status?.[path]) return send(o.status[path], {});
    if (req.method === "POST" && path === "/mcp") {
      if (o.mcpStatus) return send(o.mcpStatus, {});
      const challenge = "challenge" in o ? o.challenge : `Bearer realm="agent-recall", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`;
      return send(401, challenge === null ? {} : { "www-authenticate": challenge });
    }
    switch (path) {
      case "/healthz":
        return send(200, { "content-type": "application/json" }, JSON.stringify({ ok: o.ok ?? true, version: o.version ?? VERSION }));
      case "/": {
        const html = `<!doctype html><html><head><style>${o.css.replace(/\n/g, o.eol)}</style></head><body>x<script>${o.js.replace(/\n/g, o.eol)}</script>${o.extra ?? ""}</body></html>`;
        const h = { "content-type": "text/html; charset=utf-8", "content-security-policy": o.csp ?? csp(), "x-content-type-options": "nosniff" };
        if (!o.noHsts) h["strict-transport-security"] = "max-age=31536000; includeSubDomains";
        for (const k of o.drop ?? []) delete h[k];
        return send(200, h, html);
      }
      case "/local": return send(200, { "content-type": "text/html; charset=utf-8" }, "<html></html>");
      case "/connect": return send(200, { "content-type": "text/html; charset=utf-8" }, "<html>sign in</html>");
      case "/connect.md": case "/local.md": case "/llms.txt": return send(200, o.mdType ? { "content-type": o.mdType } : text, "# doc");
      case "/favicon.svg": return send(200, { "content-type": "image/svg+xml" }, "<svg/>");
      case "/.well-known/oauth-protected-resource":
        return send(200, { "content-type": "application/json" }, JSON.stringify({ resource: o.resource ?? `${origin}/mcp`, authorization_servers: [`${origin}/`] }));
      case "/.well-known/oauth-authorization-server":
        return send(200, { "content-type": "application/json" }, JSON.stringify({ issuer: o.issuer ?? `${origin}/` }));
    }
    const plate = /^\/film\/(.+)\.jpg$/.exec(path);
    if (plate && PLATES.includes(plate[1])) return send(200, { "content-type": "image/jpeg" }, "\xff\xd8\xff");
    return send(404, {});
  };
  return serve(handler, (b) => { origin = b; });
}

function serve(handler, onBase) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    onBase?.(base);
    resolve({ base, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) });
  }));
}

/** An alias like the Caddyfile's: /healthz and /mcp proxied to `target`, every other path 308 to it. */
function aliasOf(target, { proxy = true } = {}) {
  return serve((req, res) => {
    if (proxy && (req.url === "/healthz" || req.url.startsWith("/mcp"))) {
      const up = http.request(target + req.url, { method: req.method }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      return req.pipe(up);
    }
    res.writeHead(308, { location: target + req.url });
    res.end();
  });
}

async function smoke(over, extra = {}) {
  const s = await fake(over);
  try { return await runSmoke({ base: s.base, expectVersion: undefined, ...extra }); } finally { await s.close(); }
}
const failing = (results) => results.filter((r) => !r.ok).map((r) => r.name);
const find = (results, name) => results.find((r) => r.name === name);

test("a good server passes every check", async () => {
  const results = await smoke({});
  assert.deepEqual(failing(results), [], JSON.stringify(failing(results).map((n) => find(results, n))));
  assert.ok(results.length >= 18);
});

test("a CRLF page whose CSP hashes the LF form passes (browsers normalise)", async () => {
  assert.deepEqual(failing(await smoke({ eol: "\r\n" })), []);
});

test("the CRLF hash bug fails: CSP hashes the raw CRLF bytes", async () => {
  const bug = await smoke({ eol: "\r\n", cssHash: rawHash(CSS.replace(/\n/g, "\r\n")) });
  assert.deepEqual(failing(bug), ["CSP hashes match inline style and script"]);
  assert.match(find(bug, "CSP hashes match inline style and script").evidence, /style-src/);
});

test("a wrong script hash fails the CSP check, and says which directive", async () => {
  const r = await smoke({ jsHash: "'sha256-AAAA'" });
  assert.deepEqual(failing(r), ["CSP hashes match inline style and script"]);
  assert.match(find(r, "CSP hashes match inline style and script").evidence, /script-src/);
});

test("a second inline script fails the CSP check", async () => {
  const r = await smoke({ extra: "<script>again()</script>" });
  assert.match(find(r, "CSP hashes match inline style and script").evidence, /2 inline <script>/);
  assert.equal(find(r, "CSP hashes match inline style and script").ok, false);
});

test("an extra source in script-src fails (exactly the hash)", async () => {
  const r = await smoke({ csp: `default-src 'none'; style-src ${cspHash(CSS)}; script-src ${cspHash(JS)} 'unsafe-inline'; frame-ancestors 'none'` });
  assert.deepEqual(failing(r), ["CSP hashes match inline style and script"]);
});

test("missing HSTS, nosniff, or frame-ancestors fails the header check", async () => {
  assert.deepEqual(failing(await smoke({ noHsts: true })), ["security headers on /"]);
  assert.deepEqual(failing(await smoke({ drop: ["x-content-type-options"] })), ["security headers on /"]);
  const noFrame = await smoke({ csp: `default-src 'none'; style-src ${cspHash(CSS)}; script-src ${cspHash(JS)}` });
  assert.deepEqual(failing(noFrame), ["security headers on /", ].filter((n) => failing(noFrame).includes(n)));
  assert.match(find(noFrame, "security headers on /").evidence, /frame-ancestors/);
});

test("healthz: ok false, a wrong version, and a 500 each fail", async () => {
  assert.deepEqual(failing(await smoke({ ok: false })), ["GET /healthz"]);
  const v = await smoke({ version: "3.5.2" }, { expectVersion: VERSION });
  assert.deepEqual(failing(v), ["GET /healthz"]);
  assert.match(find(v, "GET /healthz").evidence, /3\.5\.2.*expected 3\.5\.3/);
  assert.deepEqual(failing(await smoke({ status: { "/healthz": 500 } })), ["GET /healthz"]);
  assert.deepEqual(failing(await smoke({}, { expectVersion: VERSION })), []);
});

test("a 500 on a page, a wrong content-type and a missing plate each fail only that page", async () => {
  assert.deepEqual(failing(await smoke({ status: { "/local": 500 } })), ["GET /local"]);
  assert.deepEqual(failing(await smoke({ mdType: "text/html" })), ["GET /connect.md", "GET /local.md", "GET /llms.txt"]);
  assert.deepEqual(failing(await smoke({ status: { "/film/m3.jpg": 404 } })), ["GET /film/m3.jpg"]);
});

test("/connect answering 5xx fails", async () => {
  assert.deepEqual(failing(await smoke({ status: { "/connect": 503 } })), ["GET /connect (no session)"]);
});

test("POST /mcp: a 200, or a 401 without the OAuth metadata pointer, fails", async () => {
  assert.deepEqual(failing(await smoke({ mcpStatus: 200 })), ["POST /mcp without credentials"]);
  assert.deepEqual(failing(await smoke({ challenge: null })), ["POST /mcp without credentials"]);
  assert.deepEqual(failing(await smoke({ challenge: 'Bearer realm="agent-recall"' })), ["POST /mcp without credentials"]);
});

test("OAuth metadata naming another origin fails", async () => {
  assert.deepEqual(failing(await smoke({ resource: "https://evil.example/mcp" })), ["GET /.well-known/oauth-protected-resource"]);
  assert.deepEqual(failing(await smoke({ issuer: "https://evil.example" })), ["GET /.well-known/oauth-authorization-server"]);
});

test("an unreachable server fails every check with the reason, and does not throw", async () => {
  const s = await fake({});
  await s.close();
  const r = await runSmoke({ base: s.base });
  assert.equal(failing(r).length, r.length);
  assert.match(r[0].evidence, /request failed/);
});

test("alias: proxied /healthz and /mcp, 308 for the rest, passes", async () => {
  const s = await fake({});
  const a = await aliasOf(s.base);
  try {
    const r = await runSmoke({ base: s.base, alias: a.base });
    assert.deepEqual(failing(r), []);
    assert.equal(r.filter((x) => x.name.startsWith("alias ")).length, 4);
  } finally { await a.close(); await s.close(); }
});

test("alias that redirects /mcp instead of proxying it fails", async () => {
  const s = await fake({});
  const a = await aliasOf(s.base, { proxy: false });
  try {
    const r = await runSmoke({ base: s.base, alias: a.base });
    assert.deepEqual(failing(r), ["alias GET /healthz", "alias POST /mcp"]);
  } finally { await a.close(); await s.close(); }
});

test("alias that serves pages itself instead of redirecting fails", async () => {
  const s = await fake({});
  const a = await fake({});
  try {
    const r = await runSmoke({ base: s.base, alias: a.base });
    assert.deepEqual(failing(r), ["alias POST /mcp", "alias GET / redirects to base", "alias GET /connect.md redirects to base"]);
  } finally { await a.close(); await s.close(); }
});

/** Run the CLI without blocking this process's event loop (the fake servers live in it). */
const cli = async (...args) => {
  try {
    const { stdout } = await run(process.execPath, [SMOKE, ...args]);
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.code, stdout: e.stdout };
  }
};

test("CLI: exit 0 with PASS lines when good, exit 1 with FAIL lines when not, exit 2 on bad usage", async () => {
  const good = await fake({});
  const bad = await fake({ noHsts: true });
  try {
    const ok = await cli("--base", good.base, "--expect-version", VERSION);
    assert.equal(ok.code, 0, ok.stdout);
    assert.match(ok.stdout, /^PASS {2}GET \/healthz: ok:true version 3\.5\.3$/m);
    const no = await cli("--base", bad.base);
    assert.equal(no.code, 1);
    assert.match(no.stdout, /^FAIL {2}security headers on \/: Strict-Transport-Security is missing\r?$/m);
    assert.equal((await cli("--base", "not a url")).code, 2);
    assert.equal((await cli("--nope")).code, 2);
  } finally { await good.close(); await bad.close(); }
});
