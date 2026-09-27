/**
 * scripts/acceptance/contract-suite.mjs
 *
 * FROZEN, driver-agnostic acceptance contract suite (WP-V, ADR-001 rev2.1).
 * Loads a Harness (scripts/acceptance/harness.d.ts) from AR_HARNESS (absolute
 * path to a module default-exporting createHarness()) and exercises it
 * through ONLY the MemoryRepository / AdminRepository / Harness surfaces --
 * never by importing packages/core internals directly.
 *
 * Run:
 *   AR_HARNESS=/abs/path/to/harness.mjs \
 *   AGENT_RECALL_STRICT_CONTEXT=1 \
 *   node --test scripts/acceptance/contract-suite.mjs
 *
 * Every group below either runs its real assertions, or -- when the loaded
 * harness's capabilities don't support it -- registers a single trivially
 * passing test named "N/A:<group>:<reason>". Consumers must treat N/A tests
 * as not_applicable, never as a PASS of that group's requirement.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";

// ---------------------------------------------------------------------------
// Harness bootstrap
// ---------------------------------------------------------------------------

const harnessPathArg = process.env.AR_HARNESS;
if (!harnessPathArg) {
  console.error("contract-suite: AR_HARNESS env var (absolute path to a harness module) is required.");
  process.exit(2);
}
const harnessUrl = pathToFileURL(path.resolve(harnessPathArg)).href;
const harnessModule = await import(harnessUrl);
const createHarness = harnessModule.default;
if (typeof createHarness !== "function") {
  console.error(`contract-suite: ${harnessPathArg} must default-export createHarness()`);
  process.exit(2);
}
const harness = await createHarness();
await harness.setup();

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function uuid() {
  return randomUUID();
}

/** Normalizes the 6 read-surface return shapes (ReadResult / Page / array / ExportResult) to an item list. */
function itemsOf(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.items)) return result.items;
  if (result && Array.isArray(result.records)) return result.records;
  return [];
}

function isDenied(result) {
  return itemsOf(result).length === 0;
}

function containsId(result, id) {
  return itemsOf(result).some((r) => r.id === id);
}

async function collectAllChanges(repo, ctx, pageLimit) {
  let cursor = null;
  const events = [];
  let guard = 0;
  for (;;) {
    const page = await repo.readChanges(cursor, ctx, pageLimit);
    events.push(...page.events);
    if (!page.has_more) break;
    cursor = page.next_cursor;
    guard += 1;
    if (guard > 200000) throw new Error("readChanges pagination did not terminate (possible infinite loop)");
  }
  return events;
}

async function poll(fn, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined && v !== false && v !== null) return v;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() > deadline) {
      throw new Error(`poll: timed out after ${timeoutMs}ms${lastErr ? `; last error: ${lastErr.message}` : ""}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function na(groupName, reason) {
  test(`N/A:${groupName}:${reason}`, () => {});
}

function baseCreate(overrides = {}) {
  return {
    op: "create",
    id: uuid(),
    workspace_id: overrides.workspace_id ?? uuid(),
    project_id: overrides.project_id ?? null,
    kind: overrides.kind ?? "fact",
    visibility: overrides.visibility ?? "private",
    content: overrides.content ?? "x",
    authority: overrides.authority ?? "agent_inference",
    ...overrides,
  };
}

function handoffContent(payload) {
  return JSON.stringify(payload);
}

function makeHandoffPayload(overrides = {}) {
  return {
    task_key: overrides.task_key ?? "task-" + uuid(),
    goal: "goal",
    state: "state",
    decisions: [],
    items: overrides.items ?? [{ text: "did a thing", status: "todo", evidence_refs: [] }],
    next: [],
    blockers: [],
    memory_refs: [],
    ...overrides,
  };
}

// ===========================================================================
// G-validate
// ===========================================================================

test("G-validate", async (t) => {
  const owner = await harness.newOwner("U");
  const repo = await harness.repoFor(owner);
  const ws = await harness.workspace(owner);

  await t.test("non-UUID record id -> rejected:schema", async () => {
    const cmd = baseCreate({ id: "not-a-uuid", workspace_id: ws });
    const r = await repo.mutate(cmd, null, uuid(), owner.write());
    assert.equal(r.status, "rejected");
    assert.equal(r.reason, "schema");
  });

  await t.test("non-UUID operation id -> rejected:schema", async () => {
    const cmd = baseCreate({ workspace_id: ws });
    const r = await repo.mutate(cmd, null, "not-a-uuid-op", owner.write());
    assert.equal(r.status, "rejected");
    assert.equal(r.reason, "schema");
  });

  await t.test("non-UUID workspace_id -> rejected:schema", async () => {
    const cmd = baseCreate({ workspace_id: "not-a-uuid" });
    const r = await repo.mutate(cmd, null, uuid(), owner.write());
    assert.equal(r.status, "rejected");
    assert.equal(r.reason, "schema");
  });

  await t.test("update with expectedRevision null -> schema", async () => {
    const createCmd = baseCreate({ workspace_id: ws });
    const created = await repo.mutate(createCmd, null, uuid(), owner.write());
    assert.equal(created.status, "committed", "fixture create must commit");
    const updateCmd = { op: "update", id: createCmd.id, patch: { content: "changed" } };
    const r = await repo.mutate(updateCmd, null, uuid(), owner.write());
    assert.equal(r.status, "rejected");
    assert.equal(r.reason, "schema");
  });

  await t.test('path-traversal id ("../x") rejected before any effect is observable', async () => {
    const trickId = "../x";
    const cmd = baseCreate({ id: trickId, workspace_id: ws });
    const r = await repo.mutate(cmd, null, uuid(), owner.write());
    assert.equal(r.status, "rejected");
    assert.equal(r.reason, "schema");
    const readBack = await repo.get(trickId, owner.read());
    assert.ok(isDenied(readBack), "path-traversal id must not have created a readable record");
  });
});

// ===========================================================================
// G-cas (A10 subset)
// ===========================================================================

test("G-cas", async (t) => {
  const owner = await harness.newOwner("U");
  const repo = await harness.repoFor(owner);
  const ws = await harness.workspace(owner);

  const createCmd = baseCreate({ workspace_id: ws, content: "seed" });
  const created = await repo.mutate(createCmd, null, uuid(), owner.write());
  assert.equal(created.status, "committed");
  const id = createCmd.id;

  let currentRevision = created.revision;
  const PAIRS = 100;
  const violations = [];

  for (let i = 0; i < PAIRS; i += 1) {
    const rev = currentRevision;
    const cmdA = { op: "update", id, patch: { content: `round-${i}-A` } };
    const cmdB = { op: "update", id, patch: { content: `round-${i}-B` } };
    const [ra, rb] = await Promise.all([
      repo.mutate(cmdA, rev, uuid(), owner.write()),
      repo.mutate(cmdB, rev, uuid(), owner.write()),
    ]);
    const statuses = [ra.status, rb.status].sort();
    const committedCount = statuses.filter((s) => s === "committed").length;
    const conflictCount = statuses.filter((s) => s === "conflict").length;
    if (committedCount !== 1 || conflictCount !== 1) {
      violations.push({ round: i, ra: ra.status, rb: rb.status });
      // resync so the loop doesn't cascade-fail every subsequent round on a broken backend
      const cur = await repo.get(id, owner.read());
      currentRevision = itemsOf(cur)[0]?.revision ?? rev + 1;
      continue;
    }
    const winner = ra.status === "committed" ? ra : rb;
    assert.equal(winner.revision, rev + 1, `round ${i}: revision must be exactly +1`);
    const after = await repo.get(id, owner.read());
    const rec = itemsOf(after)[0];
    assert.ok(rec, `round ${i}: record must still be readable`);
    assert.equal(rec.revision, rev + 1, `round ${i}: stored revision must match winner`);
    const winnerContent = ra.status === "committed" ? cmdA.patch.content : cmdB.patch.content;
    assert.equal(rec.content, winnerContent, `round ${i}: content must be exactly the winner's (no content loss / no merge)`);
    currentRevision = rev + 1;
  }

  assert.equal(
    violations.length,
    0,
    `G-cas: ${violations.length}/${PAIRS} rounds did not yield exactly 1 committed + 1 conflict: ${JSON.stringify(violations.slice(0, 5))}`,
  );
});

