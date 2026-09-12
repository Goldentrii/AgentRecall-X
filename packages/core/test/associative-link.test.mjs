import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-associative-link-test-" + Date.now());
const PROJECT = "assoc-proj";

describe("Associative linking", () => {
  let core;
  let associative;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core = await import("../dist/index.js");
    associative = await import("../dist/helpers/associative-link.js");
    core.setRoot(TEST_ROOT);
  });

  beforeEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    core.setRoot(TEST_ROOT);
  });

  after(() => {
    core.resetRoot();
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("linkToSimilar creates bidirectional edges in graph.json when similar content exists", async () => {
    await seedSimilarMemory(core);

    await associative.linkToSimilar(
      PROJECT,
      "Architecture decision: semantic recall links related memory graph entries for retrieval.",
      "architecture/new-semantic-recall"
    );

    const edges = readEdges(core);
    const forward = edges.find((e) =>
      e.from === "architecture/new-semantic-recall" &&
      e.to.startsWith("architecture/") &&
      e.type === "semantic_similar"
    );
    assert.ok(forward, `Expected forward semantic edge, got ${JSON.stringify(edges, null, 2)}`);

    const backward = edges.find((e) =>
      e.from === forward.to &&
      e.to === "architecture/new-semantic-recall" &&
      e.type === "semantic_similar"
    );
    assert.ok(backward, `Expected backward semantic edge, got ${JSON.stringify(edges, null, 2)}`);
  });

  it("review M2 pin (fix4, 2026-09-11): a SINGLE-source, unboosted keyword match does NOT create edges — the gate keeps multi-evidence semantics", async () => {
    // One palace doc, one vote (1/61 ≈ 0.0164), no cross-source sibling, no
    // hot-window date — below the 0.02 multi-evidence gate. The review
    // caught a first-cut threshold (0.015) that sat below the ENTIRE
    // single-source band, silently linking the top-3 of any keyword match
    // on every save.
    await core.palaceWrite({
      room: "architecture",
      topic: "lone-mention",
      project: PROJECT,
      content: "**A:** semantic recall links related memory graph entries",
    });

    await associative.linkToSimilar(
      PROJECT,
      "Architecture decision: semantic recall links related memory graph entries for retrieval.",
      "architecture/new-single-evidence"
    );

    const graphPath = path.join(core.palaceDir(PROJECT), "graph.json");
    const edges = fs.existsSync(graphPath) ? JSON.parse(fs.readFileSync(graphPath, "utf-8")).edges : [];
    const linked = edges.filter((e) => e.from === "architecture/new-single-evidence" && e.type === "semantic_similar");
    assert.equal(
      linked.length,
      0,
      `a lone unboosted single-source match must not auto-link; got ${JSON.stringify(linked)}`,
    );
  });

  it("linkToSimilar does not throw when project has no memories yet", async () => {
    await assert.doesNotReject(() =>
      associative.linkToSimilar(
        "empty-assoc-proj",
        "A standalone architecture decision with no prior memories.",
        "architecture/standalone"
      )
    );
  });

  it("graph edges are bidirectional after one linkToSimilar call", async () => {
    await seedSimilarMemory(core);

    await associative.linkToSimilar(
      PROJECT,
      "Architecture decision: semantic recall links related memory graph entries for retrieval.",
      "architecture/new-memory-graph-link"
    );

    const edges = readEdges(core);
    for (const edge of edges.filter((e) => e.from === "architecture/new-memory-graph-link")) {
      const reverse = edges.find((e) =>
        e.from === edge.to &&
        e.to === edge.from &&
        e.type === edge.type
      );
      assert.ok(reverse, `Missing reverse edge for ${JSON.stringify(edge)}`);
    }
  });
});

// RETARGETED (fix4 S4-completion + review M2, 2026-09-11): the original seed
// wrote THREE similar lines into ONE palace file, and the 0.03 link gate was
// only ever satisfied because the pre-fix4 palace tier summed one RRF
// contribution per matching LINE of the same file (the applyRRF id-collision
// — 1/61 + 1/62 + 1/63 ≈ 0.048). With one-doc-one-vote scoring that fixture
// is SINGLE-evidence (one doc, one vote, 0.0164) and by the gate's original
// multi-evidence semantics must NOT link. The seed now expresses the same
// intent ("genuinely similar content exists") with real multi-evidence: the
// SAME short line seeded through TWO independent sources (palace + journal),
// which cross-source-fuses to ≈0.033 — above the recalibrated 0.02 gate.
// The "**A:** " prefix + short line follow audit-retrieval-accounting.test.mjs
// Case A's own byte-identical-excerpt convention (journalCapture prepends
// "**A:** "; both tiers' excerpt windows must capture the whole line).
async function seedSimilarMemory(core) {
  const LINE = "semantic recall links related memory graph entries";
  await core.journalCapture({
    question: "What links memories?",
    answer: LINE,
    project: PROJECT,
    tags: ["seed"],
  });
  await core.palaceWrite({
    room: "architecture",
    topic: "existing-semantic-recall",
    project: PROJECT,
    content: `**A:** ${LINE}`,
  });
}

function readEdges(core) {
  const graphPath = path.join(core.palaceDir(PROJECT), "graph.json");
  assert.ok(fs.existsSync(graphPath), "Expected graph.json to exist");
  return JSON.parse(fs.readFileSync(graphPath, "utf-8")).edges;
}
