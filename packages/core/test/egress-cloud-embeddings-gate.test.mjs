// packages/core/test/egress-cloud-embeddings-gate.test.mjs
//
// Regression for rigorous-eval 2026-10-15 §5 finding 1 (adversarial script
// scripts/eval/adversarial-2026-10-15/egress-ambient-openai-key.mjs): an
// AMBIENT OPENAI_API_KEY — set for any other tool on the machine, with zero
// AgentRecall opt-in — used to silently route every recall query's text and
// every remembered memory's content to api.openai.com/v1/embeddings via
// getRecallBackend() → LocalVectorRecallBackend.available() and
// smartRemember's fire-and-forget indexing → vector/embedding.ts embed().
//
// The fix: cloud embeddings require the EXPLICIT opt-in env
// AGENT_RECALL_CLOUD_EMBEDDINGS=1 (or "true") AND OPENAI_API_KEY. The key
// alone must never select the OpenAI backend or send a single byte to
// api.openai.com.
//
// Strategy: stub globalThis.fetch (no real network ever leaves this process,
// matching egress-guard.test.mjs's behavioral approach), run recall + remember
// against an isolated temp root, and count attempted calls to api.openai.com.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  smartRecall,
  smartRemember,
  resetRecallBackend,
  getRecallBackend,
  LocalVectorRecallBackend,
  cloudEmbeddingsEnabled,
  embed,
  setRoot,
  resetRoot,
} from "agent-recall-core";

const PROJECT = "egress-gate-fixture";

// ── fetch stub: record every attempted URL, never let anything out ──────────
const realFetch = globalThis.fetch;
let attemptedUrls = [];
const openaiCalls = () => attemptedUrls.filter((u) => u.includes("api.openai.com"));

function stubFetch() {
  attemptedUrls = [];
  globalThis.fetch = async (u) => {
    attemptedUrls.push(String(u));
    throw new Error("egress blocked by test stub");
  };
}

// ── env save/restore ─────────────────────────────────────────────────────────
const SAVED = {};
const ENV_KEYS = ["OPENAI_API_KEY", "AGENT_RECALL_CLOUD_EMBEDDINGS"];

let tmpRoot;

before(() => {
  for (const k of ENV_KEYS) SAVED[k] = process.env[k];
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ar-egress-gate-"));
  setRoot(tmpRoot);
  stubFetch();
});