// ===========================================================================
// G-idem (A09 subset)
// ===========================================================================

test("G-idem", async (t) => {
  const owner = await harness.newOwner("U");
  const repo = await harness.repoFor(owner);
  const ws = await harness.workspace(owner);

  await t.test("create replayed 10x same payload -> one change, replayed=true after first", async () => {
    const opId = uuid();
    const cmd = baseCreate({ workspace_id: ws, content: "idem-create" });
    const first = await repo.mutate(cmd, null, opId, owner.write());
    assert.equal(first.status, "committed");
    assert.equal(first.replayed, false);
    let last = first;
    for (let i = 0; i < 9; i += 1) {
      const r = await repo.mutate(cmd, null, opId, owner.write());
      assert.equal(r.status, "committed", `replay ${i} must still resolve committed`);
      assert.equal(r.replayed, true, `replay ${i} must report replayed=true`);
      assert.equal(r.revision, first.revision, `replay ${i} must not change revision`);
      last = r;
    }
    void last;
    const after = await repo.get(cmd.id, owner.read());
    const rec = itemsOf(after)[0];
    assert.ok(rec, "record must exist exactly once");
    assert.equal(rec.revision, first.revision, "10 replays must yield exactly one committed change");
  });

  await t.test("update replayed 10x same payload -> one change", async () => {
    const seed = baseCreate({ workspace_id: ws, content: "seed-u" });
    const created = await repo.mutate(seed, null, uuid(), owner.write());
    assert.equal(created.status, "committed");
    const opId = uuid();
    const cmd = { op: "update", id: seed.id, patch: { content: "updated-once" } };
    const first = await repo.mutate(cmd, created.revision, opId, owner.write());
    assert.equal(first.status, "committed");
    for (let i = 0; i < 9; i += 1) {
      const r = await repo.mutate(cmd, created.revision, opId, owner.write());
      assert.equal(r.status, "committed");
      assert.equal(r.replayed, true, `update replay ${i} must report replayed=true`);
      assert.equal(r.revision, first.revision);
    }
    const after = await repo.get(seed.id, owner.read());
    assert.equal(itemsOf(after)[0].revision, first.revision);
  });

  await t.test("retract replayed 10x same payload -> one change", async () => {
    const seed = baseCreate({ workspace_id: ws, content: "seed-r" });
    const created = await repo.mutate(seed, null, uuid(), owner.write());
    const opId = uuid();
    const cmd = { op: "retract", id: seed.id, reason: "test" };
    const first = await repo.mutate(cmd, created.revision, opId, owner.write());
    assert.equal(first.status, "committed");
    for (let i = 0; i < 9; i += 1) {
      const r = await repo.mutate(cmd, created.revision, opId, owner.write());
      assert.equal(r.status, "committed");
      assert.equal(r.replayed, true);
      assert.equal(r.revision, first.revision);
    }
  });

  await t.test("same operation id, different payload -> idempotency_mismatch", async () => {
    const opId = uuid();
    const cmdA = baseCreate({ workspace_id: ws, content: "payload-A" });
    const first = await repo.mutate(cmdA, null, opId, owner.write());
    assert.equal(first.status, "committed");
    const cmdB = baseCreate({ workspace_id: ws, content: "payload-B", id: uuid() });
    const r = await repo.mutate(cmdB, null, opId, owner.write());
    assert.equal(r.status, "rejected");
    assert.equal(r.reason, "idempotency_mismatch");
  });

  await t.test("different principal reusing the same operation id is independent", async () => {
    const opId = uuid();
    const ownerCmd = baseCreate({ workspace_id: ws, content: "owner-payload" });
    const ownerResult = await repo.mutate(ownerCmd, null, opId, owner.write());
    assert.equal(ownerResult.status, "committed");

    let other;
    if (harness.capabilities.agents) {
      other = await harness.newAgent(owner, "idem-other", { workspace_id: ws, project_ids: null, can_read: true, can_write: true, can_approve: false, personal: false });
    } else if (harness.capabilities.multiUser) {
      other = await harness.newOwner("idem-other-user");
    } else {
      return; // nothing to compare against; core replay semantics already covered above.
    }
    const otherRepo = await harness.repoFor(other);
    const otherCmd = baseCreate({ workspace_id: ws, content: "other-principal-payload", id: uuid() });
    const otherResult = await otherRepo.mutate(otherCmd, null, opId, other.write());
    assert.equal(otherResult.status, "committed", "a different principal reusing the same operation_id must be independent, not idempotency_mismatch");
    assert.notEqual(otherResult.id, ownerResult.id);
  });

  if (harness.capabilities.agents) {
    await t.test("replay of an already-committed op still returns the original receipt AFTER the actor's grant is revoked (R2.5)", async () => {
      const agent = await harness.newAgent(owner, "idem-revoke-replay", { workspace_id: ws, project_ids: null, can_read: true, can_write: true, can_approve: false, personal: false });
      const agentRepoForIdem = await harness.repoFor(agent);
      const opId = uuid();
      const cmd = baseCreate({ workspace_id: ws, content: "idem-revoke-payload" });
      const first = await agentRepoForIdem.mutate(cmd, null, opId, agent.write());
      assert.equal(first.status, "committed");

      await harness.revoke(owner, agent, ws);

      const replay = await agentRepoForIdem.mutate(cmd, null, opId, agent.write());
      assert.equal(replay.status, "committed", "R2.5: same-hash replay after grant revocation must still resolve to the ORIGINAL receipt, not a fresh authorization decision");
      assert.equal(replay.replayed, true);
      assert.equal(replay.id, first.id);
      assert.equal(replay.revision, first.revision, "revoked-agent replay must not cause a second effect");
    });
  }
});

// ===========================================================================
// G-authz (R2.1)
// ===========================================================================

