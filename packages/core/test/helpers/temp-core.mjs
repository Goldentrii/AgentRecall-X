import { before, after } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export const DIST = new URL("../../dist/index.js", import.meta.url).href;
/** Isolated store root + core (dist) for one test file. */
export function useTempCore(prefix) {
  const ctx = { root: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), core: null };
  before(async () => { process.env.AGENT_RECALL_ROOT = ctx.root; delete process.env.AR_AB_ENABLED; ctx.core = await import(DIST); ctx.core.setRoot(ctx.root); });
  after(() => { ctx.core.resetRoot(); delete process.env.AGENT_RECALL_ROOT; fs.rmSync(ctx.root, { recursive: true, force: true }); });
  return ctx;
}
/** Runs fn with stderr captured → [result, ...count of stderr lines containing each needle]. */
export async function stderrOf(fn, ...needles) {
  const lines = [], orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (c) => { lines.push(String(c)); return true; };
  try { const value = await fn(); return [value, ...needles.map((n) => lines.filter((l) => l.includes(n)).length)]; } finally { process.stderr.write = orig; }
}
