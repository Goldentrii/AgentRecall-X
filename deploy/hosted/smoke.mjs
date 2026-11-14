#!/usr/bin/env node
// Post-deploy smoke check for a hosted AgentRecall server. Read-only: GETs, plus
// one unauthenticated POST /mcp (which must be refused). No dependencies.
//
//   node deploy/hosted/smoke.mjs [--base https://agentrecallx.com] [--expect-version 3.5.3]
//                                [--alias https://recall.aiakada.com]
//
// Prints one PASS/FAIL line per check with its evidence; exit 1 if any FAIL, 2 on bad usage.
// What the server must answer is defined in packages/mcp-server/src/http (site.ts,
// film.ts, serve.ts, oauth-app.ts) and the alias behaviour in deploy/hosted/Caddyfile.
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE = "https://agentrecallx.com";
const TIMEOUT_MS = 15_000;
// FILM_PLATES in packages/mcp-server/src/http/film.ts
const PLATES = ["human", "m0", "wrong", "m2", "m3"];

const PAGES = [
  ["/", "text/html"],
  ["/local", "text/html"],
  ["/connect.md", "text/plain"],
  ["/local.md", "text/plain"],
  ["/llms.txt", "text/plain"],
  ["/favicon.svg", "image/svg+xml"],
  ...PLATES.map((p) => [`/film/${p}.jpg`, "image/jpeg"]),
];

// ---- transport -------------------------------------------------------------

