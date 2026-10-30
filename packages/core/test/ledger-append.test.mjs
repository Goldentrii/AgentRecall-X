// packages/core/test/ledger-append.test.mjs — ledger spec SW-3: appendLedgerEvent,
// heads, readEvents, failure policy (D8). W3 extends block (b) with real
// palaceWrite + sessionEnd calls.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";

const TEST_ROOT = path.join(os.tmpdir(), "ar-ledger-append-" + Date.now());
const PROJECT = "ledger-probe";
const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");

function eventLines() {
  const f = path.join(TEST_ROOT, "ledger", "events.jsonl");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf-8").split("\n").filter(Boolean) : [];
}

/** Capture console.error output while fn runs. */
async function captureStderr(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return lines.join("\n");
}

describe("ledger append", () => {
  let core;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core = await import("../dist/index.js");
    core.setRoot(TEST_ROOT);
  });

  after(() => {
    core.resetRoot?.();
    core.resetLedgerContext();
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    core.resetLedgerContext();
  });

  it("a/b/c/d: journalWrite -> palace.write -> session.end chain, heads, rebuild, read", async () => {
    // (a) journalWrite is the wired reference integration
    await core.journalWrite({ project: PROJECT, content: "ledger probe entry" });
    const lines = eventLines();
    assert.equal(lines.length, 1);
    const e1 = JSON.parse(lines[0]);
    assert.equal(e1.type, "journal.write");
    assert.ok(e1.target.startsWith(`projects/${PROJECT}/journal/`), e1.target);
    assert.ok(!e1.target.includes("\\"));
    const onDisk = fs.readFileSync(path.join(TEST_ROOT, e1.target));
    assert.equal(e1.sha256, sha256hex(onDisk));
    assert.equal(e1.bytes, onDisk.length);
    assert.equal(e1.parent, null);
    assert.equal(e1.via, "library");
    assert.equal(e1.actor, "system");
    assert.ok(["A", "B", "C"].includes(e1.host));
    assert.equal(e1.v, 1);
    assert.ok(core.isUlid(e1.id));

    // (b) W3 REPLACES THIS BLOCK with real palaceWrite + sessionEnd calls
    const palaceRel = `projects/${PROJECT}/palace/rooms/goals/active.md`;
    fs.mkdirSync(path.dirname(path.join(TEST_ROOT, palaceRel)), { recursive: true });
    fs.writeFileSync(path.join(TEST_ROOT, palaceRel), "# goals\n");
    const e2 = await core.appendLedgerEvent({ type: "palace.write", project: PROJECT, target: palaceRel });
    const e3 = await core.appendLedgerEvent({ type: "session.end", project: PROJECT, target: null });
    assert.equal(eventLines().length, 3);
    assert.equal(e2.parent, e1.id);
    assert.equal(e3.parent, e2.id);
    assert.equal(e3.sha256, null);
    const headsPath = path.join(TEST_ROOT, "ledger", "heads.json");
    const heads = JSON.parse(fs.readFileSync(headsPath, "utf-8"));
    assert.deepEqual(heads[PROJECT], { head: e3.id, count: 3, first_ts: e1.ts, last_ts: e3.ts });

    // (c) heads.json is derived: delete + rebuild is byte-identical
    const before = fs.readFileSync(headsPath);
    fs.rmSync(headsPath);
    assert.deepEqual(core.rebuildHeads(), { projects: 1, events: 3, badLines: 0 });
    assert.ok(before.equals(fs.readFileSync(headsPath)));

    // (d) readEvents filters
    assert.equal(core.readEvents({ project: PROJECT }).length, 3);
    assert.equal(core.readEvents({ project: PROJECT, type: "journal.write" }).length, 1);
    assert.deepEqual(core.readEvents({ project: PROJECT, limit: 2 }), [e2, e3]);
    assert.deepEqual(core.readEvents({ project: "other" }), []);
    assert.equal(core.readEvents({ since: "24h" }).length, 3);
    assert.equal(core.readEvents({ since: "2999-01-01" }).length, 0);
  });

  it("e: failure path (D8) — unwritable ledger/ never throws into the mutation", async () => {
    fs.writeFileSync(path.join(TEST_ROOT, "ledger"), "not a dir");
    let res;
    const err1 = await captureStderr(async () => {
      res = await core.journalWrite({ project: PROJECT, content: "survives ledger failure" });
    });
    assert.equal(res.success, true);
    assert.ok(fs.existsSync(res.file), "journal file must exist despite ledger failure");
    assert.match(err1, /ledger append failed/);

    let ev;
    const err2 = await captureStderr(async () => {
      ev = await core.appendLedgerEvent({ type: "ledger.note", project: PROJECT });
    });
    assert.equal(ev, null);
    assert.match(err2, /ledger append failed/);
    assert.ok(fs.statSync(path.join(TEST_ROOT, "ledger")).isFile());
  });

  it("f: setLedgerContext flows into the next event", async () => {
    core.setLedgerContext({ via: "mcp", actor: "agent" });
    const ev = await core.appendLedgerEvent({ type: "ledger.note", project: PROJECT });
    assert.equal(ev.via, "mcp");
    assert.equal(ev.actor, "agent");
  });

  it("g: oversized meta is replaced by { _truncated: true }", async () => {
    const ev = await core.appendLedgerEvent({
      type: "ledger.note",
      project: PROJECT,
      meta: { note: "x".repeat(600) },
    });
    assert.deepEqual(ev.meta, { _truncated: true });
    assert.deepEqual(JSON.parse(eventLines()[0]).meta, { _truncated: true });
  });

  it("h: a target outside the store is rejected (null) and nothing is appended", async () => {
    let ev;
    const err = await captureStderr(async () => {
      ev = await core.appendLedgerEvent({
        type: "journal.write",
        project: PROJECT,
        target: path.resolve(os.tmpdir(), "..", "outside-the-store", "x.md"),
      });
    });
    assert.equal(ev, null);
    assert.match(err, /ledger append failed/);
    assert.equal(eventLines().length, 0);
  });
});
