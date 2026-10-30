// packages/core/test/ledger-verify.test.mjs — ledger spec SW-5: verifyLedger
// (orphan / drift / missing / chain / unknown-via), read-only guarantee, backfill.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";

const TEST_BASE = path.join(os.tmpdir(), "ar-ledger-verify-" + process.pid + "-" + Date.now());
let TEST_ROOT = TEST_BASE;
let caseNo = 0;
const PROJECT = "verify-probe";
const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");
const EVENTS = () => path.join(TEST_ROOT, "ledger", "events.jsonl");

function readLines() {
  return fs.readFileSync(EVENTS(), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function writeLines(events) {
  fs.writeFileSync(EVENTS(), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

describe("ledger verify / trace / backfill", () => {
  let core;
  let seedEvent;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_BASE;
    core = await import("../dist/index.js");
  });

  after(() => {
    core.resetRoot?.();
    core.resetLedgerContext();
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_BASE, { recursive: true, force: true });
  });

  // fresh root per case (no rm between cases: cheaper and immune to Windows file-handle lag)
  beforeEach(async () => {
    TEST_ROOT = path.join(TEST_BASE, "case-" + ++caseNo);
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    core.setRoot(TEST_ROOT);
    core.resetLedgerContext();
  });

  /** One journalWrite on a fresh root: genesis (_global) + one journal.write. */
  async function seed() {
    await core.journalWrite({ project: PROJECT, content: "verify probe entry" });
    seedEvent = readLines().find((e) => e.project === PROJECT);
    assert.ok(seedEvent, "journalWrite must yield a ledger event");
    return seedEvent;
  }

  it("a: clean store reports no findings", async () => {
    await seed();
    const res = core.verifyLedger(PROJECT);
    assert.deepEqual(res.findings, []);
    assert.equal(res.scanned.events, 1);
    assert.ok(res.scanned.files >= 1);
    // no project: the genesis note is not a finding either
    assert.deepEqual(core.verifyLedger().findings, []);
  });

  it("b: hand-written journal file is an orphan", async () => {
    await seed();
    const rel = `projects/${PROJECT}/journal/2026-10-31.md`;
    fs.writeFileSync(path.join(TEST_ROOT, rel), "# hand written\n");
    const res = core.verifyLedger(PROJECT);
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].kind, "orphan");
    assert.equal(res.findings[0].target, rel);
  });

  it("c: modified ledgered file is drift", async () => {
    const ev = await seed();
    fs.appendFileSync(path.join(TEST_ROOT, ev.target), " x");
    const res = core.verifyLedger(PROJECT);
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].kind, "drift");
    assert.equal(res.findings[0].eventId, ev.id);
  });

  it("d: deleted ledgered file is missing", async () => {
    const ev = await seed();
    fs.rmSync(path.join(TEST_ROOT, ev.target));
    const res = core.verifyLedger(PROJECT);
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].kind, "missing");
    assert.equal(res.findings[0].target, ev.target);
  });

  it("e: corrupted parent is exactly one chain finding", async () => {
    await seed();
    writeLines(readLines().map((e) => (e.project === PROJECT ? { ...e, parent: "01BROKENPARENT0000000000000" } : e)));
    const res = core.verifyLedger(PROJECT);
    assert.equal(res.findings.length, 1, JSON.stringify(res.findings));
    assert.equal(res.findings[0].kind, "chain");
  });

  it("e2: stale heads.json is a chain finding and verify does not repair it", async () => {
    await seed();
    const headsFile = path.join(TEST_ROOT, "ledger", "heads.json");
    const heads = JSON.parse(fs.readFileSync(headsFile, "utf-8"));
    heads[PROJECT].head = "01STALEHEAD0000000000000000";
    fs.writeFileSync(headsFile, JSON.stringify(heads));
    const before = fs.readFileSync(headsFile, "utf-8");
    const res = core.verifyLedger(PROJECT);
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].kind, "chain");
    assert.equal(fs.readFileSync(headsFile, "utf-8"), before, "verify must not rewrite heads.json");
  });

  it("f: unknown via is exactly one unknown-via finding", async () => {
    await seed();
    writeLines(readLines().map((e) => (e.project === PROJECT ? { ...e, via: "telepathy" } : e)));
    const res = core.verifyLedger(PROJECT);
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].kind, "unknown-via");
  });

  it("f2: an unparsable line is counted and reported", async () => {
    await seed();
    fs.appendFileSync(EVENTS(), "{not json\n");
    const res = core.verifyLedger(PROJECT);
    assert.equal(res.scanned.badLines, 1);
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].kind, "unknown-via");
  });

  it("g: backfill dry-run, write, idempotence", async () => {
    await seed();
    const rel = `projects/${PROJECT}/journal/2026-10-31.md`;
    const abs = path.join(TEST_ROOT, rel);
    fs.writeFileSync(abs, "# hand written\n");
    const linesBefore = fs.readFileSync(EVENTS(), "utf-8");

    const dry = await core.backfillLedger({ dryRun: true });
    assert.equal(dry.candidates, 1);
    assert.equal(dry.written, 0);
    assert.deepEqual(dry.targets, [rel]);
    assert.equal(fs.readFileSync(EVENTS(), "utf-8"), linesBefore, "dry-run must not touch events.jsonl");

    const ctxBefore = core.getLedgerContext();
    const real = await core.backfillLedger();
    assert.equal(real.written, 1);
    assert.deepEqual(core.getLedgerContext(), ctxBefore);

    const ev = readLines().filter((e) => e.target === rel).pop();
    assert.equal(ev.type, "ledger.backfill");
    assert.equal(ev.via, "backfill");
    assert.equal(ev.actor, "system");
    assert.equal(ev.ts, new Date(fs.statSync(abs).mtimeMs).toISOString());
    assert.equal(ev.sha256, sha256hex(fs.readFileSync(abs)));

    assert.equal((await core.backfillLedger()).written, 0);
    assert.deepEqual(core.verifyLedger().findings, []);
  });

  it("h: verify on a root without a ledger writes nothing", () => {
    const res = core.verifyLedger();
    assert.deepEqual(res, { findings: [], scanned: { files: 0, events: 0, projects: 0, badLines: 0 } });
    assert.equal(fs.existsSync(path.join(TEST_ROOT, "ledger")), false);
  });

  it("trace: oldest first, five fields, since/limit", async () => {
    await seed();
    await core.journalWrite({ project: PROJECT, content: "second entry" });
    const all = core.traceProject(PROJECT);
    assert.equal(all.length, 2);
    assert.deepEqual(core.traceProject(PROJECT, { limit: 1 }).map((e) => e.id), [all[1].id]);
    assert.equal(core.traceProject(PROJECT, { since: "1h" }).length, 2);
    assert.throws(() => core.traceProject(PROJECT, { since: "garbage" }), RangeError);
    const fields = core.formatTraceLine(all[0]).split(" ");
    assert.equal(fields.length, 5);
    assert.equal(fields[1], "journal.write");
    assert.equal(fields[4].length, 8);
  });
});
