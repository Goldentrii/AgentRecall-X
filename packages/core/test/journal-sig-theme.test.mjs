import { test } from "node:test";
import assert from "node:assert/strict";

const { autoClassifySig, autoClassifyTheme } = await import("../dist/index.js");

test("autoClassifySig: shipped", () => {
  assert.equal(autoClassifySig("Published to npm. v3.4.1 shipped."), "shipped");
});

test("autoClassifySig: blocked", () => {
  assert.equal(autoClassifySig("Blockers: SERP endpoint 404."), "blocked");
});

test("autoClassifySig: milestone", () => {
  assert.equal(autoClassifySig("Feature complete. v3.4.1 shipped."), "milestone");
});

test("autoClassifySig: recovery", () => {
  assert.equal(autoClassifySig("Resolved the sync issue. Unblocked after fixing the import path."), "recovery");
});

test("autoClassifySig: default minor", () => {
  assert.equal(autoClassifySig("Did some work today."), "minor");
});

test("autoClassifyTheme: silent-failure", () => {
  assert.equal(autoClassifyTheme("The agent had been failing silently for 4 nights."), "silent-failure");
});

test("autoClassifyTheme: version-bump", () => {
  assert.equal(autoClassifyTheme("Bumped to v3.4.1 and published."), "version-bump");
});

test("autoClassifyTheme: agent-fix", () => {
  assert.equal(autoClassifyTheme("Updated dream-prompt to include rollup step."), "agent-fix");
});

test("autoClassifyTheme: default none", () => {
  assert.equal(autoClassifyTheme("Routine session today."), "none");
});

test("autoClassifySig: critical", () => {
  assert.equal(autoClassifySig("A critical bug was found causing data loss."), "critical");
});

test("autoClassifySig: audit", () => {
  assert.equal(autoClassifySig("Loop 1 complete. Scored 7/10 on quality."), "audit");
});

test("autoClassifySig: decision", () => {
  assert.equal(autoClassifySig("Decisions: chose pgvector over keyword search."), "decision");
});

test("autoClassifySig: research", () => {
  assert.equal(autoClassifySig("Research phase: gathered information on competitors."), "research");
});

test("autoClassifyTheme: cross-project (3+ project names)", () => {
  // Uses agentrecall, novada-web, aam — avoids "mcp" which triggers mcp-unavailable first
  assert.equal(
    autoClassifyTheme("agentrecall and novada-web and aam all affected by this change."),
    "cross-project"
  );
});

// ---------------------------------------------------------------------------
// mcp-unavailable epidemic (TOW2 audit 2026-07-27): the project name
// "novada-mcp" alone was enough to trigger this theme. These fixtures pin
// the condition (agent's own tool access was actually unavailable) vs the
// vocabulary (the string "mcp" appears anywhere, e.g. as a project name).
// ---------------------------------------------------------------------------

test("autoClassifyTheme: mcp-unavailable — genuine positive (tool + unavailability signal)", () => {
  assert.equal(
    autoClassifyTheme("MCP server was unavailable, fell back to claude -p --bare for the rest of the run."),
    "mcp-unavailable"
  );
});

test("autoClassifyTheme: mcp-unavailable — genuine positive (headless fallback)", () => {
  assert.equal(
    autoClassifyTheme("Tool unavailable after the crash; ran the rest of the session headless."),
    "mcp-unavailable"
  );
});

test("autoClassifyTheme: mcp-unavailable — false positive guard (bare project-name mention)", () => {
  assert.equal(
    autoClassifyTheme("Shipped 15-tool scraper factory in novada-mcp, 23→38 tools via a config-driven factory."),
    "none"
  );
});

test("autoClassifyTheme: mcp-unavailable — false positive guard (real corpus: competitor teardown)", () => {
  // Real excerpt (novada-mcp journal, 2026-07-18): "MCP" and "broken" both
  // appear, but "broken" describes a competitor's Dockerfile, not this
  // session's own tool access.
  assert.equal(
    autoClassifyTheme(
      "Full source-level teardown of Bright Data MCP (74 tools, per-source, doc drift, broken Dockerfile) and Firecrawl MCP."
    ),
    "none"
  );
});

