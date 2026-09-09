// packages/core/test/recall-path-truthful-label.test.mjs
//
// PRE-SHIP FIX-BATCH (2026-09-09) — F-1.
//
// Bug: smartRecall()'s remote-fusion branch (see recall-remote-fusion.test.mjs
// for the rest of that wave's coverage) sets `recall_path = "remote"`
// whenever the fusion flag is on and the fusion preconditions are unmet
// (`localResults.length > 0 && remoteResults.length > 0` failed), REGARDLESS
// of which side's data actually ended up in `results`. The pre-existing
// ternary (`results = remoteResults.length > 0 ? remoteResults : localResults`)
// correctly falls back to LOCAL data when remote resolves empty, but the
// label right below it was unconditional — so a caller reading `recall_path`
// would see "remote" even though every item in `results` came from the local
// pipeline. This is a lie an observability field must never tell.
//
// Fix: `recall_path` must reflect which side's data is actually in `results`:
//   - "fused": both sides non-empty, fuseRemoteWithLocal() ran (unchanged).
//   - "remote": remote answered non-empty and its data is what's returned
//     (unchanged — see recall-remote-fusion.test.mjs's own "flag ON but
//     local side is empty" case, which is the genuine, still-correct use of
//     this label and must stay green).
//   - "local" (NEW): remote answered (no timeout) but was EMPTY — including
//     the both-empty case — so `results` is local data (possibly itself
//     empty). Never "remote" here.
//   - "local-timeout": remote timed out/errored (unchanged).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  setRoot,
  resetRoot,
  smartRecall,
  getRecallBackend,
  resetRecallBackend,
  resetSupabaseClient,
} from "agent-recall-core";

let tmpDir;
let savedEnv;

const ENV_KEYS = [
  "AGENT_RECALL_SUPABASE_URL",
  "AGENT_RECALL_SUPABASE_KEY",
  "AGENT_RECALL_EMBEDDING_KEY",
  "AGENT_RECALL_RECALL_FUSION",
  "AGENT_RECALL_RECALL_BUDGET_MS",
];

function saveEnv(keys) {
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  return saved;
}
function restoreEnv(saved) {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-recall-path-truthful-"));
  setRoot(tmpDir);
  savedEnv = saveEnv(ENV_KEYS);
});

afterEach(() => {
  resetRecallBackend();
  resetSupabaseClient();
  restoreEnv(savedEnv);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  resetRoot();
});

async function installMockedRemoteBackend(searchImpl) {
  process.env.AGENT_RECALL_SUPABASE_URL = "https://fixture.invalid.supabase.co";
  process.env.AGENT_RECALL_SUPABASE_KEY = "fixture-anon-key";
  process.env.AGENT_RECALL_EMBEDDING_KEY = "fixture-embed-key";
  resetRecallBackend();
  resetSupabaseClient();
  const backend = await getRecallBackend();
  assert.equal(backend.constructor.name, "SupabaseRecallBackend");
  backend.search = searchImpl;
  return backend;
}

describe("F-1: recall_path is truthful about which side's data populated `results`", () => {
  it("flag ON, remote resolves EMPTY, local has data — recall_path must say the truth, never 'remote'", async () => {
    const project = "recall-path-remote-empty-local-hit";
    const trigger = "unique-truthful-label-trigger-xyz";

    // Seed a local journal hit so localRecallSearch has something to find.
    const { journalDir } = await import("agent-recall-core");
    const jdir = journalDir(project);
    fs.mkdirSync(jdir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(jdir, `${today}.md`), `## notes\nlocal-only mention of ${trigger}\n`, "utf-8");

    await installMockedRemoteBackend(async () => []); // remote resolves EMPTY, not a timeout
    process.env.AGENT_RECALL_RECALL_FUSION = "1";

    const result = await smartRecall({ query: trigger, project, limit: 10, drilldown: false });
    assert.notEqual(result.recall_path, "remote", `recall_path must not claim "remote" when remote returned nothing and local data was used, got: ${result.recall_path}`);
    assert.ok(result.results.some((r) => r.excerpt.includes(trigger)), "the local hit must be present in results");
  });

  it("flag ON, BOTH remote and local resolve empty — recall_path must not say 'remote' either", async () => {
    const project = "recall-path-both-empty";
    await installMockedRemoteBackend(async () => []);
    process.env.AGENT_RECALL_RECALL_FUSION = "1";

    const result = await smartRecall({ query: "nonexistent-term-nothing-here", project, limit: 10 });
    assert.notEqual(result.recall_path, "remote", `recall_path must not claim "remote" when nothing came from remote, got: ${result.recall_path}`);
    assert.equal(result.results.length, 0);
  });

  it("REGRESSION GUARD: flag ON, remote has data, local is empty — recall_path='remote' is still correct here", async () => {
    const project = "recall-path-remote-genuinely-answers";
    const remoteFixture = [{ id: "r1", source: "palace", title: "R", excerpt: "r excerpt", score: 0.5, confidence: "high", calibrated: 0.8 }];
    await installMockedRemoteBackend(async () => remoteFixture);
    process.env.AGENT_RECALL_RECALL_FUSION = "1";
    const result = await smartRecall({ query: "nonexistent-term-xyz-regression", project, limit: 10 });
    assert.equal(result.recall_path, "remote", "remote genuinely answered and its data is what's returned — this label must stay correct");
    assert.deepEqual(result.results, remoteFixture);
  });
});
