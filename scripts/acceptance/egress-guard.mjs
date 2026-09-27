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
 * node:dgram Socket.prototype.send/connect, node:dns lookup/resolve(+promises,
 * +Resolver prototype), globalThis.fetch, node:http(s).request/get, node:tls.connect
 * (defense in depth), undici's request/fetch when resolvable, and (best-effort)
 * node:worker_threads Worker construction (auto-injects execArgv so spawned worker
 * threads load this same guard fresh in their own realm). Also propagates itself to
 * any Node child process via NODE_OPTIONS (see below).
 *
 * This is a test-time guard, not a sandbox: it relies on every network primitive
 * going through these documented Node entry points. It does not replace OS-level
 * network isolation for untrusted code.
 *
 * ============================================================================
 * RESIDUAL GAPS (all of them -- read before treating a green run as proof of A22)
 * ============================================================================
 * 1. node:dns named/namespace import bypass (verified empirically, Node 24, ESM).
 *    Node's CJS->ESM interop gives each named/namespace import of a core module
 *    (e.g. `import { request } from "node:http"` or `import * as dns from
 *    "node:dns"`) a binding SNAPSHOTTED at first module evaluation; reassigning
 *    the property on the `import x from "node:mod"` default object (what this
 *    file does) does NOT propagate to that snapshot. Empirically:
 *    http.request/https.request/fetch/net.connect/dgram.send calls remain caught
 *    regardless of import style because they transitively call a shared
 *    PROTOTYPE method (net.Socket.prototype.connect, dgram.Socket.prototype.send,
 *    dns.Resolver.prototype.resolve*) patched below and therefore import-style-
 *    agnostic. Plain `dns.lookup`/`dns.resolve` (the bare functions, not the
 *    Resolver class) do NOT open a socket, so a caller that imports "node:dns"
 *    via named/namespace syntax specifically bypasses just those two patches.
 *    Same class of limitation applies to the worker_threads patch in #3 below.
 * 2. child_process: NOT patched directly. This file appends `--import <self>` to
 *    process.env.NODE_OPTIONS, which `child_process.spawn/fork/exec` propagates
 *    automatically to any child that (a) is itself `node` (or a node-based
 *    shebang script) AND (b) inherits process.env (Node's default when the
 *    caller does not pass an explicit `options.env`). This does NOT cover: a
 *    child launched with an explicit `env` that omits NODE_OPTIONS; a non-Node
 *    child (shell, python, curl, a compiled binary, ...); or a child that itself
 *    unsets/overrides NODE_OPTIONS. Verified empirically: a `node -e
 *    "fetch(...)"` child spawned from a guarded parent without passing
 *    `--import` explicitly is still blocked, because NODE_OPTIONS carried it.
 * 3. node:worker_threads: best-effort only. `Worker` is wrapped (default-import
 *    style only -- same ESM snapshot caveat as #1) so `new Worker(path)` is
 *    rewritten to `new Worker(path, {...opts, execArgv: [...execArgv,
 *    "--import", <self>]})`, which DOES give the spawned thread a fresh,
 *    independently-guarded realm (verified empirically: a worker script calling
 *    `fetch()` throws EgressBlockedError inside the worker). The residual gap is
 *    exactly the #1 pattern: a caller doing `import { Worker } from
 *    "node:worker_threads"` (named import) gets the ORIGINAL unwrapped class and
 *    is not covered.
 * 4. Native addons / N-API modules that perform raw socket syscalls without
 *    going through any of node:net/dgram/tls/http(s)/dns/undici/fetch are
 *    invisible to this guard by construction -- there is no JS-level hook to
 *    intercept. Treat any test dependency that ships a native binding as
 *    requiring independent, out-of-band audit for A22 purposes.
 *
 * Treat this file as a fast in-process tripwire for test/CI convenience, not as
 * the sole authority for a production zero-egress guarantee; pair it with an
 * OS/CI-level network-egress block (firewall / no-network container / VM) for
 * anything load-bearing like the A22 acceptance gate.
 */

import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import dgram from "node:dgram";
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

// --- node:dgram (UDP) -------------------------------------------------------
// dgram.Socket is a shared prototype (like net.Socket), so patching it here is
// import-style-agnostic regardless of how the caller imported "node:dgram".
function hostFromDgramSend(args) {
  let rest = args;
  if (typeof rest[rest.length - 1] === "function") rest = rest.slice(0, -1); // drop optional callback
  // signature is one of: send(msg[, offset, length], port[, address]). msg is always index 0 (string or
  // Buffer/Uint8Array/array-of-buffers); address, when present, is the last remaining string argument.
  for (let i = rest.length - 1; i >= 1; i -= 1) {
    if (typeof rest[i] === "string") return rest[i];
  }
  return "localhost"; // dgram's documented default destination address when omitted
}
function hostFromDgramConnect(args) {
  return typeof args[1] === "string" ? args[1] : "127.0.0.1"; // dgram.connect()'s documented default
}
if (dgram.Socket && dgram.Socket.prototype) {
  const origDgramSend = dgram.Socket.prototype.send;
  if (typeof origDgramSend === "function") {
    dgram.Socket.prototype.send = function patchedDgramSend(...args) {
      guard("dgram.send", hostFromDgramSend(args));
      return origDgramSend.apply(this, args);
    };
  }
  const origDgramConnect = dgram.Socket.prototype.connect;
  if (typeof origDgramConnect === "function") {
    dgram.Socket.prototype.connect = function patchedDgramConnect(...args) {
      guard("dgram.connect", hostFromDgramConnect(args));
      return origDgramConnect.apply(this, args);
    };
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

// --- propagate to Node child processes via NODE_OPTIONS -----------------------
// child_process.spawn/fork/exec inherit process.env (including NODE_OPTIONS) by
// default unless the caller passes an explicit `env`. This makes the guard apply
// automatically to any further `node` invocation without every call site having
// to remember `--import`. See RESIDUAL GAPS #2 above for what this does NOT cover.
const SELF_URL = import.meta.url;
const SELF_IMPORT_FLAG = `--import ${SELF_URL}`;
{
  const existing = process.env.NODE_OPTIONS ?? "";
  if (!existing.includes(SELF_URL)) {
    process.env.NODE_OPTIONS = existing.length > 0 ? `${existing} ${SELF_IMPORT_FLAG}` : SELF_IMPORT_FLAG;
  }
}

// --- node:worker_threads (best-effort; see RESIDUAL GAPS #3 above) ------------
try {
  const workerThreads = await import("node:worker_threads");
  const OrigWorker = workerThreads.Worker;
  if (typeof OrigWorker === "function") {
    class GuardedWorker extends OrigWorker {
      constructor(filenameOrUrl, options) {
        const opts = { ...(options ?? {}) };
        const execArgv = Array.isArray(opts.execArgv) ? [...opts.execArgv] : [];
        if (!execArgv.some((a) => typeof a === "string" && a.includes(SELF_URL))) {
          execArgv.push("--import", SELF_URL);
        }
        opts.execArgv = execArgv;
        // eval:true workers run inline source, not a file; execArgv still applies to the thread's own
        // bootstrap the same way, so no special-casing needed here.
        super(filenameOrUrl, opts);
      }
    }
    try {
      workerThreads.Worker = GuardedWorker;
    } catch {
      /* read-only export on this binding style; named/namespace importers remain an acknowledged gap */
    }
  }
} catch {
  /* node:worker_threads unavailable (unlikely) -- nothing to wrap */
}

logAttempt("guard.installed", { allowLoopback: ALLOW_LOOPBACK, nodeOptionsPropagated: true }, false);
