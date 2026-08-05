import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("session_end journal file filtering", () => {
  let core;
  let testRoot;

  before(async () => {
    core = await import("../dist/index.js");
  });

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ar-session-end-filter-"));
    process.env.AGENT_RECALL_ROOT = testRoot;
    core.setRoot(testRoot);
    core.resetSessionState();
  });

  afterEach(() => {
    core.resetRoot();
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  function journalPath(project) {
    const dir = path.join(testRoot, "projects", project, "journal");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function isoDaysAgo(days) {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date.toISOString().slice(0, 10);
  }

  it("ignores same-day capture logs when choosing Brief vs Update heading", async () => {
    const project = "filter-brief";
    const today = new Date().toISOString().slice(0, 10);
    const dir = journalPath(project);
    fs.writeFileSync(
      path.join(dir, `${today}-log.md`),
      `# ${today} - capture log\n\n## Brief\nCaptured troubleshooting details only.\n`,
      "utf-8",
    );

    await core.sessionEnd({
      summary: "Recorded secure oauth implementation details for the current session",
      project,
    });

    const realFiles = fs.readdirSync(dir)
      .filter((file) => file.startsWith(today) && file.endsWith(".md"))
      .filter((file) => file !== `${today}-log.md` && file !== "index.md");
    assert.equal(realFiles.length, 1);
    const content = fs.readFileSync(path.join(dir, realFiles[0]), "utf-8");
    assert.match(content, /^## Brief$/m);
    assert.doesNotMatch(content, /^## Update \d{2}:\d{2}$/m);
  });

  it("excludes auxiliary journal files from the save-card journal count", async () => {
    const project = "filter-count";
    const today = new Date().toISOString().slice(0, 10);
    const dir = journalPath(project);
    fs.writeFileSync(path.join(dir, `${today}.md`), `# ${today}\n\n## Brief\nExisting real entry.\n`, "utf-8");
    fs.writeFileSync(path.join(dir, "index.md"), "# Index\n", "utf-8");
    fs.writeFileSync(path.join(dir, `${today}-log.md`), "# Capture Log\n", "utf-8");
    fs.writeFileSync(path.join(dir, `${today}--capture--none--none--note.md`), "# Smart Capture\n", "utf-8");
    fs.writeFileSync(path.join(dir, `${today}.merged.md`), "# Merged Entry\n", "utf-8");
    fs.writeFileSync(path.join(dir, "2026-W21.md"), "# Weekly Rollup\n", "utf-8");

    const result = await core.sessionEnd({
      summary: "Added the second real journal update for count filtering",
      project,
    });

    assert.match(result.card, /#1\b/);
  });

  it("does not suggest merges from overlapping capture logs", async () => {
    const project = "filter-merge";
    const dir = journalPath(project);
    const yesterday = isoDaysAgo(1);
    fs.writeFileSync(
      path.join(dir, `${yesterday}-log.md`),
      "# Capture Log\n\n## Brief\nOAuth refresh token rotation security browser authentication notes.\n",
      "utf-8",
    );

    const result = await core.sessionEnd({
      summary: "OAuth refresh token rotation security browser authentication summary",
      project,
    });

    assert.equal(result.merge_suggestions, undefined);
  });
});
