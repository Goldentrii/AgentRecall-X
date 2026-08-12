// packages/cli/test/root-resolution-bypass-fix.test.mjs
//
// Task A (2026-08-12, followups wave) — os.homedir()/root-resolution bypass
// class in packages/cli/src/index.ts.
//
// Before this wave, several hook/CLI code paths joined `os.homedir()` +
// ".agent-recall" directly instead of `core.getRoot()`, so `--root <path>`
// (and AGENT_RECALL_ROOT) was silently ignored for those specific
// artifacts — they always read/wrote the REAL user's ~/.agent-recall even
// when the caller explicitly asked for an isolated store. This is exactly
// the failure mode that let test suites leak into the real store (see
// continuity-wave.test.mjs's header comment, itself now partially stale —
// it documents the OLD behavior these fixes correct).
//
// Each test below runs the CLI with BOTH `--root TEST_ROOT` AND a HOME
// pointed at a fresh, empty, isolated directory (a directory the real
// os.homedir()/.agent-recall bug would have targeted instead). Every
// assertion is POSITIVE evidence only ("the artifact landed under
// TEST_ROOT") — this file never inspects the real ~/.agent-recall, so it
// can never accidentally read from or write to it.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "dist", "index.js");

const tmpDirs = [];
function freshRoot(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** An isolated HOME — a fresh dir the (fixed) os.homedir() bypass would have
 * targeted instead of --root, had the fix not landed. */
function isolatedHome() {
  return freshRoot("ar-rootfix-home-");
}

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Run the CLI. Returns { code, stdout, stderr }. */
function runCli(args, { stdin, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args], {
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

describe("root-resolution bypass fix — hook-start", () => {
  it("writes .hook-start-lock under --root, not under the (isolated) real home dir", async () => {
    const root = freshRoot("ar-rootfix-hs-lock-");
    const home = isolatedHome();
    const { code, stderr } = await runCli(["--root", root, "--project", "rootfix-hs", "hook-start"], {
      env: { HOME: home, CLAUDE_SESSION_ID: "rootfix-hs-lock-test" },
    });
    assert.equal(code, 0, `expected clean exit, stderr=${stderr}`);
    assert.ok(fs.existsSync(path.join(root, ".hook-start-lock")), "expected .hook-start-lock under --root");
    assert.ok(!fs.existsSync(path.join(home, ".agent-recall")), "must NOT have created anything under the isolated home");
  });

  it("reads semantic-prefetch.json from --root, not the isolated home", async () => {
    const root = freshRoot("ar-rootfix-hs-prefetch-");
    const home = isolatedHome();
    const project = "rootfix-hs-prefetch";
    const prefetchDir = path.join(root, "projects", project);
    fs.mkdirSync(prefetchDir, { recursive: true });
    fs.writeFileSync(
      path.join(prefetchDir, "semantic-prefetch.json"),
      JSON.stringify({
        generated: new Date().toISOString(),
        results: [{ source: "journal", title: "root-fix prefetch marker TOW2-000" }],
      }),
      "utf-8",
    );

    const { code, stdout, stderr } = await runCli(["--root", root, "--project", project, "hook-start"], {
      env: { HOME: home, CLAUDE_SESSION_ID: "rootfix-hs-prefetch-test" },
    });
    assert.equal(code, 0, `expected clean exit, stderr=${stderr}`);
    assert.match(stdout, /root-fix prefetch marker TOW2-000/, `expected the prefetch line to render; stdout=${stdout}`);
  });
});

describe("root-resolution bypass fix — hook-end", () => {
  it("writes .hook-end-lock and .last-session-summary.txt under --root, reading the Q&A log via getRoot()-resolved journalDir", async () => {
    const root = freshRoot("ar-rootfix-he-");
    const home = isolatedHome();
    const project = "rootfix-he";
    const today = new Date().toISOString().slice(0, 10);

    // Pre-seed the Q&A journal log that hook-end's summary-extraction reads —
    // this only succeeds if `resolvedJournalDir` (core.journalDir(project))
    // actually resolved under --root.
    const journalDir = path.join(root, "projects", project, "journal");
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(
      path.join(journalDir, `${today}-log.md`),
      "**Q:** what changed?\n**A:** Fixed the root-resolution bypass class in the CLI.\n",
      "utf-8",
    );

    const sid = "rootfix-he-sid-1";
    const payload = JSON.stringify({ session_id: sid });
    const { code, stderr } = await runCli(["--root", root, "--project", project, "hook-end"], {
      stdin: payload,
      env: { HOME: home },
    });
    assert.equal(code, 0, `expected clean exit, stderr=${stderr}`);

    assert.ok(fs.existsSync(path.join(root, ".hook-end-lock")), "expected .hook-end-lock under --root");
    const summaryPath = path.join(root, ".last-session-summary.txt");
    assert.ok(fs.existsSync(summaryPath), "expected .last-session-summary.txt under --root");
    assert.match(
      fs.readFileSync(summaryPath, "utf-8"),
      /root-resolution bypass class/,
      "summary must be derived from the --root-resolved Q&A log, not an empty/wrong one",
    );
    assert.ok(!fs.existsSync(path.join(home, ".agent-recall")), "must NOT have created anything under the isolated home");
  });
});

describe("root-resolution bypass fix — hook-correction", () => {
  it("writes .hook-correction-seen under --root when a correction is captured", async () => {
    const root = freshRoot("ar-rootfix-hc-");
    const home = isolatedHome();
    const payload = JSON.stringify({
      prompt: "That's wrong, you always do this.", // proven two-gate capture (see hook-correction-detect.test.mjs)
      session_id: "rootfix-hc-sid-1",
    });
    const { code, stderr } = await runCli(["--root", root, "--project", "rootfix-hc", "hook-correction"], {
      stdin: payload,
      env: { HOME: home },
    });
    assert.equal(code, 0, `expected clean exit, stderr=${stderr}`);
    assert.ok(fs.existsSync(path.join(root, ".hook-correction-seen")), "expected .hook-correction-seen under --root");
    assert.ok(!fs.existsSync(path.join(home, ".agent-recall")), "must NOT have created anything under the isolated home");
  });
});

describe("root-resolution bypass fix — hook-ambient", () => {
  it("writes the .ambient-counter-<sid> rate-limit file under --root", async () => {
    const root = freshRoot("ar-rootfix-ha-");
    const home = isolatedHome();
    const sid = "rootfix-ha-sid-1";
    const payload = JSON.stringify({ prompt: "just a normal prompt about the widget", session_id: sid });
    const { code, stderr } = await runCli(["--root", root, "--project", "rootfix-ha", "hook-ambient"], {
      stdin: payload,
      env: { HOME: home },
    });
    assert.equal(code, 0, `expected clean exit, stderr=${stderr}`);
    const expected = path.join(root, `.ambient-counter-${sid.replace(/[^a-z0-9_-]/gi, "_")}`);
    assert.ok(fs.existsSync(expected), `expected ${expected} under --root`);
    assert.ok(!fs.existsSync(path.join(home, ".agent-recall")), "must NOT have created anything under the isolated home");
  });
});

describe("root-resolution bypass fix — ar stats", () => {
  it("counts corrections/journal entries from --root, not the isolated home", async () => {
    const root = freshRoot("ar-rootfix-stats-");
    const home = isolatedHome();
    const project = "rootfix-stats";

    const corrDir = path.join(root, "projects", project, "corrections");
    fs.mkdirSync(corrDir, { recursive: true });
    fs.writeFileSync(path.join(corrDir, "2026-08-12-marker.json"), "{}", "utf-8");

    const jDir = path.join(root, "projects", project, "journal");
    fs.mkdirSync(jDir, { recursive: true });
    fs.writeFileSync(path.join(jDir, "2026-08-12-marker.md"), "x", "utf-8");

    const { code, stdout, stderr } = await runCli(["--root", root, "--project", project, "stats"], {
      env: { HOME: home },
    });
    assert.equal(code, 0, `expected clean exit, stderr=${stderr}`);
    assert.match(stdout, /1/, `expected the counts (1 correction, 1 journal entry) to appear; stdout=${stdout}`);
    assert.ok(
      !/Corrections:\s*0/.test(stdout) && !/Journal.*:\s*0/i.test(stdout),
      `stats must reflect --root's data, not a zeroed isolated-home read; stdout=${stdout}`,
    );
  });
});

describe("root-resolution bypass fix — ar setup supabase --backfill", () => {
  it("resolves the projects dir and config.json from --root, not ~/.agent-recall under the isolated home", async () => {
    const root = freshRoot("ar-rootfix-backfill-");
    const home = isolatedHome();
    const project = "rootfix-backfill";

    // A real project dir exists under --root (and ONLY under --root) —
    // config.json is deliberately absent, so the correct next message is
    // "Supabase not configured", NOT "No projects found". The old
    // os.homedir()-literal bug would report "No projects found" here, since
    // the isolated home's .agent-recall/projects never existed at all.
    fs.mkdirSync(path.join(root, "projects", project), { recursive: true });

    const { code, stdout, stderr } = await runCli(["--root", root, "setup", "supabase", "--backfill"], {
      env: { HOME: home },
    });
    assert.equal(code, 0, `expected clean exit, stderr=${stderr}`);
    assert.match(
      stdout,
      /Supabase not configured/,
      `expected the config-missing message (proving --root's projects/ dir WAS found) — got: ${stdout}`,
    );
    assert.ok(!/No projects found/.test(stdout), `must not report --root's real project dir as missing; stdout=${stdout}`);
  });
});
