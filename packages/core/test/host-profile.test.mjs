import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveHostProfile, lifecycleInstructions, isHookOwnedHost } from "../dist/host-profile.js";

// Env keys this suite touches — snapshot + restore around every test so we
// never leak state into other test files sharing this `node --test` process
// (this repo's dev/CI environment may itself set CLAUDECODE=1).
const TOUCHED_KEYS = ["AR_HOST", "CLAUDECODE"];
const CLAUDE_CODE_PREFIX = "CLAUDE_CODE_";

let snapshot;

beforeEach(() => {
  snapshot = {};
  for (const key of TOUCHED_KEYS) snapshot[key] = process.env[key];
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(CLAUDE_CODE_PREFIX)) snapshot[key] = process.env[key];
  }
  // Clear the ambient signals so every test starts from a known-clean slate.
  for (const key of Object.keys(snapshot)) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resolveHostProfile — explicit AR_HOST override", () => {
  it("claude-code resolves to Tier A / hook-driven", () => {
    process.env["AR_HOST"] = "claude-code";
    const profile = resolveHostProfile();
    assert.deepEqual(profile, { host: "claude-code", tier: "A", lifecycle: "hook-driven" });
  });

  for (const host of ["codex", "cursor", "raw", "openclaw", "chatbox", "generic"]) {
    it(`${host} resolves to Tier B / agent-driven`, () => {
      process.env["AR_HOST"] = host;
      const profile = resolveHostProfile();
      assert.deepEqual(profile, { host, tier: "B", lifecycle: "agent-driven" });
    });
  }

  for (const host of ["sdk", "cli"]) {
    it(`${host} resolves to Tier C / manual`, () => {
      process.env["AR_HOST"] = host;
      const profile = resolveHostProfile();
      assert.deepEqual(profile, { host, tier: "C", lifecycle: "manual" });
    });
  }

  it("an unrecognized explicit AR_HOST value defaults conservatively to Tier B, never Tier A", () => {
    process.env["AR_HOST"] = "some-future-host-nobody-classified-yet";
    const profile = resolveHostProfile();
    assert.equal(profile.host, "some-future-host-nobody-classified-yet");
    assert.equal(profile.tier, "B");
    assert.equal(profile.lifecycle, "agent-driven");
  });

  it("AR_HOST is case- and whitespace-insensitive", () => {
    process.env["AR_HOST"] = "  Claude-Code  ";
    const profile = resolveHostProfile();
    assert.equal(profile.tier, "A");
  });

  it("AR_HOST wins even when CLAUDECODE is also set (explicit override always wins)", () => {
    process.env["AR_HOST"] = "codex";
    process.env["CLAUDECODE"] = "1";
    const profile = resolveHostProfile();
    assert.equal(profile.tier, "B");
    assert.equal(profile.host, "codex");
  });
});

describe("resolveHostProfile — best-effort inference (no AR_HOST)", () => {
  it("CLAUDECODE=1 present infers Tier A", () => {
    process.env["CLAUDECODE"] = "1";
    const profile = resolveHostProfile();
    assert.equal(profile.tier, "A");
    assert.equal(profile.host, "claude-code");
  });

  it("any CLAUDE_CODE_* env var present infers Tier A even without CLAUDECODE itself", () => {
    process.env["CLAUDE_CODE_SESSION_ID"] = "abc123";
    const profile = resolveHostProfile();
    assert.equal(profile.tier, "A");
  });

  it("no AR_HOST and no Claude Code signal infers Tier B (conservative MCP default)", () => {
    const profile = resolveHostProfile();
    assert.equal(profile.tier, "B");
    assert.equal(profile.lifecycle, "agent-driven");
  });
});

describe("isHookOwnedHost — H1 single exported gate predicate", () => {
  it("true when CLAUDECODE=1 is present (Tier A)", () => {
    process.env["CLAUDECODE"] = "1";
    assert.equal(isHookOwnedHost(), true);
  });

  it("true when any CLAUDE_CODE_* var is present, even without CLAUDECODE itself", () => {
    process.env["CLAUDE_CODE_SESSION_ID"] = "abc123";
    assert.equal(isHookOwnedHost(), true);
  });

  it("false with no signal at all (conservative MCP default)", () => {
    assert.equal(isHookOwnedHost(), false);
  });

  it("false when AR_HOST explicitly overrides to a non-hook host, even with CLAUDECODE also set", () => {
    process.env["AR_HOST"] = "codex";
    process.env["CLAUDECODE"] = "1";
    assert.equal(isHookOwnedHost(), false, "explicit AR_HOST override must win — a raw CLAUDECODE inline check would get this wrong");
  });

  it("true when AR_HOST explicitly says claude-code", () => {
    process.env["AR_HOST"] = "claude-code";
    assert.equal(isHookOwnedHost(), true);
  });
});

describe("lifecycleInstructions — canonical per-tier text", () => {
  it("Tier B text contains the 'YOU drive its lifecycle' carrier sentinel", () => {
    const text = lifecycleInstructions("B");
    assert.ok(text.includes("YOU drive its lifecycle"));
    assert.ok(text.includes("session_start"));
    assert.ok(text.includes("session_end"));
  });

  it("Tier A text notes hooks drive entry/exit and that agent calls remain safe/idempotent", () => {
    const text = lifecycleInstructions("A");
    assert.ok(/hook/i.test(text));
    assert.ok(/idempotent|safe to call/i.test(text));
    // Tier A should not claim the agent is the SOLE driver — that's the Tier B claim.
    assert.ok(!text.includes("YOU drive its lifecycle"));
  });

  it("Tier C text describes a manual SDK/CLI integration with no MCP session", () => {
    const text = lifecycleInstructions("C");
    assert.ok(/sdk|cli/i.test(text));
    assert.ok(text.includes("session_start"));
    assert.ok(text.includes("session_end"));
  });

  it("each tier's text is distinct", () => {
    const a = lifecycleInstructions("A");
    const b = lifecycleInstructions("B");
    const c = lifecycleInstructions("C");
    assert.notEqual(a, b);
    assert.notEqual(b, c);
    assert.notEqual(a, c);
  });
});
