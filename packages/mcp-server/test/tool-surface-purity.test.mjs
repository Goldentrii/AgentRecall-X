/**
 * Tool-surface purity regression guard — purity-census-2026-07-05
 *
 * Purpose: Catch surface creep before it ships. Any change to the tool listing
 * must update the EXPECTED_* sets below and survive code review.
 *
 * Invariants (a) default listing is exactly the alive set
 *            (b) --full WITHOUT AR_EXTRAS contains exactly check_action
 *            (c) AR_EXTRAS=1 --full restores exactly the quarantined set
 *
 * P3b owner-approved deletion (2026-07-05, all seven items checkmarked):
 *   Removed from --full surface: skill_write, skill_recall, skill_list,
 *   dashboard_export, session_end_reflect, project_board, project_status,
 *   bootstrap_scan, bootstrap_import, memory_query, brief (11 MCP tools).
 *   New matrix: default 5 / full 6 (core 5 + check_action) / extras 6+7=13.
 *   CLI bootstrap, ar status, ar consolidate, palace/skills logic untouched.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(__dirname, "..", "dist", "index.js");

// ── Canonical sets — update here when the surface intentionally changes ───────

/** The 5 default tools — the only surface most agents ever see. */
const EXPECTED_DEFAULT = new Set([
  "session_start",
  "session_end",
  "remember",
  "recall",
  "check",
]);

/**
 * The --full surface WITHOUT AR_EXTRAS=1.
 * 5 core + 1 active extended = 6 total.
 * All formerly-full tools (skill_*, dashboard_export, session_end_reflect,
 * project_board, project_status, bootstrap_scan, bootstrap_import, memory_query,
 * brief) were deleted 2026-07-05 (P3b purity, owner-approved).
 * Quarantined tools (pipeline_*, register_rule, digest) must NOT appear here.
 */
const EXPECTED_FULL_NO_EXTRAS = new Set([
  "session_start",
  "session_end",
  "remember",
  "recall",
  "check",
  "check_action",
]);

/**
 * Tools that are quarantined behind AR_EXTRAS=1.
 * These must NOT appear in default or --full-without-extras, and MUST appear
 * when AR_EXTRAS=1 is set alongside --full.
 */
const QUARANTINED_EXTRAS = new Set([
  "pipeline_open",
  "pipeline_close",
  "pipeline_list",
  "pipeline_current",
  "pipeline_show",
  "register_rule",
  "digest",
]);

/** Full set with AR_EXTRAS=1 = EXPECTED_FULL_NO_EXTRAS ∪ QUARANTINED_EXTRAS */
const EXPECTED_FULL_WITH_EXTRAS = new Set([
  ...EXPECTED_FULL_NO_EXTRAS,
  ...QUARANTINED_EXTRAS,
]);

// ── Helper ────────────────────────────────────────────────────────────────────

async function listTools(extraArgs = [], env = {}) {
  const { stdout } = await execFileAsync(
    "node",
    [ENTRY, "--list-tools", ...extraArgs],
    { env: { ...process.env, ...env } }
  );
  return JSON.parse(stdout).map((t) => t.name);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Tool-surface purity — purity-census-2026-07-05", () => {
  it("(a) default listing is exactly the 5 alive tools — no extras", async () => {
    const names = await listTools();
    const got = new Set(names);

    assert.equal(
      names.length,
      EXPECTED_DEFAULT.size,
      `Expected ${EXPECTED_DEFAULT.size} default tools, got ${names.length}: ${names.join(", ")}`
    );
    for (const name of EXPECTED_DEFAULT) {
      assert.ok(got.has(name), `Default listing missing expected tool '${name}'`);
    }
    for (const name of got) {
      assert.ok(
        EXPECTED_DEFAULT.has(name),
        `Default listing contains unexpected tool '${name}' — surface creep detected`
      );
    }
  });

  it("(b) --full WITHOUT AR_EXTRAS is exactly 6 tools (5 core + check_action only)", async () => {
    const names = await listTools(["--full"]);
    const got = new Set(names);

    // Quarantined tools must be absent
    for (const name of QUARANTINED_EXTRAS) {
      assert.ok(
        !got.has(name),
        `--full (no AR_EXTRAS) should NOT expose quarantined tool '${name}' — it crept back in`
      );
    }

    // Active tools must all be present
    for (const name of EXPECTED_FULL_NO_EXTRAS) {
      assert.ok(got.has(name), `--full missing expected active tool '${name}'`);
    }

    assert.equal(
      names.length,
      EXPECTED_FULL_NO_EXTRAS.size,
      `Expected ${EXPECTED_FULL_NO_EXTRAS.size} tools in --full (no extras), got ${names.length}: ${names.join(", ")}`
    );
  });

  it("(c) AR_EXTRAS=1 --full restores exactly the quarantined set", async () => {
    const names = await listTools(["--full"], { AR_EXTRAS: "1" });
    const got = new Set(names);

    // All quarantined tools must now appear
    for (const name of QUARANTINED_EXTRAS) {
      assert.ok(
        got.has(name),
        `AR_EXTRAS=1 --full should expose quarantined tool '${name}' but it's absent`
      );
    }

    // Full expected set must match exactly
    assert.equal(
      names.length,
      EXPECTED_FULL_WITH_EXTRAS.size,
      `Expected ${EXPECTED_FULL_WITH_EXTRAS.size} tools with AR_EXTRAS=1 --full, got ${names.length}: ${names.join(", ")}`
    );
    for (const name of got) {
      assert.ok(
        EXPECTED_FULL_WITH_EXTRAS.has(name),
        `AR_EXTRAS=1 --full contains unexpected tool '${name}'`
      );
    }
  });

  it("AR_EXTRAS=1 without --full does NOT expose quarantined tools (flag requires both)", async () => {
    // AR_EXTRAS alone (no --full) should still return only the 5 default tools
    const names = await listTools([], { AR_EXTRAS: "1" });
    const got = new Set(names);

    assert.equal(
      names.length,
      EXPECTED_DEFAULT.size,
      `AR_EXTRAS without --full should still give 5 default tools, got ${names.length}`
    );
    for (const name of QUARANTINED_EXTRAS) {
      assert.ok(
        !got.has(name),
        `AR_EXTRAS without --full should NOT expose '${name}'`
      );
    }
  });
});
