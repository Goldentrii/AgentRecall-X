import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

// Review B1 (WP-P1-review.md #1, CRITICAL): get()/history()/getOperation()/
// recordOutcome() take a bare `id`/`operationId` straight from the caller
// with NO isUuid() gate before it reaches path.join() — unlike mutate(),
// which always runs validateCommand() (isUuid(cmd.id)) first. A path-shaped
// id can read (or, for recordOutcome, act on) a file outside records/.

describe("B1: path traversal via unvalidated bare ids", () => {
  let runtimeMod;
  let root;
  let rt;
  let owner;

  before(async () => { runtimeMod = await import("../dist/repository/runtime.js"); });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ar-path-trav-"));
    owner = { principal_id: "local:owner", owner_id: "local:owner", kind: "user", auth: "local" };
    rt = runtimeMod.createMemoryRuntime({ root, mode: "local" }, owner);
  });

  afterEach(async () => {
    await rt.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function readCtx() { return { principal: owner, channel: "sdk" }; }

  it("plants a secret file outside records/ and confirms it is NOT readable via a path-traversal id", async () => {
    // Force repo/ to exist, then plant a file OUTSIDE records/ shaped like a
    // MemoryRecord an owner could read.
    const planted = {
      id: "planted-secret", owner_id: owner.owner_id, workspace_id: crypto.randomUUID(), project_id: null,
      kind: "fact", visibility: "private", content: "TOP SECRET — should never be readable via get()",
      content_hash: "x", metadata: {}, authority: "explicit_user", status: "active", revision: 1,
      source: { principal_id: owner.principal_id, captured_at: new Date().toISOString(), channel: "sdk" },
      evidence_refs: [], derived_from: [], derived_closure: [], dependency_release: null, exceptions: [],
      proposal_of: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    fs.mkdirSync(path.join(root, "repo"), { recursive: true });
    fs.writeFileSync(path.join(root, "repo", "planted-secret.json"), JSON.stringify(planted), "utf-8");

    const traversalId = "../planted-secret";
    const getResult = await rt.run(() => rt.repository.get(traversalId, readCtx()));
    assert.equal(getResult.items.length, 0, "get() must not read a file outside records/ via a traversal id");

    const historyResult = await rt.run(() => rt.repository.history(traversalId, readCtx()));
    assert.equal(historyResult.length, 0, "history() must not read a file outside history/ via a traversal id");
  });

  it("getOperation() rejects a non-UUID operationId instead of hashing it into a lookup", async () => {
    const result = await rt.run(() => rt.repository.getOperation("../not-a-uuid", owner));
    assert.equal(result, null);
  });

  it("recordOutcome() rejects a non-UUID memory.id instead of touching records/ with it", async () => {
    const receipt = await rt.run(() => rt.repository.recordOutcome(
      {
        task_id: "t1", session_id: "s1", memory: { id: "../planted-secret", revision: 1 }, injected: true,
        applicable: true, result: "success", evidence_refs: [], judged_by: "test", judge_version: "1",
        source_event_id: crypto.randomUUID(),
      },
      crypto.randomUUID(), { principal: owner, channel: "sdk" },
    ));
    assert.equal(receipt.status, "rejected");
  });
});
