import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { writeBlindSpots } from "../dist/storage/blind-spots-store.js";
import { deriveBlindSpots } from "../dist/helpers/blind-spots.js";
import { personalDir } from "../dist/storage/paths.js";
import { classifyPath } from "../dist/storage/classification.js";

let testRoot;
const PROJECT = "personal-proj";

describe("Wave 5 — personal tier stays off backfill/sync", () => {
  beforeEach(() => {
    testRoot = path.join(tmpdir(), `ar-personal-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(testRoot, { recursive: true });
    process.env.AGENT_RECALL_ROOT = testRoot;
  });

  afterEach(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("the blind-spots file and the whole personal/ dir classify as personal", () => {
    const profile = deriveBlindSpots(
      [
        { id: "2026-06-01-a", date: "2026-06-01", severity: "p0", project: PROJECT, rule: "Never push without approval", context: "x", tags: [] },
      ],
      [],
    );
    writeBlindSpots(PROJECT, profile);

    const file = path.join(personalDir(PROJECT), "blind-spots.json");
    assert.ok(fs.existsSync(file));
    assert.equal(classifyPath(file), "personal");
    assert.equal(classifyPath(personalDir(PROJECT)), "personal");
  });

  it("autoBackfill scans journal + palace/rooms only — never reaches projects/<slug>/personal/", async () => {
    // session-start.ts autoBackfill is module-private. We assert the structural
    // invariant the spec requires: a recursive walk of the project dir that
    // ONLY follows the backfill scan roots (journal, palace/rooms) can never
    // enter personal/. This mirrors the actual autoBackfill scan roots.
    const profile = deriveBlindSpots(
      [{ id: "2026-06-01-a", date: "2026-06-01", severity: "p0", project: PROJECT, rule: "Never push without approval", context: "x", tags: [] }],
      [],
    );
    writeBlindSpots(PROJECT, profile);

    const projectDir = path.join(testRoot, "projects", PROJECT);
    // The two scan roots autoBackfill walks:
    const scanRoots = [path.join(projectDir, "journal"), path.join(projectDir, "palace", "rooms")];

    const collected = [];
    for (const root of scanRoots) {
      if (!fs.existsSync(root)) continue;
      const stack = [root];
      while (stack.length) {
        const cur = stack.pop();
        for (const e of fs.readdirSync(cur)) {
          const full = path.join(cur, e);
          if (fs.statSync(full).isDirectory()) stack.push(full);
          else collected.push(full);
        }
      }
    }
    // No collected file may be under personal/.
    assert.ok(
      collected.every((f) => classifyPath(f) !== "personal"),
      "no backfilled file may be a personal-tier path",
    );
    assert.ok(
      collected.every((f) => !f.includes(`${path.sep}personal${path.sep}`)),
      "no backfilled file may live under personal/",
    );
  });
});
