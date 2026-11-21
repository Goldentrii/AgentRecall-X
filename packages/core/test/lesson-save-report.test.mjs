// packages/core/test/lesson-save-report.test.mjs
//
// 3.5.4 PR-E (P0-4a + P0-5a). session_end and remember used to reply
// "1 added" from a pre-pass over the insights index, whatever awareness and
// the index then did. Measured in the 3.5.3 memory test: a new lesson replaced
// by an archived one still said "1 added" (2/2), and project A kept 19 of 60
// lessons after project B saved 240, with no word to anyone. These tests pin
// the honest report: merged / resurrected / demoted / archive-dropped /
// evicted (with project) / not indexed, as ADDITIVE fields only.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { sessionEnd } from "../dist/tools-logic/session-end.js";
import { smartRemember } from "../dist/tools-logic/smart-remember.js";
import { readInsightsIndex, writeInsightsIndex, addIndexedInsight } from "../dist/palace/insights-index.js";

let root;

beforeEach(() => {
  root = path.join(tmpdir(), `ar-lesson-report-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(root, { recursive: true });
  process.env.AGENT_RECALL_ROOT = root;
});

afterEach(() => {
  delete process.env.AGENT_RECALL_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

const NEW_LESSON = {
  title: "Token-bucket rate limiting absorbs bursts better than fixed windows",
  evidence: "Load test dropped 0 requests vs 12% with fixed windows",
  applies_when: ["rate limiting", "api gateway"],
};

function insight(title, extra = {}) {
  return {
    id: `insight-${Math.random().toString(16).slice(2)}`,
    title,
    evidence: `evidence for ${title}`,
    confirmations: 5,
    lastConfirmed: "2026-11-01T00:00:00.000Z",
    appliesWhen: ["fixture"],
    source: "fixture",
    source_project: "proj-a",
    trend: "stable",
    ...extra,
  };
}

function writeState(topInsights) {
  fs.writeFileSync(
    path.join(root, "awareness-state.json"),
    JSON.stringify({ identity: "t", topInsights, compoundInsights: [], trajectory: "", blindSpots: [], lastUpdated: "2026-11-01T00:00:00.000Z" }),
  );
}

// Mutually dissimilar titles: four fixed-width letter-only words unique to i,
// so no two titles share a keyword (or contain one another's as a substring,
// which the awareness matchers also count), and none overlaps NEW_LESSON.
function word(i, pos) {
  const a = "abcdefghijklmnopqrstuvwxyz";
  return `q${a[pos]}${a[Math.floor(i / 676) % 26]}${a[Math.floor(i / 26) % 26]}${a[i % 26]}x`;
}
function distinctTitle(i) {
  return `${word(i, 0)} ${word(i, 1)} ${word(i, 2)} ${word(i, 3)}`;
}

function fullIndex(project, count) {
  const insights = [];
  for (let i = 0; i < 200; i++) {
    insights.push({
      id: `idx-${i}`,
      title: distinctTitle(i),
      source: "fixture",
      applies_when: ["fixture"],
      projects: [project],
      confirmed_count: count,
      last_confirmed: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      severity: "important",
    });
  }
  fs.writeFileSync(path.join(root, "insights-index.json"), JSON.stringify({ version: "1.0.0", updated: "x", insights }));
}

describe("session_end reports what happened to each lesson (P0-4a)", () => {
  it("a fresh lesson is plainly added (no extra fields)", async () => {
    const r = await sessionEnd({ summary: "Shipped the limiter today", insights: [NEW_LESSON], project: "proj-a" });
    assert.equal(r.insights_added, 1);
    assert.equal(r.insights_confirmed, 0);
    for (const k of ["insights_merged", "insights_resurrected", "insights_demoted", "insights_archive_dropped", "insights_evicted", "insights_not_indexed"]) {
      assert.equal(r[k], undefined, `${k} absent on a plain add`);
    }
    assert.ok(!r.card.includes("⟦agentrecall:memory:"), "no lesson warning block on a plain add");
  });

  it("resurrected: an archived lesson replacing the new title is not reported as added (S3)", async () => {
    const archived = insight("Token-bucket rate limiting absorbs bursts in the gateway too", { source_project: "proj-b" });
    fs.writeFileSync(path.join(root, "awareness-archive.json"), JSON.stringify([archived]));
    const r = await sessionEnd({ summary: "Shipped the limiter today", insights: [NEW_LESSON], project: "proj-a" });
    assert.equal(r.insights_added, 0, "a resurrected lesson is not '1 added'");
    assert.deepEqual(r.insights_resurrected, [{ title: NEW_LESSON.title, resurrected: archived.title }]);
    assert.match(r.card, /resurrected/i);
    assert.ok(r.card.includes(archived.title));
    assert.ok(r.card.includes("⟦agentrecall:memory:"), "stored titles in the card are fenced");
  });

  it("merged: awareness merges into an existing lesson even when the index adds it", async () => {
    const existing = insight("Token-bucket rate limiting absorbs bursts in the gateway too");
    writeState([existing]);
    const r = await sessionEnd({ summary: "Shipped the limiter today", insights: [NEW_LESSON], project: "proj-a" });
    assert.equal(r.insights_added, 0);
    assert.deepEqual(r.insights_merged, [{ title: NEW_LESSON.title, into: existing.title }]);
    assert.match(r.card, /merged into/i);
  });

  it("demoted: a full top-20 list moves its lowest lesson to the archive and says so", async () => {
    const top = Array.from({ length: 20 }, (_, i) => insight(distinctTitle(i), { confirmations: 10 + i, source_project: "proj-b" }));
    writeState(top);
    const r = await sessionEnd({ summary: "Shipped the limiter today", insights: [NEW_LESSON], project: "proj-a" });
    assert.equal(r.insights_added, 1, "the new lesson itself is stored");
    assert.deepEqual(r.insights_demoted, [{ title: distinctTitle(0), project: "proj-b" }]);
    assert.ok(r.card.includes(distinctTitle(0)));
  });

  it("archive dropped: demoting into a full 50-entry archive reports the lesson that fell off", async () => {
    const top = Array.from({ length: 20 }, (_, i) => insight(distinctTitle(i), { confirmations: 10 + i }));
    writeState(top);
    const archive = Array.from({ length: 50 }, (_, i) => insight(distinctTitle(100 + i), { source_project: "proj-c" }));
    fs.writeFileSync(path.join(root, "awareness-archive.json"), JSON.stringify(archive));
    const r = await sessionEnd({ summary: "Shipped the limiter today", insights: [NEW_LESSON], project: "proj-a" });
    assert.deepEqual(r.insights_archive_dropped, [{ title: distinctTitle(149), project: "proj-c" }]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "awareness-archive.json"), "utf-8")).length, 50);
  });

  it("evicted: a full index evicts another project's oldest lesson and B's reply names it (g7 S2)", async () => {
    fullIndex("proj-b", 1);
    const r = await sessionEnd({ summary: "Shipped the limiter today", insights: [NEW_LESSON], project: "proj-a" });
    assert.equal(r.insights_added, 1);
    assert.deepEqual(r.insights_evicted, [{ title: distinctTitle(0), projects: ["proj-b"], other_project: true }]);
    assert.ok(r.card.includes(distinctTitle(0)), "the evicted title is named");
    assert.match(r.card, /proj-b/);
    assert.match(r.card, /another project/i);
    assert.equal(readInsightsIndex().insights.length, 200);
  });

  it("evicted from the same project is not called 'another project'", async () => {
    fullIndex("proj-a", 1);
    const r = await sessionEnd({ summary: "Shipped the limiter today", insights: [NEW_LESSON], project: "proj-a" });
    assert.equal(r.insights_evicted[0].other_project, false);
    assert.ok(!/another project/i.test(r.card));
  });

  it("not indexed: an index full of confirmed lessons refuses the new one, and the reply says so", async () => {
    fullIndex("proj-b", 2);
    const r = await sessionEnd({ summary: "Shipped the limiter today", insights: [NEW_LESSON], project: "proj-a" });
    assert.equal(r.insights_added, 0, "today this said 1 added");
    assert.deepEqual(r.insights_not_indexed, [NEW_LESSON.title]);
    assert.match(r.card, /not indexed/i);
    assert.ok(!readInsightsIndex().insights.some((i) => i.title === NEW_LESSON.title));
  });

  it("confirmed: a near-duplicate of an indexed lesson is confirmed, not added", async () => {
    await sessionEnd({ summary: "Shipped the limiter today", insights: [NEW_LESSON], project: "proj-a" });
    const r = await sessionEnd({ summary: "Second session on the limiter", insights: [{ ...NEW_LESSON, evidence: "Second load test agreed" }], project: "proj-a" });
    assert.equal(r.insights_added, 0);
    assert.equal(r.insights_confirmed, 1);
    assert.equal(r.insights_merged, undefined, "merging into the same title is not reported as a merge");
  });

  it("resurrected AND not indexed are both reported (a full index does not hide the resurrection)", async () => {
    const archived = insight("Token-bucket rate limiting absorbs bursts in the gateway too");
    fs.writeFileSync(path.join(root, "awareness-archive.json"), JSON.stringify([archived]));
    fullIndex("proj-b", 2);
    const r = await sessionEnd({ summary: "Shipped the limiter today", insights: [NEW_LESSON], project: "proj-a" });
    assert.equal(r.insights_added, 0);
    assert.deepEqual(r.insights_resurrected, [{ title: NEW_LESSON.title, resurrected: archived.title }]);
    assert.deepEqual(r.insights_not_indexed, [NEW_LESSON.title]);
  });

  it("merged in awareness AND confirmed in the index reports both", async () => {
    const existing = insight("Token-bucket rate limiting absorbs bursts in the gateway too");
    writeState([existing]);
    await addIndexedInsight({ title: NEW_LESSON.title, source: "t", applies_when: [], projects: ["proj-a"], severity: "important" });
    const r = await sessionEnd({ summary: "Shipped the limiter today", insights: [NEW_LESSON], project: "proj-a" });
    assert.equal(r.insights_added, 0);
    assert.equal(r.insights_confirmed, 1);
    assert.deepEqual(r.insights_merged, [{ title: NEW_LESSON.title, into: existing.title }]);
  });

  it("evicting a global lesson (no projects) is not called 'another project'", async () => {
    fullIndex("proj-b", 1);
    const idx = JSON.parse(fs.readFileSync(path.join(root, "insights-index.json"), "utf-8"));
    delete idx.insights[0].projects;
    fs.writeFileSync(path.join(root, "insights-index.json"), JSON.stringify(idx));
    const r = await sessionEnd({ summary: "Shipped the limiter today", insights: [NEW_LESSON], project: "proj-a" });
    assert.deepEqual(r.insights_evicted, [{ title: distinctTitle(0), projects: [], other_project: false }]);
    assert.ok(r.card.includes("with no project"));
    assert.ok(!/another project/i.test(r.card));
  });

  it("a failure part-way through a batch still reports the lessons already stored", async () => {
    // 19 lessons on top: the 1st new lesson fits (no demotion); the 2nd demotes
    // into the archive, whose path is a directory, so that write throws.
    writeState(Array.from({ length: 19 }, (_, i) => insight(distinctTitle(i), { confirmations: 10 + i })));
    fs.mkdirSync(path.join(root, "awareness-archive.json"));
    fs.writeFileSync(path.join(root, "awareness-archive.json", "keep"), "x");
    const second = { title: "Circuit breakers stop retry storms during partial outages", evidence: "Retry storm took the API down twice", applies_when: ["retries"] };
    const r = await sessionEnd({ summary: "Two lessons, the second write fails", insights: [NEW_LESSON, second], project: "proj-a" });
    assert.ok(r.awareness_error, "the failure is reported");
    assert.equal(r.insights_added, 1, "the first lesson was stored and is reported");
    assert.ok(readInsightsIndex().insights.some((i) => i.title === NEW_LESSON.title));
  });
});

describe("remember() carries the same report (P0-4a)", () => {
  it("lesson route at a full index names the evicted lesson and its project", async () => {
    fullIndex("proj-b", 1);
    const r = await smartRemember({
      content: "Token-bucket rate limiting absorbs bursts better than fixed windows. Load test dropped 0 requests.",
      context: "lesson",
      project: "proj-a",
    });
    assert.equal(r.routed_to, "awareness_update");
    assert.deepEqual(r.lessons?.evicted, [{ title: distinctTitle(0), projects: ["proj-b"], other_project: true }]);
    assert.ok(r.lesson_warnings?.some((w) => w.includes(distinctTitle(0)) && w.includes("proj-b")));
  });

  it("lesson route at an index full of confirmed lessons reports not indexed", async () => {
    fullIndex("proj-b", 2);
    const r = await smartRemember({
      content: "Token-bucket rate limiting absorbs bursts better than fixed windows. Load test dropped 0 requests.",
      context: "lesson",
      project: "proj-a",
    });
    assert.equal(r.lessons?.not_indexed.length, 1);
    assert.ok(r.lesson_warnings?.some((w) => /not indexed/i.test(w)));
    assert.equal(r.entry_indicator, "insight not indexed");
  });

  it("a plain lesson save carries no warnings", async () => {
    const r = await smartRemember({
      content: "Token-bucket rate limiting absorbs bursts better than fixed windows. Load test dropped 0 requests.",
      context: "lesson",
      project: "proj-a",
    });
    assert.equal(r.lesson_warnings, undefined);
  });
});

describe("addIndexedInsight onEvict (additive option)", () => {
  it("calls onEvict with the evicted entry and keeps its return type", async () => {
    fullIndex("proj-b", 1);
    const evicted = [];
    const added = await addIndexedInsight(
      { title: NEW_LESSON.title, source: "t", applies_when: [], projects: ["proj-a"], severity: "important" },
      { onEvict: (e) => evicted.push(e) },
    );
    assert.equal(added.title, NEW_LESSON.title);
    assert.equal(evicted.length, 1);
    assert.equal(evicted[0].title, distinctTitle(0));
  });
});

describe("writeInsightsIndex is atomic (P0-5a)", () => {
  it("replaces the file by rename, never rewrites it in place (a hard link keeps the old bytes)", () => {
    // An in-place write (the pre-3.5.4 writeFileSync) truncates and rewrites
    // the same inode, so a hard link would see the new, possibly torn, bytes.
    // tmp + rename swaps the directory entry: the link keeps the old file.
    writeInsightsIndex({ version: "1.0.0", updated: "", insights: [] });
    const p = path.join(root, "insights-index.json");
    const link = path.join(root, "old-index-link.json");
    fs.linkSync(p, link);
    const before = fs.readFileSync(link, "utf-8");
    writeInsightsIndex({ version: "1.0.0", updated: "", insights: [{ id: "x", title: "new entry title here", source: "t", applies_when: [], confirmed_count: 1, last_confirmed: "2026-01-01T00:00:00.000Z" }] });
    assert.equal(fs.readFileSync(link, "utf-8"), before, "the old file is untouched");
    assert.equal(JSON.parse(fs.readFileSync(p, "utf-8")).insights.length, 1, "the index has the new content");
  });

  it("sweeps tmp files a killed writer left behind, once they are stale", () => {
    const stale = path.join(root, "insights-index.json.tmp.999.deadbeef");
    const fresh = path.join(root, "insights-index.json.tmp.998.cafef00d");
    fs.writeFileSync(stale, "{");
    fs.writeFileSync(fresh, "{");
    const old = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(stale, old, old);
    writeInsightsIndex({ version: "1.0.0", updated: "", insights: [] });
    assert.ok(!fs.existsSync(stale), "a stale tmp is removed");
    assert.ok(fs.existsSync(fresh), "a fresh tmp (a live writer's) is kept");
  });

  it("leaves no tmp file behind and writes valid JSON", () => {
    writeInsightsIndex({ version: "1.0.0", updated: "", insights: [] });
    assert.deepEqual(fs.readdirSync(root).filter((n) => n.includes(".tmp")), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "insights-index.json"), "utf-8")).insights, []);
  });

  it("is owner-only (0o600) on POSIX", { skip: process.platform === "win32" }, () => {
    writeInsightsIndex({ version: "1.0.0", updated: "", insights: [] });
    assert.equal(fs.statSync(path.join(root, "insights-index.json")).mode & 0o777, 0o600);
  });

  it("a failed rename keeps the old target and removes the tmp file", () => {
    // The target is a non-empty directory, so the rename over it must fail.
    const target = path.join(root, "insights-index.json");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "keep"), "x");
    assert.throws(() => writeInsightsIndex({ version: "1.0.0", updated: "", insights: [] }));
    assert.ok(fs.statSync(target).isDirectory(), "old target untouched");
    assert.deepEqual(fs.readdirSync(root).filter((n) => n.includes(".tmp")), [], "no tmp leaked");
  });
});
