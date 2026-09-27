/**
 * repo-cloud-outbox-pgerror.test.mjs — Fix round 1, non-blocking item:
 * Outbox.drain()'s catch-all treated any thrown error — including a genuine
 * PgError (e.g. from supersede's unchecked unique-violation on a colliding
 * replacement id) — the same as NetworkError/TimeoutError: retried up to
 * MAX_ATTEMPTS then left "exhausted" forever, rather than terminal like the
 * live mutate() path already classifies it (cloud-repository.ts's own catch
 * block treats PgError as a terminal rejected receipt, not a retry signal).
 *
 * Direct unit test of Outbox (not through the full harness/PGlite stack —
 * this is purely about drain()'s error-classification logic).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { Outbox } from "../dist/repository/cloud/outbox.js";
import { PgError, NetworkError } from "../dist/repository/cloud/sql-executor.js";

describe("WP-P2 fix round 1 / non-blocking: Outbox.drain() classifies PgError as terminal", () => {
  // Each test gets its OWN root — sharing one directory would leak an
  // unresolved entry from one test into the next test's drain() call (this
  // bit us once already: under the pre-fix code, test 1's PgError entry was
  // never removed, so test 2's drain() silently processed both entries and
  // the call count came out wrong for reasons that had nothing to do with
  // test 2's own assertion).
  const roots = [];

  after(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  });

  function freshRoot() {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), "ar2-outbox-pgerror-"));
    roots.push(r);
    return r;
  }

  it("a PgError (e.g. a unique-violation) is terminal — removed from the outbox, not retried MAX_ATTEMPTS times", async () => {
    const outbox = new Outbox(freshRoot());
    const opId = randomUUID();
    await outbox.enqueue({
      operation_id: opId, workspace_id: "ws", cmd: { op: "supersede" }, expected_revision: 1,
      payload_hash: "h", principal_id: "p1", queued_at: new Date().toISOString(),
    });

    let calls = 0;
    const results = await outbox.drain(async () => {
      calls += 1;
      throw new PgError("duplicate key value violates unique constraint", "23505");
    });

    assert.equal(calls, 1, "a PgError must not be retried at all — it's a permanent rejection, not a transient transport failure");
    assert.equal(results.length, 1);
    assert.equal(results[0].outcome, "terminal_rejected");
    assert.equal(outbox.list().length, 0, "the entry must be removed from the outbox after a terminal PgError");
  });

  it("a NetworkError still retries up to MAX_ATTEMPTS and stays queued (regression guard: the PgError fix must not touch this path)", async () => {
    const outbox = new Outbox(freshRoot());
    const opId = randomUUID();
    await outbox.enqueue({
      operation_id: opId, workspace_id: "ws", cmd: { op: "create" }, expected_revision: null,
      payload_hash: "h2", principal_id: "p1", queued_at: new Date().toISOString(),
    });

    let calls = 0;
    const results = await outbox.drain(async () => {
      calls += 1;
      throw new NetworkError("still offline");
    });

    assert.equal(calls, 8, "a NetworkError must still be retried MAX_ATTEMPTS (8) times per drain round");
    // "still_offline" (not "exhausted"): Outbox only calls it "exhausted"
    // once it has actually seen a real (non-throwing) receipt come back at
    // least once — a pure NetworkError never produces one, so the outcome
    // correctly stays "still_offline" throughout.
    assert.equal(results[0].outcome, "still_offline");
    assert.equal(outbox.list().length, 1, "a NetworkError must leave the entry queued for the next drain(), never removed");
  });
});
