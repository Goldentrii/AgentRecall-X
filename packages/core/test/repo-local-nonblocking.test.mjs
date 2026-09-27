import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

// Review non-blocking items (WP-P1-review.md): R2.10 access_epoch on
// visibility change, plus the 3 named surviving mutations.

describe("Non-blocking review items", () => {
  let runtimeMod;
  let policyMod;

  before(async () => {
    runtimeMod = await import("../dist/repository/runtime.js");
    policyMod = await import("../dist/repository/policy.js");
  });

  function owner() { return { principal_id: "local:owner", owner_id: "local:owner", kind: "user", auth: "local" }; }
  function ctx() { return { principal: owner(), channel: "sdk" }; }

  it("R2.10: access_epoch bumps for the owner on a visibility change (not on a content-only update)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ar-nonblock-epoch-"));
    const trustMod = await import("../dist/repository/trust.js");
    const rt = runtimeMod.createMemoryRuntime({ root, mode: "local" }, owner());
    const id = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    // private -> project WIDENS visibility (VIS_RANK), which requires
    // owner_trusted + can_approve to apply directly (else it's stored as a
    // proposal, per R2.1 row 5) — mint a real trusted context so this
    // actually applies and we're testing the epoch bump, not the propose path.
    function trustedCtx() {
      return {
        principal: owner(), channel: "cli",
        trusted_user_event: trustMod.mintTrustedUserEvent({ source: "tty_confirm", host: "test", host_event_id: crypto.randomUUID(), raw_text_hash: crypto.createHash("sha256").update("epoch-test").digest("hex") }),
      };
    }

    const created = await rt.run(() => rt.repository.mutate(
      { op: "create", id, workspace_id: workspaceId, project_id: null, kind: "fact", visibility: "private", content: "v1", authority: "explicit_user" },
      null, crypto.randomUUID(), ctx(),
    ));
    const before1 = (await rt.run(() => rt.repository.get(id, ctx()))).access_epoch;

    // Content-only update must NOT bump the epoch.
    const afterContent = await rt.run(() => rt.repository.mutate(
      { op: "update", id, patch: { content: "v2" } }, created.revision, crypto.randomUUID(), ctx(),
    ));
    const before2 = (await rt.run(() => rt.repository.get(id, ctx()))).access_epoch;
    assert.equal(before2, before1, "a content-only update must not bump access_epoch");

    // Visibility change MUST bump it.
    const afterVis = await rt.run(() => rt.repository.mutate(
      { op: "update", id, patch: { visibility: "project" } }, afterContent.revision, crypto.randomUUID(), trustedCtx(),
    ));
    assert.equal(afterVis.status, "committed");
    assert.equal(afterVis.effective, true, "sanity: this must be a direct apply, not a proposal");
    const after = (await rt.run(() => rt.repository.get(id, ctx()))).access_epoch;
    assert.ok(after > before2, `visibility change must bump access_epoch (before=${before2}, after=${after})`);

    await rt.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("mutation-kill #1 (policy.ts recomputeAuthority): verified_observation only sticks via the worker channel", () => {
    const nonWorker = policyMod.recomputeAuthority("verified_observation", { channel: "sdk" }, false);
    assert.equal(nonWorker, "agent_inference", "a non-worker channel must downgrade verified_observation");
    const worker = policyMod.recomputeAuthority("verified_observation", { channel: "worker" }, false);
    assert.equal(worker, "verified_observation", "the worker channel is the only one that preserves verified_observation");
  });

  it("mutation-kill #2 (doException target_revision): the exception's target_revision equals the NEW revision it's attached to, not the old one", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ar-nonblock-exception-"));
    const trustMod = await import("../dist/repository/trust.js");
    const rt = runtimeMod.createMemoryRuntime({ root, mode: "local" }, owner());
    const id = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const created = await rt.run(() => rt.repository.mutate(
      { op: "create", id, workspace_id: workspaceId, project_id: null, kind: "constraint", visibility: "private", content: "forbid X", authority: "explicit_user", applicability: { polarity: "forbid" } },
      null, crypto.randomUUID(), ctx(),
    ));
    const trustedCtx = {
      principal: owner(), channel: "cli",
      trusted_user_event: trustMod.mintTrustedUserEvent({ source: "tty_confirm", host: "test", host_event_id: crypto.randomUUID(), raw_text_hash: crypto.createHash("sha256").update("x").digest("hex") }),
    };
    const exceptionReceipt = await rt.run(() => rt.repository.mutate(
      { op: "exception", id, exception_id: crypto.randomUUID(), applicability: { polarity: "forbid" }, valid_until: new Date(Date.now() + 86400000).toISOString(), reason: "temp allow" },
      created.revision, crypto.randomUUID(), trustedCtx,
    ));
    assert.equal(exceptionReceipt.status, "committed");
    const read = await rt.run(() => rt.repository.get(id, ctx()));
    const rec = read.items[0];
    assert.equal(rec.revision, exceptionReceipt.revision, "sanity: the record's current revision matches the receipt");
    assert.equal(rec.exceptions.length, 1);
    assert.equal(rec.exceptions[0].target_revision, rec.revision,
      `exception.target_revision (${rec.exceptions[0].target_revision}) must equal the NEW revision it's attached to (${rec.revision}), not revision-1`);

    await rt.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("mutation-kill #3 (isClosureValid): a dependency_release only exempts the LISTED source_revisions, not the whole closure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ar-nonblock-closure-"));
    const rt = runtimeMod.createMemoryRuntime({ root, mode: "local" }, owner());
    const workspaceId = crypto.randomUUID();
    const sourceAId = crypto.randomUUID();
    const sourceBId = crypto.randomUUID();
    const derivedId = crypto.randomUUID();

    const sourceA = await rt.run(() => rt.repository.mutate(
      { op: "create", id: sourceAId, workspace_id: workspaceId, project_id: null, kind: "fact", visibility: "private", content: "source A", authority: "explicit_user" },
      null, crypto.randomUUID(), ctx(),
    ));
    await rt.run(() => rt.repository.mutate(
      { op: "create", id: sourceBId, workspace_id: workspaceId, project_id: null, kind: "fact", visibility: "private", content: "source B", authority: "explicit_user" },
      null, crypto.randomUUID(), ctx(),
    ));
    await rt.run(() => rt.repository.mutate(
      { op: "create", id: derivedId, workspace_id: workspaceId, project_id: null, kind: "experience", visibility: "private", content: "derived", authority: "explicit_user", derived_from: [{ id: sourceAId, revision: 1 }, { id: sourceBId, revision: 1 }] },
      null, crypto.randomUUID(), ctx(),
    ));

    // Retract source A -> its closure entry becomes invalid (status != active).
    await rt.run(() => rt.repository.mutate({ op: "retract", id: sourceAId, reason: "gone" }, sourceA.revision, crypto.randomUUID(), ctx()));

    // Directly write a dependency_release that lists ONLY source B (NOT
    // source A) — simulates a partial release. There is no public command
    // shape for a partial release today (doReleaseDependency releases the
    // whole current closure) — this targets isClosureValid()'s per-entry
    // gate directly, at the storage layer, per the review's exact ask.
    const recordPath = path.join(root, "repo", "records", `${derivedId}.json`);
    const rec = JSON.parse(fs.readFileSync(recordPath, "utf-8"));
    rec.dependency_release = {
      approved_by: owner().principal_id, approved_at: new Date().toISOString(),
      redaction_report_ref: "partial-release-1", source_revisions: [{ id: sourceBId, revision: 1 }],
    };
    fs.writeFileSync(recordPath, JSON.stringify(rec), "utf-8");

    const read = await rt.run(() => rt.repository.get(derivedId, ctx()));
    assert.equal(read.items.length, 0,
      "source A's (retracted, unlisted in dependency_release.source_revisions) closure entry must still invalidate the derived record");

    await rt.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
