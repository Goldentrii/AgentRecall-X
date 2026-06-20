import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-awareness-test-" + Date.now());

describe("Awareness system — module integration", () => {
  let awareness;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    awareness = await import("../dist/palace/awareness.js");
  });

  after(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("initAwareness creates state and markdown files", () => {
    const state = awareness.initAwareness("tongwu — AI product builder");
    assert.equal(state.identity, "tongwu — AI product builder");
    assert.equal(state.topInsights.length, 0);

    // Check files created
    const mdPath = path.join(TEST_ROOT, "awareness.md");
    const jsonPath = path.join(TEST_ROOT, "awareness-state.json");
    assert.ok(fs.existsSync(mdPath));
    assert.ok(fs.existsSync(jsonPath));
  });

  it("readAwareness returns the markdown content", () => {
    const content = awareness.readAwareness();
    assert.ok(content.includes("# Awareness"));
    assert.ok(content.includes("tongwu"));
  });

  it("addInsight adds a new insight", () => {
    const result = awareness.addInsight({
      title: "Agents skip extraction steps under context pressure",
      evidence: "Seen in novada replication sessions",
      appliesWhen: ["replication", "extraction"],
      source: "proxy-veil session",
    });
    assert.equal(result.action, "added");
    assert.equal(result.insight.confirmations, 1);
  });

  it("addInsight merges similar insight (>50% word overlap)", () => {
    const result = awareness.addInsight({
      title: "Agents skip extraction steps when tired",
      evidence: "Second occurrence in brightdata session",
      appliesWhen: ["extraction", "fatigue"],
      source: "brightdata session",
    });
    assert.equal(result.action, "merged");
    assert.equal(result.insight.confirmations, 2);
    // appliesWhen should include both old and new
    assert.ok(result.insight.appliesWhen.includes("replication"));
    assert.ok(result.insight.appliesWhen.includes("fatigue"));
  });

  it("addInsight adds distinct insights separately", () => {
    awareness.addInsight({
      title: "Rate limiting prevents runaway costs",
      evidence: "proxy-veil Browser API incident",
      appliesWhen: ["cost", "browser"],
      source: "proxy-veil",
    });
    const state = awareness.readAwarenessState();
    assert.equal(state.topInsights.length, 2);
  });

  it("addInsight replaces lowest when over 20", () => {
    // Reset to clean state
    awareness.initAwareness("overflow test");

    // Add 20 completely distinct insights (no word overlap possible)
    const topics = [
      "PostgreSQL indexing strategies",
      "Kubernetes pod autoscaling",
      "WebSocket connection pooling",
      "GraphQL schema stitching",
      "Redis cluster failover",
      "Docker layer caching",
      "Terraform state locking",
      "gRPC streaming deadlines",
      "OAuth PKCE token rotation",
      "WASM sandboxing boundaries",
      "Rust lifetime elision",
      "Erlang supervision trees",
      "eBPF kernel tracing",
      "Cassandra compaction tuning",
      "Nginx upstream health checks",
      "Envoy proxy circuit breaking",
      "ClickHouse columnar storage",
      "Flink watermark semantics",
      "NATS JetStream delivery",
      "Wasm component interface types",
    ];
    for (const title of topics) {
      awareness.addInsight({
        title,
        evidence: `Evidence for ${title}`,
        appliesWhen: [title.split(" ")[0].toLowerCase()],
        source: "test",
      });
    }
    let state = awareness.readAwarenessState();
    assert.equal(state.topInsights.length, 20);

    // 21st should trigger replacement
    const result = awareness.addInsight({
      title: "Completely novel Zig comptime metaprogramming",
      evidence: "Fresh evidence",
      appliesWhen: ["zig"],
      source: "test",
    });
    assert.equal(result.action, "replaced");
    state = awareness.readAwarenessState();
    assert.equal(state.topInsights.length, 20); // still 20, not 21
  });

  it("writeAwareness enforces 200-line max", () => {
    const longContent = Array.from({ length: 300 }, (_, i) => `Line ${i}`).join("\n");
    awareness.writeAwareness(longContent);
    const content = awareness.readAwareness();
    const lineCount = content.split("\n").length;
    assert.ok(lineCount <= 201, `Expected ≤201 lines, got ${lineCount}`);
  });

  it("renderAwareness includes all sections", () => {
    const state = awareness.readAwarenessState();
    awareness.renderAwareness(state);
    const content = awareness.readAwareness();
    assert.ok(content.includes("## Identity"));
    assert.ok(content.includes("## Top Insights"));
    assert.ok(content.includes("## Trajectory"));
    assert.ok(content.includes("## Blind Spots"));
  });

  it("detectCompoundInsights finds patterns across 3+ insights", () => {
    // Reset with fresh state
    awareness.initAwareness("test user");

    // Add 3 distinct insights sharing "deployment" keyword in appliesWhen
    // Titles must be completely different to avoid merge
    awareness.addInsight({
      title: "PostgreSQL migration rollback strategy",
      evidence: "Seen in prod incident",
      appliesWhen: ["deployment", "database"],
      source: "test",
    });
    awareness.addInsight({
      title: "Kubernetes canary release patterns",
      evidence: "From SRE handbook",
      appliesWhen: ["deployment", "kubernetes"],
      source: "test",
    });
    awareness.addInsight({
      title: "Terraform provider version pinning",
      evidence: "Broke staging once",
      appliesWhen: ["deployment", "infrastructure"],
      source: "test",
    });

    const state = awareness.readAwarenessState();
    assert.equal(state.topInsights.length, 3, "Should have 3 distinct insights");

    const compounds = awareness.detectCompoundInsights();
    assert.ok(compounds.length > 0, "Should detect 'deployment' compound");
    assert.ok(compounds[0].sourceInsights.length >= 3);
  });

  it("fetchDashboardArchivedTitles skips network when Supabase is not configured", async () => {
    const previousFetch = globalThis.fetch;
    const previousEnv = {
      AGENT_RECALL_SUPABASE_URL: process.env.AGENT_RECALL_SUPABASE_URL,
      AGENT_RECALL_SUPABASE_KEY: process.env.AGENT_RECALL_SUPABASE_KEY,
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    };
    delete process.env.AGENT_RECALL_SUPABASE_URL;
    delete process.env.AGENT_RECALL_SUPABASE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;

    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return { ok: true, json: async () => [{ title: "remote archived" }] };
    };

    try {
      const archived = await awareness.fetchDashboardArchivedTitles();
      assert.deepEqual(archived, []);
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = previousFetch;
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("fetchDashboardArchivedTitles uses AgentRecall Supabase config", async () => {
    const previousFetch = globalThis.fetch;
    fs.writeFileSync(path.join(TEST_ROOT, "config.json"), JSON.stringify({
      supabase_url: "https://configured.supabase.co",
      supabase_anon_key: "configured-key",
      sync_enabled: true,
    }));

    let requestedUrl = "";
    let requestedHeaders = {};
    globalThis.fetch = async (url, options) => {
      requestedUrl = String(url);
      requestedHeaders = options.headers;
      return { ok: true, json: async () => [{ title: "archived from config" }] };
    };

    try {
      const archived = await awareness.fetchDashboardArchivedTitles();
      assert.deepEqual(archived, ["archived from config"]);
      assert.equal(requestedUrl, "https://configured.supabase.co/rest/v1/ar_awareness?select=title&is_active=eq.false");
      assert.equal(requestedHeaders.apikey, "configured-key");
      assert.equal(requestedHeaders.Authorization, "Bearer configured-key");
    } finally {
      globalThis.fetch = previousFetch;
      fs.rmSync(path.join(TEST_ROOT, "config.json"), { force: true });
    }
  });
});

describe("Wave 3 — crystallization candidates", () => {
  let awareness;
  const ROOT = path.join(os.tmpdir(), "ar-crystallize-test-" + Date.now());

  before(async () => {
    process.env.AGENT_RECALL_ROOT = ROOT;
    awareness = await import("../dist/palace/awareness.js");
  });

  after(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it("returns [] when no awareness state exists", () => {
    // Fresh root, no state written yet.
    const candidates = awareness.findCrystallizationCandidates();
    assert.deepEqual(candidates, []);
  });

  it("clusters 3 insights sharing ≥2 appliesWhen keywords with enough confirmations", () => {
    awareness.initAwareness("crystallize user");
    // Three distinct insights sharing the keywords "deploy" + "rollback" in appliesWhen.
    // Bump confirmations by re-adding strongly-overlapping titles so sum >= 5.
    awareness.addInsight({
      title: "PostgreSQL migration must run before deploy rollback window",
      evidence: "prod incident A",
      appliesWhen: ["deploy", "rollback", "database"],
      source: "test",
    });
    awareness.addInsight({
      title: "Kubernetes canary needs deploy rollback automation",
      evidence: "sre handbook B",
      appliesWhen: ["deploy", "rollback", "kubernetes"],
      source: "test",
    });
    awareness.addInsight({
      title: "Terraform provider pin avoids deploy rollback churn",
      evidence: "staging break C",
      appliesWhen: ["deploy", "rollback", "infrastructure"],
      source: "test",
    });

    // Push total confirmations up so the cluster clears minTotalConfirm.
    const state = awareness.readAwarenessState();
    for (const ins of state.topInsights) ins.confirmations = 2;
    awareness.writeAwarenessState(state);

    const candidates = awareness.findCrystallizationCandidates({ minCluster: 3, minTotalConfirm: 5 });
    assert.ok(candidates.length >= 1, "should find at least one cluster");
    const cluster = candidates[0];
    assert.ok(cluster.size >= 3, `cluster size >= 3, got ${cluster.size}`);
    assert.ok(cluster.total_confirmations >= 5, `sum confirmations >= 5, got ${cluster.total_confirmations}`);
    assert.ok(Array.isArray(cluster.shared_keywords) && cluster.shared_keywords.length >= 2);
    assert.ok(Array.isArray(cluster.insight_ids) && cluster.insight_ids.length >= 3);
  });

  it("does not synthesize a principle string — candidates only", () => {
    const candidates = awareness.findCrystallizationCandidates({ minCluster: 3, minTotalConfirm: 5 });
    for (const c of candidates) {
      assert.equal(c.principle, undefined, "must NOT write a synthesized principle");
      assert.equal(c.synthesis, undefined, "must NOT write a synthesized principle");
    }
  });

  it("requires minTotalConfirm — under-confirmed clusters are dropped", () => {
    awareness.initAwareness("low confirm user");
    awareness.addInsight({ title: "Alpha deploy rollback alpha note", evidence: "e1", appliesWhen: ["deploy", "rollback"], source: "t" });
    awareness.addInsight({ title: "Beta deploy rollback beta note", evidence: "e2", appliesWhen: ["deploy", "rollback"], source: "t" });
    awareness.addInsight({ title: "Gamma deploy rollback gamma note", evidence: "e3", appliesWhen: ["deploy", "rollback"], source: "t" });
    // Each at 1 confirmation → sum = 3 < 5.
    const candidates = awareness.findCrystallizationCandidates({ minCluster: 3, minTotalConfirm: 5 });
    assert.equal(candidates.length, 0, "sum confirmations < 5 must yield no cluster");
  });

  it("excludes clusters whose insights are already CRYSTALLIZED/CRITICAL", () => {
    awareness.initAwareness("excluded user");
    awareness.addInsight({ title: "CRITICAL: deploy rollback gate one", evidence: "e1xx", appliesWhen: ["deploy", "rollback"], source: "t" });
    awareness.addInsight({ title: "CRYSTALLIZED deploy rollback gate two", evidence: "e2xx", appliesWhen: ["deploy", "rollback"], source: "t" });
    awareness.addInsight({ title: "CRITICAL deploy rollback gate three", evidence: "e3xx", appliesWhen: ["deploy", "rollback"], source: "t" });
    const state = awareness.readAwarenessState();
    for (const ins of state.topInsights) ins.confirmations = 3;
    awareness.writeAwarenessState(state);

    const candidates = awareness.findCrystallizationCandidates({ minCluster: 3, minTotalConfirm: 5 });
    assert.equal(candidates.length, 0, "already-crystallized/critical insights must be excluded");
  });
});