if (harness.capabilities.agents) {
  test("G-authz", async (t) => {
    const owner = await harness.newOwner("U");
    const ownerRepo = await harness.repoFor(owner);
    const ws = await harness.workspace(owner);
    const agent = await harness.newAgent(owner, "worker", {
      workspace_id: ws, project_ids: null, can_read: true, can_write: true, can_approve: false, personal: true,
    });
    const agentRepo = await harness.repoFor(agent);

    await t.test("positive control: agent create of a plain private fact is directly effective", async () => {
      const cmd = baseCreate({ workspace_id: ws, kind: "fact", visibility: "private", content: "agent-plain-fact" });
      const r = await agentRepo.mutate(cmd, null, uuid(), agent.write());
      assert.equal(r.status, "committed");
      assert.equal(r.effective, true);
      assert.equal(r.effective_status, "active");
    });

    const constraintCmd = baseCreate({
      workspace_id: ws, kind: "constraint", visibility: "workspace", authority: "explicit_user",
      content: "never publish without approval", applicability: { polarity: "forbid", action_terms: ["publish"] },
    });
    const constraintCreated = await ownerRepo.mutate(constraintCmd, null, uuid(), owner.ownerWrite());
    // Deliberately NOT a bare assertion here: this used to throw synchronously and silently cancel EVERY
    // subsequent t.test() below it (retract/quarantine/narrow/confirm/metadata/forged-trust/supersede/
    // exception/release_dependency never even registered as run against a driver that gets this one thing
    // wrong). Isolate it in its own subtest so one wrong field can never mask the rest of the matrix.
    await t.test("owner-trusted constraint create is committed, active, and recomputed to explicit_user authority", () => {
      assert.equal(constraintCreated.status, "committed", "owner-trusted constraint create must commit");
      assert.equal(constraintCreated.effective_authority, "explicit_user", "owner-trusted create must be recomputed as explicit_user");
      assert.equal(constraintCreated.effective_status, "active");
    });
    const constraintId = constraintCmd.id;
    // Fallback keeps downstream subtests syntactically able to proceed (and independently fail on their
    // OWN merits) even if the setup subtest above already flagged a wrong/missing revision.
    let constraintRevision = constraintCreated.revision ?? 1;

    await t.test("agent cannot retract an explicit_user constraint", async () => {
      const r = await agentRepo.mutate({ op: "retract", id: constraintId, reason: "agent trying" }, constraintRevision, uuid(), agent.write());
      assert.equal(r.status, "rejected");
      assert.equal(r.reason, "requires_owner_approval");
      const after = await ownerRepo.get(constraintId, owner.read());
      const rec = itemsOf(after)[0];
      assert.equal(rec.status, "active", "original constraint must remain active");
      assert.equal(rec.revision, constraintRevision, "original constraint revision must be unchanged");
    });

    await t.test("agent cannot quarantine an explicit_user constraint", async () => {
      const r = await agentRepo.mutate({ op: "quarantine", id: constraintId, reason: "agent trying" }, constraintRevision, uuid(), agent.write());
      assert.equal(r.status, "rejected");
      assert.equal(r.reason, "requires_owner_approval");
      const after = await ownerRepo.get(constraintId, owner.read());
      assert.equal(itemsOf(after)[0].status, "active");
    });

    await t.test("agent 'narrowing' (updating applicability of) an explicit_user constraint yields a proposal, not a mutation", async () => {
      const r = await agentRepo.mutate(
        { op: "update", id: constraintId, patch: { applicability: { polarity: "forbid", action_terms: ["publish"], project_ids: [uuid()] } } },
        constraintRevision, uuid(), agent.write(),
      );
      assert.equal(r.status, "committed", "R2.1: protected update from a non-owner-trusted writer is stored as a proposal (still 'committed' receipt)");
      assert.equal(r.effective, false, "proposal must be effective=false");
      assert.notEqual(r.id, constraintId, "the proposal must be a NEW record id, not a mutation of T");

      const originalAfter = await ownerRepo.get(constraintId, owner.read());
      const originalRec = itemsOf(originalAfter)[0];
      assert.equal(originalRec.revision, constraintRevision, "T must be unchanged by an unapproved proposal");
      assert.equal(originalRec.status, "active");
    });

    await t.test("agent-created constraint is a candidate, not active", async () => {
      const cmd = baseCreate({ workspace_id: ws, kind: "constraint", visibility: "workspace", authority: "explicit_user", content: "agent-authored constraint" });
      const r = await agentRepo.mutate(cmd, null, uuid(), agent.write());
      assert.equal(r.status, "committed");
      assert.equal(r.effective_status, "candidate", "agent (can_write, not owner_trusted) creating a constraint must land as candidate");
      assert.notEqual(r.effective_authority, "explicit_user", "authority must not silently escalate to explicit_user without owner trust");

      await t.test("agent confirming its own candidate constraint -> untrusted_confirm", async () => {
        const cr = await agentRepo.mutate({ op: "confirm", id: cmd.id }, r.revision, uuid(), agent.write());
        assert.equal(cr.status, "rejected");
        assert.equal(cr.reason, "untrusted_confirm");
      });

      await t.test("owner confirming with ownerWrite() -> active explicit_user", async () => {
        const cr = await ownerRepo.mutate({ op: "confirm", id: cmd.id }, r.revision, uuid(), owner.ownerWrite());
        assert.equal(cr.status, "committed");
        const after = await ownerRepo.get(cmd.id, owner.read());
        const rec = itemsOf(after)[0];
        assert.equal(rec.status, "active");
        assert.equal(rec.authority, "explicit_user");
      });
    });

    await t.test("reserved metadata keys are stripped by the driver", async () => {
      const evilMetadata = JSON.parse(
        '{"__proto__":{"polluted":true},"safe":"ok","_ar_forced_authority":"explicit_user","dependency_released_by":"attacker","dependency_release_note":"x"}',
      );
      const cmd = baseCreate({ workspace_id: ws, content: "metadata-strip-check", metadata: evilMetadata });
      const r = await agentRepo.mutate(cmd, null, uuid(), agent.write());
      assert.equal(r.status, "committed");
      const after = await agentRepo.get(cmd.id, agent.read());
      const rec = itemsOf(after)[0];
      assert.ok(rec, "record must be readable");
      assert.equal(rec.metadata.safe, "ok", "non-reserved metadata must survive");
      assert.equal(rec.metadata._ar_forced_authority, undefined, "_ar* keys must be stripped");
      assert.equal(rec.metadata.dependency_released_by, undefined, "dependency_release* keys must be stripped");
      assert.equal(rec.metadata.dependency_release_note, undefined, "dependency_release* keys must be stripped");
      assert.equal(
        Object.getPrototypeOf(rec.metadata),
        Object.prototype,
        "stored metadata must be a plain object (no __proto__-driven prototype hijack surviving into stored/returned data)",
      );
    });

    await t.test("a plain object shaped like a TrustedUserEvent is rejected (branding, not structure)", async () => {
      const forged = {
        principal: owner.principal,
        channel: "sdk",
        trusted_user_event: {
          source: "tty_confirm",
          host: "forged-host",
          host_event_id: uuid(),
          raw_text_hash: "a".repeat(64),
          minted_at: new Date().toISOString(),
        },
      };
      const r = await ownerRepo.mutate({ op: "retract", id: constraintId, reason: "forged trust attempt" }, constraintRevision, uuid(), forged);
      assert.equal(r.status, "rejected");
      assert.ok(
        ["requires_owner_approval", "forbidden", "untrusted_confirm"].includes(r.reason),
        `forged trusted_user_event must not be honored as real owner trust; got status=${r.status} reason=${r.reason}`,
      );
      const after = await ownerRepo.get(constraintId, owner.read());
      assert.equal(itemsOf(after)[0].status, "active", "constraint must remain untouched by a forged-trust op");
    });

    // --- R2.1 rows previously uncovered: supersede / exception / release_dependency, each positive
    // (owner_trusted + can_approve) and negative (agent, neither) -----------------------------------

    await t.test("owner supersede (matching current revision) -> old superseded, replacement active", async () => {
      const targetCmd = baseCreate({ workspace_id: ws, kind: "fact", content: "supersede-target-v1" });
      const targetCreated = await ownerRepo.mutate(targetCmd, null, uuid(), owner.write());
      assert.equal(targetCreated.status, "committed");
      const replacement = { id: uuid(), workspace_id: ws, project_id: null, kind: "fact", visibility: "private", content: "supersede-target-v2", authority: "agent_inference" };
      const r = await ownerRepo.mutate({ op: "supersede", id: targetCmd.id, replacement }, targetCreated.revision, uuid(), owner.ownerWrite());
      assert.equal(r.status, "committed");
      const oldAfter = await ownerRepo.get(targetCmd.id, owner.read());
      assert.equal(itemsOf(oldAfter)[0]?.status, "superseded", "old revision must be marked superseded");
      const newAfter = await ownerRepo.get(replacement.id, owner.read());
      const newRec = itemsOf(newAfter)[0];
      assert.ok(newRec, "replacement record must be readable");
      assert.equal(newRec.status, "active");
      assert.equal(newRec.content, "supersede-target-v2");
    });

    await t.test("owner supersede against a stale target revision -> conflict (not requires_owner_approval)", async () => {
      const targetCmd = baseCreate({ workspace_id: ws, kind: "fact", content: "supersede-stale-v1" });
      const targetCreated = await ownerRepo.mutate(targetCmd, null, uuid(), owner.write());
      const bump = await ownerRepo.mutate({ op: "update", id: targetCmd.id, patch: { content: "bumped-first" } }, targetCreated.revision, uuid(), owner.write());
      assert.equal(bump.status, "committed");
      const replacement = { id: uuid(), workspace_id: ws, project_id: null, kind: "fact", visibility: "private", content: "stale-attempt", authority: "agent_inference" };
      const r = await ownerRepo.mutate({ op: "supersede", id: targetCmd.id, replacement }, targetCreated.revision /* stale on purpose */, uuid(), owner.ownerWrite());
      assert.equal(r.status, "conflict", "supersede targeting a revision that has already moved on must CAS-conflict, not silently apply against the wrong base");
    });

    await t.test("agent supersede without owner trust -> rejected:requires_owner_approval, T unchanged", async () => {
      const targetCmd = baseCreate({ workspace_id: ws, kind: "fact", content: "supersede-neg-v1" });
      const targetCreated = await ownerRepo.mutate(targetCmd, null, uuid(), owner.write());
      const replacement = { id: uuid(), workspace_id: ws, project_id: null, kind: "fact", visibility: "private", content: "agent-attempt", authority: "agent_inference" };
      const r = await agentRepo.mutate({ op: "supersede", id: targetCmd.id, replacement }, targetCreated.revision, uuid(), agent.write());
      assert.equal(r.status, "rejected");
      assert.equal(r.reason, "requires_owner_approval");
      const after = await ownerRepo.get(targetCmd.id, owner.read());
      assert.equal(itemsOf(after)[0]?.revision, targetCreated.revision, "T must be unchanged by an unapproved supersede attempt");
      assert.equal(itemsOf(after)[0]?.status, "active");
    });

    await t.test("owner exception on a constraint -> applied, exceptions[] updated", async () => {
      const constraintCmd = baseCreate({
        workspace_id: ws, kind: "constraint", authority: "explicit_user", visibility: "workspace",
        content: "no-publish-exception-target", applicability: { polarity: "forbid", action_terms: ["publish"] },
      });
      const cCreated = await ownerRepo.mutate(constraintCmd, null, uuid(), owner.ownerWrite());
      assert.equal(cCreated.status, "committed");
      const exceptionId = uuid();
      const exceptionCmd = {
        op: "exception", id: constraintCmd.id, exception_id: exceptionId,
        applicability: { polarity: "forbid", action_terms: ["publish"], project_ids: [uuid()] },
        valid_until: new Date(Date.now() + 86400000).toISOString(), reason: "one-off approved release",
      };
      const r = await ownerRepo.mutate(exceptionCmd, cCreated.revision, uuid(), owner.ownerWrite());
      assert.equal(r.status, "committed");
      const after = await ownerRepo.get(constraintCmd.id, owner.read());
      const rec = itemsOf(after)[0];
      assert.ok(Array.isArray(rec.exceptions) && rec.exceptions.some((e) => e.exception_id === exceptionId), "exceptions[] must include the new owner-approved exception");
    });

    await t.test("agent exception without owner trust -> rejected:requires_owner_approval", async () => {
      const constraintCmd = baseCreate({ workspace_id: ws, kind: "constraint", authority: "explicit_user", visibility: "workspace", content: "no-publish-exception-neg" });
      const cCreated = await ownerRepo.mutate(constraintCmd, null, uuid(), owner.ownerWrite());
      assert.equal(cCreated.status, "committed");
      const exceptionCmd = {
        op: "exception", id: constraintCmd.id, exception_id: uuid(), applicability: {},
        valid_until: new Date(Date.now() + 86400000).toISOString(), reason: "agent trying to grant itself an exception",
      };
      const r = await agentRepo.mutate(exceptionCmd, cCreated.revision, uuid(), agent.write());
      assert.equal(r.status, "rejected");
      assert.equal(r.reason, "requires_owner_approval");
      const after = await ownerRepo.get(constraintCmd.id, owner.read());
      assert.equal((itemsOf(after)[0]?.exceptions ?? []).length, 0, "no exception must have been recorded");
    });

    await t.test("owner release_dependency on a derived record -> applied, dependency_release server-set", async () => {
      const source = baseCreate({ workspace_id: ws, kind: "fact", content: "release-dep-source" });
      const sourceCreated = await ownerRepo.mutate(source, null, uuid(), owner.write());
      assert.equal(sourceCreated.status, "committed");
      const derived = baseCreate({
        workspace_id: ws, kind: "experience", authority: "verified_observation", content: "release-dep-derived",
        derived_from: [{ id: source.id, revision: sourceCreated.revision }],
      });
      const derivedCreated = await ownerRepo.mutate(derived, null, uuid(), owner.write());
      assert.equal(derivedCreated.status, "committed");
      const r = await ownerRepo.mutate(
        { op: "release_dependency", id: derived.id, redaction_report_ref: "reports/redaction-1.json" },
        derivedCreated.revision, uuid(), owner.ownerWrite(),
      );
      assert.equal(r.status, "committed");
      const after = await ownerRepo.get(derived.id, owner.read());
      const rec = itemsOf(after)[0];
      assert.ok(rec.dependency_release && rec.dependency_release.redaction_report_ref === "reports/redaction-1.json", "dependency_release must be server-set on the record after an owner-approved release");
    });

    await t.test("agent release_dependency without owner trust -> rejected:requires_owner_approval", async () => {
      const source = baseCreate({ workspace_id: ws, kind: "fact", content: "release-dep-source-2" });
      const sourceCreated = await ownerRepo.mutate(source, null, uuid(), owner.write());
      const derived = baseCreate({
        workspace_id: ws, kind: "experience", authority: "verified_observation", content: "release-dep-derived-2",
        derived_from: [{ id: source.id, revision: sourceCreated.revision }],
      });
      const derivedCreated = await ownerRepo.mutate(derived, null, uuid(), owner.write());
      assert.equal(derivedCreated.status, "committed");
      const r = await agentRepo.mutate(
        { op: "release_dependency", id: derived.id, redaction_report_ref: "reports/redaction-2.json" },
        derivedCreated.revision, uuid(), agent.write(),
      );
      assert.equal(r.status, "rejected");
      assert.equal(r.reason, "requires_owner_approval");
      const after = await ownerRepo.get(derived.id, owner.read());
      assert.equal(itemsOf(after)[0]?.dependency_release, null, "no dependency_release must have been recorded by an unapproved attempt");
    });
  });
} else {
  na("G-authz", "harness capabilities.agents=false");
}

