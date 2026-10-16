#!/usr/bin/env node
/**
 * egress-ambient-openai-key.mjs — proves that an AMBIENT OPENAI_API_KEY
 * (no AgentRecall opt-in flag of any kind) silently routes every recall
 * query's text to api.openai.com/v1/embeddings.
 *
 * Chain: smart-recall.ts:1116 getRecallBackend() →
 * recall-backend.ts:124-129 LocalVectorRecallBackend.available() =
 * !!process.env.OPENAI_API_KEY → vector/embedding.ts fetch().
 *
 * fetch is stubbed — no real network leaves this process.
 */
import * as url from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "oai-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const store = fs.mkdtempSync(path.join(os.tmpdir(), "oai-store-"));
fs.cpSync(path.join(REPO, "scripts/eval/fixtures/golden-v1"), store, { recursive: true });
process.env.AGENT_RECALL_ROOT = store;
process.env.OPENAI_API_KEY = "sk-fake-key-for-egress-test-000000000000";

const calls = [];
globalThis.fetch = async (u) => {
  calls.push(String(u));
  throw new Error("egress blocked by test");
};

const core = await import(url.pathToFileURL(path.join(REPO, "packages/core/dist/index.js")).href);
const res = await core.smartRecall({ query: "cache TTL decision", project: "alpha-platform", limit: 5 });
console.log("network calls attempted:", JSON.stringify(calls));
console.log("egress with ambient key, zero opt-in:", calls.length > 0 ? "CONFIRMED" : "not observed");
console.log("results after local fallback:", res.results.length);
process.exit(calls.length > 0 ? 0 : 1);
