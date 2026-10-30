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
    // W3: the first mutation on a new project also records project.create.
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).type, "project.create");
    const e1 = JSON.parse(lines[1]);
    assert.equal(e1.type, "journal.write");
    assert.ok(e1.target.startsWith(`projects/${PROJECT}/journal/`), e1.target);
    assert.ok(!e1.target.includes("\\"));
    const onDisk = fs.readFileSync(path.join(TEST_ROOT, e1.target));
    assert.equal(e1.sha256, sha256hex(onDisk));
    assert.equal(e1.bytes, onDisk.length);
    assert.equal(e1.parent, JSON.parse(lines[0]).id);
    assert.equal(e1.via, "library");
    assert.equal(e1.actor, "system");
    assert.ok(["A", "B", "C"].includes(e1.host));
    assert.equal(e1.v, 1);
    assert.ok(core.isUlid(e1.id));

    // (b) real palaceWrite + sessionEnd (W3 class wiring)
    await core.palaceWrite({ project: PROJECT, room: "goals", topic: "active", content: "ship the ledger" });
    const palaceRel = `projects/${PROJECT}/palace/rooms/goals/active.md`;
    const pw = core.readEvents({ project: PROJECT, type: "palace.write" }).filter((e) => e.target === palaceRel);
    assert.equal(pw.length, 1, "palaceWrite records exactly one palace.write for its topic file");
    assert.equal(pw[0].sha256, sha256hex(fs.readFileSync(path.join(TEST_ROOT, palaceRel))));
    await core.sessionEnd({ project: PROJECT, summary: "ledger probe session wrapped up cleanly" });
    const all = core.readEvents({ project: PROJECT });
    const e3 = all[all.length - 1];
    assert.equal(e3.type, "session.end");
    assert.equal(e3.target, null);
    assert.equal(e3.sha256, null);
    assert.ok(all.some((e) => e.type === "journal.write"), "sessionEnd's journal write is recorded");
    // per-project chain: every event's parent is the previous event of the project
    all.forEach((e, i) => assert.equal(e.parent, i === 0 ? null : all[i - 1].id, `chain broken at ${i} (${e.type})`));
    // every non-null hash equals the target on disk when the file is still the latest write
    const headsPath = path.join(TEST_ROOT, "ledger", "heads.json");
    const heads = JSON.parse(fs.readFileSync(headsPath, "utf-8"));
    assert.deepEqual(heads[PROJECT], { head: e3.id, count: all.length, first_ts: all[0].ts, last_ts: e3.ts });

    // (c) heads.json is derived: delete + rebuild is byte-identical
    const before = fs.readFileSync(headsPath);
    fs.rmSync(headsPath);
    // 3 events + the genesis note on the _global chain
    assert.deepEqual(core.rebuildHeads(), { projects: 2, events: all.length + 1, badLines: 0 });
    assert.ok(before.equals(fs.readFileSync(headsPath)));

    // (d) readEvents filters
    assert.equal(core.readEvents({ project: PROJECT }).length, all.length);
    assert.equal(core.readEvents({ project: PROJECT, type: "journal.write" }).length, all.filter((e) => e.type === "journal.write").length);
    assert.deepEqual(core.readEvents({ project: PROJECT, limit: 2 }), all.slice(-2));
    assert.deepEqual(core.readEvents({ project: "other" }), []);
    assert.equal(core.readEvents({ project: PROJECT, since: "24h" }).length, all.length);
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
    const scratch = (t) => core.readEvents({ project: PROJECT, type: t }).filter((e) => e.target.includes("/rooms/scratch-room/"));
    assert.equal(scratch("palace.room.create").length, 1);
    // W3: the room README (scaffold) + the journal topic file, once per journalWrite
    assert.equal(scratch("palace.write").filter((e) => e.target.endsWith("/journal.md")).length, 2);
  });

  it("A1.12: since parsing — garbage throws, 24h/7d/ISO filter", async () => {
    await core.appendLedgerEvent({ type: "ledger.note", project: PROJECT });
    assert.throws(() => core.readEvents({ since: "garbage" }), RangeError);
    assert.equal(core.readEvents({ project: PROJECT, since: "24h" }).length, 1);
    assert.equal(core.readEvents({ project: PROJECT, since: "7d" }).length, 1);
    assert.equal(core.readEvents({ project: PROJECT, since: "2999-01-01" }).length, 0);
  });
});

