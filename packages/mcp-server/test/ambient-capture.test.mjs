/**
 * ambient-capture.test.mjs — C-1 (Train C, 2026-08-12 wave).
 *
 * Drives the COMPILED MCP server (dist/index.js) over real stdio JSON-RPC
 * (Client + StdioClientTransport, matching this package's existing
 * lifecycle-canonical-drift.test.mjs / project-board-text.test.mjs
 * convention) against an isolated AGENT_RECALL_ROOT, so these tests exercise
 * the ACTUAL wrapped `server.registerTool` — not a reimplementation of the
 * wrapper's logic.
 *
 * IMPORTANT interaction with C-3: closing the client connection triggers
 * this SAME server's graceful-exit handler (`installLifecycleExitHandlers`),
 * which immediately distills the just-appended working-memory line into a
 * session card and DELETES the working-memory file (by design — see
 * lifecycle-exit.test.mjs for that path in isolation). So every test below
 * that wants to assert on the RAW working-memory file inspects it BEFORE
 * calling `client.close()` — inspecting only after close would be asserting
 * against C-3's behavior, not C-1's.
 *
 * Fixture-class axes covered (per the Train C build's fixture-class
 * convention): CJK params, defaults-only call, two concurrent processes,
 * unwritable (WM-subsystem-blocked) root.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(__dirname, "..", "dist", "index.js");

const tmpDirs = [];
function isolatedRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-ambient-capture-test-"));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Connect a fresh MCP server subprocess against `root`, call one tool, run
 * `inspect()` WHILE the connection is still open (before C-3's graceful-exit
 * handler can fire and distill/delete the working-memory file), then close.
 * Returns whatever `inspect()` returns.
 */
async function callToolAndInspect(root, toolName, args, inspect, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: "node",
    args: [ENTRY],
    env: { AGENT_RECALL_ROOT: root, ...extraEnv },
  });
  const client = new Client({ name: "ambient-capture-test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    return await inspect(result);
  } finally {
    await client.close();
  }
}

/** Read the single working-memory JSONL file expected under root, asserting exactly one exists. */
function readSoleWmFile(root) {
  const wmDir = path.join(root, "working-memory");
  const files = fs.existsSync(wmDir) ? fs.readdirSync(wmDir).filter((f) => f.endsWith(".jsonl")) : [];
  assert.equal(files.length, 1, `expected exactly one working-memory file, found: ${files.join(", ")}`);
  const content = fs.readFileSync(path.join(wmDir, files[0]), "utf-8");
  const lines = content.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { file: files[0], lines };
}

