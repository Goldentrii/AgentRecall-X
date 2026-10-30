// packages/core/test/ledger-append.test.mjs — ledger spec SW-3: appendLedgerEvent,
// heads, readEvents, failure policy (D8). W3 extends block (b) with real
// palaceWrite + sessionEnd calls.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const TEST_ROOT = path.join(os.tmpdir(), "ar-ledger-append-" + Date.now());
const PROJECT = "ledger-probe";
const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");

function rawLines() {
  const f = path.join(TEST_ROOT, "ledger", "events.jsonl");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf-8").split("\n").filter(Boolean) : [];
}

/** Event lines without the per-store genesis note (project "_global"). */
function eventLines() {
  return rawLines().filter((l) => !l.includes('"project":"_global"'));
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
    // 3 events + the genesis note on the _global chain
    assert.deepEqual(core.rebuildHeads(), { projects: 2, events: 4, badLines: 0 });
    assert.ok(before.equals(fs.readFileSync(headsPath)));

    // (d) readEvents filters
    assert.equal(core.readEvents({ project: PROJECT }).length, 3);
    assert.equal(core.readEvents({ project: PROJECT, type: "journal.write" }).length, 1);
    assert.deepEqual(core.readEvents({ project: PROJECT, limit: 2 }), [e2, e3]);
    assert.deepEqual(core.readEvents({ project: "other" }), []);
    assert.equal(core.readEvents({ project: PROJECT, since: "24h" }).length, 3);
    assert.equal(core.readEvents({ project: PROJECT, since: "2999-01-01" }).length, 0);
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

  it("g: over-budget meta is replaced by { _truncated: true }", async () => {
    const ev = await core.appendLedgerEvent({
      type: "ledger.note",
      project: PROJECT,
      meta: Object.fromEntries(Array.from({ length: 8 }, (_, i) => ["k" + i, "x".repeat(100)])),
    });
    assert.deepEqual(ev.meta, { _truncated: true });
    assert.deepEqual(JSON.parse(eventLines()[0]).meta, { _truncated: true });
  });

  it("h: targets outside the store are rejected (null), nothing appended", async () => {
    for (const target of [path.join(os.tmpdir(), "outside.md"), "../escape.md", "a/../../escape.md"]) {
      let ev;
      const err = await captureStderr(async () => {
        ev = await core.appendLedgerEvent({ type: "journal.write", project: PROJECT, target });
      });
      assert.equal(ev, null, target);
      assert.match(err, /ledger append failed/);
    }
    assert.equal(rawLines().length, 0);
  });

  it("A1.2: lost heads.json does not fork the chain", async () => {
    const e1 = await core.appendLedgerEvent({ type: "ledger.note", project: PROJECT });
    const e2 = await core.appendLedgerEvent({ type: "ledger.note", project: PROJECT });
    fs.rmSync(path.join(TEST_ROOT, "ledger", "heads.json"));
    const e3 = await core.appendLedgerEvent({ type: "ledger.note", project: PROJECT });
    assert.equal(e1.parent, null);
    assert.equal(e3.parent, e2.id);
    assert.equal(core.readHeads()[PROJECT].count, 3);
  });

  it("A1.2: unwritable heads.json => null, line still durable, errors.log written", async () => {
    await core.appendLedgerEvent({ type: "ledger.note", project: PROJECT });
    // A directory squatting on the heads tmp path makes writeHeads fail fast
    // (a directory at heads.json itself would burn the 5 s win32 rename retry).
    fs.mkdirSync(path.join(TEST_ROOT, "ledger", `heads.json.tmp.${process.pid}`));
    const before = eventLines().length;
    let ev;
    await captureStderr(async () => {
      ev = await core.appendLedgerEvent({ type: "ledger.note", project: PROJECT });
    });
    assert.equal(ev, null);
    assert.equal(eventLines().length, before + 1);
    assert.ok(fs.readFileSync(path.join(TEST_ROOT, "ledger", "errors.log"), "utf-8").trim().length > 0);
  });

  it("A1.3: torn last line is fenced off; append only extends the file (prefix property)", async () => {
    await core.appendLedgerEvent({ type: "ledger.note", project: PROJECT });
    const ep = path.join(TEST_ROOT, "ledger", "events.jsonl");
    fs.appendFileSync(ep, '{"v":1,"id":"torn');
    const before = fs.readFileSync(ep);
    const ev = await core.appendLedgerEvent({ type: "ledger.note", project: PROJECT });
    const after = fs.readFileSync(ep);
    assert.ok(after.subarray(0, before.length).equals(before), "append must not rewrite earlier bytes");
    const { events, badLines } = core.readEventsWithStats({ project: PROJECT });
    assert.equal(badLines, 1);
    assert.equal(events.at(-1).id, ev.id);
  });

  it("A1.4: long meta strings shortened; circular/BigInt meta => { _truncated: true }; event still written", async () => {
    const a = await core.appendLedgerEvent({ type: "ledger.note", project: PROJECT, meta: { t: "y".repeat(200) } });
    assert.equal(a.meta.t.length, 120);
    assert.ok(a.meta.t.endsWith("..."));
    const circ = {};
    circ.self = circ;
    const b = await core.appendLedgerEvent({ type: "ledger.note", project: PROJECT, meta: circ });
    assert.deepEqual(b.meta, { _truncated: true });
    const c = await core.appendLedgerEvent({ type: "ledger.note", project: PROJECT, meta: { n: 10n } });
    assert.deepEqual(c.meta, { _truncated: true });
    assert.equal(core.readEvents({ project: PROJECT }).length, 3);
  });

  it("A1.5: journal.write event hashes the content this call wrote", async () => {
    const res = await core.journalWrite({ project: PROJECT, content: "hash me" });
    const ev = core.readEvents({ project: PROJECT, type: "journal.write" })[0];
    const disk = fs.readFileSync(res.file);
    assert.equal(ev.sha256, sha256hex(disk));
    assert.equal(ev.bytes, disk.length);
  });

  it("A1.7: a held ledger lock bounds the wait (null within ~3.5s)", async () => {
    const lock = path.join(TEST_ROOT, ".lock-ledger");
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));
    const t0 = Date.now();
    let ev;
    await captureStderr(async () => {
      ev = await core.appendLedgerEvent({ type: "ledger.note", project: PROJECT });
    });
    assert.equal(ev, null);
    assert.ok(Date.now() - t0 < 3500, `waited ${Date.now() - t0}ms`);
    fs.rmSync(lock, { recursive: true, force: true });
  });

  it("A1.8: 50 concurrent appends across 2 projects keep per-project chains + heads", async () => {
    const jobs = [];
    for (let i = 0; i < 25; i++) {
      jobs.push(core.appendLedgerEvent({ type: "ledger.note", project: "p1" }));
      jobs.push(core.appendLedgerEvent({ type: "ledger.note", project: "p2" }));
    }
    await Promise.all(jobs);
    const all = core.readEvents().filter((e) => e.project === "p1" || e.project === "p2");
    assert.equal(all.length, 50);
    for (const p of ["p1", "p2"]) {
      const evs = all.filter((e) => e.project === p);
      assert.equal(evs.length, 25);
      evs.forEach((e, i) => assert.equal(e.parent, i === 0 ? null : evs[i - 1].id));
      assert.equal(core.readHeads()[p].count, 25);
    }
    const hp = path.join(TEST_ROOT, "ledger", "heads.json");
    const before = fs.readFileSync(hp);
    core.rebuildHeads();
    assert.ok(before.equals(fs.readFileSync(hp)));
  });

  it("A1.9: ledger is local-only (no supabase reference) and lives outside projects/", () => {
    const dir = fileURLToPath(new URL("../src/ledger/", import.meta.url));
    for (const f of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, f), "utf-8");
      assert.ok(!/supabase/i.test(src), `${f} mentions supabase`);
    }
    assert.ok(!core.LEDGER_DIR.startsWith("projects"));
  });

  it("A1.10: first append writes a genesis note on its own _global chain", async () => {
    const ev = await core.appendLedgerEvent({ type: "ledger.note", project: PROJECT });
    const lines = rawLines().map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].type, "ledger.note");
    assert.equal(lines[0].project, "_global");
    assert.equal(lines[0].meta.kind, "genesis");
    assert.equal(lines[0].meta.root, TEST_ROOT.replaceAll("\\", "/"));
    assert.equal(lines[1].id, ev.id);
    assert.equal(ev.parent, null);
  });

  it("A1.11: journalWrite with palace_room ledgers palace.write (+ room.create when new)", async () => {
    await core.journalWrite({ project: PROJECT, content: "palace probe", palace_room: "scratch-room" });
    const types = core.readEvents({ project: PROJECT }).map((e) => e.type);
    assert.ok(types.includes("journal.write"));
    assert.ok(types.includes("palace.write"));
    assert.ok(types.includes("palace.room.create"));
    await core.journalWrite({ project: PROJECT, content: "again", palace_room: "scratch-room" });
    assert.equal(core.readEvents({ project: PROJECT, type: "palace.room.create" }).length, 1);
    assert.equal(core.readEvents({ project: PROJECT, type: "palace.write" }).length, 2);
  });

  it("A1.12: since parsing — garbage throws, 24h/7d/ISO filter", async () => {
    await core.appendLedgerEvent({ type: "ledger.note", project: PROJECT });
    assert.throws(() => core.readEvents({ since: "garbage" }), RangeError);
    assert.equal(core.readEvents({ project: PROJECT, since: "24h" }).length, 1);
    assert.equal(core.readEvents({ project: PROJECT, since: "7d" }).length, 1);
    assert.equal(core.readEvents({ project: PROJECT, since: "2999-01-01" }).length, 0);
  });
});
