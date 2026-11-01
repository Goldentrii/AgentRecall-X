import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "index.js");
const dirs = [];
export function tmpDir(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; }
export function cleanupTmp() { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); }
/** Built CLI, isolated HOME, no inherited session ids (a parent Claude Code sets CLAUDE_CODE_SESSION_ID). */
export function runCli(root, args, { stdin, env = {} } = {}) {
  const home = tmpDir("ar-cli-home-"), base = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "SESSION_ID", "AGENT_RECALL_ROOT", "AR_AB_ENABLED"]) delete base[k];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "--root", root, ...args], { env: { ...base, ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}
