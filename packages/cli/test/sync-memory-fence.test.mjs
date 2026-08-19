// packages/cli/test/sync-memory-fence.test.mjs
//
// P1 fence-completeness harness (TOW2-388, resume SOP 23bfd5df) — regression
// test for the `ar sync-memory` frontmatter/fence blank-line bug found
// during this pass.
//
// `ar sync-memory` writes retrieved memory (P0 correction rule text, top
// insight titles, a journal Brief excerpt, palace room keywords) directly
// into a file under Claude Code's OWN auto-loaded `memory/` directory — a
// PERSISTED surface every future session in this host silently ingests into
// its system prompt, not a one-shot stdout print. It is therefore fenced as
// one block (see packages/cli/src/index.ts's "sync-memory" case), with the
// YAML frontmatter deliberately kept OUTSIDE the fence (the host's own
// parser reads that header; wrapping it would risk corrupting parsing).
//
// The regression: `syncFrontmatter` (its own string, ending in exactly one
// "\n" after the closing `---`) was concatenated directly against
// `core.fenceMemory(syncLines...)` with NO separator — producing
// `---\n⟦agentrecall:memory⟧...` (frontmatter's closing delimiter butted
// directly against the fence-open marker, no blank line) instead of the
// original, pre-refactor `---\n\n⟦agentrecall:memory⟧...` shape every other
// AgentRecall-authored `.md` file in this directory uses (YAML frontmatter
// documents conventionally require a blank line after the closing `---`).
// Fixed by re-inserting the separator explicitly at the join point rather
// than relying on array-trailing-empty-string join arithmetic.
//
// This test proves BOTH halves of the fix at once:
//   (a) a blank line separates the frontmatter's closing `---` from the
//       fenced body (the regression itself), and
//   (b) genuinely retrieved memory content (a P0 correction's rule text)
//       actually appears INSIDE the fence markers, not just structural
//       scaffolding — i.e. this isn't a vacuous shape check.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "dist", "index.js");

const FENCE_OPEN_PREFIX = "⟦agentrecall:memory⟧";
const FENCE_CLOSE = "⟦/agentrecall:memory⟧";
const RULE_TEXT = "always run the type-checker before committing (sync-memory-fence regression fixture)";

const tmpDirs = [];
function isolatedRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-sync-memory-fence-root-"));
  tmpDirs.push(dir);
  return dir;
}
function isolatedHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-sync-memory-fence-home-"));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Run the CLI against an isolated `root`. Returns { code, stdout, stderr }. */
function runCli(root, args, { env } = {}) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env, ...env };
    // Hermeticity: same precondition as p1-fence-boundary.test.mjs — the
    // C4 A/B experiment must be off so it never forces corrections:[] here.
    delete childEnv.AR_AB_ENABLED;
    delete childEnv.AR_AB_FORCE;
    const child = spawn("node", [CLI, "--root", root, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function writeRawP0Correction(root, project, record) {
  const slug = record.id.replace(/[^a-zA-Z0-9_-]/g, "-");
  const dir = path.join(root, "projects", project, "corrections");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${record.date}-${slug}.json`), JSON.stringify(record, null, 2));
}

describe("ar sync-memory — frontmatter/fence blank-line regression", () => {
  it("writes a blank line between the YAML frontmatter and the fenced body, with real retrieved content inside the fence", async () => {
    const root = isolatedRoot();
    const home = isolatedHome();
    const project = "sync-memory-fence-test";

    writeRawP0Correction(root, project, {
      id: "2026-08-19-sync-memory-fence",
      date: "2026-08-19",
      severity: "p0",
      project,
      rule: RULE_TEXT,
      tags: [],
      active: true,
      proof_count: 1,
      proof_confidence: 1.0,
    });

    // Pre-create the memDir sync-memory writes to on the PRIMARY path
    // (packages/cli/src/index.ts hardcodes this under os.homedir(), which
    // resolves to isolated `home` because HOME is overridden below — never
    // the real machine's ~/.claude). Without this the command silently
    // falls back to <root>/projects/<slug>/SYNC.md instead.
    const memDir = path.join(home, ".claude", "projects", `-Users-${os.userInfo().username}`, "memory");
    fs.mkdirSync(memDir, { recursive: true });

    const { code, stdout, stderr } = await runCli(root, ["--project", project, "sync-memory"], { env: { HOME: home } });
    assert.equal(code, 0, `expected clean exit, stderr=${stderr}`);

    const syncPath = path.join(memDir, `ar_sync_${project.toLowerCase()}.md`);
    assert.ok(fs.existsSync(syncPath), `expected sync-memory to write ${syncPath}; stdout=${stdout}`);
    const content = fs.readFileSync(syncPath, "utf-8");

    // (a) THE REGRESSION ITSELF — a blank line must separate the
    // frontmatter's closing `---` from the fence-open marker. Locate the
    // frontmatter's known closing sequence and inspect exactly what follows
    // it: the FIXED shape has an extra "\n" (a blank line) before the fence
    // marker; the BUGGY shape has the marker immediately after the single
    // newline `join()` already produces, with no separating blank line.
    const frontmatterTail = "type: reference\n---\n";
    const tailIdx = content.indexOf(frontmatterTail);
    assert.ok(tailIdx >= 0, `expected frontmatter to end with "${frontmatterTail}"; got: ${content.slice(0, 200)}`);
    const afterFrontmatter = content.slice(tailIdx + frontmatterTail.length);
    assert.ok(
      afterFrontmatter.startsWith(`\n${FENCE_OPEN_PREFIX}`),
      `expected a blank line between the frontmatter and the fenced body (regression: frontmatter's closing "---" directly abutting the fence-open marker with no blank line); got the next 80 chars: ${JSON.stringify(afterFrontmatter.slice(0, 80))}`,
    );

    // (b) NON-VACUITY — the frontmatter fields themselves stay OUTSIDE the
    // fence (structural header, not memory prose)...
    const fenceOpenIdx = content.indexOf(FENCE_OPEN_PREFIX);
    const nameFieldIdx = content.indexOf("name: AgentRecall sync");
    assert.ok(nameFieldIdx >= 0 && nameFieldIdx < fenceOpenIdx, "frontmatter's `name:` field must precede the fence-open marker (stay outside the fence)");

    // ...while genuinely retrieved memory content — this P0 correction's
    // OWN rule text, read back from storage, not echoed from any argument
    // to this call — appears INSIDE the fence markers.
    const ruleIdx = content.indexOf(RULE_TEXT);
    const fenceCloseIdx = content.indexOf(FENCE_CLOSE);
    assert.ok(ruleIdx > fenceOpenIdx, "the correction's rule text must appear AFTER the fence-open marker");
    assert.ok(ruleIdx < fenceCloseIdx, "the correction's rule text must appear BEFORE the fence-close marker");
  });
});
