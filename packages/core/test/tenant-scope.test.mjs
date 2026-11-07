/**
 * tenant-scope.test.mjs — hosted multi-tenant isolation in core.
 *
 * One server process serves many users; each request runs in withTenant().
 * Inside a tenant scope, nothing process-global or tied to the server's OS user
 * may leak in: root, session id, default project, legacy ~/.claude scans,
 * Supabase (process-wide singletons + env overrides), cloud embeddings.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as core from "../dist/index.js";
import { readSupabaseConfig } from "../dist/supabase/config.js";
import { cloudEmbeddingsEnabled } from "../dist/vector/embedding.js";
import { detectProject } from "../dist/storage/project.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let base;
let rootA;
let rootB;
const ctx = (root, sid, defaultProject = "main") => ({ root, sid, defaultProject });

before(() => {
  base = fs.mkdtempSync(path.join(tmpdir(), "ar-tenant-"));
  rootA = path.join(base, "tenants", "alice");
  rootB = path.join(base, "tenants", "bob");
  fs.mkdirSync(rootA, { recursive: true });
  fs.mkdirSync(rootB, { recursive: true });
});
after(() => fs.rmSync(base, { recursive: true, force: true }));

describe("withTenant — scope", () => {
  it("getRoot / getSessionId / isTenantScoped follow the tenant, and revert after", () => {
    const outsideRoot = core.getRoot();
    core.withTenant(ctx(rootA, "a1a1a1"), () => {
      assert.equal(core.getRoot(), path.resolve(rootA));
      assert.equal(core.getSessionId(), "a1a1a1");
      assert.equal(core.isTenantScoped(), true);
    });
    assert.equal(core.isTenantScoped(), false);
    assert.equal(core.getRoot(), outsideRoot);
  });

  it("tenant root wins over an enclosing withRoot and over AGENT_RECALL_ROOT", () => {
    const prev = process.env.AGENT_RECALL_ROOT;
    process.env.AGENT_RECALL_ROOT = path.join(base, "server-default");
    try {
      core.withRoot(path.join(base, "other"), () => {
        core.withTenant(ctx(rootB, "b2b2b2"), () => assert.equal(core.getRoot(), path.resolve(rootB)));
      });
    } finally {
      if (prev === undefined) delete process.env.AGENT_RECALL_ROOT; else process.env.AGENT_RECALL_ROOT = prev;
    }
  });

  it("interleaved async tenants never see each other's root or sid", async () => {
    const seen = [];
    const run = (root, sid) => core.withTenant(ctx(root, sid), async () => {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, Math.random() * 3));
        seen.push([sid, core.getRoot(), core.getSessionId()]);
      }
    });
    await Promise.all([run(rootA, "aaaaaa"), run(rootB, "bbbbbb")]);
    for (const [sid, root, gotSid] of seen) {
      assert.equal(gotSid, sid);
      assert.equal(root, path.resolve(sid === "aaaaaa" ? rootA : rootB));
    }
  });

  it("rejects malformed contexts (server bug → loud)", () => {
    assert.throws(() => core.withTenant(ctx("relative/root", "aaaaaa"), () => {}));
    assert.throws(() => core.withTenant(ctx(rootA, "../evil"), () => {}));
    assert.throws(() => core.withTenant(ctx(rootA, "aaaaaa", "../x"), () => {}));
  });
});

describe("withTenant — server-user state is switched off", () => {
  it("legacy ~/.claude/projects scan points inside the tenant root (non-existent)", () => {
    core.withTenant(ctx(rootA, "aaaaaa"), () => {
      const legacy = core.getLegacyRoot();
      assert.ok(legacy.startsWith(path.resolve(rootA)));
      assert.equal(fs.existsSync(legacy), false);
    });
  });

  it("Supabase config is null even with env overrides set", () => {
    const keys = ["AGENT_RECALL_SUPABASE_URL", "AGENT_RECALL_SUPABASE_KEY"];
    const prev = keys.map((k) => process.env[k]);
    process.env.AGENT_RECALL_SUPABASE_URL = "https://example.supabase.co";
    process.env.AGENT_RECALL_SUPABASE_KEY = "server-operator-key";
    try {
      assert.notEqual(readSupabaseConfig(), null, "precondition: env alone configures Supabase outside a tenant");
      core.withTenant(ctx(rootA, "aaaaaa"), () => assert.equal(readSupabaseConfig(), null));
    } finally {
      keys.forEach((k, i) => (prev[i] === undefined ? delete process.env[k] : (process.env[k] = prev[i])));
    }
  });

  it("cloud embeddings are off even when the operator opted in", () => {
    const prev = [process.env.AGENT_RECALL_CLOUD_EMBEDDINGS, process.env.OPENAI_API_KEY];
    process.env.AGENT_RECALL_CLOUD_EMBEDDINGS = "1";
    process.env.OPENAI_API_KEY = "sk-operator";
    try {
      assert.equal(cloudEmbeddingsEnabled(), true);
      core.withTenant(ctx(rootA, "aaaaaa"), () => assert.equal(cloudEmbeddingsEnabled(), false));
    } finally {
      ["AGENT_RECALL_CLOUD_EMBEDDINGS", "OPENAI_API_KEY"].forEach((k, i) =>
        prev[i] === undefined ? delete process.env[k] : (process.env[k] = prev[i]));
    }
  });

  it("project 'auto' resolves to the tenant default, ignoring server env and cwd", async () => {
    const prev = process.env.AGENT_RECALL_PROJECT;
    process.env.AGENT_RECALL_PROJECT = "server-operator-project";
    try {
      const p = await core.withTenant(ctx(rootA, "aaaaaa", "alice-main"), () => detectProject());
      assert.equal(p, "alice-main");
    } finally {
      if (prev === undefined) delete process.env.AGENT_RECALL_PROJECT; else process.env.AGENT_RECALL_PROJECT = prev;
    }
  });
});

describe("withTenant — end-to-end store isolation through public tools", () => {
  it("a memory written by tenant A is never recalled by tenant B", async () => {
    const marker = "zebra-quokka-" + Math.random().toString(16).slice(2);
    await core.withTenant(ctx(rootA, "aaaaaa"), () =>
      core.remember({ content: `Alice secret fact ${marker}`, project: "main" }));
    const hitsA = await core.withTenant(ctx(rootA, "aaaaab"), () => core.smartRecall({ query: marker, project: "main" }));
    const hitsB = await core.withTenant(ctx(rootB, "bbbbbb"), () => core.smartRecall({ query: marker, project: "main" }));
    const text = (r) => JSON.stringify(r);
    assert.match(text(hitsA.results), new RegExp(marker), "tenant A must recall its own memory");
    assert.doesNotMatch(text(hitsB.results), new RegExp(marker), "tenant B must never see tenant A's memory");
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    assert.ok(walk(rootB).every((f) => !fs.readFileSync(f, "utf-8").includes(marker)), "no A content on B's disk");
  });
});

describe("strict tenant mode", () => {
  it("getRoot() outside a tenant scope throws once strict mode is on (child process)", () => {
    const script = `
      import * as core from ${JSON.stringify(path.join(here, "..", "dist", "index.js").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"))};
      core.enableStrictTenantMode();
      let threw = false;
      try { core.getRoot(); } catch { threw = true; }
      const inside = core.withTenant({ root: ${JSON.stringify(rootA)}, sid: "aaaaaa", defaultProject: "main" }, () => core.getRoot());
      console.log(JSON.stringify({ threw, inside }));
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf-8" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.equal(out.threw, true);
    assert.equal(out.inside, path.resolve(rootA));
  });
});
