/**
 * repo-cloud-nonblocking.test.mjs — Fix round 1, non-blocking items:
 *  - server-side strip of __proto__/constructor/prototype metadata keys
 *    (ar2_strip_reserved_metadata didn't mirror the rev2.2 contract.ts fix)
 *  - ar2_query's LIMIT applied before ar2_derived_valid filtering, so
 *    list()'s pagination silently returned fewer than `limit` items and
 *    terminated early whenever a page mixed valid/withheld derived records
 *  - ar2_records.workspace_id has no FK to ar2_workspaces(id)
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

describe("WP-P2 fix round 1 / non-blocking: __proto__/constructor/prototype metadata stripping", () => {
  let db;

  before(async () => {
    db = new PGlite({ extensions: { pg_trgm } });
    await db.exec(fs.readFileSync(path.join(__dirname, "fixtures", "supabase-auth-stub.sql"), "utf8"));
    await db.exec(fs.readFileSync(path.join(REPO_ROOT, "migrations", "0002_shared_memory.sql"), "utf8"));
  });

  after(async () => {
    await db.close();
  });

  async function asOwner(ownerId, fn) {
    await db.exec("SET ROLE authenticated;");
    await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: ownerId })]);
    try {
      return await fn();
    } finally {
      await db.exec("RESET ROLE;");
    }
  }

  it("__proto__/constructor/prototype keys in metadata never survive to the stored record", async () => {
    const ownerId = randomUUID();
    const wsId = (await asOwner(ownerId, async () => (await db.query("SELECT ar2_admin_workspace($1) AS result", ["proto-strip-ws"])).rows[0].result)).workspace_id;

    const recId = randomUUID();
    // Hand-built raw JSON text (a hostile-client-shaped payload) — never
    // constructed via a JS object literal, so there's no ambiguity about
    // whether "__proto__" is an own enumerable property: it's just bytes
    // in the wire payload, exactly as Postgres would receive it.
    const rawCmdJson = JSON.stringify({
      op: "create", id: recId, workspace_id: wsId, project_id: null, kind: "fact", visibility: "private",
      content: "proto pollution attempt", authority: "explicit_user",
    }).replace(/\}$/, ',"metadata":{"__proto__":"polluted","constructor":"evil","prototype":"evil2","normal_key":"kept"}}');

    const receipt = await asOwner(ownerId, async () =>
      (await db.query("SELECT ar2_mutate($1, $2, $3, $4, $5, $6) AS result", [ownerId, rawCmdJson, null, randomUUID(), "proto-hash", null])).rows[0].result,
    );
    assert.equal(receipt.status, "committed");

    const stored = await asOwner(ownerId, async () => (await db.query("SELECT ar2_get($1, $2) AS result", [ownerId, recId])).rows[0].result);
    assert.ok(!Object.prototype.hasOwnProperty.call(stored.metadata, "__proto__"), "__proto__ must be stripped server-side");
    assert.ok(!Object.prototype.hasOwnProperty.call(stored.metadata, "constructor"), "constructor must be stripped server-side");
    assert.ok(!Object.prototype.hasOwnProperty.call(stored.metadata, "prototype"), "prototype must be stripped server-side");
    assert.equal(stored.metadata.normal_key, "kept", "ordinary metadata keys must survive stripping");
  });
});

describe("WP-P2 fix round 1 / non-blocking: list() pagination must not terminate early on withheld derived records", () => {
  let harness;

  before(async () => {
    harness = await createHarness();
    await harness.setup();
  });

  after(async () => {
    await harness.teardown();
  });

  it("a page mixing valid facts and withheld (invalid-closure) derived records still returns `limit` valid items when enough exist", async () => {
    const owner = await harness.newOwner("U-nb-pagination");
    const wsId = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);

    // Interleave 3 valid facts with 2 "withheld" experience records (derived
    // from a source that doesn't exist -> ar2_derived_valid = false), in
    // creation order so ORDER BY updated_at DESC naturally interleaves them:
    // valid1, invalid1, valid2, invalid2, valid3 (oldest..newest) => DESC
    // order is valid3, invalid2, valid2, invalid1, valid1.
    // A LIMIT-before-filter bug would take the top 3 (valid3, invalid2,
    // valid2), filter out invalid2, and return only 2 valid items.
    async function createValid(label) {
      await repo.mutate(
        { op: "create", id: randomUUID(), workspace_id: wsId, project_id: null, kind: "fact", visibility: "private", content: label, authority: "explicit_user" },
        null, randomUUID(), owner.ownerWrite(),
      );
      await new Promise((r) => setTimeout(r, 5));
    }
    async function createWithheld(label) {
      await repo.mutate(
        {
          op: "create", id: randomUUID(), workspace_id: wsId, project_id: null, kind: "experience", visibility: "private",
          content: label, authority: "explicit_user", derived_from: [{ id: randomUUID(), revision: 1 }],
        },
        null, randomUUID(), owner.ownerWrite(),
      );
      await new Promise((r) => setTimeout(r, 5));
    }

    await createValid("valid1");
    await createWithheld("invalid1");
    await createValid("valid2");
    await createWithheld("invalid2");
    await createValid("valid3");

    const page = await repo.list({ limit: 3 }, owner.read(), null);
    assert.equal(page.items.length, 3, `expected all 3 valid records in the first page of limit=3, got ${page.items.length}: ${JSON.stringify(page.items.map((i) => i.content))}`);
    const contents = page.items.map((i) => i.content).sort();
    assert.deepEqual(contents, ["valid1", "valid2", "valid3"]);
  });
});

describe("WP-P2 fix round 1 / non-blocking: ar2_records.workspace_id has a real FK", () => {
  let db;

  before(async () => {
    db = new PGlite({ extensions: { pg_trgm } });
    await db.exec(fs.readFileSync(path.join(__dirname, "fixtures", "supabase-auth-stub.sql"), "utf8"));
    await db.exec(fs.readFileSync(path.join(REPO_ROOT, "migrations", "0002_shared_memory.sql"), "utf8"));
  });

  after(async () => {
    await db.close();
  });

  it("a direct insert with a nonexistent workspace_id is rejected by a foreign key constraint", async () => {
    const ownerId = randomUUID();
    const bogusWorkspaceId = randomUUID();
    const sourceJson = JSON.stringify({ principal_id: ownerId, captured_at: "2026-01-01T00:00:00Z", channel: "sdk" });
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO ar2_records (owner_id, id, workspace_id, kind, visibility, content, content_hash, authority, source)
           VALUES ($1, $2, $3, 'fact', 'private', 'x', 'h', 'agent_inference', $4::jsonb)`,
          [ownerId, randomUUID(), bogusWorkspaceId, sourceJson],
        ),
      /foreign key|violates/i,
    );
  });
});
