import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

// Review B5 (WP-P1-review.md #5, HIGH): get()/query()/readSnapshot()/list()/
// export()/latestHandoff() all route through readAll() -> readableStatusSet(),
// which NEVER includes "retracted" (A16: "retracted content is never
// returned", even for a management-channel owner read). history() bypassed
// readAll() entirely and filtered ONLY by canRead(), with no status filter
// at all -- so the exact owner who gets 0 items from get() (existence
// hiding) got the full retracted content (plus the retraction reason) back
// from history().

describe("B5: history() must not return retracted-revision content", () => {
  let runtimeMod;
  let root;
  let rt;
  let owner;

  before(async () => { runtimeMod = await import("../dist/repository/runtime.js"); });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ar-history-retract-"));
    owner = { principal_id: "local:owner", owner_id: "local:owner", kind: "user", auth: "local" };
    rt = runtimeMod.createMemoryRuntime({ root, mode: "local" }, owner);
  });

  afterEach(async () => {
    await rt.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function ctx() { return { principal: owner, channel: "sdk" }; }

  it("create -> retract -> get() hides existence AND history() must not leak the retracted content to the SAME owner", async () => {
    const id = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const created = await rt.run(() => rt.repository.mutate(
      { op: "create", id, workspace_id: workspaceId, project_id: null, kind: "fact", visibility: "private", content: "secret v1", authority: "explicit_user" },
      null, crypto.randomUUID(), ctx(),
    ));
    await rt.run(() => rt.repository.mutate(
      { op: "retract", id, reason: "no longer needed" }, created.revision, crypto.randomUUID(), ctx(),
    ));

    const getResult = await rt.run(() => rt.repository.get(id, ctx()));
    assert.equal(getResult.items.length, 0, "sanity: get() already correctly hides a retracted record");

    const hist = await rt.run(() => rt.repository.history(id, ctx()));
    for (const rev of hist) {
      assert.notEqual(rev.status, "retracted", `history() returned a retracted revision (content: ${JSON.stringify(rev.content)}) to the same owner get() just told "this doesn't exist"`);
    }
  });
});
