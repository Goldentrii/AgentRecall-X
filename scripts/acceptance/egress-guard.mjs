/**
 * scripts/acceptance/egress-guard.mjs
 *
 * `--import` preload that turns any real network attempt during a test run
 * into a thrown error, so "local default = zero network" (A22/A25) can be
 * enforced mechanically instead of by eyeballing a packet capture.
 *
 * Usage:
 *   AR_EGRESS_LOG=/abs/path/egress.jsonl \
 *   node --import ./scripts/acceptance/egress-guard.mjs your-script.mjs
 *
 * Env:
 *   AR_EGRESS_LOG              - jsonl file every attempt (allowed or blocked) is appended to. Optional.
 *   AR_EGRESS_ALLOW_LOOPBACK=1 - allow 127.0.0.1/::1/localhost (e.g. a local PGlite/test HTTP server).
 *                                Anything else always throws, loopback or not, unless this is set.
 *
 * Patches: node:net Socket.prototype.connect (+ net.connect/net.createConnection),
 * node:dns lookup/resolve(+promises), globalThis.fetch, node:http(s).request/get,
 * node:tls.connect (defense in depth), and undici's request/fetch when resolvable.
 *
 * This is a test-time guard, not a sandbox: it relies on every network primitive
 * going through these documented Node entry points. It does not replace OS-level
 * network isolation for untrusted code.
 *
 * KNOWN GAP (verified empirically, Node 24, ESM): Node's CJS->ESM interop gives
 * each named/namespace import of a core module (e.g. `import { request } from
 * "node:http"` or `import * as dns from "node:dns"`) a binding SNAPSHOTTED at
 * first module evaluation; reassigning the property on the `import x from
 * "node:mod"` default object (what this file does) does NOT propagate to that
 * snapshot. Empirically: http.request/https.request/fetch/net.* calls remain
 * caught regardless of import style because they transitively call
 * net.Socket.prototype.connect (a shared prototype method, patched below and
 * therefore import-style-agnostic) before any data leaves the process. Plain
 * `dns.lookup`/`dns.resolve` calls do NOT open a socket, so a caller that
 * imports "node:dns" via named/namespace syntax (not `import dns from
 * "node:dns"`) can bypass the dns.lookup/dns.resolve patches below -- this is
 * the one residual gap. dns.Resolver-class usage is still caught (its
 * prototype methods are patched below, same reasoning as net.Socket). Treat
 * this file as a fast in-process tripwire for test/CI convenience, not as the
 * sole authority for a production zero-egress guarantee; pair it with an
 * OS/CI-level network-egress block for anything load-bearing (A22).
 */

import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";

const LOG_PATH = process.env.AR_EGRESS_LOG;
const ALLOW_LOOPBACK = process.env.AR_EGRESS_ALLOW_LOOPBACK === "1";

function isLoopbackHost(host) {
  if (!host) return false;
  if (host === "localhost" || host === "::1" || host === "0.0.0.0") return true;
  if (host === "127.0.0.1" || /^127\.\d+\.\d+\.\d+$/.test(host)) return true;
  return false;
}

let logStream = null;
function logAttempt(kind, detail, blocked) {
  if (!LOG_PATH) return;
  try {
    if (!logStream) {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });
    }
    logStream.write(`${JSON.stringify({ ts: new Date().toISOString(), kind, blocked, ...detail })}\n`);
  } catch {
    // logging must never itself become a reason a test hangs/crashes differently than the guard's intent.
  }
}

export class EgressBlockedError extends Error {
  constructor(kind, detail) {
    super(`egress-guard: blocked network attempt [${kind}] ${JSON.stringify(detail)}`);
    this.name = "EgressBlockedError";
    this.kind = kind;
    this.detail = detail;
  }
}

function guard(kind, host, extra = {}) {
  const allowed = ALLOW_LOOPBACK && isLoopbackHost(host);
  logAttempt(kind, { host, ...extra }, !allowed);
  if (!allowed) throw new EgressBlockedError(kind, { host, ...extra });
}

function hostFromNetOptions(args) {
  const opts = args[0];
  if (typeof opts === "number") {
    return typeof args[1] === "string" ? args[1] : "127.0.0.1";
  }
  if (typeof opts === "string") {
    // net.connect(path) for IPC pipes -- not a network egress; treat as loopback-equivalent.
    return "127.0.0.1";
  }
  if (opts && typeof opts === "object") {
    return opts.host ?? opts.hostname ?? (opts.path ? "127.0.0.1" : "unknown");
  }
  return "unknown";
}

function hostFromUrlLike(input) {
  try {
    if (typeof input === "string") return new URL(input).hostname;
    if (input instanceof URL) return input.hostname;
    if (input && typeof input === "object") {
      if (input.hostname) return input.hostname;
      if (input.host) return input.host.split(":")[0];
      if (input.url) return hostFromUrlLike(input.url);
    }
  } catch {
    /* fall through */
  }
  return "unknown";
}

