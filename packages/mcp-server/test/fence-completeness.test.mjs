// packages/mcp-server/test/fence-completeness.test.mjs
//
// P1 fence-completeness harness (TOW2-388) — PRIMARY DELIVERABLE.
//
// Three hand-enumeration passes at fencing every surface that emits stored
// memory content to an agent each missed something the next pass (or an
// independent verify pass) found: the journal-resources.ts MCP resource,
// and the entire agent-recall-sdk package. The lesson stated in this
// ticket's brief: "per-site enumeration is structurally instance-prone."
// This file makes "did we miss a surface" answerable by CI, not humans.
//
// ── The enforcement mechanism, and why it's the strongest enforceable form ──
//
// Fully-automatic, no-manifest reachability proof ("prove that NOTHING
// unfenced can reach an agent") is not cleanly statically decidable here:
// this codebase's core package alone has 204 exports, fencing is a content
// judgment call (is this field prose retrieved from storage, or a
// same-turn echo / structural identifier / template diagnostic?) that no
// type-checker or taint-tracker can make without a human/LLM reading the
// field's provenance — exactly the class of decision `content-guard.ts`'s
// own header comments make by hand throughout this codebase (e.g. the
// documented, deliberate decision NOT to scan for `Authorization: Bearer`
// tokens because of false-positive rate).
//
// The STRONGEST enforceable approximation, adopted here: a per-surface
// MANIFEST (fence-manifest.mjs) where every registered MCP tool, MCP
// resource, CLI subcommand (+ best-effort sub-action), and SDK export is
// classified {fenced | allowlisted: reason}. This test asserts:
//   (a) every LIVE-DISCOVERED surface has a manifest entry — a NEW,
//       unclassified surface fails the build. This is the completeness
//       guarantee, and it is what makes the mechanism "CI-enforced" rather
//       than "policy written in a comment somewhere".
//   (b) every "fenced" entry is BACKED by an actual fenceMemory() call
//       (grepped/AST-matched in its source, or in a per-channel TRUSTED
//       WRAPPER — outputFenced/withFenced/fenceString/fenceRoomMeta — whose
//       OWN body is independently verified, once, to call fenceMemory).
//       A manifest entry that CLAIMS "fenced" but whose source doesn't
//       actually call fenceMemory fails the build.
//   (c) every "allowlisted" entry carries a non-empty, substantive reason
//       (>= fence-manifest.mjs's MIN_REASON_LENGTH) — a silent "N" with no
//       justification fails the build.
//
// What this does NOT claim: it cannot prove a FUTURE field added inside an
// EXISTING already-"fenced" surface's result type is itself safe (e.g. a
// new prose field added to SmartRecallResult tomorrow) — that is a content
// judgment, not a structural completeness question, and is explicitly out
// of scope for "did we miss a SURFACE" (a whole tool/resource/command/
// method), which is the actual documented failure mode from all three
// prior passes. The CLI sub-action layer is ALSO a documented, narrower
// approximation (a text-window heuristic, not full AST) — see
// fence-ast.mjs's extractSubActions header comment.
//
// ── Proof of failure (the part that makes this a REAL test, not a tautology) ──
// Section "PROOF OF FAILURE" below injects a temporary unfenced fixture
// surface into EACH channel's discovery path and asserts the completeness
// check goes RED — then the fixture is discarded (never touches the real
// manifest or real source tree). If these tests ever go green while
// leaving the checker passing, the checker itself is broken.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as z from "zod/v4";

import {
  discoverMcpSurface,
  discoverCliSurface,
  discoverSdkSurface,
  readWholeFile,
  CLI_SRC,
  SDK_SRC,
} from "./lib/fence-discovery.mjs";
import { textCallsFence, extractTopLevelFunction } from "./lib/fence-ast.mjs";
import { MANIFEST, entriesForChannel, REPO_ROOT_MARKERS } from "./fence-manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// repo root = packages/mcp-server/test/../../../ = repo root
const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const { MIN_REASON_LENGTH } = REPO_ROOT_MARKERS;

const tmpDirs = [];
function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-p1-fence-completeness-"));
  tmpDirs.push(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────
// The core assertion, used against BOTH the real repo (must pass) and
// synthetic fixtures (must throw) — same function, same rules, either way.
// ─────────────────────────────────────────────────────────────────────────

/**
 * @param {string} channel
 * @param {Iterable<string>} discoveredIds
 * @param {ReturnType<typeof entriesForChannel>} manifestEntries
 * @throws if any discovered id has no manifest entry
 */
function assertNoUnclassifiedSurfaces(channel, discoveredIds, manifestEntries) {
  const known = new Set(manifestEntries.map((e) => e.id));
  const missing = [...discoveredIds].filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new Error(
      `fence-completeness [${channel}]: ${missing.length} surface(s) have NO manifest entry — ` +
      `classify each as {status:"fenced"} or {status:"allowlisted", reason:"..."} in fence-manifest.mjs ` +
      `before this can go green: ${missing.join(", ")}`,
    );
  }
}

