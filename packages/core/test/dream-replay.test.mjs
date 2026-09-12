/**
 * fix10 (2026-09-12) — REPLAY: a synthetic thin corpus, the shape that
 * produced 22 zero-output nights, now yields.
 *
 * The corpus below mirrors the real store's density ("2–47 journal files,
 * 3.5–48 KB, mostly lightweight auto-captures"): 6 small journals across two
 * projects and 7 days, one pattern recurring exactly 3× — the ADVERTISED bar.
 * Under the old Step-3 math this pattern scored (3/7)×0.85 = 0.36 and was
 * silently discarded; under dream-admission it promotes the same night.
 *
 * Extraction here is a mechanical literal-phrase scan (the LLM's job in the
 * real pipeline is judgment, not math) — the deterministic pipeline starts
 * at the candidate list, exactly where `ar dream admit` starts.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_ROOT = path.join(os.tmpdir(), "ar-dream-replay-" + Date.now());
const RUN_NIGHT_1 = new Date(2026, 8, 12, 2, 0, 0); // 2 AM — freshest journal is yesterday
const RUN_NIGHT_2 = new Date(2026, 8, 13, 2, 0, 0);

const PATTERNS = [
  { title: "prefer ripgrep over grep for code search", applies_when: ["search", "cli", "ripgrep"] },
  { title: "use jq for structured json parsing", applies_when: ["json", "cli", "jq"] },
  { title: "stale habit only seen last month", applies_when: ["stale"] },
];

// project → date → journal body (thin: a few hundred bytes each)
const CORPUS = {
  nova: {
    "2026-09-09": "## Observations\n- prefer ripgrep over grep for code search\n- misc note\n",
    "2026-09-10": "## Observations\n- prefer ripgrep over grep for code search\n",
    "2026-09-11": "## Observations\n- use jq for structured json parsing\n",
    "2026-08-20": "## Observations\n- stale habit only seen last month\n",
  },
  orion: {
    "2026-09-10": "## Observations\n- use jq for structured json parsing\n",
    "2026-09-11": "## Observations\n- prefer ripgrep over grep for code search\n",
  },
};

/** Mechanical Step-3 stand-in: literal recurrence scan over the corpus. */
function extractCandidates(root) {
  const projectsDir = path.join(root, "projects");
  const candidates = PATTERNS.map((p) => ({ ...p, observations: [] }));
  for (const slug of fs.readdirSync(projectsDir)) {
    const journalDir = path.join(projectsDir, slug, "journal");
    if (!fs.existsSync(journalDir)) continue;
    for (const file of fs.readdirSync(journalDir)) {
      const date = file.slice(0, 10);
      const body = fs.readFileSync(path.join(journalDir, file), "utf-8");
      for (const c of candidates) {
        if (body.includes(c.title)) c.observations.push({ date, project: slug });
      }
    }
  }
  return candidates.filter((c) => c.observations.length > 0);
}

describe("replay: 3x/7d pattern over a synthetic thin corpus", () => {
  let core;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    for (const [slug, days] of Object.entries(CORPUS)) {
      const dir = path.join(TEST_ROOT, "projects", slug, "journal");
      fs.mkdirSync(dir, { recursive: true });
      for (const [date, body] of Object.entries(days)) {
        fs.writeFileSync(path.join(dir, `${date}.md`), body, "utf-8");
      }
    }
    fs.writeFileSync(
      path.join(TEST_ROOT, "awareness-state.json"),
      JSON.stringify({
        identity: "test-user", topInsights: [], compoundInsights: [],
        trajectory: "", blindSpots: [], lastUpdated: new Date().toISOString(),
      }),
      "utf-8",
    );
    core = await import("../dist/index.js");
  });

  after(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("night 1: the 3x pattern PROMOTES — the exact input class the old math discarded for 22 nights", async () => {
    const candidates = extractCandidates(TEST_ROOT);
    assert.equal(candidates.length, 3, "corpus produced 3 candidates");

    const ripgrep = candidates.find((c) => c.title.includes("ripgrep"));
    assert.equal(ripgrep.observations.length, 3, "the pattern recurred exactly 3× in 7 days — the advertised bar");
    // The contrast, pinned: old math on this very input.
    assert.ok((ripgrep.observations.length / 7) * 0.85 < 0.5, "old math: silent discard for this exact input");

    const journalFiles = Object.values(CORPUS).reduce((s, d) => s + Object.keys(d).length, 0);
    const report = await core.runDreamAdmission(candidates, {
      runDate: RUN_NIGHT_1,
      corpus: { journal_files: journalFiles },
    });

    assert.equal(report.candidates_seen, 3);
    assert.equal(report.promoted, 1);
    assert.equal(report.admitted, 1);
    assert.equal(report.rejected, 1);

    const state = core.readAwarenessState();
    assert.ok(
      state.topInsights.some((i) => i.title.includes("ripgrep")),
      "3x/7d pattern is IN AWARENESS after one night",
    );
    const promoted = state.topInsights.find((i) => i.title.includes("ripgrep"));
    assert.equal(promoted.confirmations >= 1, true);

    // Yield record: the night is classifiable and the discard is visible.
    const y = core.readDreamYield("2026-09-12");
    assert.ok(y);
    assert.equal(core.classifyNight(y), "productive");
    const stale = y.decisions.find((d) => d.title.includes("stale habit"));
    assert.equal(stale.outcome, "rejected");
    assert.match(stale.reason, /window/);
  });

  it("night 2: same corpus replayed — idempotent, and the night classifies as already-known, not silent", async () => {
    const report = await core.runDreamAdmission(extractCandidates(TEST_ROOT), {
      runDate: RUN_NIGHT_2,
      corpus: { journal_files: 6 },
    });
    assert.equal(report.promoted, 0, "nothing new to promote");
    assert.equal(report.admitted, 0);

    const index = core.readInsightsIndex();
    const jq = index.insights.find((i) => i.title.includes("jq"));
    assert.equal(jq.confirmed_count, 2, "no inflation from the overlapping window");

    const y = core.readDreamYield("2026-09-13");
    assert.ok(y, "night 2 still writes its yield record");
    const klass = core.classifyNight(y);
    assert.notEqual(klass, "productive");
    assert.ok(
      y.decisions.every((d) => d.reason.length > 0),
      "every zero-yield decision still carries a reason — silence is impossible",
    );
  });
});
