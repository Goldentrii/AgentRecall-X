import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import {
  buildRecognition,
  PERSON_LOW_CONFIDENCE_CAVEAT,
} from "../dist/tools-logic/recognition.js";
import { ensurePalaceInitialized } from "../dist/palace/rooms.js";
import { writeIdentity, readIdentity } from "../dist/palace/identity.js";
import { writeSkill } from "../dist/palace/skills.js";
import { writeCorrection } from "../dist/storage/corrections.js";
import { recomputeBlindSpots } from "../dist/storage/blind-spots-store.js";
import { palaceDir, journalDir } from "../dist/storage/paths.js";

let testRoot;

function setRoot() {
  testRoot = path.join(tmpdir(), `ar-recognition-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(testRoot, { recursive: true });
  process.env.AGENT_RECALL_ROOT = testRoot;
}

function clearRoot() {
  delete process.env.AGENT_RECALL_ROOT;
  fs.rmSync(testRoot, { recursive: true, force: true });
}

/** Seed a fully-populated project so every recognition field is non-trivial. */
function seedRichProject(slug) {
  // WHO — identity card with name + intention + source/owner.
  // writeIdentity does not create the palace dir; create it first.
  fs.mkdirSync(palaceDir(slug), { recursive: true });
  writeIdentity(
    slug,
    `---\nproject: ${slug}\ncreated: 2026-01-01T00:00:00.000Z\n---\n\n# ${slug}\n\n` +
      `**Intention:** Ship the recognition assembler for AgentRecall.\n\n` +
      `- Source: /Users/test/Projects/${slug}\n`,
  );

  // CAN_DO — a procedural skill.
  writeSkill(
    slug,
    {
      slug: "deploy-flow",
      name: "Deploy Flow",
      topic: "deploy",
      triggers: ["deploy", "release", "ship"],
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
      source: "manual",
    },
    {
      when: "Deploying to prod",
      preconditions: ["build is green"],
      steps: ["run build", "push"],
      postconditions: ["site is live"],
    },
  );

  // CAN_DO — permission-bearing corrections (also feed PERSON via blind spots).
  writeCorrection(slug, {
    id: "2026-06-01-no-push",
    date: "2026-06-01",
    severity: "p0",
    project: slug,
    rule: "Never push without explicit approval",
    context: "Never push without explicit approval",
    tags: [],
  });
  writeCorrection(slug, {
    id: "2026-06-02-no-deploy",
    date: "2026-06-02",
    severity: "p0",
    project: slug,
    rule: "Never deploy without explicit approval from the human",
    context: "Never deploy without explicit approval from the human",
    tags: [],
  });

  // PERSON — derive + persist the blind-spots profile from those corrections.
  recomputeBlindSpots(slug);

  // PROJECT — a journal entry with a ## Next trajectory.
  const jdir = journalDir(slug);
  fs.mkdirSync(jdir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(
    path.join(jdir, `${today}-recognition-work.md`),
    `# ${today}\n\n## Brief\nBuilt the recognition assembler.\n\n## Next\n- Implement and wire the recognition payload into session_start\n`,
    "utf-8",
  );
}

describe("Loop 4 — buildRecognition", () => {
  beforeEach(setRoot);
  afterEach(clearRoot);

  // (1) DETERMINISM — same input ⇒ byte-identical payload across repeated runs.
  it("is deterministic — repeated runs yield byte-identical JSON", () => {
    seedRichProject("recog-det");
    const runs = [];
    for (let i = 0; i < 5; i++) {
      runs.push(JSON.stringify(buildRecognition("recog-det")));
    }
    for (let i = 1; i < runs.length; i++) {
      assert.equal(runs[i], runs[0], `run ${i} diverged from run 0`);
    }
    // Sanity: the payload is actually populated (determinism of empty is trivial).
    const payload = JSON.parse(runs[0]);
    assert.equal(payload.who.unknown, false);
    assert.ok(payload.can_do.skills.length >= 1, "should surface the deploy-flow skill");
    assert.ok(payload.can_do.permissions.length >= 1, "should surface permission corrections");
    assert.ok(payload.person.tendencies.length >= 1, "should surface blind-spot tendencies");
    assert.ok(payload.project.trajectory, "should surface a trajectory");
  });

  // (2) NO HALLUCINATED IDENTITY — empty/unknown project ⇒ WHO 'unknown', honest-empty person.
  it("never hallucinates identity — empty project yields who.unknown + 'unknown' name", () => {
    // Nothing seeded. Reading a never-written project must be honest.
    const payload = buildRecognition("ghost-project");
    assert.equal(payload.who.name, "unknown");
    assert.equal(payload.who.unknown, true);
    assert.equal(payload.who.role, null);
    assert.equal(payload.who.owner, null);

    // Honest-empty capabilities + person; no fabricated persona.
    assert.deepEqual(payload.can_do.skills, []);
    assert.deepEqual(payload.can_do.permissions, []);
    assert.deepEqual(payload.person.tendencies, []);
    assert.equal(payload.project.status, "empty");
    assert.equal(payload.project.last_journal_date, null);
    // Caveat MUST still be present even with zero tendencies.
    assert.equal(payload.person.caveat, PERSON_LOW_CONFIDENCE_CAVEAT);
  });

  it("parses **Intention:** role cleanly (no leaked bold/colon markers)", () => {
    seedRichProject("recog-role");
    const who = buildRecognition("recog-role").who;
    assert.equal(who.unknown, false);
    assert.equal(who.name, "recog-role");
    assert.ok(who.role, "role should be populated from the Intention line");
    assert.ok(!who.role.startsWith("*"), `role must not start with a bold marker, got: ${who.role}`);
    assert.ok(!who.role.startsWith(":"), "role must not start with a colon");
    assert.match(who.role, /^Ship the recognition assembler/);
    assert.equal(who.owner, "/Users/test/Projects/recog-role");
  });

  it("a template-stub-only identity card is still reported as unknown (no fabrication)", () => {
    const slug = "stub-project";
    // Exactly what palace bootstrap writes: frontmatter + stub heading + stub quote.
    const idPath = path.join(palaceDir(slug), "identity.md");
    fs.mkdirSync(path.dirname(idPath), { recursive: true });
    fs.writeFileSync(
      idPath,
      `---\nproject: \ncreated: 2026-01-01T00:00:00.000Z\n---\n\n# \n\n> _(fill in: 1-line purpose, primary language, key constraint)_\n`,
      "utf-8",
    );
    const payload = buildRecognition(slug);
    assert.equal(payload.who.unknown, true);
    assert.equal(payload.who.name, "unknown");
    assert.equal(payload.who.role, null);
  });

  // (L5 CARRY-IN) The REAL bootstrap output — `ensurePalaceInitialized` writes a
  // `# <slug>` heading + a `> _(fill in...)_` stub body. The slug heading is NOT
  // a real identity (it is the project label, auto-filled, not a human-authored
  // name), so WHO must be `unknown`. Loop 4's test used `# \n` (empty heading),
  // an APPROXIMATION that masked this bug — `# <slug>` parses as a real name and
  // wrongly returns unknown:false. This test exercises the ACTUAL bootstrap.
  it("a freshly-bootstrapped identity card (real ensurePalaceInitialized output) is unknown", () => {
    const slug = "bootstrap-project";
    ensurePalaceInitialized(slug);

    // Prove we are testing the REAL bootstrap artifact: `# <slug>` heading + the
    // fill-in stub, NOT an approximation. (Fail loud if bootstrap ever changes.)
    const card = readIdentity(slug);
    assert.match(card, new RegExp(`^#\\s+${slug}\\s*$`, "m"), "bootstrap writes a `# <slug>` heading");
    assert.match(card, /_\(fill in/, "bootstrap writes the fill-in stub body");

    const payload = buildRecognition(slug);
    assert.equal(payload.who.unknown, true, "slug-only heading + fill-in stub must be unknown");
    assert.equal(payload.who.name, "unknown");
    assert.equal(payload.who.role, null);
    assert.equal(payload.who.owner, null);
  });

  // The flip-side guard: a slug heading WITH real authored body (intention/owner)
  // is a known identity — the fix must not over-correct and erase real cards.
  it("a slug heading WITH real authored intention is known (no over-correction)", () => {
    const slug = "filled-project";
    ensurePalaceInitialized(slug);
    // Human fills in the card: keeps the `# <slug>` heading, adds a real intention.
    writeIdentity(
      slug,
      `---\nproject: ${slug}\ncreated: 2026-01-01T00:00:00.000Z\n---\n\n# ${slug}\n\n` +
        `**Intention:** Build the local semantic matcher.\n\n- Source: /Users/test/Projects/${slug}\n`,
    );
    const who = buildRecognition(slug).who;
    assert.equal(who.unknown, false, "a real authored body makes the card known");
    assert.equal(who.name, slug);
    assert.match(who.role, /^Build the local semantic matcher/);
  });

  // (3) NO NETWORK on the hot path — stub global fetch and assert it is never called.
  it("makes no network call — global fetch is never invoked", () => {
    seedRichProject("recog-net");

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (...args) => {
      fetchCalls++;
      throw new Error(`buildRecognition attempted a network fetch: ${JSON.stringify(args[0])}`);
    };
    try {
      const payload = buildRecognition("recog-net");
      assert.equal(fetchCalls, 0, "buildRecognition must not call fetch");
      // Still produced a real payload from local stores.
      assert.equal(payload.who.unknown, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("recognition.ts source references no Supabase / fetch / OpenAI in its call surface", () => {
    // Static guard: the assembler module itself imports no network client.
    const src = fs.readFileSync(
      new URL("../src/tools-logic/recognition.ts", import.meta.url),
      "utf-8",
    );
    // Strip comments so prose mentions ("no Supabase, no LLM") don't trip the grep.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\/\/.*$/gm, "");
    assert.ok(!/supabase/i.test(code), "no supabase reference in recognition.ts code");
    assert.ok(!/\bfetch\s*\(/i.test(code), "no fetch() call in recognition.ts code");
    assert.ok(!/openai/i.test(code), "no openai reference in recognition.ts code");
    assert.ok(!/from\s+["'].*\/sync\.js["']/.test(code), "no sync (backfill) import in recognition.ts");
  });

  // (4) PERSON profile carries the explicit low-confidence caveat.
  it("person profile always carries the low-confidence caveat", () => {
    seedRichProject("recog-caveat");
    const payload = buildRecognition("recog-caveat");
    assert.ok(payload.person.tendencies.length >= 1, "expected at least one tendency from seeded P0s");
    assert.equal(payload.person.caveat, PERSON_LOW_CONFIDENCE_CAVEAT);
    assert.match(payload.person.caveat, /low-confidence/i);
    assert.match(payload.person.caveat, /0\/13/, "caveat must cite the Loop 3 measured 0/13 result");
    assert.match(payload.person.caveat, /not validated/i);
  });

  it("permissions are deterministically ordered P0-before-P1 then by id", () => {
    seedRichProject("recog-order");
    const { permissions } = buildRecognition("recog-order").can_do;
    for (let i = 1; i < permissions.length; i++) {
      const prev = permissions[i - 1];
      const cur = permissions[i];
      const rank = (s) => (s === "p0" ? 0 : 1);
      assert.ok(
        rank(prev.severity) < rank(cur.severity) ||
          (prev.severity === cur.severity && prev.id <= cur.id),
        `permission order violated at index ${i}`,
      );
    }
  });
});
