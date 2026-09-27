/**
 * repo-cloud-derived-cap.test.mjs — Fix round 1, B6.
 *
 * Review finding: contract.ts:MAX_DERIVED_CLOSURE (256) is exported but
 * enforced nowhere — not in contract.ts's own validateRefs (FROZEN, cannot
 * be edited here), not in ar2_derived_valid (loops the full array
 * unbounded), not in the create/supersede/update INSERT paths. R2.11: "cap
 * 256; overflow -> withheld." Since contract.ts is frozen for P1-P4, the
 * cap must be enforced server-side in this worktree's migration.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import createHarness from "./harness/pglite-harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

describe("WP-P2 fix round 1 / B6: MAX_DERIVED_CLOSURE=256 enforced server-side", () => {
  let harness;

  before(async () => {
    harness = await createHarness();
    await harness.setup();
  });

  after(async () => {
    await harness.teardown();
  });

  function refs(n) {
    return Array.from({ length: n }, () => ({ id: randomUUID(), revision: 1 }));
  }

  it("create() with 257 derived_from refs is accepted but withheld on every read (ADR R2.11 ruling)", async () => {
    const owner = await harness.newOwner("U-b6-over-cap");
    const wsId = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);
    const recId = randomUUID();

    const receipt = await repo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "experience", visibility: "private", content: "derived from too many sources", authority: "explicit_user", derived_from: refs(257) },
      null, randomUUID(), owner.ownerWrite(),
    );
    assert.equal(receipt.status, "committed", `257 derived_from refs must be accepted (withheld on read), got ${JSON.stringify(receipt)}`);

    const check = await repo.get(recId, owner.read());
    assert.equal(check.items.length, 0, "an over-cap derived record must be withheld from reads");
    assert.ok(check.withheld_derived >= 1, "withheld_derived must count the over-cap record");
  });

  it("create() with exactly 256 derived_from refs (the cap boundary) succeeds", async () => {
    const owner = await harness.newOwner("U-b6-at-cap");
    const wsId = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);
    const recId = randomUUID();

    const receipt = await repo.mutate(
      { op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "experience", visibility: "private", content: "derived from exactly 256 sources", authority: "explicit_user", derived_from: refs(256) },
      null, randomUUID(), owner.ownerWrite(),
    );
    assert.equal(receipt.status, "committed", `exactly 256 derived_from refs must be accepted (the cap is inclusive), got ${JSON.stringify(receipt)}`);
  });

  it("ar2_derived_valid treats a >256-entry closure as invalid PURELY due to the cap, not because any entry is bad", async () => {
    // Decisive isolation of the cap from per-entry validity: every closure
    // entry below points at the SAME real, active, visible record (valid
    // repeated 257 times). Without an explicit cap check, the per-entry
    // loop would find every single entry valid and return TRUE regardless
    // of count; only an explicit `length > 256` bailout can make this FALSE.
    // Self-contained raw PGlite instance (not the shared harness, which
    // doesn't expose direct SQL access) — same precedent as
    // repo-cloud-owner-trust.test.mjs.
    const db = new PGlite({ extensions: { pg_trgm } });
    try {
      await db.exec(fs.readFileSync(path.join(__dirname, "fixtures", "supabase-auth-stub.sql"), "utf8"));
      await db.exec(fs.readFileSync(path.join(REPO_ROOT, "migrations", "0002_shared_memory.sql"), "utf8"));

      const ownerId = randomUUID();
      const claims = JSON.stringify({ sub: ownerId });

      async function asOwner(fn) {
        await db.exec("SET ROLE authenticated;");
        await db.query("select set_config('request.jwt.claims', $1, false)", [claims]);
        try {
          return await fn();
        } finally {
          await db.exec("RESET ROLE;");
        }
      }

      const wsRow = await asOwner(async () => (await db.query("SELECT ar2_admin_workspace($1) AS result", ["b6-cap-isolation-ws"])).rows[0].result);
      const sourceId = randomUUID();
      const createCmd = { op: "create", id: sourceId, workspace_id: wsRow.workspace_id, project_id: null, kind: "fact", visibility: "owner_shared", content: "the one real source, repeated in the closure", authority: "explicit_user" };
      const createReceipt = await asOwner(async () =>
        (await db.query("SELECT ar2_mutate($1, $2, $3, $4, $5, $6) AS result", [ownerId, JSON.stringify(createCmd), null, randomUUID(), "b6-hash", null])).rows[0].result,
      );
      assert.equal(createReceipt.status, "committed", "sanity: the real backing record must actually be created");

      const repeat = (n) => Array.from({ length: n }, () => ({ id: sourceId, revision: 1 }));

      const atCap = await asOwner(async () => (await db.query("SELECT ar2_derived_valid($1, $2, NULL) AS valid", [ownerId, JSON.stringify(repeat(256))])).rows[0].valid);
      assert.equal(atCap, true, "256 repeated valid entries must still validate true (the cap must not falsely reject at the boundary)");

      const overCap = await asOwner(async () => (await db.query("SELECT ar2_derived_valid($1, $2, NULL) AS valid", [ownerId, JSON.stringify(repeat(257))])).rows[0].valid);
      assert.equal(overCap, false, "257 repeated (individually valid) entries must be invalid PURELY because of the cap");
    } finally {
      await db.close();
    }
  });
});