// ===========================================================================
// G-visibility (R2.2)
// ===========================================================================

if (harness.capabilities.multiUser || harness.capabilities.agents) {
  test("G-visibility", async (t) => {
    const owner = await harness.newOwner("U");
    const ownerRepo = await harness.repoFor(owner);
    const ws = await harness.workspace(owner);
    const projA = await harness.project(owner, ws, "alpha");
    const projB = await harness.project(owner, ws, "beta");

    // (visibility, project) pairs -- includes TWO distinct "project"-visibility fixtures (Alpha, Beta)
    // so cross-project denial is exercised, not just cross-visibility denial.
    const fixtureSpecs = [
      { visibility: "private", projectId: null },
      { visibility: "project", projectId: projA },
      { visibility: "project", projectId: projB },
      { visibility: "workspace", projectId: null },
      { visibility: "owner_shared", projectId: null },
    ];
    const fixtures = [];
    for (const spec of fixtureSpecs) {
      const cmd = baseCreate({ workspace_id: ws, project_id: spec.projectId, visibility: spec.visibility, content: `secret-${spec.visibility}-${uuid()}` });
      const r = await ownerRepo.mutate(cmd, null, uuid(), owner.ownerWrite());
      assert.equal(r.status, "committed", `fixture ${spec.visibility}/${spec.projectId ?? "-"} must commit`);
      fixtures.push({ id: cmd.id, visibility: spec.visibility, projectId: spec.projectId });
    }

    // R2.2's `local_only` row: "never leaves the machine; cloud drivers reject it." On a local-mode
    // harness it behaves like any other owner-only fixture (never readable by anyone but the owner). On
    // a cloud-mode harness the CREATE itself must be rejected outright -- there is no "local runtime" for
    // a hosted backend to scope it to.
    if (ownerRepo.mode === "local") {
      const localOnlyCmd = baseCreate({ workspace_id: ws, project_id: null, visibility: "local_only", content: `secret-local_only-${uuid()}` });
      const localOnlyCreated = await ownerRepo.mutate(localOnlyCmd, null, uuid(), owner.ownerWrite());
      assert.equal(localOnlyCreated.status, "committed", "local_only fixture must commit on a local-mode harness");
      fixtures.push({ id: localOnlyCmd.id, visibility: "local_only", projectId: null });
    } else {
      const localOnlyCmd = baseCreate({ workspace_id: ws, project_id: null, visibility: "local_only", content: "should-be-rejected" });
      const localOnlyResult = await ownerRepo.mutate(localOnlyCmd, null, uuid(), owner.ownerWrite());
      assert.equal(localOnlyResult.status, "rejected", "cloud-mode harness must reject a local_only create outright");
      assert.equal(localOnlyResult.reason, "local_only");
    }
    // A handoff fixture for latestHandoff denial checks.
    const taskKey = "vis-task-" + uuid();
    const handoffCmd = baseCreate({
      workspace_id: ws, project_id: projA, visibility: "project", kind: "handoff",
      content: handoffContent(makeHandoffPayload({ task_key: taskKey })),
    });
    const handoffCreated = await ownerRepo.mutate(handoffCmd, null, uuid(), owner.ownerWrite());
    assert.equal(handoffCreated.status, "committed");

    const actors = [];
    if (harness.capabilities.multiUser) {
      const v = await harness.newOwner("V");
      actors.push({ label: "V-unrelated-user", actor: v, allowed: new Set() });
    }
    if (harness.capabilities.agents) {
      const alphaReader = await harness.newAgent(owner, "alpha-reader", {
        workspace_id: ws, project_ids: [projA], can_read: true, can_write: false, can_approve: false, personal: false,
      });
      actors.push({
        label: "agent-alpha-reader",
        actor: alphaReader,
        allowed: new Set(fixtures.filter((f) => f.visibility === "project" && f.projectId === projA).map((f) => f.id)),
        allowedHandoff: true,
      });
      const betaReader = await harness.newAgent(owner, "beta-reader", {
        workspace_id: ws, project_ids: [projB], can_read: true, can_write: false, can_approve: false, personal: false,
      });
      actors.push({
        label: "agent-beta-reader",
        actor: betaReader,
        allowed: new Set(fixtures.filter((f) => f.visibility === "project" && f.projectId === projB).map((f) => f.id)),
        allowedHandoff: false, // handoff fixture lives under project Alpha; a Beta-scoped grant must not see it
      });
      const revoked = await harness.newAgent(owner, "revoked", {
        workspace_id: ws, project_ids: null, can_read: true, can_write: false, can_approve: false, personal: false,
      });
      await harness.revoke(owner, revoked, ws);
      actors.push({ label: "agent-revoked", actor: revoked, allowed: new Set() });

      const otherWs = await harness.workspace(owner);
      const wrongWorkspaceAgent = await harness.newAgent(owner, "wrong-workspace", {
        workspace_id: otherWs, project_ids: null, can_read: true, can_write: false, can_approve: false, personal: false,
      });
      actors.push({ label: "agent-wrong-workspace", actor: wrongWorkspaceAgent, allowed: new Set() });
    }

    assert.ok(actors.length > 0, "at least one unauthorized actor is required for this group to be meaningful");

    let requestCount = 0;
    const violations = [];

    function record(label, ok, extra) {
      requestCount += 1;
      if (!ok) violations.push({ label, ...extra });
    }

    const ID_GUESS_REPEATS = 3;
    // A07 / PLAN.md §9.2 floor: "至少1000次矩阵请求" (>=1000 allow/deny matrix requests). Reads are
    // side-effect-free, so repeating the full actor x fixture x read-path matrix across ROUNDS is a
    // legitimate way to reach that floor (it also surfaces any intermittent/racy authorization bug the
    // same way G-cas repeats 100 CAS pairs rather than trying exactly one).
    const ROUNDS = 5;

    for (let round = 0; round < ROUNDS; round += 1) {
      for (const { label, actor, allowed, allowedHandoff } of actors) {
        const repo = await harness.repoFor(actor);
        const readCtx = () => actor.read({ workspace_id: ws });

        for (const fx of fixtures) {
          const shouldAllow = allowed.has(fx.id);
          const fxLabel = `${fx.visibility}${fx.projectId ? `(${fx.projectId.slice(0, 8)})` : ""}`;

          const g = await repo.get(fx.id, readCtx());
          record(`round${round} ${label} get ${fxLabel}`, shouldAllow ? containsId(g, fx.id) : isDenied(g), { got: g });

          const q = await repo.query({ ids: [fx.id] }, readCtx());
          record(`round${round} ${label} query ${fxLabel}`, shouldAllow ? containsId(q, fx.id) : isDenied(q), { got: q });

          const snap = await repo.readSnapshot(readCtx(), { ids: [fx.id] });
          record(`round${round} ${label} readSnapshot ${fxLabel}`, shouldAllow ? containsId(snap, fx.id) : isDenied(snap), {});

          const page = await repo.list({ ids: [fx.id] }, readCtx(), null);
          record(`round${round} ${label} list ${fxLabel}`, shouldAllow ? page.items.some((i) => i.id === fx.id) : page.items.length === 0, {});

          const hist = await repo.history(fx.id, readCtx());
          record(`round${round} ${label} history ${fxLabel}`, shouldAllow ? hist.length > 0 : hist.length === 0, {});

          const exp = await repo.export({ ids: [fx.id] }, readCtx());
          record(`round${round} ${label} export ${fxLabel}`, shouldAllow ? exp.records.some((i) => i.id === fx.id) : exp.records.length === 0, {});

          // id guessing: a totally nonexistent id must look identical (empty) to a denied real id, repeated.
          for (let g2 = 0; g2 < ID_GUESS_REPEATS; g2 += 1) {
            const guess = await repo.get(uuid(), readCtx());
            record(`round${round} ${label} get id-guess#${g2} vs ${fxLabel}`, isDenied(guess), {});
          }
        }

        const lh = await repo.latestHandoff(projA, taskKey, readCtx());
        record(`round${round} ${label} latestHandoff`, allowedHandoff ? containsId(lh, handoffCmd.id) : isDenied(lh), {});
      }

      // Legit positive control each round: owner reading their own fixtures always succeeds.
      for (const fx of fixtures) {
        const g = await ownerRepo.get(fx.id, owner.read());
        record(`round${round} owner get ${fx.visibility}`, containsId(g, fx.id), {});
      }
    }

    assert.ok(requestCount >= 1000, `G-visibility must issue >=1000 requests (A07/PLAN.md §9.2), issued ${requestCount}`);
    assert.equal(
      violations.length, 0,
      `G-visibility: ${violations.length}/${requestCount} allow/deny violations: ${JSON.stringify(violations.slice(0, 10).map((v) => v.label))}`,
    );
  });
} else {
  na("G-visibility", "harness capabilities.multiUser=false and agents=false");
}