// ---------------------------------------------------------------------------
// version-bump shadow epidemic: fixing mcp-unavailable above unmasks every
// summary that merely MENTIONS a version number (e.g. inside a bare project
// reference or a benchmark comparison) into a false version-bump. Require an
// actual bump/ship/release action next to the version string.
// ---------------------------------------------------------------------------

test("autoClassifyTheme: version-bump — genuine positive (existing phrase)", () => {
  assert.equal(autoClassifyTheme("Bumped to v3.4.1 and published."), "version-bump");
});

test("autoClassifyTheme: version-bump — genuine positive (shipped + version)", () => {
  assert.equal(
    autoClassifyTheme("Shipped v0.8.9 npm + hosted (0.8.9-hosted live-verified, 116 vendor exports)."),
    "version-bump"
  );
});

test("autoClassifyTheme: version-bump — false positive guard (bare version reference)", () => {
  // Real excerpt shape (novada-mcp journal, 2026-05-23): comparing benchmark
  // numbers across versions is not a bump event.
  assert.equal(
    autoClassifyTheme("Updated core advantages section with v0.7.8 numbers from the 50-round benchmark."),
    "none"
  );
});

test("autoClassifyTheme: version-bump — false positive guard (mentioning a tested version)", () => {
  assert.equal(autoClassifyTheme("Regression suite passed when tested against v3.4.38."), "none");
});

// ---------------------------------------------------------------------------
// agent-fix shadow epidemic: bare "arsave" fires even when a summary merely
// mentions using the /arsave tool (e.g. a session-close marker), not fixing
// or configuring it.
// ---------------------------------------------------------------------------

test("autoClassifyTheme: agent-fix — genuine positive (existing phrase)", () => {
  assert.equal(autoClassifyTheme("Updated dream-prompt to include rollup step."), "agent-fix");
});

test("autoClassifyTheme: agent-fix — genuine positive (fixed arsave logic)", () => {
  assert.equal(
    autoClassifyTheme("Fixed the arsave same-day dedup logic so multi-session saves no longer collide."),
    "agent-fix"
  );
});

test("autoClassifyTheme: agent-fix — false positive guard (bare arsave mention)", () => {
  // Real excerpt (novada-mcp journal, 2026-07-02): a closing marker that
  // merely names the tool used, not a fix to it.
  assert.equal(
    autoClassifyTheme("Session close — explicit /arsave (2026-07-02 ~00:15). Full day already detailed above."),
    "none"
  );
});

// ---------------------------------------------------------------------------
// critical (sig) offenders: bare "critical" as an adjective/label, and
// substring "broke" matching "broker"/"brokerage", and "broken" describing
// someone else's artifact.
// ---------------------------------------------------------------------------

test("autoClassifySig: critical — existing genuine positive still passes", () => {
  assert.equal(autoClassifySig("A critical bug was found causing data loss."), "critical");
});

test("autoClassifySig: critical — genuine positive (enumerated CJK-mixed count)", () => {
  assert.equal(
    autoClassifySig("Reviewer caught 2 个 critical: mint hex leak and a contrast-ratio failure."),
    "critical"
  );
});

test("autoClassifySig: critical — false positive guard (bare label, not a real incident)", () => {
  assert.equal(
    autoClassifySig("Added extract description CRITICAL format block to the response header."),
    "minor"
  );
});

test("autoClassifySig: critical — false positive guard (broker substring)", () => {
  assert.equal(autoClassifySig("Talked to the insurance broker about the office lease renewal."), "minor");
});

test("autoClassifySig: critical — false positive guard (someone else's broken thing)", () => {
  assert.equal(
    autoClassifySig("Competitor teardown: Bright Data ships a broken Dockerfile in their repo."),
    "minor"
  );
});
