// packages/core/test/classification.test.mjs
//
// Wave 1 — Privacy classification + Supabase awareness-leak gate.
// Tests the pure classifier (single source of truth) and the single-source
// guarantee: every PERSONAL_STORES member must classify as "personal" so the
// sync gate in sync.ts catches it. Also exercises the live gate via env flag.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { setRoot, resetRoot } from "agent-recall-core";

describe("classification (Wave 1)", () => {
  it("classifyStore: awareness store => personal", async () => {
    const { classifyStore } = await import("agent-recall-core");
    assert.equal(classifyStore("awareness"), "personal");
  });

  it("classifyStore: journal/palace/digest stores => project", async () => {
    const { classifyStore } = await import("agent-recall-core");
    assert.equal(classifyStore("journal"), "project");
    assert.equal(classifyStore("palace"), "project");
    assert.equal(classifyStore("digest"), "project");
  });

  it("classifyStore: _global palace project => personal", async () => {
    const { classifyStore } = await import("agent-recall-core");
    // bootstrap path writes palace with project "_global"
    assert.equal(classifyStore("palace", { project: "_global" }), "personal");
  });

  it("classifyStore: ordinary project palace => project", async () => {
    const { classifyStore } = await import("agent-recall-core");
    assert.equal(classifyStore("palace", { project: "my-app" }), "project");
  });

  it("classifyStore: unknown store does NOT throw and defaults to project", async () => {
    const { classifyStore } = await import("agent-recall-core");
    // error-path trace: an unrecognized store value must be safe.
    assert.equal(classifyStore("totally-unknown"), "project");
    assert.equal(classifyStore(undefined), "project");
  });

  it("classifyPath: corrections => personal", async () => {
    const { classifyPath } = await import("agent-recall-core");
    assert.equal(
      classifyPath("/home/u/.agent-recall/projects/my-app/corrections/2026-06-20.md"),
      "personal"
    );
  });

  it("classifyPath: awareness file => personal", async () => {
    const { classifyPath } = await import("agent-recall-core");
    assert.equal(
      classifyPath("/home/u/.agent-recall/projects/_global/palace/awareness/state.json"),
      "personal"
    );
  });

  it("classifyPath: behavior-policies.json => personal", async () => {
    const { classifyPath } = await import("agent-recall-core");
    assert.equal(
      classifyPath("/home/u/.agent-recall/projects/my-app/behavior-policies.json"),
      "personal"
    );
  });

  it("classifyPath: _global project tree => personal", async () => {
    const { classifyPath } = await import("agent-recall-core");
    assert.equal(
      classifyPath("/home/u/.agent-recall/projects/_global/palace/rooms/goals/active.md"),
      "personal"
    );
  });

  it("classifyPath: personal/ tier => personal (future-proofing)", async () => {
    const { classifyPath } = await import("agent-recall-core");
    assert.equal(
      classifyPath("/home/u/.agent-recall/projects/my-app/personal/blind-spots.json"),
      "personal"
    );
  });

  it("classifyPath: ordinary palace room => project", async () => {
    const { classifyPath } = await import("agent-recall-core");
    assert.equal(
      classifyPath("/home/u/.agent-recall/projects/my-app/palace/rooms/goals/active.md"),
      "project"
    );
  });

  it("classifyPath: ordinary journal file => project", async () => {
    const { classifyPath } = await import("agent-recall-core");
    assert.equal(
      classifyPath("/home/u/.agent-recall/projects/my-app/journal/2026-06-20.md"),
      "project"
    );
  });

  it("isPersonalProject: only _global is personal", async () => {
    const { isPersonalProject } = await import("agent-recall-core");
    assert.equal(isPersonalProject("_global"), true);
    assert.equal(isPersonalProject("my-app"), false);
  });

  // ---- Single-source guarantee ----
  // Every PERSONAL_STORES member MUST classify as "personal" so the sync gate
  // catches it. If someone adds a personal store without it classifying
  // personal, this fails — the gate would silently leak it.
  it("single-source: every PERSONAL_STORES member classifies as personal", async () => {
    const { PERSONAL_STORES, classifyStore } = await import("agent-recall-core");
    assert.ok(PERSONAL_STORES instanceof Set, "PERSONAL_STORES must be a Set");
    assert.ok(PERSONAL_STORES.size >= 1, "PERSONAL_STORES must be non-empty");
    for (const store of PERSONAL_STORES) {
      assert.equal(
        classifyStore(store),
        "personal",
        `PERSONAL_STORES member "${store}" must classifyStore() => "personal" (sync gate coverage)`
      );
    }
  });
});

describe("config: sync_personal flag (Wave 1)", () => {
  let tmpDir;
  let origEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-syncpersonal-"));
    origEnv = { ...process.env };
    setRoot(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("AGENT_RECALL_")) delete process.env[key];
    }
    Object.assign(process.env, origEnv);
    resetRoot();
  });

  it("sync_personal defaults to false", async () => {
    const { readSupabaseConfig } = await import("agent-recall-core");
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({
        supabase_url: "https://test.supabase.co",
        supabase_anon_key: "key",
        embedding_provider: "openai",
        embedding_api_key: "sk-test",
        sync_enabled: true,
      })
    );
    const config = readSupabaseConfig();
    assert.equal(config.sync_personal, false);
  });

  it("sync_personal can be enabled via config.json", async () => {
    const { readSupabaseConfig } = await import("agent-recall-core");
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({
        supabase_url: "https://test.supabase.co",
        supabase_anon_key: "key",
        embedding_provider: "openai",
        embedding_api_key: "sk-test",
        sync_enabled: true,
        sync_personal: true,
      })
    );
    const config = readSupabaseConfig();
    assert.equal(config.sync_personal, true);
  });

  it("AGENT_RECALL_SYNC_PERSONAL env override beats config.json", async () => {
    const { readSupabaseConfig } = await import("agent-recall-core");
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({
        supabase_url: "https://test.supabase.co",
        supabase_anon_key: "key",
        embedding_provider: "openai",
        embedding_api_key: "sk-test",
        sync_enabled: true,
        sync_personal: false,
      })
    );
    process.env.AGENT_RECALL_SYNC_PERSONAL = "true";
    const config = readSupabaseConfig();
    assert.equal(config.sync_personal, true);
  });

  it("AGENT_RECALL_SYNC_PERSONAL=false env override forces false", async () => {
    const { readSupabaseConfig } = await import("agent-recall-core");
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({
        supabase_url: "https://test.supabase.co",
        supabase_anon_key: "key",
        embedding_provider: "openai",
        embedding_api_key: "sk-test",
        sync_enabled: true,
        sync_personal: true,
      })
    );
    process.env.AGENT_RECALL_SYNC_PERSONAL = "false";
    const config = readSupabaseConfig();
    assert.equal(config.sync_personal, false);
  });
});