/** One request; redirects are never followed (a redirect is itself an answer). */
async function request(url, { method = "GET", body, headers } = {}) {
  const res = await fetch(url, { method, body, headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

const unauthenticatedMcp = (origin) =>
  request(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: "{}",
  });

// ---- assertions: throw with the evidence a human needs ----------------------

class Fail extends Error {}
const fail = (msg) => { throw new Fail(msg); };
const expect = (cond, msg) => { if (!cond) fail(msg); };
const trim = (s) => s.replace(/\/+$/, "");
const mediaType = (res) => (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
const json = (res, what) => {
  expect(mediaType(res) === "application/json", `${what}: content-type ${mediaType(res) || "(none)"}, want application/json`);
  try { return JSON.parse(res.text); } catch { return fail(`${what}: body is not JSON`); }
};

/** sha256 CSP source of an inline element body, as a browser computes it (CRLF and CR parse to LF). */
export const cspHash = (content) =>
  `'sha256-${createHash("sha256").update(content.replace(/\r\n?/g, "\n"), "utf8").digest("base64")}'`;

/** Tokens of one CSP directive, or null when the policy has none. */
function directive(csp, name) {
  for (const part of csp.split(";")) {
    const [n, ...tokens] = part.trim().split(/\s+/);
    if (n === name) return tokens;
  }
  return null;
}

/** Bodies of the page's inline elements of one kind (<style>, or <script> without src). */
function inline(html, tag) {
  const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi");
  return [...html.matchAll(re)].filter((m) => !/\ssrc\s*=/i.test(m[1] ?? "")).map((m) => m[2]);
}

// ---- checks: (ctx, ...args) => evidence string, or throw ---------------------

const checks = {
  async healthz({ base, expectVersion }) {
    const res = await request(`${base}/healthz`);
    expect(res.status === 200, `status ${res.status}, want 200`);
    const body = json(res, "healthz");
    expect(body.ok === true, `ok is ${JSON.stringify(body.ok)}, want true`);
    expect(typeof body.version === "string" && body.version, "version missing");
    if (expectVersion) expect(body.version === expectVersion, `version ${body.version}, expected ${expectVersion}`);
    return `ok:true version ${body.version}`;
  },

  async page({ base }, path, type) {
    const res = await request(base + path);
    expect(res.status === 200, `status ${res.status}, want 200`);
    expect(mediaType(res) === type, `content-type ${mediaType(res) || "(none)"}, want ${type}`);
    expect(res.text.length > 0, "empty body");
    return `200 ${type}, ${res.text.length} chars`;
  },

  async connect({ base }) {
    const res = await request(`${base}/connect`);
    expect(res.status === 200 || (res.status >= 300 && res.status < 400), `status ${res.status}, want 200 (sign-in page) or a redirect`);
    return res.status === 200 ? "200 sign-in page" : `${res.status} -> ${res.headers.get("location")}`;
  },

  async csp({ base }) {
    const res = await request(`${base}/`);
    expect(res.status === 200, `status ${res.status}, want 200`);
    const csp = res.headers.get("content-security-policy");
    expect(csp, "no Content-Security-Policy header");
    const evidence = [];
    for (const [tag, dir] of [["style", "style-src"], ["script", "script-src"]]) {
      const bodies = inline(res.text, tag);
      expect(bodies.length === 1, `${bodies.length} inline <${tag}> elements, want exactly 1`);
      const want = cspHash(bodies[0]);
      const have = directive(csp, dir);
      expect(have, `CSP has no ${dir}`);
      expect(have.length === 1 && have[0] === want, `${dir} is [${have.join(" ")}], served <${tag}> hashes to ${want}`);
      evidence.push(`${dir} ${want.slice(1, 15)}...`);
    }
    return `${evidence.join(", ")} match the served bytes`;
  },

  async headers({ base }) {
    const res = await request(`${base}/`);
    const hsts = res.headers.get("strict-transport-security");
    expect(hsts && /max-age=\d+/i.test(hsts), `Strict-Transport-Security is ${hsts ?? "missing"}`);
    const sniff = res.headers.get("x-content-type-options");
    expect(sniff?.toLowerCase() === "nosniff", `X-Content-Type-Options is ${sniff ?? "missing"}`);
    const fa = directive(res.headers.get("content-security-policy") ?? "", "frame-ancestors");
    expect(fa && fa.length === 1 && fa[0] === "'none'", `CSP frame-ancestors is ${fa ? fa.join(" ") : "missing"}, want 'none'`);
    return `HSTS ${hsts}; nosniff; frame-ancestors 'none'`;
  },

  async mcpUnauthorized({ base }) {
    const res = await unauthenticatedMcp(base);
    expect(res.status === 401, `status ${res.status}, want 401`);
    const challenge = res.headers.get("www-authenticate") ?? "";
    const meta = `${base}/.well-known/oauth-protected-resource`;
    expect(
      /^Bearer\b/i.test(challenge) && challenge.includes(`resource_metadata="${meta}`),
      `WWW-Authenticate is ${challenge ? `"${challenge}"` : "missing"}, want resource_metadata="${meta}..."`,
    );
    return `401, ${challenge}`;
  },

  async protectedResource({ base }) {
    const res = await request(`${base}/.well-known/oauth-protected-resource`);
    expect(res.status === 200, `status ${res.status}, want 200`);
    const body = json(res, "protected-resource");
    expect(trim(body.resource ?? "") === `${base}/mcp`, `resource ${body.resource}, want ${base}/mcp`);
    expect(
      Array.isArray(body.authorization_servers) && body.authorization_servers.some((s) => trim(s) === base),
      `authorization_servers ${JSON.stringify(body.authorization_servers)} lacks ${base}`,
    );
    return `resource ${body.resource}`;
  },

  async authorizationServer({ base }) {
    const res = await request(`${base}/.well-known/oauth-authorization-server`);
    expect(res.status === 200, `status ${res.status}, want 200`);
    const body = json(res, "authorization-server");
    expect(trim(body.issuer ?? "") === base, `issuer ${body.issuer}, want ${base}`);
    return `issuer ${body.issuer}`;
  },

  async aliasHealthz({ base, alias }) {
    const [a, b] = await Promise.all([request(`${base}/healthz`), request(`${alias}/healthz`)]);
    expect(a.status === 200 && b.status === 200, `status ${b.status} on alias, ${a.status} on base, want 200 on both`);
    expect(a.text === b.text, "alias answers differently from base");
    return "200, same body as base";
  },

  async aliasMcp({ base, alias }) {
    const [a, b] = await Promise.all([unauthenticatedMcp(base), unauthenticatedMcp(alias)]);
    expect(b.status === 401, `status ${b.status} on alias, want 401 (proxied, not redirected)`);
    expect(b.headers.get("www-authenticate") === a.headers.get("www-authenticate"), "alias WWW-Authenticate differs from base");
    return "401, same challenge as base";
  },

  async aliasRedirect({ base, alias }, path) {
    const res = await request(alias + path);
    expect(res.status === 308, `status ${res.status}, want 308`);
    expect(res.headers.get("location") === base + path, `Location ${res.headers.get("location")}, want ${base + path}`);
    return `308 -> ${base + path}`;
  },
};

/** The ordered check list for these options: [name, run]. */
export function plan({ base, expectVersion, alias }) {
  const ctx = { base, expectVersion, alias };
  const at = (fn, ...args) => () => fn(ctx, ...args);
  const list = [
    ["GET /healthz", at(checks.healthz)],
    ...PAGES.map(([path, type]) => [`GET ${path}`, at(checks.page, path, type)]),
    ["GET /connect (no session)", at(checks.connect)],
    ["CSP hashes match inline style and script", at(checks.csp)],
    ["security headers on /", at(checks.headers)],
    ["POST /mcp without credentials", at(checks.mcpUnauthorized)],
    ["GET /.well-known/oauth-protected-resource", at(checks.protectedResource)],
    ["GET /.well-known/oauth-authorization-server", at(checks.authorizationServer)],
  ];
  if (alias) {
    list.push(
      ["alias GET /healthz", at(checks.aliasHealthz)],
      ["alias POST /mcp", at(checks.aliasMcp)],
      ["alias GET / redirects to base", at(checks.aliasRedirect, "/")],
      ["alias GET /connect.md redirects to base", at(checks.aliasRedirect, "/connect.md")],
    );
  }
  return list;
}

/** Run every check (one failing never stops the rest); resolves to [{name, ok, evidence}]. */
export async function runSmoke(opts) {
  const results = [];
  for (const [name, run] of plan(opts)) {
    try {
      results.push({ name, ok: true, evidence: await run() });
    } catch (err) {
      const evidence = err instanceof Fail ? err.message : `request failed: ${err?.cause?.code ?? err?.message ?? err}`;
      results.push({ name, ok: false, evidence });
    }
  }
  return results;
}

class Usage extends Error {}

function origin(value, flag) {
  try {
    const u = new URL(value);
    if (u.protocol === "https:" || u.protocol === "http:") return trim(u.origin);
  } catch { /* fall through */ }
  throw new Usage(`${flag} must be an http(s) URL, got ${value}`);
}

// Sets process.exitCode instead of calling process.exit(): exiting with a fetch still
// closing its sockets aborts the process on Windows (exit code 0xC0000409).
async function main() {
  try {
    const { values } = parseArgs({
      options: { base: { type: "string", default: DEFAULT_BASE }, "expect-version": { type: "string" }, alias: { type: "string" } },
      strict: true,
    });
    const base = origin(values.base, "--base");
    const alias = values.alias ? origin(values.alias, "--alias") : undefined;
    const results = await runSmoke({ base, expectVersion: values["expect-version"], alias });
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}: ${r.evidence}`);
    const failed = results.filter((r) => !r.ok).length;
    console.log(failed ? `\n${failed} of ${results.length} checks FAILED against ${base}` : `\nall ${results.length} checks passed against ${base}`);
    process.exitCode = failed ? 1 : 0;
  } catch (err) {
    console.error(`smoke: ${err.message}\nusage: node deploy/hosted/smoke.mjs [--base URL] [--expect-version X.Y.Z] [--alias URL]`);
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