// ---------------------------------------------------------------------------
// W3 class-fix: every store mutation outside journalWrite records an event.
// One test per member (or family) of the class; each fails on pre-fix code.
// ---------------------------------------------------------------------------
describe("ledger class wiring (W3)", () => {
  const ROOT = path.join(os.tmpdir(), "ar-ledger-class-" + Date.now());
  const P = "class-probe";
  let core;

  const events = (filter = {}) => core.readEvents({ project: P, ...filter });
  const at = (rel) => path.join(ROOT, "projects", P, ...rel.split("/"));
  const relOf = (rel) => `projects/${P}/${rel}`;
  const byTarget = (rel, type) => events(type ? { type } : {}).filter((e) => e.target === relOf(rel));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
    fs.writeFileSync(at(rel), text);
  };
  /** The latest event for a target must carry the on-disk hash. */
  const assertHashMatchesDisk = (rel) => {
    const evs = byTarget(rel);
    assert.ok(evs.length > 0, `no event for ${rel}`);
    const last = evs[evs.length - 1];
    assert.equal(last.sha256, sha256hex(fs.readFileSync(at(rel))), `latest ${last.type} hash != disk for ${rel}`);
  };

  before(async () => {
    process.env.AGENT_RECALL_ROOT = ROOT;
    core = await import("../dist/index.js");
    core.setRoot(ROOT);
  });
  after(() => {
    core.resetRoot?.();
    core.resetLedgerContext();
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(ROOT, { recursive: true, force: true });
  });
  beforeEach(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true });
    core.resetLedgerContext();
  });

  it("journalCapture -> journal.capture on the log file; palace_room -> palace.write captures.md", async () => {
    const r = await core.journalCapture({ project: P, question: "why?", answer: "because", palace_room: "knowledge" });
    const rel = path.relative(path.join(ROOT, "projects", P), r.file_path).replaceAll("\\", "/");
    assert.equal(byTarget(rel, "journal.capture").length, 1);
    assertHashMatchesDisk(rel);
    assert.equal(byTarget("palace/rooms/knowledge/captures.md", "palace.write").length, 1);
  });

  it("journalArchive -> journal.archive on the source path (pre-move hash, meta.moved_to)", async () => {
    const body = "# old\n## Brief\nold entry\n";
    write("journal/2026-01-01.md", body);
    const r = await core.journalArchive({ project: P, older_than_days: 1 });
    assert.equal(r.archived, 1);
    assert.ok(!fs.existsSync(at("journal/2026-01-01.md")));
    const ev = byTarget("journal/2026-01-01.md", "journal.archive");
    assert.equal(ev.length, 1);
    assert.equal(ev[0].sha256, sha256hex(Buffer.from(body)));
    assert.equal(ev[0].meta.moved_to, "archive/2026-01-01.md");
  });

  it("journalMerge -> journal.merge for target (new hash), source (moved_to) and the .merged.md backup", async () => {
    write("journal/2026-01-01.md", "# a\n## Brief\naaa\n");
    write("journal/2026-01-02.md", "# b\n## Brief\nbbb\n");
    await core.journalMerge({ project: P, target_file: "2026-01-01.md", source_file: "2026-01-02.md" });
    const target = byTarget("journal/2026-01-01.md", "journal.merge");
    assert.equal(target.length, 1);
    assert.equal(target[0].sha256, sha256hex(fs.readFileSync(at("journal/2026-01-01.md"))));
    const source = byTarget("journal/2026-01-02.md", "journal.merge");
    assert.equal(source.length, 1);
    assert.equal(source[0].meta.moved_to, "2026-01-02.merged.md");
    assert.equal(byTarget("journal/2026-01-02.merged.md", "journal.merge").length, 1);
    assertHashMatchesDisk("journal/2026-01-02.merged.md");
  });

  it("journalRollup -> journal.rollup for the weekly summary and every entry that left journal/", async () => {
    write("journal/2026-01-05.md", "# one\n## Brief\nfirst\n");
    write("journal/2026-01-06.md", "# two\n## Brief\nsecond\n");
    const r = await core.journalRollup({ project: P, min_age_days: 1, min_entries: 2 });
    assert.equal(r.weeksRolledUp, 1);
    const rolled = events({ type: "journal.rollup" });
    assert.ok(rolled.some((e) => e.meta.entries === 2), "summary event");
    assert.equal(rolled.filter((e) => e.meta.moved_to).length, 2, "one moved_to event per archived entry");
    for (const e of rolled.filter((x) => !x.meta.moved_to)) {
      assert.equal(e.sha256, sha256hex(fs.readFileSync(path.join(ROOT, e.target))));
    }
  });

  it("knowledgeWrite -> knowledge.write for the legacy file and the palace topic", async () => {
    await core.knowledgeWrite({ project: P, category: "gotchas", title: "T1", what_happened: "w", root_cause: "r", fix: "f" });
    assert.equal(byTarget("knowledge/gotchas.md", "knowledge.write").length, 1);
    assert.equal(byTarget("palace/rooms/knowledge/gotchas.md", "knowledge.write").length, 1);
    assertHashMatchesDisk("palace/rooms/knowledge/gotchas.md");
    // duplicate title the same day changes nothing on disk => no new event
    await core.knowledgeWrite({ project: P, category: "gotchas", title: "T1", what_happened: "w", root_cause: "r", fix: "f" });
    assert.equal(byTarget("knowledge/gotchas.md", "knowledge.write").length, 1);
  });

  it("skillWrite + writeSkill (reinforce path) -> skill.write with the on-disk hash", async () => {
    const r = await core.skillWrite({ project: P, name: "deploy ledger", topic: "deploy", triggers: ["deploy"], when: "when deploying", steps: ["build", "ship"] });
    assert.equal(r.success, true);
    const rel = path.relative(path.join(ROOT, "projects", P), r.file_path).replaceAll("\\", "/");
    assert.equal(byTarget(rel, "skill.write").length, 1);
    assertHashMatchesDisk(rel);
    // direct writeSkill (what reinforce/archive-flag/promotion use) goes through the queue
    const before = events({ type: "skill.write" }).length;
    const now = new Date().toISOString();
    core.writeSkill(
      P,
      { slug: "", name: "second skill", topic: "git", triggers: ["git"], created: now, updated: now, source: "manual" },
      { when: "w", preconditions: [], steps: ["s"], postconditions: [] },
    );
    await core.flushLedgerQueue();
    assert.equal(events({ type: "skill.write" }).length, before + 1);
  });

  it("writeCorrection / recordOutcome / setCorrectionTier / retractCorrection -> correction.* on the record file", async () => {
    const w = await core.writeCorrection(
      P,
      {
        id: "c-ledger-1", date: "2026-10-30", severity: "p0", project: P,
        rule: "Always run the build before committing changes",
        context: "Always run the build before committing changes to main", tags: ["build"],
      },
      { skipActionableGate: true },
    );
    assert.equal(w.written, true);
    const cw = events({ type: "correction.write" });
    assert.equal(cw.length, 1);
    assert.ok(cw[0].target.startsWith(`projects/${P}/corrections/`) && cw[0].target.endsWith(".json"));
    const rel = cw[0].target.slice(`projects/${P}/`.length);
    assertHashMatchesDisk(rel);

    await core.recordOutcome({ correction_id: "c-ledger-1", project: P, kind: "retrieved", at: new Date().toISOString() });
    assert.equal(events({ type: "correction.write" }).length, 2, "counter rewrite is a write");
    assertHashMatchesDisk(rel);

    await core.setCorrectionTier(P, "c-ledger-1", "nudge");
    assert.equal(events({ type: "correction.write" }).length, 3);
    assertHashMatchesDisk(rel);

    const rt = await core.retractCorrection(P, "c-ledger-1", "obsolete");
    assert.equal(rt.success, true);
    assert.equal(events({ type: "correction.retract" }).length, 1);
    assertHashMatchesDisk(rel);
  });

  it("addIndexedInsight -> insight.add then insight.confirm on insights-index.json", async () => {
    const ins = { title: "ledger insight about provenance chains", evidence: "e", applies_when: ["ledger"], source: "test", severity: "important" };
    await core.addIndexedInsight(ins);
    await core.addIndexedInsight(ins);
    const all = core.readEvents({}).filter((e) => e.target === "insights-index.json");
    assert.deepEqual(all.map((e) => e.type), ["insight.add", "insight.confirm"]);
    assert.equal(all[1].sha256, sha256hex(fs.readFileSync(path.join(ROOT, "insights-index.json"))));
  });

  it("sessionStart / sessionEnd -> session.start (once per session) and session.end", async () => {
    await core.sessionStart({ project: P });
    await core.sessionStart({ project: P });
    assert.equal(events({ type: "session.start" }).length, 1, "repeat session_start is idempotent");
    await core.sessionEnd({ project: P, summary: "ledger session end probe, long enough" });
    const se = events({ type: "session.end" });
    assert.equal(se.length, 1);
    assert.equal(se[0].target, null);
    assert.ok(events({ type: "project.create" }).length >= 1);
  });

  it("writeSessionCard -> journal.write(card); staged card + claim -> project.claim on both paths", async () => {
    const card = (slug, sid) => ({
      markdown: `# card ${sid}\n`, title: "t", artifacts: [], linearRefs: [], decisions: [], nextStep: [], sid, slug, date: "2026-10-30",
    });
    const ok = core.writeSessionCard(card(P, "sid-real-1"));
    await core.flushLedgerQueue();
    const cards = events({ type: "journal.write" }).filter((e) => e.meta.kind === "card");
    assert.equal(cards.length, 1);
    assert.equal(cards[0].sha256, sha256hex(fs.readFileSync(ok.path)));

    core.writeSessionCard(card("auto", "sid-staged-1")); // invalid slug => _unclaimed staging
    await core.flushLedgerQueue();
    assert.equal(core.readEvents({ project: "_unclaimed", type: "journal.write" }).length, 1);
    core.claimUnclaimedSession("sid-staged-1", "claimed-proj");
    await core.flushLedgerQueue();
    const claims = core.readEvents({ type: "project.claim" });
    const arrived = claims.find((e) => e.project === "claimed-proj");
    assert.ok(arrived && arrived.meta.moved_from);
    assert.ok(claims.some((e) => e.project === "_unclaimed" && e.meta.moved_to));
    assert.equal(arrived.sha256, sha256hex(fs.readFileSync(path.join(ROOT, arrived.target))));
  });

  it("createRoom / ensurePalaceInitialized / writeIdentity -> room.create + palace.write on the scaffold files", async () => {
    core.createRoom(P, "scratch", "Scratch", "d", []);
    core.writeIdentity(P, "# identity\n");
    await core.flushLedgerQueue();
    assert.equal(byTarget("palace/rooms/scratch/_room.json", "palace.room.create").length, 1);
    assert.equal(byTarget("palace/rooms/scratch/README.md", "palace.write").length, 1);
    assertHashMatchesDisk("palace/rooms/scratch/README.md");
    assertHashMatchesDisk("palace/identity.md");
    core.ensurePalaceInitialized("scaffold-probe");
    await core.flushLedgerQueue();
    const scaffold = core.readEvents({ project: "scaffold-probe" });
    assert.ok(scaffold.filter((e) => e.type === "palace.room.create").length >= 3, "default rooms recorded");
    assert.ok(scaffold.some((e) => e.target?.endsWith("palace/identity.md")));
  });

  it("consolidateJournalToPalace / contextSynthesize -> palace.consolidate on the topic files", async () => {
    write("journal/2026-10-01.md", "# t\n\n## Brief\nship the ledger\n\n## Decisions\n- chose sqlite over postgres for the local store\n\n## Next\n- write the tests\n");
    await core.consolidateJournalToPalace(P, 5);
    const pc = events({ type: "palace.consolidate" });
    assert.ok(pc.some((e) => e.target === relOf("palace/rooms/architecture/decisions.md")));
    assertHashMatchesDisk("palace/rooms/architecture/decisions.md");
    const before = pc.length;
    await core.contextSynthesize({ project: P, entries: 5, consolidate: true });
    assert.ok(events({ type: "palace.consolidate" }).length > before);
  });

  it("pipelineOpen -> palace.write(milestone); fanOut back-reference -> palace.write(backref)", async () => {
    const r = await core.pipelineOpen({ project: P, phase_name: "ledger phase", goal: "g" });
    assert.equal(r.success, true);
    await core.flushLedgerQueue();
    const ms = events({ type: "palace.write" }).filter((e) => e.meta.kind === "milestone");
    assert.equal(ms.length, 1);
    assert.equal(ms[0].sha256, sha256hex(fs.readFileSync(path.join(ROOT, ms[0].target))));
    await core.palaceWrite({ project: P, room: "architecture", topic: "linked", content: "see [[goals]] for the plan" });
    assert.ok(events({ type: "palace.write" }).some((e) => e.meta.kind === "backref" && e.target.endsWith("/rooms/goals/README.md")));
    assertHashMatchesDisk("palace/rooms/goals/README.md");
  });

  it("compressTopic -> palace.consolidate for the rewritten topic and its _archive copy", async () => {
    const entry = (d) => `\n### ${d} [[journal/${d}]]\n\nledger provenance chain verification hashing events appended project\n`;
    write("palace/rooms/knowledge/dupes.md", `# knowledge / dupes\n${entry("2026-01-01")}${entry("2026-01-02")}${entry("2026-01-03")}`);
    const r = core.compressTopic(P, "knowledge", "dupes", false);
    assert.ok(r.clustersMerged >= 1, JSON.stringify(r));
    await core.flushLedgerQueue();
    const pc = events({ type: "palace.consolidate" });
    assert.ok(pc.some((e) => e.meta.kind === "compress" && e.target === relOf("palace/rooms/knowledge/dupes.md")));
    assert.ok(pc.some((e) => e.meta.kind === "compress-archive" && e.target.includes("/_archive/")));
    assertHashMatchesDisk("palace/rooms/knowledge/dupes.md");
  });

  it("palaceLint --fix room archive -> palace.consolidate pairs (left rooms/, arrived archive/)", async () => {
    core.createRoom(P, "stale-room", "Stale", "d", []);
    await core.flushLedgerQueue();
    const metaPath = at("palace/rooms/stale-room/_room.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    fs.writeFileSync(metaPath, JSON.stringify({ ...meta, updated: "2020-01-01T00:00:00.000Z", last_accessed: "2020-01-01T00:00:00.000Z", access_count: 0 }));
    const r = await core.palaceLint({ project: P, fix: true });
    assert.ok(r.fixed >= 1);
    const moved = events({ type: "palace.consolidate" }).filter((e) => e.meta.kind === "room-archive");
    assert.ok(moved.some((e) => e.meta.moved_to) && moved.some((e) => e.meta.moved_from));
  });

  it("alignmentCheck / nudge -> journal.write on the alignment log", async () => {
    await core.alignmentCheck({ project: P, goal: "g", confidence: "low", human_correction: "no, do x", delta: "d" });
    await core.nudge({ project: P, past_statement: "a", current_statement: "b", question: "q" });
    const al = events({ type: "journal.write" }).filter((e) => e.meta.kind === "alignment" || e.meta.kind === "nudge");
    assert.equal(al.length, 2);
    assertHashMatchesDisk(al[0].target.slice(`projects/${P}/`.length));
    assert.ok(events({ type: "palace.write" }).some((e) => e.target.includes("/rooms/alignment/")));
  });

  it("a ledger failure never changes a tool's result (wired tools)", async () => {
    fs.writeFileSync(path.join(ROOT, "ledger"), "not a dir"); // ledger/ unwritable
    const quiet = console.error;
    console.error = () => {};
    try {
      const r1 = await core.palaceWrite({ project: P, room: "goals", content: "x" });
      assert.equal(r1.success, true);
      const r2 = await core.journalCapture({ project: P, question: "q", answer: "a" });
      assert.equal(r2.success, true);
      const r3 = await core.sessionEnd({ project: P, summary: "ledger failure does not break session end" });
      assert.equal(r3.journal_written, true);
      const r4 = await core.addIndexedInsight({ title: "x y z insight", evidence: "e", applies_when: ["x"], source: "t", severity: "minor" });
      assert.ok(r4);
    } finally {
      console.error = quiet;
    }
  });
});
