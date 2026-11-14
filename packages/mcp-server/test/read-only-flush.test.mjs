/**
 * read-only-flush.test.mjs: when queued read bookkeeping is applied.
 *
 *  - On a hook-owned host (Claude Code with hooks) the stdio server flushes it when stdin closes, so a recall
 *    rating and the counters reach disk even though no distill/exit handler runs there.
 *  - A write tool waits only a short, bounded time for the queue: an op that never settles must not stall it.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { bookkeep, withDeferredBookkeeping } from "agent-recall-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(here, "..", "dist", "index.js");
const textOf = (res) => (res.content ?? []).map((c) => c.text ?? "").join("\n");

const tmpDirs = [];
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ar-ro-flush-")); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

describe("shutdown flush on a hook-owned stdio host", () => {
  it("stdin close flushes the queued recall rating and lifecycle telemetry to disk", async () => {
    const root = mk();
    const project = "flushproj";
    const jdir = path.join(root, "projects", project, "journal");
    fs.mkdirSync(jdir, { recursive: true });
    fs.writeFileSync(path.join(jdir, "2026-11-01.md"), "# 2026-11-01\n\nCache invalidation keyed by content hash, not path. Rollback plan checked.\n");

    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "AR_HOST" || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k.startsWith("AGENT_RECALL_") || k === "AR_AB_ENABLED") continue;
      if (v !== undefined) env[k] = v;
    }
    env.AR_HOST = "claude-code"; // Tier A: hook-owned, so lifecycle-exit's distill path is skipped
    env.AGENT_RECALL_ROOT = root;

    const transport = new StdioClientTransport({ command: "node", args: [ENTRY], env });
    const client = new Client({ name: "ro-flush", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    try {
      const call = (name, args) => client.callTool({ name, arguments: { project, ...args } });
      const r = textOf(await call("recall", { query: "cache hash rollback" }));
      const id = /IDs: 1=(\S+)/.exec(r)?.[1];
      assert.ok(id, "recall returned a result id: " + r);
      await call("recall", { query: "cache hash", feedback: [{ id, useful: true }] });
      await call("session_start", {});
      // Queued, not written: a read.
      assert.equal(fs.existsSync(path.join(root, "feedback-log.json")), false, "feedback must still be queued after the read");
    } finally {
      await client.close(); // ends stdin; the server flushes (bounded) as it goes
    }
    // The flush ran in the child; give the filesystem a beat in case close() returned on the process exit event.
    const file = path.join(root, "feedback-log.json");
    assert.ok(fs.existsSync(file), "feedback-log.json reached disk after stdin close");
    assert.match(fs.readFileSync(file, "utf-8"), /useful/);
    assert.match(fs.readFileSync(path.join(root, "telemetry", "lifecycle.jsonl"), "utf-8"), /"event":"session_start"/);
  });
});

describe("pre-write flush is bounded", () => {
  it("a queued op that never settles does not stall a write tool", async () => {
    const root = mk();
    process.env.AGENT_RECALL_ROOT = root;
    process.env.AR_HOST = "codex";
    delete process.env.AR_AB_ENABLED;
    const { buildServer } = await import("../dist/build-server.js");
    const server = buildServer({ tier: "B", full: true, extras: true, ambientCapture: true });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ro-hang", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      // A wedged op (a lock that never frees) queued by a read for this store.
      withDeferredBookkeeping(() => { void bookkeep({ apply: () => new Promise(() => {}) }); });
      const t0 = Date.now();
      const res = await client.callTool({ name: "remember", arguments: { project: "hangproj", content: "Lesson: a hung flush must not block writes", context: "lesson" } });
      const ms = Date.now() - t0;
      assert.ok(!res.isError, "remember succeeded: " + textOf(res));
      assert.ok(ms < 5000, `write completed promptly despite the hung op (took ${ms} ms)`);
      // A second write is bounded the same way (the stuck op keeps the chain busy; each wait is capped).
      const t1 = Date.now();
      await client.callTool({ name: "remember", arguments: { project: "hangproj", content: "Lesson: second write also bounded", context: "lesson" } });
      assert.ok(Date.now() - t1 < 5000, "second write also prompt");
    } finally {
      await client.close();
      await server.close();
      delete process.env.AGENT_RECALL_ROOT;
    }
  });
});
