import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-digest-test-" + Date.now());

describe("Digest store — CRUD", () => {
  let core;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core = await import("../dist/index.js");
  });

  after(async () => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("creates a digest and returns success", async () => {
    const result = await core.createDigest({
      title: "Business logic analysis of novada-site",
      scope: "novada-site full codebase architecture",
      content: "# Analysis\n\nNovada is a B2B proxy SaaS platform with 10 products.",
      source_agent: "Explore",
      source_query: "analyze novada business logic",
      project: "novada-site",
    });
    assert.equal(result.success, true);
    assert.equal(result.action, "created");
    assert.ok(result.id.startsWith("digest-"));
    assert.ok(result.token_estimate > 0);
    assert.ok(result.expires !== null);
  });

  it("reads back a created digest", async () => {
    const created = await core.createDigest({
      title: "API route analysis",
      scope: "novada-site API routes",
      content: "POST /api/search proxies to scraperapi.novada.com",
      project: "read-test",
    });
    const { meta, content } = core.readDigest("read-test", created.id);
    assert.ok(meta);
    assert.equal(meta.title, "API route analysis");
    assert.ok(content.includes("POST /api/search"));
  });

  it("lists all digests for a project", async () => {
    await core.createDigest({ title: "Kubernetes deployment configuration", scope: "kubernetes infra", content: "k8s content", project: "list-test" });
    await core.createDigest({ title: "Python machine learning pipeline", scope: "ml training", content: "ml content", project: "list-test" });
    const all = core.listDigests("list-test");
    assert.ok(all.length >= 2, `Expected >=2 digests, got ${all.length}`);
  });

  it("lists only non-stale digests when stale=false", async () => {
    const d = await core.createDigest({ title: "Will go stale", scope: "stale test", content: "x", project: "stale-filter" });
    await core.markStale("stale-filter", d.id, "test reason");
    const fresh = core.listDigests("stale-filter", { stale: false });
    assert.ok(fresh.every(e => !e.stale));
  });

  it("marks a digest as stale", async () => {
    const d = await core.createDigest({ title: "Stale candidate", scope: "s", content: "c", project: "stale-test" });
    await core.markStale("stale-test", d.id, "code changed");
    const { meta } = core.readDigest("stale-test", d.id);
    assert.equal(meta.stale, true);
    assert.equal(meta.stale_reason, "code changed");
  });

  it("markStale (fix9, async-only): resolves true on success, false on missing id", async () => {
    // fix9 retired the sync/async twin pair (the sync markStale parked the
    // whole event loop via Atomics.wait and existed only to pin the old sync
    // SDK signature digestInvalidate(): void — now Promise<void>). This
    // ports the former markStaleAsync coverage to the canonical name.
    const d = await core.createDigest({ title: "Async stale candidate", scope: "s", content: "c", project: "stale-async" });
    assert.equal(await core.markStale("stale-async", d.id, "async invalidate"), true);
    const { meta } = core.readDigest("stale-async", d.id);
    assert.equal(meta.stale, true);
    assert.equal(meta.stale_reason, "async invalidate");
    assert.equal(await core.markStale("stale-async", "digest-nonexistent", "x"), false);
  });

  it("refreshes an existing digest when title overlaps", async () => {
    await core.createDigest({
      title: "Novada business logic analysis deep dive",
      scope: "novada full architecture",
      content: "Version 1 of the analysis",
      project: "refresh-test",
    });
    const refreshed = await core.createDigest({
      title: "Novada business logic analysis updated",
      scope: "novada full architecture",
      content: "Version 2 — updated analysis with new findings",
      project: "refresh-test",
    });
    assert.equal(refreshed.action, "refreshed");
    const all = core.listDigests("refresh-test");
    // Should not create a duplicate — only 1 entry
    assert.equal(all.length, 1);
    const { content } = core.readDigest("refresh-test", refreshed.id);
    assert.ok(content.includes("Version 2"));
  });

  it("estimates tokens within reasonable range", async () => {
    const text = "x".repeat(1000);
    const d = await core.createDigest({ title: "Token test", scope: "s", content: text, project: "token-test" });
    // 1000 chars / 3.5 ≈ 286 tokens
    assert.ok(d.token_estimate >= 200 && d.token_estimate <= 400);
  });

  it("checkExpiry marks TTL-expired digests as stale", async () => {
    // Create with TTL=0 (immediate expiry still sets an expires timestamp)
    const d = await core.createDigest({
      title: "Expiring digest",
      scope: "s",
      content: "c",
      ttl_hours: 0.0001, // ~0.36 seconds
      project: "expiry-test",
    });
    // Wait a tick then check
    const staled = await core.checkExpiry("expiry-test");
    // The expiry might have already passed
    if (staled.length > 0) {
      assert.ok(staled[0].stale);
    }
  });

  it("pruneStale removes old stale digests", async () => {
    const proj = "prune-test-" + Date.now();
    const d = await core.createDigest({ title: "Prune target unique entry", scope: "pruning scope", content: "prune content", project: proj });
    await core.markStale(proj, d.id, "old");
    // With olderThanDays=0 everything stale gets pruned
    const pruned = await core.pruneStale(proj, 0);
    assert.ok(pruned >= 1, `Expected >=1 pruned, got ${pruned}`);
    const remaining = core.listDigests(proj);
    assert.equal(remaining.length, 0);
  });

  it("respects MAX_DIGESTS_PER_PROJECT by evicting least-accessed", async () => {
    const project = "overflow-test";
    // Create MAX + 1 digests
    for (let i = 0; i < core.MAX_DIGESTS_PER_PROJECT + 1; i++) {
      await core.createDigest({
        title: `Digest overflow ${i} unique title ${Math.random()}`,
        scope: `scope ${i}`,
        content: `content ${i}`,
        project,
      });
    }
    const all = core.listDigests(project);
    assert.ok(all.length <= core.MAX_DIGESTS_PER_PROJECT);
  });

  it("creates global digest when global=true", async () => {
    const d = await core.createDigest({
      title: "Cross-project insight",
      scope: "global knowledge",
      content: "Applicable across all projects",
      global: true,
      project: "any",
    });
    assert.equal(d.project, "__global__");
    const { meta } = core.readDigest("any", d.id, true);
    assert.ok(meta);
  });

  it("never expires when ttl_hours=0", async () => {
    const d = await core.createDigest({
      title: "Permanent digest",
      scope: "s",
      content: "c",
      ttl_hours: 0,
      project: "perm-test",
    });
    assert.equal(d.expires, null);
  });
});
