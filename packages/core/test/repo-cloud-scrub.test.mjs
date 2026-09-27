/**
 * repo-cloud-scrub.test.mjs — Fix round 1, B2.
 *
 * Review finding: `CloudRepository.mutate()`'s create branch scrubs a
 * throwaway shallow copy (`cleanCmd`) and never uses it again — `payloadHash`
 * and `callMutateRpc` both read the original, unscrubbed `cmd`. Secrets in
 * `create()` content reach Postgres (and the outbox, offline) unredacted.
 * update/supersede happen to scrub correctly but mutate the CALLER's own
 * command object in place (a milder, separate bug).
 *
 * Required fix: use the scrubbed copy for payloadHash/callMutateRpc/outbox;
 * never mutate the caller's command object.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";

import createHarness from "./harness/pglite-harness.mjs";

const AKIA_CANARY = "AKIAABCDEFGHIJKLMNOP"; // AKIA + 16 chars
const SK_CANARY = "sk-ABCDEFGHIJKLMNOPQRSTUVWX"; // sk- + 24 chars
const PEM_CANARY = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\n-----END RSA PRIVATE KEY-----";
const REDACTED = "[REDACTED-SECRET]";

function assertRedacted(content, label) {
  assert.ok(!content.includes(AKIA_CANARY), `${label}: AKIA canary must not appear verbatim`);
  assert.ok(!content.includes(SK_CANARY), `${label}: sk- canary must not appear verbatim`);
  assert.ok(!content.includes("BEGIN RSA PRIVATE KEY"), `${label}: PEM block must not appear verbatim`);
  assert.ok(content.includes(REDACTED), `${label}: redaction placeholder must be present`);
}

describe("WP-P2 fix round 1 / B2: create() must scrub before send, never mutate the caller's object", () => {
  let harness;

  before(async () => {
    harness = await createHarness();
    await harness.setup();
  });

  after(async () => {
    await harness.teardown();
  });

  it("create(): secret content is redacted server-side (stored record), not just in a discarded local copy", async () => {
    const owner = await harness.newOwner("U-scrub-create");
    const wsId = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);
    const recId = randomUUID();

    const cmd = {
      op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private",
      content: `key=${AKIA_CANARY} and ${SK_CANARY}\n${PEM_CANARY}`, authority: "explicit_user",
    };
    const cmdSnapshotBefore = JSON.parse(JSON.stringify(cmd));

    const receipt = await repo.mutate(cmd, null, randomUUID(), owner.ownerWrite());
    assert.equal(receipt.status, "committed");

    const stored = await repo.get(recId, owner.read());
    assertRedacted(stored.items[0].content, "create() stored content");

    assert.deepEqual(cmd, cmdSnapshotBefore, "mutate() must never mutate the caller's own command object");
  });

  it("update(): secret content is redacted server-side, and the caller's patch object is not mutated in place", async () => {
    const owner = await harness.newOwner("U-scrub-update");
    const wsId = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);
    const recId = randomUUID();
    await repo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: "clean content", authority: "explicit_user" },
      null, randomUUID(), owner.ownerWrite(),
    );

    const updateCmd = { op: "update", id: recId, patch: { content: `rotate me: ${AKIA_CANARY}` } };
    const updateSnapshotBefore = JSON.parse(JSON.stringify(updateCmd));

    const receipt = await repo.mutate(updateCmd, 1, randomUUID(), owner.ownerWrite());
    assert.equal(receipt.status, "committed");

    const stored = await repo.get(recId, owner.read());
    assertRedacted(stored.items[0].content, "update() stored content");

    assert.deepEqual(updateCmd, updateSnapshotBefore, "mutate() must never mutate the caller's own patch object in place");
  });

  it("supersede(): secret content in the replacement is redacted server-side, and the caller's replacement object is not mutated", async () => {
    const owner = await harness.newOwner("U-scrub-supersede");
    const wsId = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);
    const recId = randomUUID();
    await repo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: "original", authority: "explicit_user" },
      null, randomUUID(), owner.ownerWrite(),
    );

    const newId = randomUUID();
    const supersedeCmd = {
      op: "supersede", id: recId,
      replacement: {
        id: newId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private",
        content: `secret replacement: ${SK_CANARY}`, authority: "explicit_user",
      },
    };
    const supersedeSnapshotBefore = JSON.parse(JSON.stringify(supersedeCmd));

    const receipt = await repo.mutate(supersedeCmd, 1, randomUUID(), owner.ownerWrite());
    assert.equal(receipt.status, "committed");

    const stored = await repo.get(newId, owner.read());
    assertRedacted(stored.items[0].content, "supersede() stored replacement content");

    assert.deepEqual(supersedeCmd, supersedeSnapshotBefore, "mutate() must never mutate the caller's own replacement object");
  });

  it("offline: the durable outbox file itself holds redacted content, not the raw secret", async () => {
    const owner = await harness.newOwner("U-scrub-outbox");
    const wsId = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);
    const recId = randomUUID();

    await harness.armFault("offline", owner);
    const receipt = await repo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: `queued secret ${AKIA_CANARY}`, authority: "explicit_user" },
      null, randomUUID(), owner.ownerWrite(),
    );
    assert.equal(receipt.status, "queued");
    await harness.clearFaults();

    const raw = fs.readFileSync(receipt.outbox_ref, "utf8");
    assert.ok(!raw.includes(AKIA_CANARY), "outbox file on disk must not contain the raw secret");
    assert.ok(raw.includes(REDACTED), "outbox file on disk must contain the redaction placeholder");
  });
});
