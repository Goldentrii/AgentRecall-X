// packages/cli/test/working-memory-wave.test.mjs
//
// v3.4.42 working-memory wave — CLI wiring: hook-ambient capture, hook-end
// cleanup ("sleep consolidation"), and hook-start orphan rescue.
//
// Convention: spawn the compiled CLI (dist/index.js) against an isolated
// --root TEST_ROOT, matching continuity-wave.test.mjs / hook-ambient-purity
// .test.mjs. HOME is overridden per-spawn (hook-start/hook-end lock files and
// the hook-ambient rate-limit counter live at os.homedir()/.agent-recall/*,
// NOT under --root) so these tests never touch the real ~/.agent-recall
// store and never collide with other test files' lock keys.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "dist", "index.js");
const TEST_ROOT = path.join(os.tmpdir(), "ar-wm-wave-test-" + Date.now());

const tmpDirs = [];
function isolatedHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-wm-wave-home-"));
  tmpDirs.push(dir);
  return dir;
}

/** Run the CLI against TEST_ROOT. Returns { code, stdout, stderr }. */
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

function ambientPayload(prompt, sessionId, cwd) {
  return JSON.stringify({ prompt, session_id: sessionId, cwd });
}

/** Back-date a WM file's mtime by `ms` beyond the orphan-rescue window. */
function backdateOrphan(wmFilePath, extraMs = 60 * 60 * 1000) {
  const past = (Date.now() - (60 * 60 * 1000 + extraMs)) / 1000; // > WM_ORPHAN_WINDOW_MS (1h)
  fs.utimesSync(wmFilePath, past, past);
}

