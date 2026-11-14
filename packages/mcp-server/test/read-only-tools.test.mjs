/**
 * read-only-tools.test.mjs: session_start and recall are read-only in substance, not only in their annotation.
 *
 * A read leaves the store byte-identical; the ranking bookkeeping it would have written is queued per store
 * and applied by the next write tool call, a flush, or shutdown; queues never mix tenants. Covered for the
 * local stdio server (ambient capture on) and the hosted HTTP server.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import * as crypto from "node:crypto";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  bookkeep, withDeferredBookkeeping, flushBookkeeping, flushAllBookkeeping, bookkeepingStats, withTenant, getRoot,
} from "agent-recall-core";

// A hook-less host: ambient capture is installed, so a read-only call must not append working memory either.
for (const k of Object.keys(process.env)) if (k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE") delete process.env[k];
process.env.AR_HOST = "codex";
delete process.env.AR_AB_ENABLED;
const { buildServer } = await import("../dist/build-server.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const mk = (p) => fs.mkdtempSync(path.join(tmpdir(), p));
const cleanup = [];
after(() => { for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true }); });

/** Every file under root; `skip` names top-level directories left out (see the stdio test). */
function snapshot(root, skip = []) {
  const m = {};
  (function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!skip.includes(path.relative(root, p))) walk(p); }
      else m[path.relative(root, p)] = crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex");
    }
  })(root);
  return m;
}
const read = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), "utf-8"); } catch { return ""; } };
const textOf = (res) => (res.content ?? []).map((c) => c.text ?? "").join("\n");

