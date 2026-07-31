// packages/cli/test/continuity-wave.test.mjs
//
// Wave 2 (integrator) — CLI wiring tests for the 2026-07-31 continuity wave.
// Covers the four SUCCESS_WHEN scenarios named in the integrator brief:
//
//  (1) hook-end round-trip: unified F1 naming resolves a slug, then writes
//      BOTH the raw archive AND the F3 session card AND the F2 recency-index
//      line under that SAME slug (the split-brain bug this wave fixes).
//  (2) hook-start renders the F5 "⚠️ hook failures" line when hook-health.json
//      has a fresh failure.
//  (3) `ar resurrect` finds a synthetic dead session, cross-slug (found even
//      while the CLI's current --project context is a DIFFERENT slug).
//  (4) `ar health` empty-state renders cleanly and exits 0.
//
// Convention: spawn the compiled CLI (dist/index.js) against an isolated
// --root TEST_ROOT, matching hook-end-archive.test.mjs / hook-end-p3-backstop
// .test.mjs. HOME is overridden per-spawn (hook-start/hook-end lock files and
// ambient counters live at os.homedir()/.agent-recall/*, NOT under --root) so
// these tests never touch the real ~/.agent-recall store and never collide
// with other test files' lock keys.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "dist", "index.js");
const TEST_ROOT = path.join(os.tmpdir(), "ar-continuity-wave-test-" + Date.now());

const tmpDirs = [];
function isolatedHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-continuity-home-"));
  tmpDirs.push(dir);
  return dir;
}

