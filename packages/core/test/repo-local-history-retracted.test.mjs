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
// hiding) got the full retracted CONTENT (plus the retraction reason) back
// from history().
//
// Refined per the frozen acceptance suite's G-retract group ("history shows
// the retraction as a tombstone, not silently omitted"): the fix is NOT to
// omit the retracted revision from history() (that lost real audit-trail
// information the suite requires), it's to keep the tombstone (status/
// metadata/timestamps) but redact its CONTENT specifically (A16's actual
// wording is "content not returned by any read path", not "the revision
// itself never appears").

describe("B5: history() shows a retracted revision as a content-redacted tombstone", () => {
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
    assert.ok(hist.length > 0, "history must still report the record existed (a tombstone, not silent omission)");
    const last = hist[hist.length - 1];
    assert.equal(last.status, "retracted", "the final revision's tombstone status must still be visible");
    assert.equal(last.content, "", "the retracted revision's CONTENT must be redacted (A16), even though its tombstone metadata is visible");
  });
});