after(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("working-memory wave — hook-ambient capture", () => {
  it("a genuine prompt is appended to working-memory/<sid>.jsonl", async () => {
    const sid = "wm-ambient-sid-1";
    const home = isolatedHome();
    const { code, stderr } = await runCli(
      ["--project", "wm-ambient-test", "hook-ambient"],
      { stdin: ambientPayload("how do I fix the checkout bug in the payment service", sid, "/Users/testuser/Projects/wm-ambient-test"), env: { HOME: home } },
    );
    assert.equal(code, 0, `hook must exit 0, stderr=${stderr}`);

    const wmFile = path.join(TEST_ROOT, "working-memory", `${sid}.jsonl`);
    assert.ok(fs.existsSync(wmFile), `expected a working-memory file for ${sid}; stderr=${stderr}`);
    const lines = fs.readFileSync(wmFile, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.ok(lines[0].prompt.includes("checkout bug"));
    assert.equal(lines[0].cwd, "/Users/testuser/Projects/wm-ambient-test");
  });

  it("a harness-artifact prompt (e.g. <task-notification>) is NOT captured to working memory", async () => {
    const sid = "wm-ambient-harness-sid";
    const home = isolatedHome();
    await runCli(
      ["--project", "wm-ambient-test", "hook-ambient"],
      { stdin: ambientPayload("<task-notification>\n<task-id>abc</task-id>\n</task-notification>", sid), env: { HOME: home } },
    );
    const wmFile = path.join(TEST_ROOT, "working-memory", `${sid}.jsonl`);
    assert.ok(!fs.existsSync(wmFile), "a harness-artifact prompt must never be captured to working memory");
  });
});

describe("working-memory wave — hook-end cleanup (sleep consolidation)", () => {
  it("a successful hook-end deletes the session's working-memory file after writing the card", async () => {
    const sid = "cccccccc-dead-beef-0000-111122223333";
    const slug = "wm-hookend-target";
    const home = isolatedHome();

    // Build up some working memory for this exact sid first (real capture path).
    await runCli(["--project", slug, "hook-ambient"], {
      stdin: ambientPayload("working on the wm hook-end cleanup test", sid, `/Users/testuser/Projects/${slug}`),
      env: { HOME: home },
    });
    const wmFile = path.join(TEST_ROOT, "working-memory", `${sid}.jsonl`);
    assert.ok(fs.existsSync(wmFile), "precondition: working-memory file must exist before hook-end");

    // Pre-create the target project dir so F1's claim-not-generate policy has
    // an existing slug to claim (same setup as continuity-wave.test.mjs).
    fs.mkdirSync(path.join(TEST_ROOT, "projects", slug), { recursive: true });
    const cwd = `/Users/testuser/Projects/${slug}`;
    const lines = [
      JSON.stringify({ type: "user", cwd, message: { content: "please fix the checkout race condition" } }),
      JSON.stringify({ type: "assistant", cwd, message: { content: [{ type: "text", text: "Fixed it — added a lock." }] } }),
    ];
    const tDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-wm-hookend-transcript-"));
    const transcriptPath = path.join(tDir, sid + ".jsonl");
    fs.writeFileSync(transcriptPath, lines.join("\n") + "\n");

    const { code, stderr } = await runCli(["hook-end"], {
      stdin: JSON.stringify({ transcript_path: transcriptPath, session_id: sid }),
      env: { HOME: home },
    });
    assert.equal(code, 0, `expected clean exit, stderr=${stderr}`);

    const cardPath = path.join(TEST_ROOT, "projects", slug, "journal", `${new Date().toISOString().slice(0, 10)}--card--${sid}.md`);
    assert.ok(fs.existsSync(cardPath), `session card should have been written; stderr=${stderr}`);
    assert.ok(!fs.existsSync(wmFile), "working-memory file must be deleted after a successful card write");
    assert.ok(!fs.existsSync(wmFile + ".count"), "working-memory counter sidecar must also be deleted");

    fs.rmSync(tDir, { recursive: true, force: true });
  });
});

describe("working-memory wave — hook-start orphan rescue", () => {
  it("a crashed session (WM file, no hook-end) gets rescued into a card + recency entry on the NEXT hook-start", async () => {
    const sid = "aaaaaaaa-orphan-0000-1111-222233334444";
    const slug = "wm-orphan-target";
    const wmDir = path.join(TEST_ROOT, "working-memory");
    fs.mkdirSync(wmDir, { recursive: true });
    const wmFilePath = path.join(wmDir, `${sid}.jsonl`);
    const wmLines = [
      { ts: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), prompt: "start investigating the WM_ORPHAN_UNIQUE_TERM issue", cwd: `/Users/testuser/Projects/${slug}` },
      { ts: new Date(Date.now() - 2.9 * 60 * 60 * 1000).toISOString(), prompt: "found the root cause, writing the fix now", cwd: `/Users/testuser/Projects/${slug}` },
    ];
    fs.writeFileSync(wmFilePath, wmLines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
    backdateOrphan(wmFilePath);

    const home = isolatedHome();
    const { code, stderr } = await runCli(["--project", "some-other-current-project", "hook-start"], {
      env: { HOME: home, CLAUDE_SESSION_ID: "rescuer-session-1" },
    });
    assert.equal(code, 0, `expected clean exit, stderr=${stderr}`);

    const today = new Date().toISOString().slice(0, 10);
    const cardPath = path.join(TEST_ROOT, "projects", slug, "journal", `${today}--card--${sid}.md`);
    assert.ok(fs.existsSync(cardPath), `expected a rescued session card under the guessed slug; stderr=${stderr}`);
    const cardBody = fs.readFileSync(cardPath, "utf-8");
    assert.ok(cardBody.includes("working-memory-rescue"), "rescued card frontmatter must carry source: working-memory-rescue");
    assert.ok(cardBody.includes("WM_ORPHAN_UNIQUE_TERM"), "rescued card title should come from the first recorded prompt");
    assert.ok(cardBody.includes("found the root cause, writing the fix now"), "rescued card body should include the LAST recorded prompt");

    const recencyPath = path.join(TEST_ROOT, "recent-sessions.jsonl");
    assert.ok(fs.existsSync(recencyPath), "recency index should have a new entry from the rescue");
    const recencyLines = fs.readFileSync(recencyPath, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(recencyLines.some((e) => e.sid === sid && e.slug === slug), "recency entry must exist for the rescued sid under the guessed slug");

    assert.ok(!fs.existsSync(wmFilePath), "the working-memory file must be deleted once rescued");
  });

  it("idempotency: re-running hook-start with the SAME orphaned WM data never produces a second card", async () => {
    const sid = "bbbbbbbb-idempotent-0000-1111-222233334444";
    const slug = "wm-idempotent-target";
    const wmDir = path.join(TEST_ROOT, "working-memory");
    fs.mkdirSync(wmDir, { recursive: true });
    const wmFilePath = path.join(wmDir, `${sid}.jsonl`);
    const wmContent = JSON.stringify({ ts: new Date().toISOString(), prompt: "idempotent rescue test prompt one", cwd: `/Users/testuser/Projects/${slug}` }) + "\n" +
      JSON.stringify({ ts: new Date().toISOString(), prompt: "idempotent rescue test prompt two", cwd: `/Users/testuser/Projects/${slug}` }) + "\n";

    fs.writeFileSync(wmFilePath, wmContent, "utf-8");
    backdateOrphan(wmFilePath);

    const home1 = isolatedHome();
    const first = await runCli(["--project", "irrelevant-current-project", "hook-start"], {
      env: { HOME: home1, CLAUDE_SESSION_ID: "idempotent-rescuer-1" },
    });
    assert.equal(first.code, 0, `first hook-start should exit 0; stderr=${first.stderr}`);

    const today = new Date().toISOString().slice(0, 10);
    const journalDir = path.join(TEST_ROOT, "projects", slug, "journal");
    const cardsAfterFirst = fs.readdirSync(journalDir).filter((f) => f.endsWith(`--card--${sid}.md`));
    assert.equal(cardsAfterFirst.length, 1, "exactly one card should exist after the first rescue");

    // Simulate the WM data reappearing (e.g. a race where wmDelete lost a
    // concurrent write, or a second stray copy) — the idempotency GUARD
    // (card-exists check), not mere absence of the file, must be what
    // prevents a duplicate.
    fs.writeFileSync(wmFilePath, wmContent, "utf-8");
    backdateOrphan(wmFilePath);

    const home2 = isolatedHome();
    const second = await runCli(["--project", "irrelevant-current-project", "hook-start"], {
      env: { HOME: home2, CLAUDE_SESSION_ID: "idempotent-rescuer-2" },
    });
    assert.equal(second.code, 0, `second hook-start should exit 0; stderr=${second.stderr}`);

    const cardsAfterSecond = fs.readdirSync(journalDir).filter((f) => f.endsWith(`--card--${sid}.md`));
    assert.equal(cardsAfterSecond.length, 1, `re-running rescue on the same sid must NOT create a second card, got ${cardsAfterSecond.length}`);

    const recencyLines = fs.readFileSync(path.join(TEST_ROOT, "recent-sessions.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const matches = recencyLines.filter((e) => e.sid === sid);
    assert.equal(matches.length, 1, `re-running rescue must NOT add a second recency entry for the same sid, got ${matches.length}`);

    assert.ok(!fs.existsSync(wmFilePath), "the re-appeared WM file must still be cleaned up by the guard path");
  });

  it("e2e crash-rescue round trip: prompts via hook-ambient → simulated crash → rescue → NEXT hook-start's continuity shows it", async () => {
    const sid = "e2e00000-crash-rescue-0000-111122223333";
    const slug = "wm-e2e-crash-target";
    const home = isolatedHome();

    // Simulate a real session: several prompts, no hook-end ever fires (crash).
    await runCli(["--project", slug, "hook-ambient"], {
      stdin: ambientPayload("investigating the E2E_CRASH_RESCUE_UNIQUE_TERM bug", sid, `/Users/testuser/Projects/${slug}`),
      env: { HOME: home },
    });
    await runCli(["--project", slug, "hook-ambient"], {
      stdin: ambientPayload("found it — the timeout was too short", sid, `/Users/testuser/Projects/${slug}`),
      env: { HOME: home },
    });

    const wmFilePath = path.join(TEST_ROOT, "working-memory", `${sid}.jsonl`);
    assert.ok(fs.existsSync(wmFilePath), "precondition: WM file must exist from the simulated prompts");
    backdateOrphan(wmFilePath); // simulate "it's been over an hour since the crash"

    // First hook-start (a DIFFERENT session) — triggers the rescue.
    const rescueRun = await runCli(["--project", "unrelated-current-project", "hook-start"], {
      env: { HOME: isolatedHome(), CLAUDE_SESSION_ID: "e2e-rescuer-1" },
    });
    assert.equal(rescueRun.code, 0, `rescue hook-start should exit 0; stderr=${rescueRun.stderr}`);
    assert.ok(!fs.existsSync(wmFilePath), "WM file should be gone after the rescue");

    // Second, LATER hook-start (yet another session) — should now see the
    // rescued session in its continuity block via the F2 recency index.
    const nextStart = await runCli(["--project", "another-unrelated-project", "hook-start"], {
      env: { HOME: isolatedHome(), CLAUDE_SESSION_ID: "e2e-rescuer-2" },
    });
    assert.equal(nextStart.code, 0, `follow-up hook-start should exit 0; stderr=${nextStart.stderr}`);
    assert.match(nextStart.stdout, /⏪ Continuity/, `expected a continuity block; stdout=${nextStart.stdout}`);
    assert.ok(
      nextStart.stdout.includes("E2E_CRASH_RESCUE_UNIQUE_TERM") || nextStart.stdout.includes(slug),
      `expected the rescued session to appear in the next session's continuity; stdout=${nextStart.stdout}`,
    );
  });
});
