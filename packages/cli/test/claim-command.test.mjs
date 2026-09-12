// packages/cli/test/claim-command.test.mjs
//
// fix5 (2026-09-11) — `ar claim`: the ONE sanctioned path by which a staged
// `_unclaimed/` session enters a real project. Spawns the compiled CLI
// against an isolated --root (same convention as working-memory-wave.test.mjs).
// Covers: --list (fenced output — staged titles are retrieved content),
// claim (move + manifest log), --undo (reversal), invalid target refusal.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "dist", "index.js");
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ar-claim-cmd-test-"));

function runCli(args, { stdin } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, "--root", TEST_ROOT, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
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

function stageCard(sid, title) {
  const dir = path.join(TEST_ROOT, "_unclaimed", sid);
  fs.mkdirSync(dir, { recursive: true });
  const file = `2026-09-11--card--${sid}.md`;
  fs.writeFileSync(path.join(dir, file), `---\nsid: ${sid}\nsource: working-memory-rescue\n---\n# ${title}\n`, "utf-8");
  return file;
}

after(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("ar claim — unclaimed staging CLI surface", () => {
  it("--list renders staged cards INSIDE the memory fence (staged titles are retrieved content)", async () => {
    stageCard("claim-list-sid-1", "CLAIM_LIST_UNIQUE_TITLE");
    const { code, stdout } = await runCli(["claim", "--list"]);
    assert.equal(code, 0);
    assert.ok(stdout.includes("claim-list-sid-1"), stdout);
    const fenceOpen = stdout.indexOf("⟦agentrecall:memory⟧");
    const fenceClose = stdout.indexOf("⟦/agentrecall:memory⟧");
    const titleAt = stdout.indexOf("CLAIM_LIST_UNIQUE_TITLE");
    assert.ok(fenceOpen >= 0 && fenceClose > fenceOpen, "list output must carry the memory fence");
    assert.ok(titleAt > fenceOpen && titleAt < fenceClose, "the staged card title must render INSIDE the fence");
  });

  it("claim moves the card into the target project's journal, logs the manifest, and --undo reverses it", async () => {
    const file = stageCard("claim-move-sid-1", "move me home");

    const claim = await runCli(["claim", "claim-move-sid-1", "--project", "claim-target-project"]);
    assert.equal(claim.code, 0, claim.stdout + claim.stderr);
    const dest = path.join(TEST_ROOT, "projects", "claim-target-project", "journal", file);
    assert.ok(fs.existsSync(dest), "claimed card must land in the real project's journal");
    const log = fs.readFileSync(path.join(TEST_ROOT, "_unclaimed", "_claims.jsonl"), "utf-8");
    assert.ok(log.includes('"claim-move-sid-1"'), "manifest must log the claim");

    const undo = await runCli(["claim", "claim-move-sid-1", "--undo"]);
    assert.equal(undo.code, 0, undo.stdout + undo.stderr);
    assert.ok(!fs.existsSync(dest), "undo must remove the claimed copy");
    assert.ok(fs.existsSync(path.join(TEST_ROOT, "_unclaimed", "claim-move-sid-1", file)), "undo must restore the staged card");
  });

  it("claim into an invalid target slug is refused with a nonzero exit and an actionable message", async () => {
    stageCard("claim-invalid-sid-1", "should stay staged");
    const { code, stdout } = await runCli(["claim", "claim-invalid-sid-1", "--project", "auto"]);
    assert.notEqual(code, 0, "invalid claim target must fail loudly");
    assert.ok(/invalid/i.test(stdout), stdout);
    assert.ok(fs.existsSync(path.join(TEST_ROOT, "_unclaimed", "claim-invalid-sid-1")), "the staged session must be untouched after a refused claim");
  });
});
