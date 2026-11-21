/**
 * hosted-activity.test.mjs — the per-agent activity store (activity.ts) as a unit:
 * deleted files stay deleted, bounded flush batches, failed writes keep the data,
 * unreadable files are never overwritten, the in-memory cap holds.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { ActivityStore } = await import(pathToFileURL(path.join(here, "..", "dist", "http", "activity.js")).href);
const root = fs.mkdtempSync(path.join(tmpdir(), "ar-act-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const KEY = "token:aaaaaaaaaaaa";
const obs = { client: "Claude Code", toolCalls: 1 };
const fresh = (opts = {}) => new ActivityStore(fs.mkdtempSync(path.join(root, "d-")), { flushMs: 3_600_000, ...opts });

describe("activity store", () => {
  it("last_call moves only on a tool call, never on a request that is not one", () => {
    const dataDir = fs.mkdtempSync(path.join(root, "d-"));
    let t = Date.parse("2026-03-02T09:00:00Z");
    const s = new ActivityStore(dataDir, { flushMs: 3_600_000, now: () => t });
    s.record("alice", KEY, { client: "Claude Code", toolCalls: 0 });
    assert.equal(s.entriesOf("alice")[KEY].last_call, undefined, "initialize alone");
    t += 1000;
    s.record("alice", KEY, { toolCalls: 1, tool: "recall" });
    const called = s.entriesOf("alice")[KEY];
    assert.equal(called.last_call, new Date(t).toISOString());
    t += 1000;
    s.record("alice", KEY, { toolCalls: 0 });
    const after = s.entriesOf("alice")[KEY];
    assert.equal(after.last_call, called.last_call, "a later non-call keeps it");
    assert.equal(after.last_seen, new Date(t).toISOString());
    s.flush();
    assert.equal(new ActivityStore(dataDir).entriesOf("alice")[KEY].last_call, called.last_call, "survives a reload");
  });

  it("an entry saved before last_call existed still loads, without it", () => {
    const s = fresh();
    const file = s.fileFor("alice");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: { [KEY]: { client: "Old", first_seen: "2026-01-01T00:00:00.000Z", last_seen: "2026-01-02T00:00:00.000Z", calls: 4 } } }));
    const e = s.entriesOf("alice")[KEY];
    assert.equal(e.calls, 4);
    assert.equal(e.last_call, undefined);
  });

  it("a file the operator deleted is not recreated by the next flush", () => {
    const s = fresh();
    s.record("alice", KEY, obs);
    s.flush();
    const file = s.fileFor("alice");
    assert.ok(fs.existsSync(file));
    fs.rmSync(file);
    s.record("alice", KEY, obs);
    s.flush();
    assert.ok(!fs.existsSync(file), "deleted on purpose: stays deleted");
    s.record("alice", KEY, obs); // a later request starts fresh from disk
    s.flush();
    assert.ok(fs.existsSync(file), "new activity after the slot was dropped is recorded again");
  });

  it("the timer flush writes at most 200 users per tick; shutdown writes all", () => {
    const writes = [];
    const s = fresh({ write: (f) => writes.push(f) });
    for (let i = 0; i < 450; i++) s.record(`user-${String(i).padStart(4, "0")}`, KEY, obs);
    s.flush(false);
    assert.equal(writes.length, 200);
    s.flush(); // shutdown path
    assert.equal(writes.length, 450);
  });

  it("a failed write keeps the data and a later write succeeds", () => {
    let fail = true;
    const writes = [];
    const s = fresh({ write: (f) => { if (fail) throw new Error("disk full"); writes.push(f); }, log: () => {} });
    s.record("alice", KEY, obs);
    s.flush();
    assert.equal(writes.length, 0);
    fail = false;
    s.flush();
    assert.equal(writes.length, 1);
  });

  it("an unreadable (not absent, not corrupt) file is never overwritten", () => {
    const writes = [];
    const s = fresh({ write: (f) => writes.push(f), log: () => {} });
    fs.mkdirSync(s.fileFor("alice"), { recursive: true }); // reading a directory fails with EISDIR, not ENOENT
    s.record("alice", KEY, obs);
    assert.deepEqual(s.entriesOf("alice"), {});
    s.flush();
    assert.equal(writes.length, 0);
  });

  it("a corrupt file is replaced", () => {
    const s = fresh();
    fs.mkdirSync(path.dirname(s.fileFor("alice")), { recursive: true });
    fs.writeFileSync(s.fileFor("alice"), "{not json");
    s.record("alice", KEY, obs);
    s.flush();
    assert.equal(JSON.parse(fs.readFileSync(s.fileFor("alice"), "utf-8")).entries[KEY].calls, 1);
  });

  it("the in-memory user cap holds even when every slot is dirty", () => {
    const s = fresh({ write: () => { throw new Error("no disk"); }, log: () => {} });
    for (let i = 0; i < 10_050; i++) s.record(`u${String(i).padStart(6, "0")}`, KEY, obs);
    assert.ok(s.slots.size <= 10_000, `slots: ${s.slots.size}`);
  });
});
