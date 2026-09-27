import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Review B4 (WP-P1-review.md #4, HIGH): supersede / confirm-of-proposal each
// write TWO records via two independent commitRecord() calls. A crash
// between them left the caller's real operationId's receipt ALREADY
// committed (pointing at record A's new state) while record B was never
// written — and because the receipt already existed, a retry with the same
// operationId hit the idempotency short-circuit and returned
// {replayed:true} WITHOUT ever attempting B's write again. Recovery here
// wasn't idempotent, it was silently incomplete.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(__dirname, "fixtures", "multi-record-crash-child.mjs");

function principal() {
  return { principal_id: "local:owner", owner_id: "local:owner", kind: "user", auth: "local" };
}

describe("B4: supersede / confirm-of-proposal two-record atomicity across a crash", () => {
  let runtimeMod;
  let trustMod;

  before(async () => {
    runtimeMod = await import("../dist/repository/runtime.js");
    trustMod = await import("../dist/repository/trust.js");
  });

  function ownerTrustedCtx(channel) {
    return {
      principal: principal(), channel,
      trusted_user_event: trustMod.mintTrustedUserEvent({
        source: "tty_confirm", host: "test", host_event_id: crypto.randomUUID(),
        raw_text_hash: crypto.createHash("sha256").update("owner-confirm-retry").digest("hex"),
      }),
    };
  }

  it("supersede: crash between the two record commits must not leave the replacement permanently missing on retry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ar-multi-rec-supersede-"));
    const workspaceId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    const replacementId = crypto.randomUUID();
    const operationId = crypto.randomUUID();

    const rt0 = runtimeMod.createMemoryRuntime({ root, mode: "local" }, principal());
    await rt0.run(() => rt0.repository.mutate(
      { op: "create", id: targetId, workspace_id: workspaceId, project_id: null, kind: "fact", visibility: "private", content: "original", authority: "explicit_user" },
      null, crypto.randomUUID(), { principal: principal(), channel: "sdk" },
    ));
    await rt0.close();

    const cmd = {
      op: "supersede", id: targetId,
      replacement: { id: replacementId, workspace_id: workspaceId, project_id: null, kind: "fact", visibility: "private", content: "replacement", authority: "explicit_user" },
    };
    const trustedInput = {
      source: "tty_confirm", host: "test", host_event_id: crypto.randomUUID(),
      raw_text_hash: crypto.createHash("sha256").update("owner-confirm").digest("hex"),
    };
    const childArgs = { root, principal: principal(), channel: "cli", cmd, expectedRevision: 1, operationId, trustedInput };
    const result = spawnSync(process.execPath, [CHILD], {
      env: { ...process.env, AR_FAILPOINT: "between_records", AR_CHILD_ARGS: JSON.stringify(childArgs) },
      encoding: "utf-8",
    });
    assert.equal(result.status, 137, `child should have crashed at the between_records failpoint; stdout=${result.stdout}`);

    // Restart (fresh runtime -> constructor-time WAL recovery) and retry the
    // SAME operation_id, as a real client would after an "unknown" outcome.
    const rt1 = runtimeMod.createMemoryRuntime({ root, mode: "local" }, principal());
    const retry = await rt1.run(() => rt1.repository.mutate(cmd, 1, operationId, ownerTrustedCtx("cli")));

    const replacementRead = await rt1.run(() => rt1.repository.get(replacementId, { principal: principal(), channel: "sdk" }));
    assert.equal(replacementRead.items.length, 1,
      `the replacement record must exist after recovery+retry (retry receipt: ${JSON.stringify(retry)})`);
    assert.equal(replacementRead.items[0].content, "replacement");

    const originalRead = await rt1.run(() => rt1.repository.get(targetId, { principal: principal(), channel: "sdk" }));
    // get() never returns superseded (not in the active/candidate status
    // set) — confirm via history() that it really did transition.
    const originalHistory = await rt1.run(() => rt1.repository.history(targetId, { principal: principal(), channel: "sdk" }));
    assert.equal(originalHistory[originalHistory.length - 1].status, "superseded");
    void originalRead;

    await rt1.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