after(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  globalThis.fetch = realFetch;
  resetRoot();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

beforeEach(() => {
  stubFetch();
  resetRecallBackend();
  delete process.env.OPENAI_API_KEY;
  delete process.env.AGENT_RECALL_CLOUD_EMBEDDINGS;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until at least one api.openai.com call is observed, or timeout. */
async function waitForOpenaiCall(timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (openaiCalls().length > 0) return true;
    await sleep(25);
  }
  return openaiCalls().length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
describe("cloudEmbeddingsEnabled() — opt-in truth table", () => {
  it("false with neither key nor flag", () => {
    assert.equal(cloudEmbeddingsEnabled(), false);
  });

  it("false with ambient OPENAI_API_KEY alone (the regression)", () => {
    process.env.OPENAI_API_KEY = "sk-fake-ambient-key-000000000000000000";
    assert.equal(cloudEmbeddingsEnabled(), false);
  });

  it("false with the flag alone (flag set but key missing — nothing to call with)", () => {
    process.env.AGENT_RECALL_CLOUD_EMBEDDINGS = "1";
    assert.equal(cloudEmbeddingsEnabled(), false);
  });

  it("false with flag set to a non-opt-in value", () => {
    process.env.OPENAI_API_KEY = "sk-fake-ambient-key-000000000000000000";
    process.env.AGENT_RECALL_CLOUD_EMBEDDINGS = "0";
    assert.equal(cloudEmbeddingsEnabled(), false);
    process.env.AGENT_RECALL_CLOUD_EMBEDDINGS = "yes";
    assert.equal(cloudEmbeddingsEnabled(), false);
  });

  it('true only with BOTH key and flag ("1" or "true")', () => {
    process.env.OPENAI_API_KEY = "sk-fake-ambient-key-000000000000000000";
    process.env.AGENT_RECALL_CLOUD_EMBEDDINGS = "1";
    assert.equal(cloudEmbeddingsEnabled(), true);
    process.env.AGENT_RECALL_CLOUD_EMBEDDINGS = "true";
    assert.equal(cloudEmbeddingsEnabled(), true);
  });
});

describe("ambient OPENAI_API_KEY, NO opt-in flag — zero egress", () => {
  it("embed() returns null without touching the network", async () => {
    process.env.OPENAI_API_KEY = "sk-fake-ambient-key-000000000000000000";
    const vec = await embed("this text must never leave the machine");
    assert.equal(vec, null);
    assert.equal(openaiCalls().length, 0, `expected 0 openai calls, saw: ${JSON.stringify(openaiCalls())}`);
  });

  it("LocalVectorRecallBackend.available() is false — the key alone no longer selects the backend", () => {
    process.env.OPENAI_API_KEY = "sk-fake-ambient-key-000000000000000000";
    assert.equal(new LocalVectorRecallBackend().available(), false);
  });

  it("getRecallBackend() does not select the vector backend on key alone", async () => {
    process.env.OPENAI_API_KEY = "sk-fake-ambient-key-000000000000000000";
    const backend = await getRecallBackend();
    assert.ok(!(backend instanceof LocalVectorRecallBackend), "ambient key must not select LocalVectorRecallBackend");
  });

  it("smartRecall() makes zero calls to api.openai.com", async () => {
    process.env.OPENAI_API_KEY = "sk-fake-ambient-key-000000000000000000";
    const res = await smartRecall({ query: "cache TTL decision", project: PROJECT, limit: 5 });
    assert.ok(res, "smartRecall must still resolve (keyword path)");
    assert.equal(openaiCalls().length, 0, `recall leaked to openai: ${JSON.stringify(openaiCalls())}`);
  });

  it("smartRemember() makes zero calls to api.openai.com (fire-and-forget indexing stays off)", async () => {
    process.env.OPENAI_API_KEY = "sk-fake-ambient-key-000000000000000000";
    const res = await smartRemember({
      content: "Decided to use Redis for the session cache with a 15 minute TTL.",
      project: PROJECT,
    });
    assert.equal(res.success, true);
    // The vector indexing path is fire-and-forget — give any stray async
    // chain time to fire before asserting silence.
    await sleep(400);
    assert.equal(openaiCalls().length, 0, `remember leaked to openai: ${JSON.stringify(openaiCalls())}`);
  });
});

describe("explicit opt-in (flag + key) — cloud embeddings allowed", () => {
  const optIn = () => {
    process.env.OPENAI_API_KEY = "sk-fake-ambient-key-000000000000000000";
    process.env.AGENT_RECALL_CLOUD_EMBEDDINGS = "1";
  };

  it("embed() attempts api.openai.com, and a fetch failure degrades to null (error path)", async () => {
    optIn();
    // The stub THROWS — this traces the fetch-throws error path end to end:
    // embed() must swallow it and return null, never propagate.
    const vec = await embed("opted-in text");
    assert.equal(vec, null, "fetch failure must degrade gracefully to null");
    assert.equal(openaiCalls().length, 1, `expected exactly 1 attempted openai call, saw: ${JSON.stringify(attemptedUrls)}`);
    assert.ok(openaiCalls()[0].includes("api.openai.com/v1/embeddings"));
  });

  it("LocalVectorRecallBackend becomes available and smartRecall attempts the embedding call", async () => {
    optIn();
    assert.equal(new LocalVectorRecallBackend().available(), true);
    const res = await smartRecall({ query: "cache TTL decision", project: PROJECT, limit: 5 });
    assert.ok(res, "smartRecall must still resolve when the embedding call fails (keyword fallback)");
    assert.ok(openaiCalls().length > 0, "opted-in recall should attempt the embedding call");
  });

  it("smartRemember's fire-and-forget indexing attempts the embedding call", async () => {
    optIn();
    const res = await smartRemember({
      content: "Opted-in memory: the deploy pipeline now gates on the smoke suite.",
      project: PROJECT,
    });
    assert.equal(res.success, true);
    assert.ok(await waitForOpenaiCall(), "opted-in remember should attempt the embedding call within 2s");
  });
});