async function stdioClient() {
  const server = buildServer({ tier: "B", full: true, extras: true, ambientCapture: true });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "read-only-test", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

/** A store with a correction, a behaviour rule, a palace room entry, a journal and a feedback-able recall hit. */
async function seed(client, project) {
  const call = (name, args) => client.callTool({ name, arguments: { project, ...args } });
  await call("session_end", { summary: "worked on cache keys and deploy approval", trajectory: "ship", state: { goal: "ship it", next: "deploy" } });
  await call("remember", { content: "Decision: use content hash for cache keys because paths move", context: "decision" });
  await call("register_rule", { name: "push-gate", when: "before pushing code", do: "ask the owner for explicit approval" });
  await call("check", { goal: "deploy plan", human_correction: { rule: "Never deploy without explicit owner approval", why: "owner said so after an incident", applies_when: ["deploy", "push"] } });
}

describe("local stdio server", () => {
  let root, project, h;
  before(async () => {
    root = mk("ar-ro-");
    cleanup.push(root);
    process.env.AGENT_RECALL_ROOT = root;
    project = "roproj";
    h = await stdioClient();
    await seed(h.client, project);
    const jdir = path.join(root, "projects", project, "journal");
    fs.mkdirSync(jdir, { recursive: true });
    fs.writeFileSync(path.join(jdir, "2026-11-01.md"), "# 2026-11-01\n\nCache invalidation keyed by content hash, not path. Rollback plan checked.\n");
    await flushBookkeeping();
  });
  after(async () => { await h.close(); delete process.env.AGENT_RECALL_ROOT; });

  it("session_start and recall leave every file byte-identical, repeated and with feedback", async () => {
    // Ambient capture skips read-only tools, so the whole store (working-memory included) must not change.
    const before = snapshot(root);
    const call = (name, args) => h.client.callTool({ name, arguments: { project, ...args } });
    await call("session_start", {});
    await call("session_start", {});
    await call("session_start", { mode: "full", context: "deploy cache" });
    await call("session_start", { mode: "lite" });
    const r = textOf(await call("recall", { query: "cache hash deploy" }));
    const id = /IDs: 1=(\S+)/.exec(r)?.[1];
    assert.ok(id, "recall returned a result id: " + r);
    await call("recall", { query: "cache hash", feedback: [{ id, useful: true }] });
    assert.deepEqual(snapshot(root), before, "a read changed the store");
    assert.ok(bookkeepingStats().pending > 0, "the bookkeeping was queued, not dropped");
  });

  it("the queued bookkeeping is applied by the next write tool call", async () => {
    assert.ok(bookkeepingStats().pending > 0);
    assert.doesNotMatch(read(root, "telemetry/lifecycle.jsonl"), /"event":"session_start"/);
    await h.client.callTool({ name: "remember", arguments: { project, content: "Lesson: a later write applies earlier reads", context: "lesson" } });
    assert.equal(bookkeepingStats().pending, 0);
    assert.match(read(root, "telemetry/lifecycle.jsonl"), /"event":"session_start"/);
    assert.match(read(root, `projects/${project}/corrections/_outcomes.jsonl`), /"kind":"retrieved"/);
    assert.match(read(root, `projects/${project}/palace/behavior-policies.json`), /"hits": 1/);
    assert.match(read(root, "feedback-log.json"), /useful/);
    assert.match(fs.readdirSync(path.join(root, "working-memory")).join(","), /\.jsonl/);
    const rooms = fs.readdirSync(path.join(root, "projects", project, "palace", "rooms"));
    const accessed = rooms.some((r) => /"access_count":\s*[1-9]/.test(read(root, `projects/${project}/palace/rooms/${r}/_room.json`)));
    assert.ok(accessed, "a room's access_count was bumped by the flush");
  });

  it("a flush applies it without any write tool", async () => {
    const lifecycle = () => read(root, "telemetry/lifecycle.jsonl").split("\n").filter((l) => l.includes("session_start")).length;
    const n = lifecycle();
    await h.client.callTool({ name: "session_start", arguments: { project } });
    assert.equal(lifecycle(), n, "not written during the call");
    await flushAllBookkeeping();
    assert.equal(lifecycle(), n + 1);
  });

  it("a read of a project that does not exist yet creates nothing", async () => {
    const before = snapshot(root);
    await h.client.callTool({ name: "session_start", arguments: { project: "brand-new" } });
    await h.client.callTool({ name: "recall", arguments: { project: "brand-new", query: "anything" } });
    assert.deepEqual(snapshot(root), before);
    await flushAllBookkeeping();
    assert.ok(fs.existsSync(path.join(root, "projects", "brand-new")), "the scaffold arrives with the flush");
  });
});

describe("deferred allowlist registration", () => {
  it("an explicit read then an auto read in the same cwd resolve to the explicit project, with no flush between", async () => {
    const root = mk("ar-ro-al-");
    const repo = mk("ar-ro-repo-");
    cleanup.push(root, repo);
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "repo-x-pkg" }));
    const prevRoot = process.env.AGENT_RECALL_ROOT;
    const prevCwd = process.cwd();
    process.env.AGENT_RECALL_ROOT = root;
    delete process.env.AGENT_RECALL_PROJECT;
    process.chdir(repo);
    try {
      const { resolveProject } = await import("agent-recall-core");
      const explicit = await withDeferredBookkeeping(() => resolveProject("my-explicit"));
      assert.equal(explicit, "my-explicit");
      assert.ok(!fs.existsSync(path.join(root, "projects", "my-explicit")), "the read wrote nothing");
      assert.ok(bookkeepingStats().pending > 0, "the registration is queued");
      const auto = await withDeferredBookkeeping(() => resolveProject("auto"));
      assert.equal(auto, "my-explicit", "deferring the registration changed what auto resolves to");
      await flushBookkeeping();
      assert.equal(await resolveProject("auto"), "my-explicit", "same answer once written");
    } finally {
      process.chdir(prevCwd);
      if (prevRoot === undefined) delete process.env.AGENT_RECALL_ROOT; else process.env.AGENT_RECALL_ROOT = prevRoot;
    }
  });
});

describe("the queue", () => {
  const tenant = (root, sid) => ({ root, sid, defaultProject: "main" });

  it("keeps tenants apart: a flush applies only its own store's operations, inside its own scope", async () => {
    const a = mk("ar-q-a-"), b = mk("ar-q-b-");
    cleanup.push(a, b);
    const seen = [];
    const queue = (root, sid, name) => withTenant(tenant(root, sid), () => withDeferredBookkeeping(() => {
      bookkeep({ apply: () => { fs.writeFileSync(path.join(getRoot(), name), name); seen.push([name, getRoot()]); } });
    }));
    queue(a, "aaaaaa", "from-a");
    queue(b, "bbbbbb", "from-b");
    await withTenant(tenant(a, "aaaaaa"), () => flushBookkeeping());
    assert.deepEqual(fs.readdirSync(a), ["from-a"]);
    assert.deepEqual(fs.readdirSync(b), [], "tenant A's flush never touched B");
    assert.equal(withTenant(tenant(b, "bbbbbb"), () => bookkeepingStats().pending), 1);
    await flushAllBookkeeping();
    assert.deepEqual(fs.readdirSync(b), ["from-b"]);
    assert.deepEqual(seen, [["from-a", path.resolve(a)], ["from-b", path.resolve(b)]]);
  });

  it("is bounded, collapses repeats and never fails a read", async () => {
    const root = mk("ar-q-bound-");
    cleanup.push(root);
    let applied = 0;
    await withTenant(tenant(root, "cccccc"), async () => {
      const dropped0 = bookkeepingStats().dropped;
      withDeferredBookkeeping(() => {
        for (let i = 0; i < 1000; i++) bookkeep({ apply: () => { applied++; } });
        for (let i = 0; i < 100; i++) bookkeep({ key: "same", apply: () => { applied += 1000; } });
        for (let i = 0; i < 100; i++) bookkeep({ key: "count", repeat: true, apply: () => { applied += 1_000_000; } });
        bookkeep({ apply: () => { throw new Error("boom"); } });
      });
      assert.ok(bookkeepingStats().pending <= 256);
      assert.ok(bookkeepingStats().dropped > dropped0);
      const r = await flushBookkeeping();
      assert.equal(r.failed, 1, "a failing op is counted, not thrown");
      assert.equal(Math.floor(applied / 1_000_000), 16, "repeat is capped");
    });
  });

  it("outside a read it applies immediately, as before", async () => {
    let ran = false;
    await bookkeep({ apply: async () => { ran = true; } });
    assert.ok(ran);
  });
});

