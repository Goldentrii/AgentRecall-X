/**
 * lexical-index.test.mjs — perf/lexical-index (2026-10-16).
 *
 * Proves the persistent lexical journal index (retrieval/lexical-index.ts)
 * is RANKING-IDENTICAL to the brute-force journal tier it accelerates, and
 * that its invalidation/corruption/trust behavior holds:
 *
 *   1. EQUIVALENCE — `queryMemory({tiers:["journal"]})` with the index
 *      enabled (default) returns a deep-equal result to the same call with
 *      the index disabled (AGENT_RECALL_LEXICAL_INDEX=0 → the pre-existing
 *      brute-force path), on randomized corpora (ASCII + CJK + rescue-tagged
 *      + archive + capture + no-date archive files), across multiple seeds
 *      and query shapes. The brute path IS the oracle — these tests never
 *      re-implement scoring.
 *   2. INVALIDATION — externally editing / deleting / creating journal files
 *      (plain fs writes, not tool writes) is reflected on the very next
 *      query, and the post-change indexed result still equals brute.
 *   3. CRASH-SAFETY — a corrupt or truncated index file (simulating a
 *      process killed mid-write, or on-disk corruption) never breaks or
 *      skews recall: the index is rebuilt and results stay equal to brute.
 *   4. TRUST — a file that BECOMES rescue-tagged is quarantined on the next
 *      query; a POISONED index that flips a rescue file's cached trust bit
 *      cannot surface that file's content (read-time recheck).
 *   5. CONCURRENCY — parallel queries over a drifted store all succeed and
 *      agree with brute.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-lexical-index-" + Date.now());
const P = "lex-proj";

/** Deterministic PRNG (mulberry32) — same shape as scripts/eval store-lib. */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB = ("deploy rollout cache redis cluster service api endpoint latency dashboard grafana alert review " +
  "merge branch pipeline build test retry queue kafka topic postgres index migration schema bucket storage " +
  "billing invoice ticket escalation flag feature staging production secret rotate runbook incident pod").split(" ");
const CJK = ["发布", "缓存", "数据库", "部署流程", "回滚方案", "灰度开关"];

function sentence(r, n) {
  const w = [];
  for (let i = 0; i < n; i++) w.push(VOCAB[Math.floor(r() * VOCAB.length)]);
  return w.join(" ");
}

function journalDirOf(root, slug) {
  return path.join(root, "projects", slug, "journal");
}

/** Build a deterministic, deliberately-messy journal corpus under `root`. */
function buildStore(root, slug, seed, n = 40) {
  const r = rng(seed);
  const jd = journalDirOf(root, slug);
  fs.mkdirSync(path.join(jd, "archive"), { recursive: true });
  for (let i = 0; i < n; i++) {
    const date = `2026-${String((i % 9) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}`;
    const cjkLine = i % 5 === 0 ? `\n${CJK[i % CJK.length]}需要确认 ${sentence(r, 3)}\n` : "";
    // duplicate line (same term twice in one section) — exercises per-hit ids
    const body = `# ${date} entry ${i}\n\n## Work\n\nDiscussed ${sentence(r, 8)}.\nDiscussed ${sentence(r, 8)}.\n${cjkLine}\n## Decisions\n\nRevisit ${sentence(r, 5)}.\n`;
    fs.writeFileSync(path.join(jd, `${date}--manual--09L--entry-${i}.md`), body);
  }
  // needle (live)
  fs.writeFileSync(
    path.join(jd, `2026-09-14--manual--05L--needle.md`),
    `# needle\n\n## Decisions\n\nThe velvet-otter staging bucket rotates its webhook secret every 90 days.\n`,
  );
  // capture-log file (second-pass enumeration)
  fs.writeFileSync(
    path.join(jd, `2026-09-02--capture--03L--qa.md`),
    `# capture\n\n### Q: which pod renders invoices\n\nbilling-render pod with 2GB limit\n`,
  );
  // rescue-quarantined file — must NEVER surface
  fs.writeFileSync(
    path.join(jd, `2026-09-03--manual--04L--rescue.md`),
    `---\nsource: working-memory-rescue\n---\n# rescue\n\n## Work\n\nquarantined velvet-otter poison about staging bucket secret rotate\n`,
  );
  // rollup archive: dated entry + week summary (no date prefix → date "")
  fs.writeFileSync(
    path.join(jd, "archive", `2026-07-11--manual--04L--old.md`),
    `# old\n\n## Work\n\narchived postgres migration runbook lives at runbooks/pg-failover.md\n`,
  );
  fs.writeFileSync(path.join(jd, "archive", `2026-W28.md`), `# week 28\n\n## Summary\n\nkafka consumer lag incident recap\n`);
  // excluded-by-name files
  fs.writeFileSync(path.join(jd, "archive", "index.md"), `# index\n\nstaging bucket secret everything\n`);
  fs.writeFileSync(path.join(jd, "archive", "_reserved.md"), `# reserved\n\nstaging bucket secret everything\n`);
}

