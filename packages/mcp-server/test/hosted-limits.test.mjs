/**
 * hosted-limits.test.mjs — unit tests for per-tenant rate limiting and storage quota.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { RateLimiter, UsageTracker, dirSize, isWriteCall, quotaExceededResponse, WRITE_TOOLS } from "../dist/http/limits.js";

let base;
before(() => { base = fs.mkdtempSync(path.join(tmpdir(), "ar-limits-")); });
after(() => fs.rmSync(base, { recursive: true, force: true }));

describe("RateLimiter (token bucket per uid)", () => {
  it("allows perMinute requests at once, then 429s with a retry-after, then refills", () => {
    let t = 1_000_000;
    const rl = new RateLimiter(3, () => t);
    for (let i = 0; i < 3; i++) assert.deepEqual(rl.take("alice"), { ok: true });
    const denied = rl.take("alice");
    assert.equal(denied.ok, false);
    assert.equal(denied.retryAfterSec, 20, "3/min → one token every 20 s");
    t += 20_000;
    assert.deepEqual(rl.take("alice"), { ok: true }, "refilled after retry-after");
    assert.equal(rl.take("alice").ok, false);
  });

  it("users are independent", () => {
    const rl = new RateLimiter(1, () => 0);
    assert.equal(rl.take("alice").ok, true);
    assert.equal(rl.take("alice").ok, false);
    assert.equal(rl.take("bob").ok, true);
  });

  it("refill never exceeds the burst capacity", () => {
    let t = 0;
    const rl = new RateLimiter(2, () => t);
    t += 60 * 60_000; // idle an hour
    assert.equal(rl.take("a").ok, true);
    assert.equal(rl.take("a").ok, true);
    assert.equal(rl.take("a").ok, false);
  });

  it("idle full buckets are pruned so memory stays bounded", () => {
    let t = 0;
    const rl = new RateLimiter(60, () => t, { pruneAbove: 10 });
    for (let i = 0; i < 50; i++) rl.take(`u${i}`);
    t += 120_000; // everyone refilled
    rl.take("trigger");
    assert.ok(rl.size() <= 11, `size ${rl.size()}`);
  });

  it("a clock jumping backwards never locks a user out", () => {
    let t = 10_000_000;
    const rl = new RateLimiter(60, () => t);
    assert.equal(rl.take("a").ok, true);
    t -= 3_600_000; // NTP step back an hour
    assert.equal(rl.take("a").ok, true, "still has tokens");
    t += 1;
    const r = rl.take("a");
    assert.ok(r.ok || r.retryAfterSec <= 1, JSON.stringify(r));
  });

  it("rejects a non-positive rate (0 = disabled is handled by the caller)", () => {
    assert.throws(() => new RateLimiter(0));
    assert.throws(() => new RateLimiter(-1));
  });
});

describe("dirSize", () => {
  it("sums file sizes recursively, missing dir = 0, does not follow symlinks", async () => {
    const d = path.join(base, "size");
    fs.mkdirSync(path.join(d, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(d, "x"), "12345");
    fs.writeFileSync(path.join(d, "a", "b", "y"), "123");
    const size = await dirSize(d);
    // Allocated blocks where the OS reports them (Linux: >= 4 KiB per file), else apparent size.
    if (process.platform === "win32") assert.equal(size, 8);
    else assert.ok(size >= 8, `size ${size}`);
    assert.equal(await dirSize(path.join(base, "nope")), 0);
    try {
      fs.symlinkSync(base, path.join(d, "loop"), "dir");
      assert.equal(await dirSize(d), size, "symlink not followed");
    } catch (e) {
      if (e.code !== "EPERM") throw e; // Windows without symlink privilege
    }
  });
});

describe("UsageTracker (storage quota)", () => {
  it("scans once, caches for ttl, adds write estimates, rescans after ttl", async () => {
    const root = path.join(base, "tenant-a");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "f"), "x".repeat(100));
    // dirSize counts allocated blocks where the OS reports them (4096 for this file on
    // ext4, 100 on Windows), so compare against the measured size, not a literal.
    const real = await dirSize(root);
    assert.ok(real >= 100, "a 100-byte file occupies at least 100 bytes");
    let t = 0;
    const u = new UsageTracker({ quotaBytes: real + 50, ttlMs: 1000, now: () => t });
    assert.equal(await u.usage("a", root), real);
    assert.equal(await u.isOver("a", root), false);
    u.add("a", 60); // estimate from a write's request body
    assert.equal(await u.usage("a", root), real + 60);
    assert.equal(await u.isOver("a", root), true);
    t += 1001;
    assert.equal(await u.usage("a", root), real, "rescan replaces the estimate with the real size");
  });

  it("concurrent checks for one tenant share a single scan", async () => {
    const root = path.join(base, "tenant-b");
    fs.mkdirSync(root, { recursive: true });
    const u = new UsageTracker({ quotaBytes: 10, ttlMs: 60_000 });
    let scans = 0;
    u.scan = async (r) => { scans++; return dirSize(r); };
    await Promise.all([u.usage("b", root), u.usage("b", root), u.usage("b", root)]);
    assert.equal(scans, 1);
  });

  it("a failed scan does not poison the cache (next call retries)", async () => {
    const root = path.join(base, "tenant-c");
    fs.mkdirSync(root, { recursive: true });
    const u = new UsageTracker({ quotaBytes: 10, ttlMs: 60_000 });
    let first = true;
    u.scan = async (r) => { if (first) { first = false; throw new Error("EIO"); } return dirSize(r); };
    await assert.rejects(u.usage("c", root), /EIO/);
    assert.equal(await u.usage("c", root), 0);
  });
});

describe("request classification", () => {
  const call = (name, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });

  it("write tools are remember, session_end, check", () => {
    assert.deepEqual([...WRITE_TOOLS].sort(), ["check", "remember", "session_end"]);
  });

  it("detects write calls in single and batch bodies; reads are not writes", () => {
    assert.equal(isWriteCall(call("remember")), true);
    assert.equal(isWriteCall(call("session_end")), true);
    assert.equal(isWriteCall(call("recall")), false);
    assert.equal(isWriteCall(call("session_start")), false);
    assert.equal(isWriteCall({ jsonrpc: "2.0", id: 1, method: "tools/list" }), false);
    assert.equal(isWriteCall([call("recall", 1), call("remember", 2)]), true);
    assert.equal(isWriteCall(null), false);
    assert.equal(isWriteCall("remember"), false);
  });

  it("quota response: writes get a readable tool error", () => {
    const one = quotaExceededResponse(call("remember", 7), "over quota");
    assert.deepEqual(one, { jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "over quota" }], isError: true } });
  });

  it("quota response for a mixed batch: writes → tool error, reads → JSON-RPC error asking to resend alone", () => {
    const many = quotaExceededResponse([call("recall", 1), call("remember", 2), { jsonrpc: "2.0", method: "notifications/initialized" }], "over quota");
    assert.equal(many.length, 2, "notifications get no answer");
    assert.equal(many[0].id, 1);
    assert.match(many[0].error.message, /Resend read requests on their own/);
    assert.equal(many[0].result, undefined);
    assert.equal(many[1].id, 2);
    assert.equal(many[1].result.isError, true);
  });

  it("quota response: notifications only → null (HTTP 202)", () => {
    const n = { jsonrpc: "2.0", method: "tools/call", params: { name: "remember" } };
    assert.equal(quotaExceededResponse(n, "x"), null);
    assert.equal(quotaExceededResponse([n, n], "x"), null);
  });
});