// ===========================================================================
// G-existence (R2.3) -- mutation-side existence hiding
// ===========================================================================
// G-visibility only exercises existence hiding on the READ side (get/query/... of an unreadable id looks
// like a nonexistent id). R2.3 additionally requires the same indistinguishability on the MUTATE side:
// updating/retracting a record the caller cannot read must resolve to rejected:not_found (never
// "forbidden", which would confirm the id refers to something real), and a genuine CAS conflict must
// never carry `current` for a caller who can't read the record.

if (harness.capabilities.agents || harness.capabilities.multiUser) {
  test("G-existence", async (t) => {
    const owner = await harness.newOwner("U");
    const ownerRepo = await harness.repoFor(owner);
    const ws = await harness.workspace(owner);

    const seed = baseCreate({ workspace_id: ws, visibility: "private", content: "existence-secret" });
    const created = await ownerRepo.mutate(seed, null, uuid(), owner.ownerWrite());
    assert.equal(created.status, "committed");

    async function makeStranger(label) {
      if (harness.capabilities.multiUser) return harness.newOwner(label);
      // No multiUser support: an agent granted on a DIFFERENT, unrelated workspace has zero standing on `ws`.
      return harness.newAgent(owner, label, { workspace_id: uuid(), project_ids: null, can_read: false, can_write: false, can_approve: false, personal: false });
    }

    await t.test("update by a caller with no grant on T -> rejected:not_found, never forbidden", async () => {
      const stranger = await makeStranger("existence-stranger-update");
      const strangerRepo = await harness.repoFor(stranger);
      const r = await strangerRepo.mutate({ op: "update", id: seed.id, patch: { content: "hijacked" } }, created.revision, uuid(), stranger.write());
      assert.equal(r.status, "rejected");
      assert.equal(r.reason, "not_found", `must not leak existence via a different reason (got "${r.reason}")`);
    });

    await t.test("retract by a caller with no grant on T -> rejected:not_found, never forbidden", async () => {
      const stranger = await makeStranger("existence-stranger-retract");
      const strangerRepo = await harness.repoFor(stranger);
      const r = await strangerRepo.mutate({ op: "retract", id: seed.id, reason: "hijack attempt" }, created.revision, uuid(), stranger.write());
      assert.equal(r.status, "rejected");
      assert.equal(r.reason, "not_found");
      const after = await ownerRepo.get(seed.id, owner.read());
      assert.equal(itemsOf(after)[0]?.status, "active", "the unauthorized retract attempt must not have taken effect");
    });

    await t.test("a deliberately wrong expectedRevision from an unauthorized caller still resolves not_found, never conflict", async () => {
      const stranger = await makeStranger("existence-stranger-wrongrev");
      const strangerRepo = await harness.repoFor(stranger);
      const r = await strangerRepo.mutate({ op: "update", id: seed.id, patch: { content: "hijack-2" } }, created.revision + 999, uuid(), stranger.write());
      assert.equal(r.status, "rejected");
      assert.equal(r.reason, "not_found", "a CAS-shaped mismatch must not surface as 'conflict' to a caller who cannot read T -- that would itself leak existence");
    });

    if (harness.capabilities.agents) {
      await t.test("ConflictReceipt.current is absent when the CAS-losing caller cannot read T (R2.3)", async () => {
        const writeOnly = await harness.newAgent(owner, "existence-write-only-no-read", {
          workspace_id: ws, project_ids: null, can_read: false, can_write: true, can_approve: false, personal: true,
        });
        const writeOnlyRepo = await harness.repoFor(writeOnly);
        // Move T on so writeOnly's captured revision is stale, forcing a genuine CAS conflict (not a
        // grant-rejection) once writeOnly attempts its own update.
        const bump = await ownerRepo.mutate({ op: "update", id: seed.id, patch: { content: "bumped-by-owner" } }, created.revision, uuid(), owner.write());
        assert.equal(bump.status, "committed");

        const r = await writeOnlyRepo.mutate({ op: "update", id: seed.id, patch: { content: "write-only-attempt" } }, created.revision, uuid(), writeOnly.write());
        assert.equal(r.status, "conflict", "a can_write (but not can_read) grant must still reach real CAS comparison, not be short-circuited as not_found");
        assert.ok(r.current === null || r.current === undefined, "ConflictReceipt.current must be absent for a caller who cannot read T (R2.3)");
      });
    }
  });
} else {
  na("G-existence", "harness capabilities.multiUser=false and agents=false");
}