const QUERIES = [
  "staging bucket secret rotate",
  "which pod renders invoices",
  "postgres migration runbook",
  "部署流程 回滚方案",
  "kafka consumer lag incident",
  "zz-no-such-term-anywhere",
  "the and of", // low-signal short words
];

describe("retrieval/lexical-index — persistent lexical journal index", () => {
  let core;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    delete process.env.AGENT_RECALL_EMBEDDINGS;
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    core = await import("../dist/index.js");
    core.setRoot(TEST_ROOT);
  });

  after(() => {
    try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  /** Deep-copy dropping function-valued properties (QueryMemoryResult carries
   *  a `renderFenced` closure — functions only ever compare by reference, so
   *  they must be stripped for brute-vs-indexed deep equality; every DATA
   *  field, including undefined-valued keys, is preserved and compared). */
  function stripFunctions(v) {
    if (typeof v === "function") return undefined;
    if (Array.isArray(v)) return v.map(stripFunctions);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) {
        if (typeof v[k] === "function") continue;
        out[k] = stripFunctions(v[k]);
      }
      return out;
    }
    return v;
  }

  async function runJournal(project, query) {
    return stripFunctions(await core.queryMemory({ project, query, tiers: ["journal"], limit: 10 }));
  }

  /** Run `fn` with the index force-disabled (brute-force oracle path). */
  async function brute(fn) {
    process.env.AGENT_RECALL_LEXICAL_INDEX = "0";
    try {
      return await fn();
    } finally {
      delete process.env.AGENT_RECALL_LEXICAL_INDEX;
    }
  }

  /** Assert indexed === brute for every query, on the given project. */
  async function assertAllQueriesEqual(project, label) {
    for (const q of QUERIES) {
      const bruteRes = await brute(() => runJournal(project, q));
      const indexedRes = await runJournal(project, q);
      assert.deepStrictEqual(indexedRes, bruteRes, `${label}: indexed != brute for query "${q}"`);
      // repeat on the warm snapshot cache — must stay byte-identical
      const indexedAgain = await runJournal(project, q);
      assert.deepStrictEqual(indexedAgain, bruteRes, `${label}: warm indexed != brute for query "${q}"`);
    }
  }

  it("equivalence: indexed journal tier === brute force across seeds and query shapes", async () => {
    for (const seed of [7, 42, 1337]) {
      const slug = `${P}-eq-${seed}`;
      buildStore(TEST_ROOT, slug, seed);
      core.resetLexicalIndexCaches();
      await assertAllQueriesEqual(slug, `seed ${seed}`);
      // persisted artifact exists and is valid JSON with the expected shape
      const idxPath = core.lexicalJournalIndexPath(slug);
      assert.ok(fs.existsSync(idxPath), "index file persisted");
      const parsed = JSON.parse(fs.readFileSync(idxPath, "utf-8"));
      assert.equal(parsed.version, 1);
      assert.ok(Array.isArray(parsed.vocab) && Array.isArray(parsed.docs));
    }
  });

  it("equivalence survives a process restart (cold in-process caches, warm disk index)", async () => {
    const slug = `${P}-restart`;
    buildStore(TEST_ROOT, slug, 99);
    await runJournal(slug, QUERIES[0]); // build + persist
    core.resetLexicalIndexCaches(); // simulate a fresh process
    await assertAllQueriesEqual(slug, "restart");
  });

  it("rescue-tagged content never surfaces through the indexed path", async () => {
    const slug = `${P}-eq-42`;
    for (const q of ["quarantined velvet-otter poison", "staging bucket secret rotate"]) {
      const res = await runJournal(slug, q);
      for (const item of res.items ?? []) {
        assert.ok(!`${item.title} ${item.excerpt}`.includes("quarantined velvet-otter poison"),
          `rescue content leaked via "${q}"`);
      }
    }
  });

  it("invalidation: external in-place edit is reflected on the next query", async () => {
    const slug = `${P}-edit`;
    buildStore(TEST_ROOT, slug, 11);
    await runJournal(slug, "staging bucket"); // build index
    const target = path.join(journalDirOf(TEST_ROOT, slug), "2026-09-14--manual--05L--needle.md");
    fs.writeFileSync(target, `# needle\n\n## Decisions\n\nEDITED: the zanzibar-quokka bucket now rotates every 30 days instead.\n`);
    const indexedRes = await runJournal(slug, "zanzibar-quokka bucket");
    assert.ok((indexedRes.items ?? []).some((i) => i.excerpt.includes("zanzibar-quokka")), "edited content not picked up");
    await assertAllQueriesEqual(slug, "after external edit");
  });

  it("invalidation: delete and create are reflected on the next query", async () => {
    const slug = `${P}-mut`;
    buildStore(TEST_ROOT, slug, 23);
    await runJournal(slug, "staging bucket");
    // delete the needle
    fs.rmSync(path.join(journalDirOf(TEST_ROOT, slug), "2026-09-14--manual--05L--needle.md"));
    let res = await runJournal(slug, "velvet-otter staging bucket");
    assert.ok(!(res.items ?? []).some((i) => i.excerpt.includes("velvet-otter")), "deleted file still surfaced");
    // create a new file
    fs.writeFileSync(
      path.join(journalDirOf(TEST_ROOT, slug), "2026-09-20--manual--04L--fresh.md"),
      `# fresh\n\n## Work\n\nbrand-new xylophone-walrus deployment note.\n`,
    );
    res = await runJournal(slug, "xylophone-walrus deployment");
    assert.ok((res.items ?? []).some((i) => i.excerpt.includes("xylophone-walrus")), "new file not picked up");
    await assertAllQueriesEqual(slug, "after delete+create");
  });

  it("trust invalidation: a file that becomes rescue-tagged is quarantined on the next query", async () => {
    const slug = `${P}-trustflip`;
    buildStore(TEST_ROOT, slug, 31);
    await runJournal(slug, "staging bucket");
    const target = path.join(journalDirOf(TEST_ROOT, slug), "2026-09-14--manual--05L--needle.md");
    fs.writeFileSync(target, `---\nsource: working-memory-rescue\n---\n# needle\n\n## Decisions\n\nThe velvet-otter staging bucket rotates its webhook secret every 90 days.\n`);
    const res = await runJournal(slug, "velvet-otter staging bucket");
    assert.ok(!(res.items ?? []).some((i) => i.excerpt.includes("velvet-otter")), "newly rescue-tagged file still surfaced");
    await assertAllQueriesEqual(slug, "after trust flip");
  });

  it("crash-safety: corrupt / truncated index file → rebuild, results equal brute", async () => {
    const slug = `${P}-corrupt`;
    buildStore(TEST_ROOT, slug, 55);
    await runJournal(slug, "staging bucket"); // build + persist
    const idxPath = core.lexicalJournalIndexPath(slug);
    const good = fs.readFileSync(idxPath, "utf-8");

    // (a) binary garbage
    fs.writeFileSync(idxPath, Buffer.from([0x00, 0xff, 0x13, 0x37, 0x00]));
    core.resetLexicalIndexCaches();
    await assertAllQueriesEqual(slug, "garbage index");
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(idxPath, "utf-8")), "index not re-persisted as valid JSON");

    // (b) truncated JSON (process killed mid-write simulation)
    fs.writeFileSync(idxPath, good.slice(0, Math.floor(good.length / 2)));
    core.resetLexicalIndexCaches();
    await assertAllQueriesEqual(slug, "truncated index");

    // (c) valid JSON, wrong schema
    fs.writeFileSync(idxPath, JSON.stringify({ version: 999, docs: "nope" }));
    core.resetLexicalIndexCaches();
    await assertAllQueriesEqual(slug, "wrong-schema index");
  });

  it("poisoned index cannot surface quarantined content (read-time trust recheck)", async () => {
    const slug = `${P}-poison`;
    buildStore(TEST_ROOT, slug, 77);
    await runJournal(slug, "staging bucket"); // build + persist
    const idxPath = core.lexicalJournalIndexPath(slug);
    const parsed = JSON.parse(fs.readFileSync(idxPath, "utf-8"));
    let flipped = 0;
    for (const d of parsed.docs) {
      if (d.u === 1) { d.u = 0; flipped++; }
    }
    assert.ok(flipped > 0, "fixture should contain a quarantined doc");
    fs.writeFileSync(idxPath, JSON.stringify(parsed));
    core.resetLexicalIndexCaches();
    const res = await runJournal(slug, "quarantined velvet-otter poison");
    for (const item of res.items ?? []) {
      assert.ok(!`${item.title} ${item.excerpt}`.includes("quarantined velvet-otter poison"), "poisoned index surfaced rescue content");
    }
  });

  it("concurrency: parallel queries over a drifted store agree with brute", async () => {
    const slug = `${P}-conc`;
    buildStore(TEST_ROOT, slug, 123);
    await runJournal(slug, "staging bucket");
    // drift: add two files so every parallel query sees a dirty index
    fs.writeFileSync(path.join(journalDirOf(TEST_ROOT, slug), "2026-09-21--manual--03L--c1.md"), `# c1\n\n## Work\n\nparallel-alpha deploy note\n`);
    fs.writeFileSync(path.join(journalDirOf(TEST_ROOT, slug), "2026-09-22--manual--03L--c2.md"), `# c2\n\n## Work\n\nparallel-beta deploy note\n`);
    const queries = ["parallel-alpha deploy", "parallel-beta deploy", "staging bucket secret", "postgres migration runbook", "kafka consumer lag"];
    const results = await Promise.all(queries.map((q) => runJournal(slug, q)));
    for (let i = 0; i < queries.length; i++) {
      const bruteRes = await brute(() => runJournal(slug, queries[i]));
      assert.deepStrictEqual(results[i], bruteRes, `concurrent query "${queries[i]}" != brute`);
    }
  });

  it("rawArchiveOnly: readTierCandidates subset flag is identical to filtering the full read", async () => {
    const slug = `${P}-rawonly`;
    buildStore(TEST_ROOT, slug, 61);
    // plant raw-archive content (the only sourceKind this flag may return)
    const rawDir = path.join(journalDirOf(TEST_ROOT, slug), "archive", "raw");
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, "2026-08-01--sid1.md"), `# raw dump\n\nverbatim transcript about terraform state lock\n`);
    fs.writeFileSync(path.join(rawDir, "2026-08-02--sid2.md"), `---\nsource: working-memory-rescue\n---\n# raw rescue\n\nquarantined raw line\n`);
    const full = core
      .readTierCandidates("journal", slug, { includeRawArchive: true, includeRollupArchive: true, includeUntrusted: true })
      .filter((c) => c.sourceKind === "journal-archive-raw");
    const rawOnly = core.readTierCandidates("journal", slug, { includeRawArchive: true, rawArchiveOnly: true, includeUntrusted: true });
    assert.deepStrictEqual(rawOnly, full, "rawArchiveOnly must be byte-identical to filtering the full journal read");
    assert.ok(rawOnly.length === 2, "sanity: both raw files visible pre-trust-filter");
    assert.ok(core.filterTrusted(rawOnly).length === 1, "trust filter still drops the rescue-tagged raw dump");
  });

  it("includeRollupArchive=false scope matches brute and does not clobber archive entries", async () => {
    const slug = `${P}-noarch`;
    buildStore(TEST_ROOT, slug, 88);
    // first, a default (archive-inclusive) query persists archive entries
    await runJournal(slug, "staging bucket");
    const noArchive = async (q) =>
      stripFunctions(await core.queryMemory({ project: slug, query: q, tiers: ["journal"], limit: 10, journal: { includeRollupArchive: false } }));
    for (const q of ["postgres migration runbook", "kafka consumer lag incident"]) {
      const bruteRes = await brute(() => noArchive(q));
      const indexedRes = await noArchive(q);
      assert.deepStrictEqual(indexedRes, bruteRes, `no-archive indexed != brute for "${q}"`);
    }
    // and a subsequent archive-inclusive query still equals brute (archive entries intact)
    await assertAllQueriesEqual(slug, "archive after no-archive persist");
  });
});
