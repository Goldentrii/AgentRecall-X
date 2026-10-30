// packages/core/test/ledger-commands.test.mjs — spec SW-8. The /arsave command
// files must make a degraded (file-fallback) save visible in the ledger and
// end every save with an `ar verify` card row. Grep-style, like
// recall-owner-repro-2026-10-30.test.mjs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FILES = ["commands/arsave.md", "experimental/harness-kit/commands/arsave.md"];

for (const f of FILES) {
  describe(`SW-8 ${f}`, () => {
    const lines = fs.readFileSync(path.join(REPO_ROOT, f), "utf-8").split(/\r?\n/);

    it("a. file-fallback records a ledger.note", () => {
      assert.ok(
        lines.some((l) => l.includes("ar ledger append") && l.includes("--type ledger.note") && l.includes("--via file-fallback")),
      );
    });

    it("b. runs ar verify on the project", () => {
      assert.ok(lines.some((l) => /ar verify (<slug>|\$SLUG|"\$SLUG")/.test(l)));
    });

    it("c. the save card has a Verify row", () => {
      assert.ok(lines.some((l) => l.includes("Verify") && l.includes("ar verify")));
    });

    it("d. no hardcoded store path", () => {
      const bad = lines.filter((l) => l.includes(".agent-recall") && !l.includes("AGENT_RECALL_ROOT"));
      assert.deepEqual(bad, []);
    });
  });
}