// ===========================================================================
// G-retract (A16 subset)
// ===========================================================================

test("G-retract", async (t) => {
  const owner = await harness.newOwner("U");
  const repo = await harness.repoFor(owner);
  const ws = await harness.workspace(owner);

  const cmd = baseCreate({ workspace_id: ws, content: "will-be-retracted" });
  const created = await repo.mutate(cmd, null, uuid(), owner.write());
  assert.equal(created.status, "committed");

  const handoffTaskKey = "retract-task-" + uuid();
  const handoffCmd = baseCreate({
    workspace_id: ws, kind: "handoff", content: handoffContent(makeHandoffPayload({ task_key: handoffTaskKey })),
  });
  const handoffCreated = await repo.mutate(handoffCmd, null, uuid(), owner.write());
  assert.equal(handoffCreated.status, "committed");

  const retract = await repo.mutate({ op: "retract", id: cmd.id, reason: "test retraction" }, created.revision, uuid(), owner.write());
  assert.equal(retract.status, "committed");
  const retractHandoff = await repo.mutate({ op: "retract", id: handoffCmd.id, reason: "test retraction" }, handoffCreated.revision, uuid(), owner.write());
  assert.equal(retractHandoff.status, "committed");

  await t.test("get never returns retracted content", async () => {
    const r = await repo.get(cmd.id, owner.read());
    assert.ok(isDenied(r), "retracted record must not be returned by get()");
  });
  await t.test("query never returns retracted content", async () => {
    const r = await repo.query({ ids: [cmd.id] }, owner.read());
    assert.ok(isDenied(r));
  });
  await t.test("readSnapshot never returns retracted content", async () => {
    const r = await repo.readSnapshot(owner.read(), { ids: [cmd.id] });
    assert.ok(isDenied(r));
  });
  await t.test("list never returns retracted content", async () => {
    const page = await repo.list({ ids: [cmd.id] }, owner.read(), null);
    assert.equal(page.items.length, 0);
  });
  await t.test("export never returns retracted content", async () => {
    const r = await repo.export({ ids: [cmd.id] }, owner.read());
    assert.equal(r.records.length, 0);
  });
  await t.test("latestHandoff never returns a retracted handoff", async () => {
    const r = await repo.latestHandoff(null, handoffTaskKey, owner.read());
    assert.ok(isDenied(r));
  });
  await t.test("history shows the retraction as a tombstone, not silently omitted", async () => {
    const h = await repo.history(cmd.id, owner.read());
    assert.ok(h.length > 0, "history must still report the record existed");
    const last = h[h.length - 1];
    assert.equal(last.status, "retracted");
  });
});

// ===========================================================================
// G-derived (R2.11)
// ===========================================================================

test("G-derived", async (t) => {
  const owner = await harness.newOwner("U");
  const repo = await harness.repoFor(owner);
  const ws = await harness.workspace(owner);

  const source = baseCreate({ workspace_id: ws, kind: "fact", content: "source-of-truth" });
  const sourceCreated = await repo.mutate(source, null, uuid(), owner.write());
  assert.equal(sourceCreated.status, "committed");

  const derived = baseCreate({
    workspace_id: ws, kind: "experience", authority: "verified_observation", content: "derived-summary",
    derived_from: [{ id: source.id, revision: sourceCreated.revision }],
  });
  const derivedCreated = await repo.mutate(derived, null, uuid(), owner.write());
  assert.equal(derivedCreated.status, "committed");

  await t.test("derived record is visible while its source is valid", async () => {
    const r = await repo.query({ ids: [derived.id] }, owner.read());
    assert.ok(containsId(r, derived.id));
    assert.equal(r.withheld_derived ?? 0, 0);
  });

  await t.test("derived record is withheld once its source is retracted", async () => {
    const retract = await repo.mutate({ op: "retract", id: source.id, reason: "source retracted" }, sourceCreated.revision, uuid(), owner.write());
    assert.equal(retract.status, "committed");
    const r = await repo.query({ ids: [derived.id] }, owner.read());
    assert.ok(!containsId(r, derived.id), "derived record must be withheld once a closure source is retracted");
    assert.ok((r.withheld_derived ?? 0) >= 1, "withheld_derived must count the withheld derived record");
  });

  // Independent scenario: source revised (not retracted) -> closure revision mismatch -> also withheld.
  const source2 = baseCreate({ workspace_id: ws, kind: "fact", content: "source-2-v1" });
  const source2Created = await repo.mutate(source2, null, uuid(), owner.write());
  assert.equal(source2Created.status, "committed");
  const derived2 = baseCreate({
    workspace_id: ws, kind: "experience", authority: "verified_observation", content: "derived-2-summary",
    derived_from: [{ id: source2.id, revision: source2Created.revision }],
  });
  const derived2Created = await repo.mutate(derived2, null, uuid(), owner.write());
  assert.equal(derived2Created.status, "committed");

  await t.test("derived record is withheld once its source is revised (closure revision mismatch)", async () => {
    const update = await repo.mutate({ op: "update", id: source2.id, patch: { content: "source-2-v2" } }, source2Created.revision, uuid(), owner.write());
    assert.equal(update.status, "committed");
    const r = await repo.query({ ids: [derived2.id] }, owner.read());
    assert.ok(!containsId(r, derived2.id), "derived record must be withheld once a closure source's revision no longer matches");
    assert.ok((r.withheld_derived ?? 0) >= 1);
  });

  await t.test("derived_closure exceeding the 256-entry cap is withheld (R2.11: 'cap 256; overflow -> withheld')", async () => {
    const OVER_CAP = 257;
    const sourceRefs = [];
    for (let i = 0; i < OVER_CAP; i += 1) {
      const s = baseCreate({ workspace_id: ws, kind: "fact", content: `closure-cap-source-${i}` });
      const sCreated = await repo.mutate(s, null, uuid(), owner.write());
      assert.equal(sCreated.status, "committed", `closure-cap source ${i} must commit`);
      sourceRefs.push({ id: s.id, revision: sCreated.revision });
    }
    const overCapDerived = baseCreate({
      workspace_id: ws, kind: "experience", authority: "verified_observation", content: "over-cap-derived",
      derived_from: sourceRefs,
    });
    const overCapCreated = await repo.mutate(overCapDerived, null, uuid(), owner.write());
    assert.equal(overCapCreated.status, "committed", "the CREATE itself must still succeed (the cap governs closure validity/withholding, not creation)");
    const r = await repo.query({ ids: [overCapDerived.id] }, owner.read());
    assert.ok(!containsId(r, overCapDerived.id), `a derived record with ${OVER_CAP} direct sources (over the 256 cap) must be withheld, not silently truncated and shown`);
    assert.ok((r.withheld_derived ?? 0) >= 1, "withheld_derived must count the over-cap record");
  });
});