describe("C-1 ambient capture — every MCP tool call appends one working-memory gist line", () => {
  it("a recall() call appends exactly one WM line carrying the query", async () => {
    const root = isolatedRoot();
    await callToolAndInspect(root, "recall", { query: "AMBIENT_CAPTURE_UNIQUE_QUERY_TERM" }, (result) => {
      assert.ok(result, "recall returned no result");
      assert.ok(!result.isError, `recall unexpectedly errored: ${JSON.stringify(result)}`);

      const { lines } = readSoleWmFile(root);
      assert.equal(lines.length, 1, "exactly one gist line should have been appended for one tool call");
      assert.ok(lines[0].prompt.startsWith("recall:"), `gist should be prefixed with the tool name: ${lines[0].prompt}`);
      assert.ok(lines[0].prompt.includes("AMBIENT_CAPTURE_UNIQUE_QUERY_TERM"), `gist should carry the query text: ${lines[0].prompt}`);
      assert.ok(typeof lines[0].ts === "string" && !Number.isNaN(Date.parse(lines[0].ts)), "gist line must carry a valid ISO timestamp");
    });
  });

  it("H2: the appended WM line carries this server process's cwd (rescue needs it to guess the real project slug)", async () => {
    const root = isolatedRoot();
    // StdioClientTransport spawns the server WITHOUT overriding `cwd`, so it
    // inherits THIS test process's process.cwd() — the same value the
    // server's own `process.cwd()` will report at capture time. Before the
    // H2 fix, ambient-capture.ts's wmAppend call carried no `cwd` field at
    // all: `guessSlugFromWmLines` (storage/working-memory.ts) can only
    // attribute a rescued session to its real project via each line's `cwd`
    // — without it, EVERY MCP-only-host session (Codex/Cursor/raw MCP, the
    // exact hosts this module exists for) fell back to the literal "auto"
    // slug on rescue, even when the server's cwd unambiguously pointed at a
    // real project directory.
    await callToolAndInspect(root, "recall", { query: "H2_CWD_CAPTURE_TERM" }, (result) => {
      assert.ok(!result.isError);
      const { lines } = readSoleWmFile(root);
      assert.equal(lines.length, 1);
      assert.equal(typeof lines[0].cwd, "string", `expected a cwd string on the captured WM line, got: ${JSON.stringify(lines[0])}`);
      assert.ok(lines[0].cwd.length > 0, "cwd must not be an empty string");
      assert.equal(lines[0].cwd, process.cwd(), "the captured cwd must be THIS server process's own cwd (inherited from the spawning process)");
    });
  });

  it("defaults-only: calling session_start with NO optional args still appends a non-empty gist", async () => {
    const root = isolatedRoot();
    // session_start's inputSchema is entirely optional/defaulted (project
    // defaults to "auto", verbose to false, mode to "full") — this is the
    // "defaults-only" fixture-class axis: zero explicit arguments.
    await callToolAndInspect(root, "session_start", {}, (result) => {
      assert.ok(result, "session_start returned no result");

      const { lines } = readSoleWmFile(root);
      assert.equal(lines.length, 1);
      assert.ok(lines[0].prompt.length > 0, "a defaults-only call must still produce a non-empty gist, never a silent skip");
      assert.ok(lines[0].prompt.startsWith("session_start:"), `gist: ${lines[0].prompt}`);
    });
  });

  it("CJK: a >300-byte CJK content argument is captured, byte-capped, with no U+FFFD replacement character", async () => {
    const root = isolatedRoot();
    // Deliberately long enough (well over the 300-byte WM_PROMPT_BYTE_CAP,
    // since each CJK char is 3 bytes in UTF-8) to force truncation.
    const cjk = "记住这个重要的架构决定".repeat(20);
    await callToolAndInspect(root, "remember", { content: cjk }, (result) => {
      assert.ok(result, "remember returned no result");

      const { lines } = readSoleWmFile(root);
      assert.equal(lines.length, 1);
      assert.ok(lines[0].prompt.startsWith("remember:"), `gist: ${lines[0].prompt}`);
      assert.ok(lines[0].prompt.includes("记住"), "gist should retain the start of the CJK content");
      assert.ok(!lines[0].prompt.includes("�"), "a byte-safe truncation must never emit a U+FFFD replacement character");
      // WM_PROMPT_BYTE_CAP is 300 bytes; the raw gist (tool name + full content)
      // is pre-trimmed to 400 bytes before wmAppend re-caps to 300 — either way
      // the FINAL persisted line must never come close to the untruncated
      // ~660-byte raw content.
      const byteLen = Buffer.byteLength(lines[0].prompt, "utf-8");
      assert.ok(byteLen <= 300, `persisted gist must respect WM_PROMPT_BYTE_CAP (300 bytes), got ${byteLen}`);
    });
  });

  it("two concurrent MCP server processes never cross-talk in working memory", async () => {
    const root = isolatedRoot();

    // Both connections are held open simultaneously (no close until both
    // inspections finish) specifically so NEITHER process's graceful-exit
    // handler can fire and distill/delete its WM file before we read it.
    const transportA = new StdioClientTransport({ command: "node", args: [ENTRY], env: { AGENT_RECALL_ROOT: root } });
    const clientA = new Client({ name: "concurrent-a", version: "1.0.0" }, { capabilities: {} });
    const transportB = new StdioClientTransport({ command: "node", args: [ENTRY], env: { AGENT_RECALL_ROOT: root } });
    const clientB = new Client({ name: "concurrent-b", version: "1.0.0" }, { capabilities: {} });

    try {
      await Promise.all([clientA.connect(transportA), clientB.connect(transportB)]);
      const [resultA, resultB] = await Promise.all([
        clientA.callTool({ name: "recall", arguments: { query: "CONCURRENT_PROCESS_A_TERM" } }),
        clientB.callTool({ name: "recall", arguments: { query: "CONCURRENT_PROCESS_B_TERM" } }),
      ]);
      assert.ok(!resultA.isError && !resultB.isError, "both concurrent calls must succeed independently");

      const wmDir = path.join(root, "working-memory");
      const files = fs.readdirSync(wmDir).filter((f) => f.endsWith(".jsonl"));
      assert.equal(files.length, 2, `two independent processes must produce two independent WM files, found: ${files.join(", ")}`);

      const bodies = files.map((f) => fs.readFileSync(path.join(wmDir, f), "utf-8"));
      const hasA = bodies.some((b) => b.includes("CONCURRENT_PROCESS_A_TERM"));
      const hasB = bodies.some((b) => b.includes("CONCURRENT_PROCESS_B_TERM"));
      assert.ok(hasA && hasB, "each term must appear in some file");
      // No single file may contain BOTH terms — that would mean cross-talk
      // between two different processes' SESSION_IDs.
      for (const b of bodies) {
        assert.ok(
          !(b.includes("CONCURRENT_PROCESS_A_TERM") && b.includes("CONCURRENT_PROCESS_B_TERM")),
          "a single WM file must never contain gists from two different processes",
        );
      }
    } finally {
      await clientA.close();
      await clientB.close();
    }
  });

  it("unwritable working-memory subsystem: the real tool call still succeeds; capture fails silently", async () => {
    const root = isolatedRoot();
    // Block ONLY the working-memory subsystem (not the whole root) by
    // pre-occupying `<root>/working-memory` with a plain FILE — ensureDir's
    // existsSync check sees "already exists" and skips mkdir, but the
    // subsequent fs.appendFileSync inside wmAppend then fails with ENOTDIR
    // (can't use a file as a directory). This isolates the fault to WM
    // capture specifically, so a passing tool response here proves the
    // wrapper — not the rest of the server — absorbed the failure.
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "working-memory"), "not a directory", "utf-8");

    await callToolAndInspect(root, "recall", { query: "UNWRITABLE_ROOT_QUERY" }, (result) => {
      assert.ok(result, "recall must still return a result even when ambient capture cannot write");
      assert.ok(!result.isError, `recall must not surface the ambient-capture failure as a tool error: ${JSON.stringify(result)}`);
      assert.ok(Array.isArray(result.content) && result.content.length > 0, "recall's real response content must be intact");

      // The blocking file must be untouched (capture never got to append).
      const stat = fs.statSync(path.join(root, "working-memory"));
      assert.ok(stat.isFile(), "the blocking file must remain a plain file — capture must not have touched it");
    });
  });
});

