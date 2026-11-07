// packages/core/test/config.test.mjs
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { setRoot, resetRoot } from "agent-recall-core";

describe("Supabase config", () => {
  let tmpDir;
  let origEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-config-"));
    origEnv = { ...process.env };
    setRoot(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("AGENT_RECALL_")) delete process.env[key];
    }
    Object.assign(process.env, origEnv);
    resetRoot();
  });

  it("returns null when no config exists", async () => {
    const { readSupabaseConfig } = await import("agent-recall-core");
    const config = readSupabaseConfig();
    assert.equal(config, null);
  });

  it("reads config from config.json", async () => {
    const { readSupabaseConfig } = await import("agent-recall-core");
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({
      supabase_url: "https://test.supabase.co",
      supabase_anon_key: "eyJ-test",
      embedding_provider: "openai",
      embedding_api_key: "sk-test",
      sync_enabled: true,
    }));
    const config = readSupabaseConfig();
    assert.equal(config.supabase_url, "https://test.supabase.co");
    assert.equal(config.sync_enabled, true);
  });

  it("env vars override config.json", async () => {
    const { readSupabaseConfig } = await import("agent-recall-core");
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({
      supabase_url: "https://file.supabase.co",
      supabase_anon_key: "file-key",
      embedding_provider: "openai",
      embedding_api_key: "sk-file",
      sync_enabled: true,
    }));
    process.env.AGENT_RECALL_SUPABASE_URL = "https://env.supabase.co";
    process.env.AGENT_RECALL_SUPABASE_KEY = "env-key";
    const config = readSupabaseConfig();
    assert.equal(config.supabase_url, "https://env.supabase.co");
    assert.equal(config.supabase_secret_key, "env-key");
  });

  it("returns null when sync_enabled is false", async () => {
    const { readSupabaseConfig } = await import("agent-recall-core");
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({
      supabase_url: "https://test.supabase.co",
      supabase_anon_key: "key",
      embedding_provider: "openai",
      embedding_api_key: "sk-test",
      sync_enabled: false,
    }));
    const config = readSupabaseConfig();
    assert.equal(config, null);
  });
});

// ── Secret-key semantics (RLS hardening, 2026-11-07) ──────────────────────────

/** Build an unsigned JWT-shaped key with the given role (format only — never a real key). */
function fakeJwt(role) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase", role })}.c2lnbmF0dXJl`;
}

/** Run fn while capturing everything written to process.stderr. */
function captureStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  let out = "";
  process.stderr.write = (chunk, ...rest) => {
    out += String(chunk);
    return true;
  };
  try {
    const result = fn();
    return { result, out };
  } finally {
    process.stderr.write = orig;
  }
}