/** @throws if a "fenced" entry's source does not actually call fenceMemory (or a trusted wrapper) */
function assertFencedEntriesAreBacked(entries, { resolveText }) {
  const failures = [];
  for (const entry of entries) {
    if (entry.status !== "fenced") continue;
    const text = resolveText(entry);
    if (text === null) {
      failures.push(`${entry.id}: no source text could be resolved (missing file/delegateFile/discovered-text mapping)`);
      continue;
    }
    const trusted = entry.wrapper ? [entry.wrapper] : undefined;
    if (!textCallsFence(text, trusted)) {
      failures.push(`${entry.id}: marked "fenced" but no fenceMemory()${entry.wrapper ? ` or ${entry.wrapper}()` : ""} call found in its source`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`fence-completeness: ${failures.length} entr(y/ies) claim "fenced" but are NOT backed by an actual fenceMemory call:\n  ${failures.join("\n  ")}`);
  }
}

/** @throws if an "allowlisted" entry has no reason, or a reason too short to be substantive */
function assertAllowlistedEntriesHaveReasons(entries) {
  const failures = entries
    .filter((e) => e.status === "allowlisted")
    .filter((e) => !e.reason || e.reason.trim().length < MIN_REASON_LENGTH)
    .map((e) => e.id);
  if (failures.length > 0) {
    throw new Error(`fence-completeness: ${failures.length} "allowlisted" entr(y/ies) have no (or too-short) reason: ${failures.join(", ")}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// WRAPPER SELF-CHECK — the loophole assertFencedEntriesAreBacked's trust in
// outputFenced/withFenced/fenceString/fenceRoomMeta would otherwise open.
// Verified ONCE, here, directly against the wrapper's OWN definition.
// ─────────────────────────────────────────────────────────────────────────

describe("fence-completeness — trusted wrapper self-check", () => {
  it("CLI's outputFenced() itself calls fenceMemory (packages/cli/src/index.ts)", async () => {
    // AST-extracted (not a hand-rolled regex): a brace/paren-counting or
    // `[^)]*`/`[^{]*` regex breaks the moment the signature grows a generic
    // type parameter or an inline object-literal return-type annotation
    // containing its OWN `{` before the real body brace — see this
    // function's proof case just below (withFenced<T>). extractTopLevelFunction
    // finds the FunctionDeclaration node by name regardless of nesting depth
    // or signature shape, so it is immune to that whole bug class.
    const fnText = await extractTopLevelFunction(path.join(REPO_ROOT, "packages/cli/src/index.ts"), "outputFenced");
    assert.ok(fnText, "outputFenced() function definition not found — has it been renamed/removed? Update this self-check.");
    // trustedWrappers=[] : must find a literal fenceMemory() call, not just
    // any occurrence of the wrapper's own name (which would be a tautology).
    assert.ok(textCallsFence(fnText, []), "outputFenced() no longer calls fenceMemory() internally — every CLI entry that TRUSTS this wrapper is now unbacked");
  });

  it("SDK's withFenced/fenceString/fenceRoomMeta each call fenceMemory (packages/sdk/src/agent-recall.ts)", async () => {
    // Same AST-based extraction. withFenced's real signature —
    // `function withFenced<T extends object>(result: T): T & { fencedText: string }`
    // — is exactly the shape that broke a naive `function NAME\([^)]*\)`
    // regex (the generic `<T extends object>` sits between the name and the
    // first `(`); this is a real, previously-RED regression this rewrite
    // fixes, not a hypothetical.
    for (const name of ["withFenced", "fenceString", "fenceRoomMeta"]) {
      const fnText = await extractTopLevelFunction(path.join(REPO_ROOT, "packages/sdk/src/agent-recall.ts"), name);
      assert.ok(fnText, `${name}() function definition not found — has it been renamed/removed? Update this self-check.`);
      assert.ok(textCallsFence(fnText, []), `${name}() no longer calls fenceMemory() internally — every SDK entry that trusts this wrapper is now unbacked`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// REAL REPO — must be fully classified AND fully backed, right now.
// ─────────────────────────────────────────────────────────────────────────

describe("fence-completeness — real repo, MCP tools + resources", () => {
  it("every live-registered MCP tool and resource has a manifest entry, and every fenced one is backed", async () => {
    const { tools, resources } = await discoverMcpSurface();
    const toolEntries = entriesForChannel("mcp_tool");
    const resourceEntries = entriesForChannel("mcp_resource");
    assertNoUnclassifiedSurfaces("mcp_tool", tools, toolEntries);
    assertNoUnclassifiedSurfaces("mcp_resource", resources, resourceEntries);
    assertFencedEntriesAreBacked([...toolEntries, ...resourceEntries], {
      resolveText: (entry) => (entry.file ? readWholeFile(path.join(REPO_ROOT, entry.file)) : null),
    });
    assertAllowlistedEntriesHaveReasons([...toolEntries, ...resourceEntries]);
  });
});

describe("fence-completeness — real repo, CLI subcommands", () => {
  it("every top-level `ar <command>` case and every discovered sub-action has a manifest entry, and every fenced one is backed", async () => {
    const { top, sub } = await discoverCliSurface();
    const topEntries = entriesForChannel("cli_subcommand");
    const subEntries = entriesForChannel("cli_subaction");
    assertNoUnclassifiedSurfaces("cli_subcommand", top.keys(), topEntries);
    assertNoUnclassifiedSurfaces("cli_subaction", sub.keys(), subEntries);

    assertFencedEntriesAreBacked(topEntries, {
      resolveText: (entry) => {
        if (entry.delegateFile) return readWholeFile(path.join(REPO_ROOT, entry.delegateFile));
        if (entry.file) return top.get(entry.id) ?? null;
        return null;
      },
    });
    assertFencedEntriesAreBacked(subEntries, {
      resolveText: (entry) => (entry.file ? sub.get(entry.id) ?? null : null),
    });
    assertAllowlistedEntriesHaveReasons([...topEntries, ...subEntries]);
  });
});

describe("fence-completeness — real repo, SDK exports", () => {
  it("every public AgentRecall method/getter-submethod has a manifest entry, and every fenced one is backed", async () => {
    const surface = await discoverSdkSurface();
    const entries = entriesForChannel("sdk_export");
    assertNoUnclassifiedSurfaces("sdk_export", surface.keys(), entries);
    assertFencedEntriesAreBacked(entries, {
      resolveText: (entry) => surface.get(entry.id)?.text ?? null,
    });
    assertAllowlistedEntriesHaveReasons(entries);
  });
});

describe("fence-completeness — manifest self-consistency", () => {
  it("no duplicate {channel, id} manifest entries", () => {
    const seen = new Set();
    const dupes = [];
    for (const e of MANIFEST) {
      const key = `${e.channel}::${e.id}`;
      if (seen.has(key)) dupes.push(key);
      seen.add(key);
    }
    assert.deepEqual(dupes, [], `duplicate manifest entries: ${dupes.join(", ")}`);
  });

  it("every entry has a valid status and channel", () => {
    const validStatuses = new Set(["fenced", "allowlisted"]);
    const validChannels = new Set(["mcp_tool", "mcp_resource", "cli_subcommand", "cli_subaction", "sdk_export"]);
    for (const e of MANIFEST) {
      assert.ok(validStatuses.has(e.status), `${e.channel}::${e.id} has invalid status "${e.status}"`);
      assert.ok(validChannels.has(e.channel), `entry "${e.id}" has invalid channel "${e.channel}"`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PROOF OF FAILURE — inject an unfenced fixture surface into each channel's
// discovery path and prove the completeness check goes RED. Every fixture
// is a temp file/in-memory server, discarded after the assertion — none of
// this ever touches fence-manifest.mjs or a real source file.
// ─────────────────────────────────────────────────────────────────────────

describe("fence-completeness — PROOF OF FAILURE (fixtures, discarded after use)", () => {
  it("CLI: a new, unclassified `case \"totally_new_command\":` in a fixture source file makes the completeness check throw", async () => {
    const fixtureSrc = `
      async function main(): Promise<void> {
        const command = "x";
        switch (command) {
          case "read": {
            output("ok");
            break;
          }
          case "totally_new_command": {
            // A NEW surface, added by a hypothetical future PR, that emits
            // retrieved memory unfenced and has NO manifest entry.
            const result = await core.someNewMemoryReturningFunction();
            output(result);
            break;
          }
        }
      }
    `;
    const fixturePath = tmpFile("cli-fixture.ts", fixtureSrc);
    const { top } = await discoverCliSurface(fixturePath);
    assert.ok(top.has("totally_new_command"), "sanity: the fixture parser must actually find the injected case");

    assert.throws(
      () => assertNoUnclassifiedSurfaces("cli_subcommand", top.keys(), entriesForChannel("cli_subcommand")),
      /totally_new_command/,
      "RED->fail proof: an unclassified new CLI case MUST fail the completeness assertion",
    );
  });

  it("SDK: a new, unclassified public method in a fixture source file makes the completeness check throw", async () => {
    const fixtureSrc = `
      export class AgentRecall {
        constructor() {}
        async recall(query: string) { return withFenced(await smartRecall({ query })); }
        async totallyNewMemoryReturningMethod(query: string) {
          // A NEW method, added by a hypothetical future PR, that returns
          // retrieved memory unfenced and has NO manifest entry.
          return smartRecall({ query });
        }
      }
    `;
    const fixturePath = tmpFile("sdk-fixture.ts", fixtureSrc);
    const surface = await discoverSdkSurface(fixturePath);
    assert.ok(surface.has("AgentRecall.totallyNewMemoryReturningMethod"), "sanity: the fixture parser must actually find the injected method");

    assert.throws(
      () => assertNoUnclassifiedSurfaces("sdk_export", surface.keys(), entriesForChannel("sdk_export")),
      /totallyNewMemoryReturningMethod/,
      "RED->fail proof: an unclassified new SDK method MUST fail the completeness assertion",
    );
  });

  it("MCP: a new, unclassified tool + resource registered on a fixture server makes the completeness check throw", async () => {
    // A minimal fixture server standing in for "a future PR registered a
    // new tool/resource and forgot to fence + classify it" — driven over
    // the SAME InMemoryTransport + Client pattern this package's own
    // p1-fence-boundary.test.mjs already uses (real MCP protocol calls,
    // not a reimplementation).
    const server = new McpServer({ name: "fence-completeness-fixture", version: "1.0.0" });
    server.registerTool("totally_new_tool", { title: "New Tool", description: "unfenced fixture", inputSchema: {} }, async () => ({
      content: [{ type: "text", text: "unfenced memory content" }],
    }));
    server.registerResource(
      "New Resource",
      "fixture://totally-new-resource",
      { description: "unfenced fixture", mimeType: "text/plain" },
      async (uri) => ({ contents: [{ uri: uri.href, text: "unfenced memory content", mimeType: "text/plain" }] }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "fence-completeness-fixture-client", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const [toolsRes, resourcesRes] = await Promise.all([client.listTools(), client.listResources()]);
      const discoveredTools = toolsRes.tools.map((t) => t.name);
      const discoveredResources = resourcesRes.resources.map((r) => r.uri);
      assert.ok(discoveredTools.includes("totally_new_tool"), "sanity: fixture tool must be discoverable via the real MCP protocol");
      assert.ok(discoveredResources.includes("fixture://totally-new-resource"), "sanity: fixture resource must be discoverable via the real MCP protocol");

      assert.throws(
        () => assertNoUnclassifiedSurfaces("mcp_tool", discoveredTools, entriesForChannel("mcp_tool")),
        /totally_new_tool/,
        "RED->fail proof: an unclassified new MCP tool MUST fail the completeness assertion",
      );
      assert.throws(
        () => assertNoUnclassifiedSurfaces("mcp_resource", discoveredResources, entriesForChannel("mcp_resource")),
        /totally-new-resource/,
        "RED->fail proof: an unclassified new MCP resource MUST fail the completeness assertion",
      );
    } finally {
      await client.close();
    }
  });

  it("a manifest entry falsely claiming \"fenced\" with no fenceMemory call in its source makes the backing-check throw", () => {
    const fakeEntries = [{ channel: "cli_subcommand", id: "fake-unfenced-but-claimed-fenced", status: "fenced", file: "irrelevant.ts" }];
    assert.throws(
      () => assertFencedEntriesAreBacked(fakeEntries, { resolveText: () => "const x = 1; // no fenceMemory call anywhere in this text" }),
      /fake-unfenced-but-claimed-fenced/,
      "RED->fail proof: a fenced claim unbacked by an actual fenceMemory call MUST fail",
    );
  });

  it("an allowlisted entry with no reason (or a too-short one) makes the reason-check throw", () => {
    const fakeEntries = [
      { channel: "cli_subcommand", id: "fake-no-reason", status: "allowlisted" },
      { channel: "cli_subcommand", id: "fake-short-reason", status: "allowlisted", reason: "meh" },
    ];
    assert.throws(
      () => assertAllowlistedEntriesHaveReasons(fakeEntries),
      /fake-no-reason/,
      "RED->fail proof: an allowlisted entry with no reason MUST fail",
    );
  });
});
