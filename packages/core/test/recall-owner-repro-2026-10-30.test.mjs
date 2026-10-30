// packages/core/test/recall-owner-repro-2026-10-30.test.mjs — owner incident
// repro (2026-10-30). An `arsave` journal for project `orbitcard-clone` was
// unfindable via recall("orbitcard", project:"orbitcard-clone"): 0/15 relevant
// hits, every row an unrelated WEAK insight or an empty palace template.
//
// Three independent defects, one test block each:
//
//   BUG 1 — split brain: commands/*.md hardcode `~/.agent-recall`, but the
//   server honors AGENT_RECALL_ROOT. When the MCP call fails and the agent
//   follows the command's file fallback, the save lands in a store the
//   server never reads (owner machine: 55 files diverged since 2026-09-23).
//
//   BUG 2 — recall is not read-only: querying a project with a journal but no
//   palace scaffolds 7 empty rooms on disk, which then rank as recall hits.
//
//   BUG 3 — zero-overlap insights compete: insights sharing no token with the
//   query take result slots at the same RRF score as the real journal hit.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const TEST_ROOT = path.join(os.tmpdir(), "ar-owner-repro-" + Date.now());
const PROJECT = "orbit-probe";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const JOURNAL = `---
date: 2026-10-29
project: ${PROJECT}
saveType: arsave
sig: important
---

## Brief

Registered on orbitcard.cc. Vue 3 + Vite SPA behind a Cloudflare challenge,
~120 /api endpoints, USDT-only deposits, no KYC.

## Next

Read-only crawl, then REA analysis into a PRD and OpenAPI spec.
`;

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(dir, path.join(d.parentPath ?? d.path, d.name)))
    .sort();
}

describe("owner repro 2026-10-30 — orbitcard journal unfindable", () => {
  let core;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core = await import("../dist/index.js");
    core.setRoot(TEST_ROOT);
  });

  after(() => {
    core.resetRoot?.();
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  beforeEach(async () => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    const jdir = path.join(TEST_ROOT, "projects", PROJECT, "journal");
    fs.mkdirSync(jdir, { recursive: true });
    fs.writeFileSync(path.join(jdir, "2026-10-29.md"), JOURNAL);
    // applies_when copied from the owner's real index. Root cause: keyword
    // fragments like "or" / "a" substring-match "orbitcard"
    // ("device or resource busy" scored 5.23 against a zero-overlap query).
    for (const [title, applies_when] of [
      ["OneDrive Files-On-Demand placeholder mv fails with Device or resource busy", ["onedrive", "mv", "device or resource busy", "du"]],
      ["A second independent reviewer with a holistic brief finds different classes of bugs", ["reviewing a design/foundation", "before building on top of a spec"]],
    ]) {
      await core.addIndexedInsight({ title, source: "test-seed", applies_when, severity: "critical", projects: ["onedrive-file-organization"] });
    }
  });

  describe("BUG 1 — commands must honor AGENT_RECALL_ROOT", () => {
    it("no command file hardcodes ~/.agent-recall without an AGENT_RECALL_ROOT fallback", () => {
      const offenders = [];
      for (const rel of ["commands", "experimental/harness-kit/commands"]) {
        const cmdDir = path.join(REPO_ROOT, rel);
        for (const f of fs.readdirSync(cmdDir).filter((n) => n.endsWith(".md"))) {
          fs.readFileSync(path.join(cmdDir, f), "utf8").split("\n").forEach((line, i) => {
            // any store path (~/ or $HOME/ form) must go through the env var
            const hardcoded = line.includes(".agent-recall") && !line.includes("AGENT_RECALL_ROOT");
            // a bash expansion inside a Python string is never expanded
            const pyShellExp = /expanduser\("\$\{/.test(line);
            if (hardcoded || pyShellExp) offenders.push(`${rel}/${f}:${i + 1}`);
          });
        }
      }
      assert.deepEqual(offenders, [], `hardcoded store path (split-brain risk) at:\n  ${offenders.join("\n  ")}`);
    });
  });

  describe("BUG 2 — recall must not write palace scaffolding", () => {
    it("smartRecall on a journal-only project creates no palace files", async () => {
      const palace = path.join(TEST_ROOT, "projects", PROJECT, "palace");
      const before = listFiles(palace);
      await core.smartRecall({ query: "orbitcard", project: PROJECT, limit: 10 });
      const after = listFiles(palace);
      assert.deepEqual(after, before, `recall created files:\n  ${after.filter((f) => !before.includes(f)).join("\n  ")}`);
    });
  });

  describe("BUG 3 — zero-overlap insights must not take result slots", () => {
    it("every returned item shares a query token (or is a semantic hit)", async () => {
      const r = await core.smartRecall({ query: "orbitcard", project: PROJECT, limit: 10 });
      const items = r.results ?? r.items;
      assert.ok(items.some((it) => it.source === "journal"), "the orbitcard journal must be found");
      const noise = items.filter((it) => !it.foundBySemantic &&
        !`${it.title} ${it.excerpt ?? ""}`.toLowerCase().includes("orbitcard"));
      assert.deepEqual(noise.map((it) => `[${it.source}] ${it.title}`), [], "zero-overlap items returned");
    });

    it("short applies_when keywords still match as whole words", () => {
      // only "mv" can match here — no other seeded keyword appears
      const hits = core.recallInsights("how to mv it", 5).map((i) => i.title);
      assert.ok(hits.some((t) => t.startsWith("OneDrive")), `expected the OneDrive insight; got ${JSON.stringify(hits)}`);
    });
  });
});