// --- node:net -----------------------------------------------------------
const origSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedSocketConnect(...args) {
  guard("net.Socket.connect", hostFromNetOptions(args));
  return origSocketConnect.apply(this, args);
};

for (const fnName of ["connect", "createConnection"]) {
  if (typeof net[fnName] === "function") {
    const orig = net[fnName];
    try {
      net[fnName] = function patchedNetFn(...args) {
        guard(`net.${fnName}`, hostFromNetOptions(args));
        return orig.apply(net, args);
      };
    } catch {
      /* some environments expose non-configurable bindings; Socket.prototype patch above still applies */
    }
  }
}

// --- node:tls (defense in depth; https already routes through http(s).request below) -----
if (typeof tls.connect === "function") {
  const origTlsConnect = tls.connect;
  try {
    tls.connect = function patchedTlsConnect(...args) {
      guard("tls.connect", hostFromNetOptions(args));
      return origTlsConnect.apply(tls, args);
    };
  } catch {
    /* ignore */
  }
}

// --- node:dns -------------------------------------------------------------
const origLookup = dns.lookup;
dns.lookup = function patchedLookup(hostname, ...rest) {
  guard("dns.lookup", hostname);
  return origLookup.call(dns, hostname, ...rest);
};
const origResolve = dns.resolve;
dns.resolve = function patchedResolve(hostname, ...rest) {
  guard("dns.resolve", hostname);
  return origResolve.call(dns, hostname, ...rest);
};
if (dns.promises) {
  const origLookupP = dns.promises.lookup;
  dns.promises.lookup = function patchedLookupP(hostname, ...rest) {
    guard("dns.promises.lookup", hostname);
    return origLookupP.call(dns.promises, hostname, ...rest);
  };
  const origResolveP = dns.promises.resolve;
  dns.promises.resolve = function patchedResolveP(hostname, ...rest) {
    guard("dns.promises.resolve", hostname);
    return origResolveP.call(dns.promises, hostname, ...rest);
  };
}

// dns.Resolver / dns.promises.Resolver: patch the shared PROTOTYPE so it's caught regardless of how the
// caller imported "node:dns" (see the ESM named-binding caveat documented at the top of this file --
// prototype methods are shared/live across import styles the way module-level named exports are not).
for (const ResolverCtor of [dns.Resolver, dns.promises && dns.promises.Resolver].filter(Boolean)) {
  for (const method of ["resolve", "resolve4", "resolve6", "reverse", "resolveAny"]) {
    if (typeof ResolverCtor.prototype[method] !== "function") continue;
    const orig = ResolverCtor.prototype[method];
    ResolverCtor.prototype[method] = function patchedResolverMethod(hostOrIp, ...rest) {
      guard(`dns.Resolver.${method}`, hostOrIp);
      return orig.call(this, hostOrIp, ...rest);
    };
  }
}

// --- node:http(s) -----------------------------------------------------------
function patchRequestModule(mod, label) {
  const origRequest = mod.request;
  mod.request = function patchedRequest(...args) {
    guard(`${label}.request`, hostFromUrlLike(args[0]));
    return origRequest.apply(mod, args);
  };
  const origGet = mod.get;
  mod.get = function patchedGet(...args) {
    guard(`${label}.get`, hostFromUrlLike(args[0]));
    return origGet.apply(mod, args);
  };
}
patchRequestModule(http, "http");
patchRequestModule(https, "https");

// --- globalThis.fetch -------------------------------------------------------
if (typeof globalThis.fetch === "function") {
  const origFetch = globalThis.fetch;
  globalThis.fetch = function patchedFetch(input, init) {
    guard("fetch", hostFromUrlLike(input));
    return origFetch.call(globalThis, input, init);
  };
}

// --- undici (best-effort; node's global fetch above already covers most cases) ----
try {
  const undici = await import("undici");
  if (undici && typeof undici.request === "function") {
    try {
      const origUndiciRequest = undici.request;
      undici.request = function patchedUndiciRequest(url, opts) {
        guard("undici.request", hostFromUrlLike(url));
        return origUndiciRequest.call(undici, url, opts);
      };
    } catch {
      /* read-only export in this undici build; global fetch/http(s) patches remain the backstop */
    }
  }
  if (undici && typeof undici.fetch === "function" && undici.fetch !== globalThis.fetch) {
    try {
      const origUndiciFetch = undici.fetch;
      undici.fetch = function patchedUndiciFetch(input, init) {
        guard("undici.fetch", hostFromUrlLike(input));
        return origUndiciFetch.call(undici, input, init);
      };
    } catch {
      /* ignore */
    }
  }
} catch {
  /* undici not resolvable as a standalone package; fine, coverage already exists via fetch/http(s)/net */
}

logAttempt("guard.installed", { allowLoopback: ALLOW_LOOPBACK }, false);