describe("hosted http server", () => {
  const CLI = path.join(here, "..", "dist", "http", "cli.js");
  let base, dataDir, baseUrl, proc, tokenA, tokenB;
  const log = [];
  const env = (extra = {}) => {
    const e = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE_CODE_") && k !== "CLAUDECODE" && !k.startsWith("AGENT_RECALL_") && k !== "AR_HOST"));
    return { ...e, HOME: base, USERPROFILE: base, AR_SERVER_DATA: dataDir, ...extra };
  };
  const token = (uid) => {
    const r = spawnSync(process.execPath, [CLI, "token", "create", "--uid", uid], { env: env(), encoding: "utf-8" });
    return /\b(ar_[A-Za-z0-9_-]{43})\b/.exec(r.stdout)[1];
  };
  const connect = async (t) => {
    const client = new Client({ name: "ro-hosted", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${t}` } } }));
    return client;
  };

  before(async () => {
    base = mk("ar-ro-host-");
    cleanup.push(base);
    dataDir = path.join(base, "data");
    tokenA = token("alice");
    tokenB = token("bob");
    const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
    baseUrl = `http://127.0.0.1:${port}`;
    proc = spawn(process.execPath, [CLI, "serve", "--port", String(port)], { env: env(), stdio: ["ignore", "pipe", "pipe"] });
    proc.stderr.on("data", (d) => log.push(String(d)));
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("server did not start:\n" + log.join(""))), 30_000);
      proc.stderr.on("data", () => { if (log.join("").includes("listening on")) { clearTimeout(t); resolve(); } });
    });
  });
  after(() => { proc?.kill(); });

  it("reads leave the tenant's files byte-identical and never touch another tenant; the next write applies them", async () => {
    const alice = await connect(tokenA);
    const bob = await connect(tokenB);
    try {
      await alice.callTool({ name: "remember", arguments: { content: "Decision: hosted cache keys use content hashes", context: "decision" } });
      await bob.callTool({ name: "remember", arguments: { content: "Decision: bob keeps a separate store", context: "decision" } });
      const rootA = path.join(dataDir, "tenants", "alice"), rootB = path.join(dataDir, "tenants", "bob");
      const beforeA = snapshot(rootA), beforeB = snapshot(rootB);
      await alice.callTool({ name: "session_start", arguments: {} });
      await alice.callTool({ name: "session_start", arguments: { mode: "full" } });
      await alice.callTool({ name: "recall", arguments: { query: "hosted cache keys" } });
      assert.deepEqual(snapshot(rootA), beforeA, "a hosted read changed the tenant's store");
      assert.deepEqual(snapshot(rootB), beforeB);
      await alice.callTool({ name: "remember", arguments: { content: "Lesson: the next write applies queued reads", context: "lesson" } });
      assert.match(read(rootA, "telemetry/lifecycle.jsonl"), /"event":"session_start"/);
      assert.deepEqual(snapshot(rootB), beforeB, "alice's write applied nothing in bob's store");
    } finally {
      await alice.close();
      await bob.close();
    }
  });

  it("lists both tools as read-only over http", async () => {
    const c = await connect(tokenA);
    try {
      const tools = (await c.listTools()).tools;
      for (const n of ["session_start", "recall"]) assert.equal(tools.find((t) => t.name === n).annotations.readOnlyHint, true, n);
      assert.equal(tools.find((t) => t.name === "remember").annotations.readOnlyHint, false);
    } finally { await c.close(); }
  });
});