// ===========================================================================
// G-handoff (A21 subset)
// ===========================================================================

test("G-handoff", async (t) => {
  const owner = await harness.newOwner("U");
  const repo = await harness.repoFor(owner);
  const ws = await harness.workspace(owner);

  await t.test("verified_done without evidence -> schema", async () => {
    const cmd = baseCreate({
      workspace_id: ws, kind: "handoff",
      content: handoffContent(makeHandoffPayload({ items: [{ text: "shipped it", status: "verified_done", evidence_refs: [] }] })),
    });
    const r = await repo.mutate(cmd, null, uuid(), owner.write());
    assert.equal(r.status, "rejected");
    assert.equal(r.reason, "schema");
  });

  await t.test("latestHandoff returns the newest checkpoint for a task_key (ordered by commit sequence, not wall-clock)", async () => {
    // Deliberately NO artificial sleeps between checkpoints: on a coarse system clock, a driver that
    // orders "newest" purely by created_at wall-time can tie or even invert order under a few ms of
    // separation. Ordering here comes only from strictly sequential `await`s (JS gives us a real
    // happens-before between these three commits regardless of clock resolution) plus each receipt's own
    // commit_cursor, which is checked as a monotonic corroborating signal.
    const taskKey = "handoff-task-" + uuid();
    const c1 = baseCreate({ workspace_id: ws, kind: "handoff", content: handoffContent(makeHandoffPayload({ task_key: taskKey, state: "checkpoint-1" })) });
    const r1 = await repo.mutate(c1, null, uuid(), owner.write());
    assert.equal(r1.status, "committed");
    const c2 = baseCreate({ workspace_id: ws, kind: "handoff", content: handoffContent(makeHandoffPayload({ task_key: taskKey, state: "checkpoint-2" })) });
    const r2 = await repo.mutate(c2, null, uuid(), owner.write());
    assert.equal(r2.status, "committed");
    const c3 = baseCreate({ workspace_id: ws, kind: "handoff", content: handoffContent(makeHandoffPayload({ task_key: taskKey, state: "checkpoint-3" })) });
    const r3 = await repo.mutate(c3, null, uuid(), owner.write());
    assert.equal(r3.status, "committed");

    // commit_cursor is documented as an ordering cursor; it must be non-decreasing across strictly
    // sequential commits regardless of clock resolution.
    assert.ok(
      String(r1.commit_cursor) <= String(r2.commit_cursor) && String(r2.commit_cursor) <= String(r3.commit_cursor),
      `commit_cursor must be monotonic across sequential commits: ${r1.commit_cursor} / ${r2.commit_cursor} / ${r3.commit_cursor}`,
    );

    const latest = await repo.latestHandoff(null, taskKey, owner.read());
    assert.ok(containsId(latest, c3.id), "latestHandoff must return the newest (last-committed) checkpoint");
    assert.ok(!containsId(latest, c1.id) && !containsId(latest, c2.id), "latestHandoff must not return older checkpoints alongside the newest");
  });

  await t.test("CAS conflict on concurrent checkpoint update", async () => {
    const taskKey = "handoff-cas-" + uuid();
    const seed = baseCreate({ workspace_id: ws, kind: "handoff", content: handoffContent(makeHandoffPayload({ task_key: taskKey, state: "v1" })) });
    const created = await repo.mutate(seed, null, uuid(), owner.write());
    assert.equal(created.status, "committed");

    const cmdA = { op: "update", id: seed.id, patch: { content: handoffContent(makeHandoffPayload({ task_key: taskKey, state: "v2-A" })) } };
    const cmdB = { op: "update", id: seed.id, patch: { content: handoffContent(makeHandoffPayload({ task_key: taskKey, state: "v2-B" })) } };
    const [ra, rb] = await Promise.all([
      repo.mutate(cmdA, created.revision, uuid(), owner.write()),
      repo.mutate(cmdB, created.revision, uuid(), owner.write()),
    ]);
    const committedCount = [ra.status, rb.status].filter((s) => s === "committed").length;
    const conflictCount = [ra.status, rb.status].filter((s) => s === "conflict").length;
    assert.equal(committedCount, 1, `expected exactly 1 committed, got ra=${ra.status} rb=${rb.status}`);
    assert.equal(conflictCount, 1, `expected exactly 1 conflict, got ra=${ra.status} rb=${rb.status}`);
  });
});

// ===========================================================================
// G-cursor (A13 subset)
// ===========================================================================

test("G-cursor", async (t) => {
  const owner = await harness.newOwner("U");
  const ws = await harness.workspace(owner);

  const writers = [];
  const WRITER_COUNT = 4;
  const PER_WRITER = 250; // 4 * 250 = 1000 events
  for (let w = 0; w < WRITER_COUNT; w += 1) {
    let actor = owner;
    if (harness.capabilities.agents) {
      actor = await harness.newAgent(owner, `cursor-writer-${w}`, { workspace_id: ws, project_ids: null, can_read: true, can_write: true, can_approve: false, personal: true });
    }
    writers.push({ actor, repo: await harness.repoFor(actor) });
  }

  const expectedIds = new Set();
  async function runWriter({ actor, repo }, n) {
    for (let i = 0; i < n; i += 1) {
      const cmd = baseCreate({ workspace_id: ws, content: `cursor-${actor.label}-${i}` });
      const r = await repo.mutate(cmd, null, uuid(), actor.write());
      assert.equal(r.status, "committed", `writer ${actor.label} event ${i} must commit`);
      expectedIds.add(cmd.id);
    }
  }

  await Promise.all(writers.map((w) => runWriter(w, PER_WRITER)));
  assert.equal(expectedIds.size, WRITER_COUNT * PER_WRITER);

  const readerRepo = await harness.repoFor(owner);
  const events = await collectAllChanges(readerRepo, owner.read(), 37 /* odd page size to stress boundaries */);

  const seenEventIds = new Set();
  const dupEventIds = [];
  for (const e of events) {
    if (seenEventIds.has(e.event_id)) dupEventIds.push(e.event_id);
    seenEventIds.add(e.event_id);
  }
  assert.equal(dupEventIds.length, 0, `readChanges pagination must not duplicate events; found ${dupEventIds.length} dup(s)`);

  const createdIdsInStream = new Set(events.filter((e) => e.op === "create").map((e) => e.record_id));
  const missing = [...expectedIds].filter((id) => !createdIdsInStream.has(id));
  assert.equal(missing.length, 0, `readChanges must not have gaps; missing ${missing.length}/${expectedIds.size} create events`);

  // Cross-check vs a final snapshot: every id we created must still be reachable via list() with paging.
  let cursor = null;
  const snapshotIds = new Set();
  for (;;) {
    const page = await readerRepo.list({ kinds: ["fact"] }, owner.read(), cursor);
    for (const it of page.items) snapshotIds.add(it.id);
    if (!page.next_page_cursor) break;
    cursor = page.next_page_cursor;
    if (snapshotIds.size > expectedIds.size * 4) break; // safety valve
  }
  const missingFromSnapshot = [...expectedIds].filter((id) => !snapshotIds.has(id));
  assert.equal(missingFromSnapshot.length, 0, `final snapshot (list) must contain every committed id; missing ${missingFromSnapshot.length}`);
});

// ===========================================================================
// G-durability (IF faults include crash_before_receipt / crash_after_wal)
// ===========================================================================

