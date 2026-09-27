import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

// RuntimeContext isolation (ADR-001 rev2 R2.9, G1-root-sdk.md). Un-todo'd
// sibling of packages/sdk/test/audit-sdk-contract.test.mjs's Case B: this
// file exercises the CORE seam directly (createMemoryRuntime + the
// AsyncLocalStorage-based getRoot()) rather than through the SDK wrapper.

describe("RuntimeContext isolation", () => {
  let runtimeMod;
  let typesMod;
  let clientMod;
  let recallBackendMod;
  let rootA;
  let rootB;

  before(async () => {
    runtimeMod = await import("../dist/repository/runtime.js");
    typesMod = await import("../dist/types.js");
    clientMod = await import("../dist/supabase/client.js");
    recallBackendMod = await import("../dist/tools-logic/recall-backend.js");
  });

  beforeEach(() => {
    rootA = fs.mkdtempSync(path.join(os.tmpdir(), "ar-repo-iso-A-"));
    rootB = fs.mkdtempSync(path.join(os.tmpdir(), "ar-repo-iso-B-"));
  });

  afterEach(() => {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
    clientMod.resetSupabaseClient();
    recallBackendMod.resetRecallBackend();
  });

  function principal(id) {
    return { principal_id: `local:${id}`, owner_id: `local:${id}`, kind: "user", auth: "local" };
  }

  it("2 runtimes, 2 roots, >=50 interleaved async calls incl. fire-and-forget + setImmediate + a thrown error branch -> 0 cross-root files", async () => {
    const { createMemoryRuntime } = runtimeMod;
    const rtA = createMemoryRuntime({ root: rootA, mode: "local" }, principal("a"));
    const rtB = createMemoryRuntime({ root: rootB, mode: "local" }, principal("b"));
    const wsId = crypto.randomUUID();

    const expectedA = new Set();
    const expectedB = new Set();

    function makeCreate(rt, useA, i) {
      const id = crypto.randomUUID();
      const opId = crypto.randomUUID();
      const p = useA ? principal("a") : principal("b");
      (useA ? expectedA : expectedB).add(id);
      // fire-and-forget: the returned promise is NOT awaited by the caller
      // of rt.run() below — it resolves later, via setImmediate, exactly the
      // class of leak G1 Scenario 3 documents (supabase/sync.ts:94-105).
      return rt.run(() => new Promise((resolve, reject) => {
        setImmediate(async () => {
          try {
            const receipt = await rt.repository.mutate(
              { op: "create", id, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: `hello ${i}`, authority: "agent_inference" },
              null, opId, { principal: p, channel: "sdk" },
            );
            resolve(receipt);
          } catch (err) {
            reject(err);
          }
        });
      }));
    }

    const calls = [];
    for (let i = 0; i < 60; i++) {
      calls.push(makeCreate(i % 2 === 0 ? rtA : rtB, i % 2 === 0, i));
    }
    // A thrown-error branch: run() must propagate the throw without leaving
    // ALS in a bad state for whatever runs next (Node's ALS restores the
    // outer store on throw same as a normal return).
    calls.push(
      rtA.run(() => { throw new Error("intentional isolation-test throw"); })
        .then(() => { throw new Error("expected the run() call to reject"); })
        .catch((err) => {
          assert.equal(err.message, "intentional isolation-test throw");
        }),
    );
    // One more real write AFTER the throwing call, on the SAME runtime, to
    // prove the throw didn't corrupt rtA's context for subsequent calls.
    calls.push(makeCreate(rtA, true, "post-throw"));

    const settled = await Promise.allSettled(calls);
    const rejected = settled.filter((s) => s.status === "rejected");
    assert.equal(rejected.length, 0, `expected 0 rejected calls, got: ${rejected.map((r) => r.reason?.message).join("; ")}`);

    await rtA.close();
    await rtB.close();

    const recordsA = new Set(fs.readdirSync(path.join(rootA, "repo", "records")).map((f) => f.replace(/\.json$/, "")));
    const recordsB = new Set(fs.readdirSync(path.join(rootB, "repo", "records")).map((f) => f.replace(/\.json$/, "")));

    assert.equal(recordsA.size, expectedA.size, "rootA should hold exactly the records created via rtA");
    assert.equal(recordsB.size, expectedB.size, "rootB should hold exactly the records created via rtB");
    for (const id of expectedA) assert.ok(recordsA.has(id), `rootA missing its own record ${id}`);
    for (const id of expectedB) assert.ok(recordsB.has(id), `rootB missing its own record ${id}`);
    // The core assertion: zero cross-root contamination in either direction.
    for (const id of expectedA) assert.ok(!recordsB.has(id), `CROSS-ROOT LEAK: rtA's record ${id} landed in rootB`);
    for (const id of expectedB) assert.ok(!recordsA.has(id), `CROSS-ROOT LEAK: rtB's record ${id} landed in rootA`);
  });

  it("strict mode: getRoot() outside run() throws NoRuntimeContextError once a runtime has been created", () => {
    // Strict mode is sticky process-wide once ANY MemoryRuntime has been
    // created in this process (R2.9) — the previous test already created
    // one, so this assertion holds regardless of test execution order within
    // this file (node:test runs a file's tests in one process/worker).
    assert.throws(
      () => typesMod.getRoot(),
      (err) => err instanceof runtimeMod.NoRuntimeContextError || err.name === "NoRuntimeContextError",
      "getRoot() outside any runtime.run() must throw NoRuntimeContextError once strict mode is engaged",
    );
  });

  it("singleton crossing: supabase client + recall backend are keyed per context, not process-global", async () => {
    const { createMemoryRuntime } = runtimeMod;
    // embedding_api_key present (fake, no network call — SupabaseRecallBackend
    // .available() only checks truthiness, .search() is never invoked here)
    // so getRecallBackend() picks SupabaseRecallBackend for either context
    // absent a tripped breaker — that's the signal the assertions below use.
    fs.writeFileSync(path.join(rootA, "config.json"), JSON.stringify({ supabase_url: "https://fake-a.supabase.co", supabase_anon_key: "anon-key-a", embedding_api_key: "fake-embed-key-a" }));
    fs.writeFileSync(path.join(rootB, "config.json"), JSON.stringify({ supabase_url: "https://fake-b.supabase.co", supabase_anon_key: "anon-key-b", embedding_api_key: "fake-embed-key-b" }));

    const rtA = createMemoryRuntime({ root: rootA, mode: "local" }, principal("a"));
    const rtB = createMemoryRuntime({ root: rootB, mode: "local" }, principal("b"));

    // G1 S2 (supabase client): constructing/using rtB must NOT pin rtA's
    // client to rootB's (or vice versa) — each context's config.json is
    // resolved and cached independently.
    const clientA = await rtA.run(() => clientMod.getSupabaseClient());
    const clientB = await rtB.run(() => clientMod.getSupabaseClient());
    assert.ok(clientA, "rootA has a supabase config and should produce a client");
    assert.ok(clientB, "rootB has a supabase config and should produce a client");
    assert.notStrictEqual(clientA, clientB, "each context must get its OWN client instance");
    assert.equal(clientA.supabaseUrl, "https://fake-a.supabase.co/");
    assert.equal(clientB.supabaseUrl, "https://fake-b.supabase.co/");
    // Re-fetching under the SAME context returns the cached instance (no
    // needless reconstruction) — proves this is a real per-context cache,
    // not "construct fresh every time" (which would also pass the
    // notStrictEqual check above for the wrong reason).
    const clientAAgain = await rtA.run(() => clientMod.getSupabaseClient());
    assert.strictEqual(clientA, clientAAgain, "same context should reuse its cached client");

    // G1 S3/S4 (recall backend + breaker): tripping rtA's breaker must not
    // affect rtB's backend selection.
    await rtA.run(async () => {
      recallBackendMod.recordRemoteFailure();
      recallBackendMod.recordRemoteFailure(); // BREAKER_THRESHOLD = 2 -> tripped for rtA's context only
    });
    const backendA = await rtA.run(() => recallBackendMod.getRecallBackend());
    const backendB = await rtB.run(() => recallBackendMod.getRecallBackend());
    assert.equal(backendA.constructor.name, "LocalRecallBackend", "rtA's breaker should have forced local fallback");
    // rtB never recorded a failure — its own breaker must be untouched, so it
    // should still pick the (embedding-key-backed) Supabase backend.
    assert.equal(backendB.constructor.name, "SupabaseRecallBackend", "rtB's breaker must be independent of rtA's");

    await rtA.close();
    await rtB.close();
  });
});