describe("Supabase key handling", () => {
  let tmpDir;
  let origEnv;
  let core;

  const writeCfg = (obj) =>
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({ supabase_url: "https://t.supabase.co", ...obj }));

  beforeEach(async () => {
    core = await import("agent-recall-core");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-config-key-"));
    origEnv = { ...process.env };
    delete process.env.AGENT_RECALL_SUPABASE_URL;
    delete process.env.AGENT_RECALL_SUPABASE_KEY;
    setRoot(tmpDir);
    core.resetSupabaseConfigWarnings();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("AGENT_RECALL_")) delete process.env[key];
    }
    Object.assign(process.env, origEnv);
    resetRoot();
    core.resetSupabaseConfigWarnings();
  });

  it("classifySupabaseKey: new-format and legacy JWT keys", () => {
    const { classifySupabaseKey } = core;
    assert.equal(classifySupabaseKey("sb_secret_abc123"), "secret");
    assert.equal(classifySupabaseKey("sb_publishable_abc123"), "public");
    assert.equal(classifySupabaseKey(fakeJwt("service_role")), "secret");
    assert.equal(classifySupabaseKey(fakeJwt("anon")), "public");
    assert.equal(classifySupabaseKey(fakeJwt("authenticated")), "public");
    assert.equal(classifySupabaseKey("eyJ-test"), "unknown");
    assert.equal(classifySupabaseKey("a.b.c"), "unknown", "undecodable JWT-shaped string must not throw");
    assert.equal(classifySupabaseKey(""), "unknown");
  });

  it("isJwtSupabaseKey: only legacy JWTs qualify for Authorization: Bearer", () => {
    assert.equal(core.isJwtSupabaseKey(fakeJwt("service_role")), true);
    assert.equal(core.isJwtSupabaseKey("sb_secret_abc123"), false);
  });

  it("reads supabase_secret_key from config.json with no warning", () => {
    writeCfg({ supabase_secret_key: "sb_secret_file" });
    const { result, out } = captureStderr(() => core.readSupabaseConfig());
    assert.equal(result.supabase_secret_key, "sb_secret_file");
    assert.equal(out, "");
  });

  it("supabase_secret_key wins over the legacy supabase_anon_key field", () => {
    writeCfg({ supabase_secret_key: "sb_secret_new", supabase_anon_key: "sb_secret_old" });
    const { result, out } = captureStderr(() => core.readSupabaseConfig());
    assert.equal(result.supabase_secret_key, "sb_secret_new");
    assert.equal(out, "", "legacy field present but unused → no deprecation noise");
  });

  it("legacy supabase_anon_key field still works, with a one-time deprecation notice", () => {
    writeCfg({ supabase_anon_key: "sb_secret_legacyfield" });
    const first = captureStderr(() => core.readSupabaseConfig());
    assert.equal(first.result.supabase_secret_key, "sb_secret_legacyfield");
    assert.match(first.out, /"supabase_anon_key" is deprecated/);
    assert.match(first.out, /supabase_secret_key/);
    const second = captureStderr(() => core.readSupabaseConfig());
    assert.equal(second.out, "", "warned once per process, not on every read");
  });

  it("AGENT_RECALL_SUPABASE_KEY overrides both file fields and suppresses the legacy-field notice", () => {
    writeCfg({ supabase_secret_key: "sb_secret_file", supabase_anon_key: "sb_secret_legacy" });
    process.env.AGENT_RECALL_SUPABASE_KEY = "sb_secret_env";
    const { result, out } = captureStderr(() => core.readSupabaseConfig());
    assert.equal(result.supabase_secret_key, "sb_secret_env");
    assert.equal(out, "");
  });

  for (const [label, publicKey] of [
    ["sb_publishable_ key", "sb_publishable_LEAKME123"],
    ["legacy anon JWT", fakeJwt("anon")],
  ]) {
    it(`a public ${label} still resolves (pre-migration installs keep syncing) but warns once, never echoing the key`, () => {
      process.env.AGENT_RECALL_SUPABASE_URL = "https://t.supabase.co";
      process.env.AGENT_RECALL_SUPABASE_KEY = publicKey;
      const first = captureStderr(() => core.readSupabaseConfig());
      assert.equal(first.result.supabase_secret_key, publicKey);
      assert.match(first.out, /PUBLIC anon\/publishable key/);
      assert.match(first.out, /sb_secret_/);
      assert.ok(!first.out.includes(publicKey), "the key value must never be logged");
      assert.ok(!first.out.includes(publicKey.split(".")[1] ?? publicKey), "no fragment of the key either");
      assert.equal(captureStderr(() => core.readSupabaseConfig()).out, "", "once per process");
    });
  }

  it("a public key in the legacy field gets the security warning (not just the rename notice)", () => {
    writeCfg({ supabase_anon_key: fakeJwt("anon") });
    const { out } = captureStderr(() => core.readSupabaseConfig());
    assert.match(out, /PUBLIC anon\/publishable key/);
  });

  it("isAllowedSupabaseUrl: https anywhere, http only to loopback, unparsable passes through", () => {
    const ok = core.isAllowedSupabaseUrl;
    assert.equal(ok("https://abc.supabase.co"), true);
    assert.equal(ok("https://supabase.example.internal"), true, "self-hosted over TLS is fine");
    assert.equal(ok("http://localhost:54321"), true);
    assert.equal(ok("http://127.0.0.1:54321"), true);
    assert.equal(ok("http://[::1]:54321"), true);
    assert.equal(ok("http://abc.supabase.co"), false);
    assert.equal(ok("http://localhost.evil.com"), false);
    assert.equal(ok("ftp://abc.supabase.co"), false);
    assert.equal(ok("::::not-a-valid-url"), true, "left to the client's own logged error path");
  });

  it("a plain-http remote URL disables sync (secret key never sent in clear) and warns once", () => {
    process.env.AGENT_RECALL_SUPABASE_URL = "http://abc.supabase.co";
    process.env.AGENT_RECALL_SUPABASE_KEY = "sb_secret_cleartext";
    const first = captureStderr(() => core.readSupabaseConfig());
    assert.equal(first.result, null);
    assert.match(first.out, /sync DISABLED: supabase_url must use https/);
    assert.ok(!first.out.includes("sb_secret_cleartext"));
    assert.equal(captureStderr(() => core.readSupabaseConfig()).out, "", "once per process");
  });

  it("writeSupabaseConfig writes supabase_secret_key, drops the legacy field, and round-trips", () => {
    core.writeSupabaseConfig({
      supabase_url: "https://w.supabase.co",
      supabase_secret_key: "sb_secret_written",
      supabase_anon_key: "should-not-persist",
      embedding_provider: "openai",
      embedding_api_key: "",
      sync_enabled: true,
      sync_personal: false,
      sync_corrections: false,
    });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "config.json"), "utf-8"));
    assert.equal(raw.supabase_secret_key, "sb_secret_written");
    assert.equal("supabase_anon_key" in raw, false);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(path.join(tmpDir, "config.json")).mode & 0o777, 0o600, "secret-bearing file is owner-only");
    }
    assert.equal(core.readSupabaseConfig().supabase_secret_key, "sb_secret_written");
  });
});