const crashKinds = (harness.capabilities.faults ?? []).filter((k) => k === "crash_before_receipt" || k === "crash_after_wal");
if (crashKinds.length > 0) {
  test("G-durability", async (t) => {
    const owner = await harness.newOwner("U");
    const ws = await harness.workspace(owner);

    for (const kind of crashKinds) {
      await t.test(`fault=${kind}: 1000 writes (fault re-armed at intervals), restart, verify`, async () => {
        const repo = await harness.repoFor(owner);
        const TOTAL = 1000; // A08 / PLAN.md §9.2 floor: "1,000 个确认 committed 操作"
        const FAULT_EVERY = 100; // 10 explicit fault-armed commit boundaries spread across the run

        const attempts = [];
        for (let i = 0; i < TOTAL; i += 1) {
          const faultArmedForThisWrite = i % FAULT_EVERY === 0;
          if (faultArmedForThisWrite) await harness.armFault(kind, owner);
          const cmd = baseCreate({ workspace_id: ws, content: `durability-${kind}-${i}` });
          const opId = uuid();
          let receipt = null;
          let threw = false;
          try {
            receipt = await repo.mutate(cmd, null, opId, owner.write());
          } catch {
            threw = true;
          }
          attempts.push({ opId, id: cmd.id, receipt, threw, faultArmedForThisWrite });
          if (faultArmedForThisWrite) await harness.clearFaults(); // isolate the fault to exactly this one write
        }
        const restarted = await harness.restart(owner);

        let committedBeforeRestart = 0;
        const violations = [];
        for (const a of attempts) {
          const wasClientCommitted = !!(a.receipt && a.receipt.status === "committed");
          if (wasClientCommitted) committedBeforeRestart += 1;
          const op = await restarted.getOperation(a.opId, owner.principal);
          const isNowCommitted = !!(op && op.receipt && op.receipt.status === "committed");

          if (wasClientCommitted && !isNowCommitted) {
            violations.push({ opId: a.opId, reason: "client-committed write lost after restart" });
          }
          if (kind === "crash_before_receipt" && a.faultArmedForThisWrite && !wasClientCommitted && isNowCommitted) {
            // A crash strictly BEFORE any receipt was produced must not silently resolve to committed later
            // (that would mean the client's failure to observe a receipt was inconsistent with server state).
            violations.push({ opId: a.opId, reason: "crash_before_receipt: reported committed after restart despite no client-visible receipt" });
          }
        }

        // Non-vacuous (review blocker #1): a driver that rejects/throws on every write -- or on almost
        // every write -- must not be able to "pass" this group by producing zero violations trivially
        // (0 committed / 0 lost is not evidence of durability, it's evidence of doing nothing). Only
        // TOTAL/FAULT_EVERY writes were ever fault-affected; the rest ran under normal conditions and a
        // correctly functioning driver must show the overwhelming majority of them as committed.
        const nonVacuousThreshold = TOTAL - Math.floor(TOTAL / FAULT_EVERY) - Math.floor(TOTAL * 0.05);
        assert.ok(
          committedBeforeRestart >= nonVacuousThreshold,
          `G-durability(${kind}): only ${committedBeforeRestart}/${TOTAL} writes reached client-visible committed (need >= ${nonVacuousThreshold}); a driver that rejects/throws on (nearly) everything must not pass this group vacuously`,
        );

        assert.equal(violations.length, 0, `G-durability(${kind}): ${violations.length}/${TOTAL} violations: ${JSON.stringify(violations.slice(0, 5))}`);
      });
    }
  });
} else {
  na("G-durability", "harness capabilities.faults includes no crash_* kind");
}

// ===========================================================================
// G-outbox (IF faults include offline)
// ===========================================================================

if ((harness.capabilities.faults ?? []).includes("offline")) {
  test("G-outbox", async (t) => {
    const owner = await harness.newOwner("U");
    const ws = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);

    await harness.armFault("offline", owner);

    const QUEUED_COUNT = 20;
    const queued = [];
    for (let i = 0; i < QUEUED_COUNT; i += 1) {
      const cmd = baseCreate({ workspace_id: ws, content: `offline-${i}` });
      const opId = uuid();
      const r = await repo.mutate(cmd, null, opId, owner.write());
      assert.equal(r.status, "queued", `write ${i} while offline must be queued, not committed (got ${r.status})`);
      queued.push({ opId, id: cmd.id });
    }

    const restarted = await harness.restart(owner);
    for (const q of queued) {
      const op = await restarted.getOperation(q.opId, owner.principal);
      assert.ok(op, `queued op ${q.opId} must survive a restart while still offline`);
      assert.equal(op.receipt.status, "queued", "must still report queued after restart while offline");
    }

    await harness.clearFaults();
    const onlineRepo = await harness.restart(owner);

    for (const q of queued) {
      await poll(async () => {
        const op = await onlineRepo.getOperation(q.opId, owner.principal);
        return op && op.receipt.status === "committed" ? op : false;
      }, { timeoutMs: 5000, intervalMs: 100 });
    }
    for (const q of queued) {
      const r = await onlineRepo.get(q.id, owner.read());
      assert.equal(itemsOf(r).length, 1, `record ${q.id} must exist exactly once after flush (no duplication)`);
    }

    await t.test("a queued write that conflicts once online resolves to a terminal conflict", async () => {
      const seed = baseCreate({ workspace_id: ws, content: "conflict-seed" });
      const created = await repo.mutate(seed, null, uuid(), owner.write());
      assert.equal(created.status, "committed");

      await harness.armFault("offline", owner);
      const offlineRepo = await harness.repoFor(owner);
      const offlineOpId = uuid();
      const offlineUpdate = await offlineRepo.mutate({ op: "update", id: seed.id, patch: { content: "offline-edit" } }, created.revision, offlineOpId, owner.write());
      assert.equal(offlineUpdate.status, "queued");

      // A conflicting online edit happens (via a fresh online connection) while the above stays queued.
      await harness.clearFaults();
      const onlineOwnerRepo = await harness.restart(owner);
      const onlineEdit = await onlineOwnerRepo.mutate({ op: "update", id: seed.id, patch: { content: "online-edit" } }, created.revision, uuid(), owner.write());
      assert.equal(onlineEdit.status, "committed");

      const finalStatus = await poll(async () => {
        const op = await onlineOwnerRepo.getOperation(offlineOpId, owner.principal);
        return op && (op.receipt.status === "conflict" || op.receipt.status === "committed") ? op : false;
      }, { timeoutMs: 5000, intervalMs: 100 });
      assert.equal(finalStatus.receipt.status, "conflict", "the queued write, once flushed against a moved-on revision, must terminally conflict (not silently drop or overwrite)");
    });
  });
} else {
  na("G-outbox", "harness capabilities.faults does not include offline");
}

// ===========================================================================
// G-ackloss (IF faults include ack_lost)
// ===========================================================================

if ((harness.capabilities.faults ?? []).includes("ack_lost")) {
  test("G-ackloss", async (t) => {
    const owner = await harness.newOwner("U");
    const ws = await harness.workspace(owner);
    const repo = await harness.repoFor(owner);

    await harness.armFault("ack_lost", owner);
    const cmd = baseCreate({ workspace_id: ws, content: "ackloss-write" });
    const opId = uuid();
    let receipt = null;
    try {
      receipt = await repo.mutate(cmd, null, opId, owner.write());
    } catch {
      receipt = null;
    }
    if (receipt) assert.equal(receipt.status, "unknown", "an ack-lost write should surface as status=unknown to the caller, not a false success/failure");
    await harness.clearFaults();

    await t.test("getOperation resolves the unknown receipt to the original committed outcome", async () => {
      const op = await repo.getOperation(opId, owner.principal);
      assert.ok(op, "getOperation must be able to recover the true outcome of an ack-lost write");
      assert.equal(op.receipt.status, "committed", "the operation must actually have committed server-side");
      assert.equal(op.receipt.id, cmd.id);
    });

    await t.test("retrying the same operation id/payload after ack loss does not duplicate", async () => {
      const retry = await repo.mutate(cmd, null, opId, owner.write());
      assert.equal(retry.status, "committed");
      assert.equal(retry.replayed, true);
      const after = await repo.get(cmd.id, owner.read());
      const rec = itemsOf(after)[0];
      assert.ok(rec, "record must exist");
      assert.equal(rec.revision, 1, "retry after ack loss must not create a second revision/duplicate");
    });
  });
} else {
  na("G-ackloss", "harness capabilities.faults does not include ack_lost");
}

// ===========================================================================
// Teardown (registered last so it runs after all groups above)
// ===========================================================================

test("zzz-harness-teardown", async () => {
  await harness.teardown();
});