/** Run the CLI. Returns { code, stdout, stderr }. */
function runCli(args, { stdin, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, "--root", TEST_ROOT, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

after(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("continuity wave — hook-end round-trip (unified naming + card + recency)", () => {
  it("resolves ONE slug via resolveSessionProject and writes archive + card + recency line under it (no --project override)", async () => {
    const sid = "cccccccc-1111-2222-3333-444455556666";
    const slug = "continuity-target";

    // Pre-create the target project dir so F1's claim-not-generate policy
    // has an EXISTING slug to claim (the strongest signal — no need to also
    // clear the >=3-mentions + ~/Projects/<name> new-slug gate).
    fs.mkdirSync(path.join(TEST_ROOT, "projects", slug), { recursive: true });

    const cwd = "/Users/testuser/Projects/continuity-target";
    const lines = [
      JSON.stringify({ type: "user", cwd, message: { content: "Let's build the continuity feature, ticket TOW2-999" } }),
      JSON.stringify({
        type: "assistant",
        cwd,
        message: { content: [{ type: "text", text: "On it — wiring the CLI commands now." }] },
      }),
      JSON.stringify({
        type: "assistant",
        cwd,
        message: {
          content: [
            {
              type: "text",
              text: "Decided: use JSONL for the recency ledger, per TOW2-999.\nNext step: wire ar health and ar resurrect.",
            },
          ],
        },
      }),
    ];
    const tDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-continuity-transcript-"));
    const transcriptPath = path.join(tDir, sid + ".jsonl");
    fs.writeFileSync(transcriptPath, lines.join("\n") + "\n");

    const payload = JSON.stringify({ transcript_path: transcriptPath, session_id: sid });
    const home = isolatedHome();
    // Deliberately NO --project flag — this exercises resolveSessionProject's
    // own resolution end-to-end, not the explicit-override path.
    const { code, stderr } = await runCli(["hook-end"], { stdin: payload, env: { HOME: home } });
    assert.equal(code, 0, `expected clean exit, stderr=${stderr}`);

    const today = new Date().toISOString().slice(0, 10);

    // ---- raw archive, under the resolved slug ----
    const rawDir = path.join(TEST_ROOT, "projects", slug, "journal", "archive", "raw");
    assert.ok(fs.existsSync(rawDir), `raw archive dir should exist under the resolved slug; stderr=${stderr}`);
    const rawFiles = fs.readdirSync(rawDir).filter((f) => f.endsWith(".md"));
    assert.ok(rawFiles.length >= 1, "raw archive file should exist");

    // ---- F3 session card, SAME slug as the raw archive (unified naming) ----
    const cardPath = path.join(TEST_ROOT, "projects", slug, "journal", `${today}--card--${sid}.md`);
    assert.ok(fs.existsSync(cardPath), `session card must be written under the SAME slug as the raw archive; stderr=${stderr}`);
    const cardBody = fs.readFileSync(cardPath, "utf-8");
    assert.ok(cardBody.includes("TOW2-999"), "card should capture the Linear ref from the transcript");
    assert.ok(/wire ar health and ar resurrect/i.test(cardBody), "card should capture the next-step line");

    // ---- F2 recency index, SAME slug + sid ----
    const recencyPath = path.join(TEST_ROOT, "recent-sessions.jsonl");
    assert.ok(fs.existsSync(recencyPath), `recency index should exist; stderr=${stderr}`);
    const recencyLines = fs.readFileSync(recencyPath, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const entry = recencyLines.find((e) => e.sid === sid);
    assert.ok(entry, `recency index should contain an entry for sid=${sid}; got ${JSON.stringify(recencyLines)}`);
    assert.equal(entry.slug, slug, "recency entry must use the SAME resolved slug as the archive/card (unified naming)");

    fs.rmSync(tDir, { recursive: true, force: true });
  });

  it("an explicit --project override wins over the resolved guess, consistently across archive + card + recency", async () => {
    const sid = "dddddddd-1111-2222-3333-444455556666";
    const overrideSlug = "explicit-override-project";
    // cwd points somewhere else entirely — if the override did NOT win, this
    // session would land under "resolveSessionProject-guess" instead.
    const cwd = "/Users/testuser/Projects/resolveSessionProject-guess";
    const lines = [
      JSON.stringify({ type: "user", cwd, message: { content: "some unrelated task" } }),
      JSON.stringify({ type: "assistant", cwd, message: { content: [{ type: "text", text: "done" }] } }),
    ];
    const tDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-continuity-override-"));
    const transcriptPath = path.join(tDir, sid + ".jsonl");
    fs.writeFileSync(transcriptPath, lines.join("\n") + "\n");

    const payload = JSON.stringify({ transcript_path: transcriptPath, session_id: sid });
    const home = isolatedHome();
    const { code, stderr } = await runCli(["--project", overrideSlug, "hook-end"], { stdin: payload, env: { HOME: home } });
    assert.equal(code, 0, `expected clean exit, stderr=${stderr}`);

    const rawDir = path.join(TEST_ROOT, "projects", overrideSlug, "journal", "archive", "raw");
    assert.ok(fs.existsSync(rawDir), "raw archive should land under the EXPLICIT --project override");

    const recencyPath = path.join(TEST_ROOT, "recent-sessions.jsonl");
    const recencyLines = fs.readFileSync(recencyPath, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const entry = recencyLines.find((e) => e.sid === sid);
    assert.ok(entry, "recency entry should exist for the override-slug session");
    assert.equal(entry.slug, overrideSlug, "recency entry must use the EXPLICIT override, not the resolved guess");

    fs.rmSync(tDir, { recursive: true, force: true });
  });
});

describe("continuity wave — hook-start renders F5 hook-health warning", () => {
  it("renders the ⚠️ hook-failures line as the FIRST line when hook-health.json has a fresh failure", async () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    fs.writeFileSync(
      path.join(TEST_ROOT, "hook-health.json"),
      JSON.stringify({
        last_failure: { ts: new Date().toISOString(), hook: "hook-end-archive", message: "boom" },
        failures_24h: 2,
      }),
      "utf-8",
    );

    const home = isolatedHome();
    const { code, stdout, stderr } = await runCli(["--project", "health-warn-test", "hook-start"], {
      env: { HOME: home, CLAUDE_SESSION_ID: "hook-start-health-test-1" },
    });
    assert.equal(code, 0, `expected clean exit, stderr=${stderr}`);
    assert.match(stdout, /⚠️ AgentRecall: 2 hook failures \(24h\)/, `expected health warning line; stdout=${stdout}`);
    assert.ok(stdout.startsWith("⚠️"), `health warning must be the FIRST line; stdout=${JSON.stringify(stdout.slice(0, 80))}`);
  });

  it("no health line at all when hook-health.json has zero recent failures", async () => {
    const cleanRoot = path.join(os.tmpdir(), "ar-continuity-clean-root-" + Date.now());
    fs.mkdirSync(cleanRoot, { recursive: true });
    const home = isolatedHome();
    const { code, stdout, stderr } = await new Promise((resolve) => {
      const child = spawn("node", [CLI, "--root", cleanRoot, "--project", "health-clean-test", "hook-start"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, HOME: home, CLAUDE_SESSION_ID: "hook-start-health-test-2" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end();
    });
    assert.equal(code, 0, `expected clean exit, stderr=${stderr}`);
    assert.ok(!stdout.includes("⚠️ AgentRecall:"), `no health warning expected on a clean store; stdout=${stdout}`);
    fs.rmSync(cleanRoot, { recursive: true, force: true });
  });
});

describe("continuity wave — L1/L2 hook-start continuity rendering (review fixes, 2026-07-31)", () => {
  it("L1: renders the ⏪ Continuity block BEFORE the 'Project:' header line, matching the MCP terse formatter's placement", async () => {
    const root = path.join(os.tmpdir(), "ar-l1-root-" + Date.now());
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, "recent-sessions.jsonl"),
      JSON.stringify({
        ts: new Date().toISOString(),
        sid: "l1-test-sid",
        slug: "some-other-project",
        title: "L1 placement check",
      }) + "\n",
      "utf-8",
    );
    const home = isolatedHome();
    const { code, stdout, stderr } = await new Promise((resolve) => {
      const child = spawn("node", [CLI, "--root", root, "--project", "l1-current-project", "hook-start"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, HOME: home, CLAUDE_SESSION_ID: "l1-hook-start-test" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end();
    });
    assert.equal(code, 0, `expected clean exit, stderr=${stderr}`);
    const continuityIdx = stdout.indexOf("⏪ Continuity");
    const projectIdx = stdout.indexOf("Project:");
    assert.ok(continuityIdx >= 0, `expected a continuity block; stdout=${stdout}`);
    assert.ok(projectIdx >= 0, `expected a Project: header line; stdout=${stdout}`);
    assert.ok(
      continuityIdx < projectIdx,
      `continuity block must render BEFORE the Project: header; stdout=${JSON.stringify(stdout)}`,
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("L2: continuity title/next_step truncation uses a word-boundary + ellipsis, not a bare mid-word cut", async () => {
    const root = path.join(os.tmpdir(), "ar-l2-root-" + Date.now());
    fs.mkdirSync(root, { recursive: true });
    const longTitle = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey";
    fs.writeFileSync(
      path.join(root, "recent-sessions.jsonl"),
      JSON.stringify({
        ts: new Date().toISOString(),
        sid: "l2-test-sid",
        slug: "some-other-project",
        title: longTitle,
      }) + "\n",
      "utf-8",
    );
    const home = isolatedHome();
    const { code, stdout, stderr } = await new Promise((resolve) => {
      const child = spawn("node", [CLI, "--root", root, "--project", "l2-current-project", "hook-start"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, HOME: home, CLAUDE_SESSION_ID: "l2-hook-start-test" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end();
    });
    assert.equal(code, 0, `expected clean exit, stderr=${stderr}`);
    const continuityLine = stdout.split("\n").find((l) => l.includes("l2-test-sid") || l.includes("[some-other-project]"));
    assert.ok(continuityLine, `expected a continuity line for the fixture; stdout=${stdout}`);
    assert.ok(continuityLine.includes("…"), `expected a word-boundary ellipsis marker, not a bare mid-word cut; line=${continuityLine}`);
    // The raw title must NOT appear whole (it exceeds the 100-char cap) and
    // the cut must not land mid-word (no dangling partial word before the ellipsis).
    assert.ok(!continuityLine.includes(longTitle), "the full long title must be truncated, not rendered whole");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("continuity wave — `ar resurrect` (F6)", () => {
  it("finds a synthetic dead session cross-slug, even under a DIFFERENT --project context", async () => {
    const targetSlug = "resurrect-target-slug";
    const currentSlug = "resurrect-caller-slug";
    const sid = "eeeeeeee-1111-2222-3333-444455556666";
    const today = new Date().toISOString().slice(0, 10);

    const rawDir = path.join(TEST_ROOT, "projects", targetSlug, "journal", "archive", "raw");
    fs.mkdirSync(rawDir, { recursive: true });
    const body = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: "Working on the CONTINUITY_UNIQUE_QUERY_TERM feature, ticket TOW2-888. Next step: ship it.",
          },
        ],
      },
    });
    fs.writeFileSync(path.join(rawDir, `${today}--${sid}.md`), body, "utf-8");

    // Ensure the CALLER's own project dir also exists (so this isn't
    // accidentally the only project in the store).
    fs.mkdirSync(path.join(TEST_ROOT, "projects", currentSlug), { recursive: true });

    const { code, stdout, stderr } = await runCli([
      "--project", currentSlug,
      "resurrect", "CONTINUITY_UNIQUE_QUERY_TERM",
      "--json",
    ]);
    assert.equal(code, 0, `expected clean exit, stderr=${stderr}`);
    const briefs = JSON.parse(stdout);
    assert.ok(Array.isArray(briefs), `expected a JSON array; stdout=${stdout}`);
    const found = briefs.find((b) => b.slug === targetSlug && b.sid === sid);
    assert.ok(
      found,
      `expected to find the target session under a DIFFERENT slug than --project; got ${JSON.stringify(briefs)}`,
    );
    assert.ok(found.linearRefs.includes("TOW2-888"), "brief should carry the Linear ref");
  });

  it("empty store → helpful markdown message, exit 0 (non-JSON mode)", async () => {
    const emptyRoot = path.join(os.tmpdir(), "ar-continuity-empty-resurrect-" + Date.now());
    fs.mkdirSync(emptyRoot, { recursive: true });
    const { code, stdout, stderr } = await new Promise((resolve) => {
      const child = spawn("node", [CLI, "--root", emptyRoot, "resurrect", "nothing-will-match-this-xyz"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end();
    });
    assert.equal(code, 0, `expected clean exit even on empty result; stderr=${stderr}`);
    assert.match(stdout, /No dead sessions found/i, `expected the helpful empty-result message; stdout=${stdout}`);
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  });
});

describe("continuity wave — `ar health` (F5 CLI surface)", () => {
  it("empty-state renders cleanly and exits 0 (human-readable)", async () => {
    const emptyRoot = path.join(os.tmpdir(), "ar-continuity-empty-health-" + Date.now());
    fs.mkdirSync(emptyRoot, { recursive: true });
    const { code, stdout, stderr } = await new Promise((resolve) => {
      const child = spawn("node", [CLI, "--root", emptyRoot, "health"], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end();
    });
    assert.equal(code, 0, `expected exit 0 on an empty/never-failed store; stderr=${stderr}`);
    assert.match(stdout, /no failures recorded/i, `expected the empty-state message; stdout=${stdout}`);
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  });

  it("empty-state --json returns a zeroed HookHealthState, exit 0", async () => {
    const emptyRoot = path.join(os.tmpdir(), "ar-continuity-empty-health-json-" + Date.now());
    fs.mkdirSync(emptyRoot, { recursive: true });
    const { code, stdout, stderr } = await new Promise((resolve) => {
      const child = spawn("node", [CLI, "--root", emptyRoot, "health", "--json"], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end();
    });
    assert.equal(code, 0, `expected exit 0; stderr=${stderr}`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.last_failure, null);
    assert.equal(parsed.failures_24h, 0);
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  });

  it("renders a populated failure state (non-empty)", async () => {
    const populatedRoot = path.join(os.tmpdir(), "ar-continuity-populated-health-" + Date.now());
    fs.mkdirSync(populatedRoot, { recursive: true });
    fs.writeFileSync(
      path.join(populatedRoot, "hook-health.json"),
      JSON.stringify({
        last_failure: { ts: new Date().toISOString(), hook: "consolidate-async", message: "queue drain failed" },
        failures_24h: 5,
      }),
      "utf-8",
    );
    const { code, stdout, stderr } = await new Promise((resolve) => {
      const child = spawn("node", [CLI, "--root", populatedRoot, "health"], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end();
    });
    assert.equal(code, 0);
    assert.match(stdout, /5 failure\(s\) in the last 24h/);
    assert.match(stdout, /consolidate-async/);
    fs.rmSync(populatedRoot, { recursive: true, force: true });
  });
});
