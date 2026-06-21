import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-tool-logic-test-" + Date.now());

describe("Tool-logic functions — integration tests", () => {
  let core;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core = await import("../dist/index.js");
  });

  after(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  // ── Journal Write + Read ─────────────────────────────

  it("journalWrite creates a journal entry", async () => {
    const result = await core.journalWrite({
      content: "## Brief\nTest project — tool logic test\n",
      project: "test-proj",
    });
    assert.equal(result.success, true);
    assert.ok(result.date);
    assert.ok(fs.existsSync(result.file));
  });

  it("journalRead reads the latest entry", async () => {
    const result = await core.journalRead({ project: "test-proj" });
    assert.ok(result.content.includes("Test project"));
    assert.equal(result.project, "test-proj");
  });

  it("journalRead reads a specific section", async () => {
    const result = await core.journalRead({
      project: "test-proj",
      section: "brief",
    });
    assert.ok(result.content.includes("Test project"));
  });

  it("journalRead returns error for missing project", async () => {
    const result = await core.journalRead({ project: "nonexistent" });
    assert.ok(result.error);
  });

  // ── Journal Capture ───────────────────────────────────

  it("journalCapture creates a log entry", async () => {
    const result = await core.journalCapture({
      question: "How to test?",
      answer: "Use node:test",
      tags: ["testing"],
      project: "test-proj",
    });
    assert.equal(result.success, true);
    assert.equal(result.entry_number, 1);
  });

  it("journalCapture increments entry number", async () => {
    const result = await core.journalCapture({
      question: "Second question?",
      answer: "Second answer",
      project: "test-proj",
    });
    assert.equal(result.entry_number, 2);
  });

  // ── Journal List ──────────────────────────────────────

  it("journalList returns entries", async () => {
    const result = await core.journalList({ project: "test-proj" });
    assert.equal(result.project, "test-proj");
    assert.ok(result.entries.length >= 1);
    assert.ok(result.entries[0].date);
  });

  // ── Journal Projects ──────────────────────────────────

  it("journalProjects lists tracked projects", async () => {
    const result = await core.journalProjects();
    assert.ok(Array.isArray(result.projects));
    assert.ok(result.projects.some((p) => p.slug === "test-proj"));
    assert.ok(result.journal_root);
  });

  it("journalProjects ignores auxiliary journal files", async () => {
    const project = "aux-filter-proj";
    const journalDir = path.join(TEST_ROOT, "projects", project, "journal");
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(
      path.join(journalDir, "2026-01-01--arsave--none--none--real-entry.md"),
      "# Real entry\n\n## Brief\nProject work that should count.\n",
      "utf-8",
    );
    fs.writeFileSync(path.join(journalDir, "index.md"), "# Index\n", "utf-8");
    fs.writeFileSync(path.join(journalDir, "2026-01-02.merged.md"), "# Merged helper\n", "utf-8");
    fs.writeFileSync(path.join(journalDir, "2026-01-03--capture--none--none--note.md"), "# Capture\n", "utf-8");
    fs.writeFileSync(path.join(journalDir, "2026-W01.md"), "# Weekly rollup\n", "utf-8");
    fs.writeFileSync(path.join(journalDir, "notes.md"), "# Freeform notes\n", "utf-8");

    const result = await core.journalProjects();
    const found = result.projects.find((p) => p.slug === project);
    assert.ok(found);
    assert.equal(found.last_entry, "2026-01-01");
    assert.equal(found.entry_count, 1);
  });

  // ── Journal State ─────────────────────────────────────

  it("journalState write + read roundtrip", async () => {
    const writeResult = await core.journalState({
      action: "write",
      data: JSON.stringify({ completed: [{ task: "test", result: "pass" }] }),
      project: "test-proj",
    });
    assert.ok(writeResult.success || writeResult.entries);

    const readResult = await core.journalState({
      action: "read",
      project: "test-proj",
    });
    assert.ok(readResult.completed || readResult.empty);
  });

  // ── Palace Write + Read ───────────────────────────────

  it("palaceWrite creates a room and writes content", async () => {
    const result = await core.palaceWrite({
      room: "test-room",
      content: "Test memory content",
      importance: "high",
      project: "test-proj",
    });
    assert.equal(result.success, true);
    assert.equal(result.room, "test-room");
    assert.equal(result.importance, "high");
  });

  it("palaceRead lists rooms", async () => {
    const result = await core.palaceRead({ project: "test-proj" });
    assert.ok(result.rooms);
    assert.ok(result.rooms.some((r) => r.slug === "test-room"));
  });

  it("palaceRead reads a specific room", async () => {
    const result = await core.palaceRead({
      room: "test-room",
      project: "test-proj",
    });
    assert.ok(result.content);
    assert.ok(result.content.includes("Test memory"));
  });

  // ── Palace Walk ───────────────────────────────────────

  it("palaceWalk returns identity depth", async () => {
    const result = await core.palaceWalk({
      depth: "identity",
      project: "test-proj",
    });
    assert.equal(result.depth, "identity");
    assert.ok(result.content);
    assert.ok(result.rooms_count >= 1);
  });

  it("palaceWalk returns active depth", async () => {
    const result = await core.palaceWalk({
      depth: "active",
      project: "test-proj",
    });
    assert.equal(result.depth, "active");
    assert.ok(result.top_rooms);
  });

  // ── Palace Search ─────────────────────────────────────

  it("palaceSearch finds content", async () => {
    const result = await core.palaceSearch({
      query: "Test memory",
      project: "test-proj",
    });
    assert.ok(result.results.length > 0);
    assert.ok(result.results[0].room === "test-room");
  });

  it("palaceSearch returns empty for no match", async () => {
    const result = await core.palaceSearch({
      query: "zzzznonexistent",
      project: "test-proj",
    });
    assert.equal(result.results.length, 0);
  });

  // ── Palace Lint ───────────────────────────────────────

  it("palaceLint detects issues", async () => {
    const result = await core.palaceLint({ project: "test-proj" });
    assert.ok(typeof result.total_issues === "number");
    assert.ok(result.rooms_checked >= 1);
  });

  // ── Awareness Update ──────────────────────────────────

  it("awarenessUpdate adds insights", async () => {
    const result = await core.awarenessUpdate({
      insights: [
        {
          title: "Test-driven development catches bugs early",
          evidence: "Caught 3 regressions in tool-logic tests",
          applies_when: ["testing", "tdd"],
          source: "test-proj, 2026-04-09",
          severity: "important",
        },
      ],
      identity: "test user",
    });
    assert.equal(result.success, true);
    assert.equal(result.insights_processed.length, 1);
    assert.ok(result.total_insights >= 1);
  });

  // ── Recall Insight ────────────────────────────────────

  it("recallInsight returns relevant insights", async () => {
    const result = await core.recallInsight({
      context: "writing tests for a new feature",
    });
    assert.ok(result.matching_insights.length >= 0);
    assert.ok(typeof result.total_in_index === "number");
  });

  // ── Alignment Check ───────────────────────────────────

  it("alignmentCheck records alignment", async () => {
    const result = await core.alignmentCheck({
      goal: "Test the alignment system",
      confidence: "high",
      project: "test-proj",
    });
    assert.equal(result.success, true);
    assert.ok(result.file);
  });

  // ── Nudge ─────────────────────────────────────────────

  it("nudge records contradiction", async () => {
    const result = await core.nudge({
      past_statement: "We should use Redis",
      current_statement: "Let's use Postgres",
      question: "Did the requirements change?",
      project: "test-proj",
    });
    assert.equal(result.success, true);
    assert.ok(result.file);
  });

  // ── Knowledge Write + Read ────────────────────────────

  it("knowledgeWrite creates a lesson", async () => {
    const result = await core.knowledgeWrite({
      category: "testing",
      title: "Always test edge cases",
      what_happened: "Missed empty array handling",
      root_cause: "No edge case tests",
      fix: "Add tests for empty, null, boundary values",
      project: "test-proj",
    });
    assert.equal(result.success, true);
    assert.ok(result.file);
  });

  it("knowledgeRead returns lessons", async () => {
    const result = await core.knowledgeRead({ project: "test-proj", category: "testing" });
    assert.ok(result.includes("Always test edge cases"));
  });

  // ── Journal Search ────────────────────────────────────

  it("journalSearch finds text across journals", async () => {
    const result = await core.journalSearch({
      query: "Test project",
      project: "test-proj",
    });
    assert.ok(result.results.length > 0);
  });

  // ── Context Synthesize ────────────────────────────────

  it("contextSynthesize generates synthesis", async () => {
    const result = await core.contextSynthesize({
      entries: 5,
      project: "test-proj",
    });
    assert.ok(result.synthesis.includes("L3 Synthesis"));
    assert.ok(result.entries_analyzed >= 1);
  });

  // ── Cold Start ─────────────────────────────────────────

  it("journalColdStart returns palace-first context", async () => {
    const result = await core.journalColdStart({ project: "test-proj" });
    assert.equal(result.project, "test-proj");
    assert.ok(result.palace_context);
    assert.ok(typeof result.total_entries === "number");
    assert.ok(result.cache.hot);
  });

  // ── Archive ────────────────────────────────────────────

  it("journalArchive with high threshold archives nothing", async () => {
    const result = await core.journalArchive({
      older_than_days: 9999,
      project: "test-proj",
    });
    assert.equal(result.archived, 0);
    assert.ok(result.archive_dir);
  });

  // ── Rollup ─────────────────────────────────────────────

  it("journalRollup dry run previews without writing", async () => {
    const result = await core.journalRollup({
      dry_run: true,
      min_age_days: 0,
      min_entries: 1,
      project: "test-proj",
    });
    assert.equal(result.dry_run, true);
    assert.equal(result.project, "test-proj");
  });

  // ── Error paths ────────────────────────────────────────

  it("palaceRead returns error for nonexistent room", async () => {
    const result = await core.palaceRead({
      room: "nonexistent-room-xyz",
      project: "test-proj",
    });
    assert.ok(result.error);
  });

  it("journalSearch with no matches returns empty", async () => {
    const result = await core.journalSearch({
      query: "zzz-completely-impossible-string-xyz",
      project: "test-proj",
    });
    assert.equal(result.results.length, 0);
  });
});
