import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import * as net from "node:net";
import * as dns from "node:dns";

import {
  buildMirror,
  renderMirror,
  deriveCrossProjectPatterns,
} from "../dist/tools-logic/mirror.js";
import { deriveBlindSpots } from "../dist/helpers/blind-spots.js";

// ── Fixture builders ───────────────────────────────────────────────────────

function correction(id, rule, severity = "p1", extra = {}) {
  return {
    id,
    date: id.slice(0, 10),
    severity,
    project: "mirror-proj",
    rule,
    context: rule,
    tags: [],
    active: true,
    ...extra,
  };
}

function insight(id, title, confirmations = 1, source_project = "_global") {
  return {
    id,
    title,
    evidence: `evidence for ${title}`,
    confirmations,
    lastConfirmed: "2026-06-20T00:00:00.000Z",
    appliesWhen: [],
    source: "test",
    source_project,
  };
}

/** Build injected readers for a project from explicit fixtures (no disk). */
function readersFor({ corrections = [], awarenessState = null, allProjects = [] }) {
  return {
    corrections: () => corrections,
    blindSpots: () => deriveBlindSpots(corrections, []),
    awareness: () => awarenessState,
    allProjectCorrections: () => allProjects,
  };
}

describe("Loop 9 — The Mirror: buildMirror", () => {
  it("empty store ⇒ honest EMPTY mirror, never a fabricated persona", () => {
    const m = buildMirror("empty-proj", {
      corrections: () => [],
      blindSpots: () => null,
      awareness: () => null,
      allProjectCorrections: () => [],
    });
    assert.equal(m.empty, true, "no data ⇒ empty mirror");
    assert.equal(m.observations.length, 0, "no observations on an empty store");
    assert.ok(m.caveat && m.caveat.length > 0, "caveat MUST be present even when empty");
    const rendered = renderMirror(m);
    assert.match(rendered, /don't have enough/i, "empty render is honest about lacking data");
    // The empty mirror must carry ZERO observation lines — no invented persona.
    // (The caveat legitimately contains "who you are"; we assert on observations,
    // which are the only place a fabricated trait could appear.)
    assert.doesNotMatch(rendered, /^- /m, "an empty mirror renders no observation bullets");
  });

  it("NO trait without a backing record — every observation cites ≥1 real id", () => {
    const corrections = [
      correction("2026-06-01-button-inline", "stop making the button full width, it should be inline", "p1"),
      correction("2026-06-02-button-inline", "again you made it full width, i told you it needs to be inline", "p1"),
      correction("2026-06-03-version-bump", "one version bump per release, not per phase", "p1"),
    ];
    const m = buildMirror("mirror-proj", readersFor({ corrections }));
    assert.ok(m.observations.length > 0, "should reflect at least one observation");

    // Collect the universe of REAL ids the mirror is allowed to cite.
    const realIds = new Set(corrections.map((c) => c.id));
    for (const o of m.observations) {
      assert.ok(Array.isArray(o.cites) && o.cites.length > 0, `observation has ≥1 cite: ${o.text}`);
      for (const id of o.cites) {
        assert.ok(realIds.has(id), `cite "${id}" must trace to a real stored correction (line: ${o.text})`);
      }
    }
  });

  it("insight lines cite a real insight id; an id-less insight is dropped (no fabrication)", () => {
    const corrections = [correction("2026-06-01-x", "Never push without approval", "p0")];
    const awarenessState = {
      identity: "tongwu",
      topInsights: [
        insight("insight-real", "Prefers simple over elaborate solutions", 3, "mirror-proj"),
        // id-less insight: must NOT be rendered (nothing real to cite)
        { ...insight("", "FABRICATED — no id", 5, "mirror-proj"), id: "" },
      ],
      compoundInsights: [],
      trajectory: "",
      blindSpots: [],
      lastUpdated: "2026-06-20T00:00:00.000Z",
    };
    const m = buildMirror("mirror-proj", readersFor({ corrections, awarenessState }));
    const insightLines = m.observations.filter((o) => o.kind === "insight");
    assert.equal(insightLines.length, 1, "only the id-backed insight is rendered");
    assert.deepEqual(insightLines[0].cites, ["insight-real"]);
    assert.doesNotMatch(renderMirror(m), /FABRICATED/, "the id-less insight must never appear");
  });

  it("honest fallibility caveat is present and references the Loop 3 0/13 negative", () => {
    const corrections = [correction("2026-06-01-x", "Never push without approval", "p0")];
    const m = buildMirror("mirror-proj", readersFor({ corrections }));
    assert.match(m.caveat, /not.*verified|noticed/i, "caveat frames it as noticed, not verified");
    assert.match(m.caveat, /0\/13|not yet predictive|predictive/i, "caveat carries the Loop 3 negative");
    assert.match(renderMirror(m), /> /, "rendered caveat appears as a blockquote line");
  });

  it("DETERMINISTIC — same store ⇒ identical observations (modulo generated_at)", () => {
    const corrections = [
      correction("2026-06-01-a", "stop making the button full width, it should be inline", "p1"),
      correction("2026-06-02-a", "again you made it full width, it needs to be inline", "p1"),
      correction("2026-06-03-b", "one version bump per release not per phase", "p1"),
      correction("2026-06-04-b", "consolidate fixes into one version bump per release", "p1"),
    ];
    const m1 = buildMirror("mirror-proj", readersFor({ corrections }));
    const m2 = buildMirror("mirror-proj", readersFor({ corrections }));
    const strip = (m) => JSON.stringify({ ...m, generated_at: "X" });
    assert.equal(strip(m1), strip(m2), "mirror output must be deterministic");
    // Ordering invariant: evidence_count is non-increasing.
    for (let i = 1; i < m1.observations.length; i++) {
      assert.ok(
        m1.observations[i - 1].evidence_count >= m1.observations[i].evidence_count,
        "observations ordered by evidence_count desc",
      );
    }
  });

  it("a P0 correction renders as a 'hard line', not a soft preference", () => {
    const corrections = [correction("2026-06-01-x", "Never push without explicit approval", "p0")];
    const m = buildMirror("mirror-proj", readersFor({ corrections }));
    const txt = renderMirror(m);
    assert.match(txt, /hard line|tend to insist/i, "P0 surfaces with hard-line framing");
  });

  it("cross-project mirror (_global) surfaces a pattern spanning ≥2 projects, citing both", () => {
    const allProjects = [
      {
        slug: "proj-a",
        corrections: [correction("2026-06-01-infra", "Never build infrastructure over revenue", "p0", { project: "proj-a" })],
      },
      {
        slug: "proj-b",
        corrections: [correction("2026-06-02-infra", "infrastructure work must serve revenue first", "p1", { project: "proj-b" })],
      },
    ];
    const { patterns, projectCount } = deriveCrossProjectPatterns(allProjects);
    assert.ok(patterns.length >= 1, "should find a cross-project pattern");
    assert.ok(patterns[0].projects.length >= 2, "pattern spans ≥2 projects");
    assert.equal(projectCount, 2);

    const m = buildMirror(undefined, {
      corrections: () => [],
      blindSpots: () => null,
      awareness: () => null,
      allProjectCorrections: () => allProjects,
    });
    assert.equal(m.project, "_global");
    const cp = m.observations.filter((o) => o.kind === "cross_project");
    assert.ok(cp.length >= 1, "global mirror surfaces the cross-project pattern");
    assert.ok(cp[0].cites.length >= 2, "cross-project line cites a correction from each project");
    // every cite is a real id from the fixtures
    const realIds = new Set(allProjects.flatMap((p) => p.corrections.map((c) => c.id)));
    for (const id of cp[0].cites) assert.ok(realIds.has(id), `cite ${id} is real`);
  });

  it("an empty-rule correction is never reflected (nothing real to cite)", () => {
    const corrections = [
      correction("2026-06-01-empty", "", "p1"),
      correction("2026-06-02-real", "Never push without approval", "p0"),
    ];
    const m = buildMirror("mirror-proj", readersFor({ corrections }));
    for (const o of m.observations) {
      assert.ok(!o.cites.includes("2026-06-01-empty"), "the empty-rule correction is never cited");
    }
  });

  it("NO NETWORK — buildMirror does not open any socket / DNS / fetch", () => {
    const calls = [];
    // Spy on the writable prototype methods (the ESM module-namespace bindings
    // for dns.lookup/http.request are read-only, so patch the prototypes and
    // the global fetch instead — any real network use would route through these).
    const origConnect = net.Socket.prototype.connect;
    const origResolverLookup = dns.Resolver?.prototype?.resolve;
    const origFetch = globalThis.fetch;
    net.Socket.prototype.connect = function () {
      calls.push("socket.connect");
      throw new Error("network blocked in test");
    };
    if (dns.Resolver?.prototype) {
      dns.Resolver.prototype.resolve = function () {
        calls.push("dns.resolve");
        throw new Error("network blocked in test");
      };
    }
    globalThis.fetch = function () {
      calls.push("fetch");
      throw new Error("network blocked in test");
    };
    try {
      const corrections = [correction("2026-06-01-x", "Never push without approval", "p0")];
      const m = buildMirror("mirror-proj", readersFor({ corrections }));
      renderMirror(m);
      assert.equal(calls.length, 0, `no network calls expected, saw: ${calls.join(", ")}`);
    } finally {
      net.Socket.prototype.connect = origConnect;
      if (dns.Resolver?.prototype && origResolverLookup) dns.Resolver.prototype.resolve = origResolverLookup;
      globalThis.fetch = origFetch;
    }
  });
});

describe("Loop 9 — The Mirror: disk-backed default readers", () => {
  let testRoot;
  beforeEach(() => {
    testRoot = path.join(tmpdir(), `ar-mirror-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(testRoot, { recursive: true });
    process.env.AGENT_RECALL_ROOT = testRoot;
  });
  afterEach(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("fresh empty root ⇒ honest empty mirror via the real disk readers", () => {
    const m = buildMirror("never-seen-proj");
    assert.equal(m.empty, true);
    assert.equal(m.observations.length, 0);
    assert.ok(m.caveat.length > 0);
  });
});
