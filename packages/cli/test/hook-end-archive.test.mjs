// packages/cli/test/hook-end-archive.test.mjs
//
// Wave 2 — hook-end rewire. The Stop hook must:
//  - exit 0 on empty/blank stdin without throwing (no crash into the Stop turn)
//  - archive a verbatim raw dump for a session even when no captures exist,
//    given a real transcript_path on stdin (mechanical, judgment-free floor)
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "dist", "index.js");
const TEST_ROOT = path.join(os.tmpdir(), "ar-hookend-test-" + Date.now());

/** Run the CLI with the given args, piping `stdin` in, resolving with {code,stdout,stderr}. */
function runHook(args, stdin) {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, "--root", TEST_ROOT, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
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

describe("hook-end archive (Wave 2)", () => {
  after(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("empty stdin → exit 0, no throw", async () => {
    const { code, stderr } = await runHook(["--project", "hookend-empty", "hook-end"], "");
    assert.equal(code, 0, `expected clean exit, stderr=${stderr}`);
    assert.ok(!/TypeError|ReferenceError|is not a function/.test(stderr), `unexpected crash: ${stderr}`);
  });

  it("blank/whitespace stdin → exit 0, no throw", async () => {
    const { code, stderr } = await runHook(["--project", "hookend-blank", "hook-end"], "   \n  ");
    assert.equal(code, 0, `expected clean exit, stderr=${stderr}`);
    assert.ok(!/TypeError|ReferenceError/.test(stderr), `unexpected crash: ${stderr}`);
  });

  it("a zero-capture session with a transcript_path leaves a verbatim raw file", async () => {
    // Build a fake Claude Code transcript .jsonl.
    const sid = "abcdef01-2345-6789-abcd-ef0123456789";
    const tDir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-transcript-"));
    const transcriptPath = path.join(tDir, sid + ".jsonl");
    const lines = [
      JSON.stringify({ type: "user", cwd: "/tmp/x", message: { content: "Please refactor the parser module" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done — refactored the parser." }] } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n") + "\n");

    const payload = JSON.stringify({ transcript_path: transcriptPath, session_id: sid });
    const { code, stderr } = await runHook(["--project", "hookend-archive", "hook-end"], payload);
    assert.equal(code, 0, `expected clean exit, stderr=${stderr}`);

    const rawDir = path.join(TEST_ROOT, "projects", "hookend-archive", "journal", "archive", "raw");
    assert.ok(fs.existsSync(rawDir), `raw archive dir should exist; stderr=${stderr}`);
    const files = fs.readdirSync(rawDir).filter((f) => f.endsWith(".md"));
    assert.ok(files.length >= 1, "at least one verbatim raw file should be written");
    const body = fs.readFileSync(path.join(rawDir, files[0]), "utf-8");
    assert.ok(body.includes("refactor"), "the raw dump should contain the transcript content");

    fs.rmSync(tDir, { recursive: true, force: true });
  });
});