describe("C-1 + C-3 pipeline — an ambient-captured gist survives into a session card on graceful close", () => {
  it("a tool call's WM gist is distilled into a session card once the client disconnects gracefully", async () => {
    const root = isolatedRoot();
    const transport = new StdioClientTransport({
      command: "node",
      args: [ENTRY],
      env: { AGENT_RECALL_ROOT: root },
    });
    const client = new Client({ name: "pipeline-test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    const result = await client.callTool({ name: "recall", arguments: { query: "PIPELINE_UNIQUE_TERM_XYZ" } });
    assert.ok(!result.isError);
    await client.close(); // triggers C-3's graceful-exit distillation

    // Give the OS a brief tick for the already-synchronous fs work to settle
    // in the child's process-exit path (defense against any scheduler jitter
    // in CI — the work itself is synchronous fs, not actually async).
    await new Promise((r) => setTimeout(r, 200));

    const wmDir = path.join(root, "working-memory");
    const wmFiles = fs.existsSync(wmDir) ? fs.readdirSync(wmDir) : [];
    assert.equal(wmFiles.length, 0, "the working-memory file must be gone after a graceful close (distilled, not orphaned)");

    const projectsDir = path.join(root, "projects");
    assert.ok(fs.existsSync(projectsDir), "a project dir should exist after distillation");
    let found = false;
    for (const slug of fs.readdirSync(projectsDir)) {
      const journalDir = path.join(projectsDir, slug, "journal");
      if (!fs.existsSync(journalDir)) continue;
      for (const f of fs.readdirSync(journalDir)) {
        if (!f.endsWith(".md")) continue;
        const body = fs.readFileSync(path.join(journalDir, f), "utf-8");
        if (body.includes("PIPELINE_UNIQUE_TERM_XYZ")) found = true;
      }
    }
    assert.ok(found, "the ambient-captured gist must appear in a session card written on graceful close");
  });
});
