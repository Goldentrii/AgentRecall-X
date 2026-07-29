import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Import from dist — build before running
const { generateSlug, detectContentType, extractKeywords, generateTopicName } = await import("../dist/index.js");

describe("Auto-naming — detectContentType", () => {
  it("detects bug-fix content", () => {
    // Requires ≥2 signals: "bug" + "error" both match bug-fix patterns
    assert.equal(detectContentType("Fixed a bug: the login form threw an error on submit"), "bug-fix");
  });

  it("detects architecture content", () => {
    assert.equal(detectContentType("The system architecture uses a microservices design with REST API"), "architecture");
  });

  it("detects decision content", () => {
    assert.equal(detectContentType("We decided to use PostgreSQL and chose Drizzle as the ORM"), "decision");
  });

  it("detects insight content", () => {
    assert.equal(detectContentType("I realized that the observation about caching patterns applies broadly"), "insight");
  });

  it("detects tool-config content", () => {
    assert.equal(detectContentType("Install the MCP server plugin and configure the setup"), "tool-config");
  });

  it("detects goal content", () => {
    assert.equal(detectContentType("Our goal is to reach the milestone of 100 users by the target date"), "goal");
  });

  it("detects blocker content", () => {
    assert.equal(detectContentType("Blocked on the dependency — stuck waiting for approval"), "blocker");
  });

  it("detects lesson content", () => {
    assert.equal(detectContentType("Lesson learned: never again deploy on Friday. Always remember to test."), "lesson");
  });

  it("returns general for ambiguous content", () => {
    assert.equal(detectContentType("Hello world this is some random text"), "general");
  });
});

describe("Auto-naming — detectContentType matches conditions, not vocabulary (2026-07-29 audit)", () => {
  // Real-corpus audit (185 journal Brief sections across the live store, same
  // grounding method as ace179a's journal-sig-theme fix) measured the OLD
  // bare-word tool-config signals — /\bconfig\b/, /\bsetup\b/, /\binstall\b/,
  // /\bmcp\b/, /\bserver\b/, /\bplugin\b/, /\bconfigure\b/ — at ~87% false
  // positive (13-15/15 real matches), and the OLD bare architecture signals
  // — /\bdesign\b/, /\bapi\b/, /\bschema\b/, /\bstructure\b/ — at ~83%
  // (5/6). Fixtures below are shaped after the real false-positive cases
  // found (paraphrased, not verbatim private content).

  it("tool-config: bare MCP project name is NOT tool-config (bare \\bmcp\\b epidemic)", () => {
    // Real case: "MCP console integration... Decisions from meeting: MCP
    // integrates into novada.com as a product line" — a product/decision
    // update, not the agent installing or configuring a tool.
    assert.notEqual(
      detectContentType("MCP console integration decisions from the meeting: MCP integrates into the product line as a new surface"),
      "tool-config"
    );
  });

  it("tool-config: MCP mentioned only as a build artifact is NOT tool-config", () => {
    // Real case: "Both MCP and SDK compile clean after npm install + npm run
    // build" — a release/build-verification narrative, not tool setup. Only
    // ONE signal (mcp+install co-occurring) should fire here — below the
    // ≥2-signal threshold — same as the real corpus text this mirrors.
    assert.notEqual(
      detectContentType(
        "Published the AAM monorepo (packages/mcp, packages/cli, packages/sdk). Reviewer caught a real SDK/README mismatch. " +
        "Fixed the public exports. Both MCP and SDK compile clean after npm install and npm run build."
      ),
      "tool-config"
    );
  });

  it("tool-config: 'Configure-MCP' as a product feature name is NOT tool-config", () => {
    // Real case: "reclassified BOTH the Configure-MCP console" — a UI
    // feature/product name, not an instruction to configure a tool.
    assert.notEqual(
      detectContentType("Reclassified both the Configure-MCP console and the docs into the new taxonomy the team proposed"),
      "tool-config"
    );
  });

  it("tool-config: bare 'config'/'install'/'setup' with no tool noun is NOT tool-config", () => {
    assert.notEqual(
      detectContentType("Updated the deployment config, ran the install script, and finished the setup for the new environment"),
      "tool-config"
    );
  });

  it("tool-config: genuine install/configure of an MCP server plugin IS tool-config (preserved)", () => {
    assert.equal(detectContentType("Install the MCP server plugin and configure the setup"), "tool-config");
  });

  it("tool-config: genuine plugin setup phrased differently IS tool-config", () => {
    assert.equal(
      detectContentType("Renamed the MCP server's config file, reinstalled the plugin, and restarted it to pick up the new setup"),
      "tool-config"
    );
  });

  it("architecture: bare 'design' in a UI/visual-design pass is NOT architecture", () => {
    // Real case: "ported the founder-approved design pass... visual-review
    // fixes (logos, chips, cursor removal...)" — product/visual design work.
    assert.notEqual(
      detectContentType("Ported the founder-approved design pass with visual-review fixes for the logos, chips, and cursor removal"),
      "architecture"
    );
  });

  it("architecture: bare 'api' in a security/key context is NOT architecture", () => {
    // Real case: "URL-encoded API key redaction bypass" — a security bug,
    // not an API design/architecture discussion.
    assert.notEqual(
      detectContentType("Found a URL-encoded API key redaction bypass and a fatal error handler credential leak during the review"),
      "architecture"
    );
  });

  it("architecture: 'schema bug' (schema + bug-fix context) is NOT architecture", () => {
    // Real case: "Release worker caught+fixed schema bug live (int overflow
    // from MAX_SAFE_INTEGER quota...)" — a bug-fix, not a schema design.
    assert.notEqual(
      detectContentType("The release worker caught and fixed a schema bug live: an int overflow from the quota constant"),
      "architecture"
    );
  });

  it("architecture: genuine architecture design (schema + database) IS architecture (preserved)", () => {
    assert.equal(
      detectContentType("Redesigned the database schema and added new API endpoints as part of the system architecture"),
      "architecture"
    );
  });

  it("architecture: 'PUSH/PULL architecture design' phrasing IS architecture (preserved)", () => {
    assert.equal(detectContentType("Documented the PUSH/PULL architecture design for the new sync pipeline"), "architecture");
  });
});

describe("Auto-naming — extractKeywords", () => {
  it("removes stopwords and returns top N", () => {
    const kws = extractKeywords("The quick brown fox jumps over the lazy dog", 3);
    assert.ok(kws.length <= 3);
    assert.ok(!kws.includes("the"));
    assert.ok(!kws.includes("over"));
  });

  it("gives header words higher weight", () => {
    const content = "# Authentication System\n\nThis module handles login and password reset flows.";
    const kws = extractKeywords(content, 3);
    // "authentication" or "system" should appear since headers get 2x weight
    assert.ok(
      kws.some((k) => k.includes("authentication") || k.includes("system")),
      `Expected header words in ${JSON.stringify(kws)}`
    );
  });

  it("returns empty array for empty content", () => {
    const kws = extractKeywords("", 3);
    assert.equal(kws.length, 0);
  });

  it("respects limit parameter", () => {
    const kws = extractKeywords(
      "React components rendering virtual DOM elements with hooks and state management",
      2
    );
    assert.ok(kws.length <= 2);
  });

  it("deduplicates stems — keeps shorter form", () => {
    const kws = extractKeywords(
      "deploy deployment deploying servers server configuration",
      5
    );
    // Should not have both "deploy" and "deployment"
    const deployVariants = kws.filter((k) => k.startsWith("deploy"));
    assert.ok(deployVariants.length <= 1, `Too many deploy variants: ${JSON.stringify(kws)}`);
  });
});

describe("Auto-naming — generateSlug", () => {
  it("generates type-keyword slug for bug-fix content", () => {
    // Requires ≥2 signals: "bug" + "error" both match bug-fix patterns
    const result = generateSlug("A critical bug caused an error in the payment processor");
    assert.equal(result.contentType, "bug-fix");
    assert.ok(result.slug.startsWith("bug-fix-"), `Slug should start with bug-fix-: ${result.slug}`);
    assert.ok(result.keywords.length > 0);
  });

  it("generates type-keyword slug for architecture content", () => {
    const result = generateSlug("The API design uses a REST architecture with schema validation");
    assert.equal(result.contentType, "architecture");
    assert.ok(result.slug.startsWith("architecture-"), `Slug should start with architecture-: ${result.slug}`);
  });

  it("falls back to general for generic content", () => {
    const result = generateSlug("Hello world testing one two three");
    assert.equal(result.contentType, "general");
  });

  it("ensures uniqueness when existingSlugs provided", () => {
    const content = "Fixed a critical bug in the authentication module";
    const first = generateSlug(content);
    const second = generateSlug(content, { existingSlugs: [first.slug] });
    assert.notEqual(first.slug, second.slug);
    assert.ok(second.slug.endsWith("-2"), `Expected -2 suffix: ${second.slug}`);
  });

  it("truncates to 60 characters", () => {
    const longContent =
      "Architecture decision about the distributed microservices authentication " +
      "authorization system design with comprehensive schema validation and " +
      "extensive error handling throughout the application";
    const result = generateSlug(longContent);
    assert.ok(result.slug.length <= 60, `Slug too long (${result.slug.length}): ${result.slug}`);
  });

  it("respects context type override", () => {
    const result = generateSlug("Some generic content about servers", { type: "blocker" });
    assert.equal(result.contentType, "blocker");
    assert.ok(result.slug.startsWith("blocker-"));
  });
});

describe("Auto-naming — generateTopicName", () => {
  it("returns title-case keywords", () => {
    const name = generateTopicName("The authentication system handles login and password reset");
    const words = name.split(" ");
    assert.ok(words.length <= 4, `Too many words: ${name}`);
    // Each word should be title-case
    for (const w of words) {
      assert.ok(
        w[0] === w[0].toUpperCase(),
        `Word not title-case: ${w} in ${name}`
      );
    }
  });

  it("returns max 4 words", () => {
    const name = generateTopicName(
      "React components rendering virtual DOM elements with hooks state management context providers"
    );
    const words = name.split(" ");
    assert.ok(words.length <= 4, `Too many words (${words.length}): ${name}`);
  });

  it("returns Untitled for empty content", () => {
    const name = generateTopicName("");
    assert.equal(name, "Untitled");
  });
});

// Review follow-up (MEDIUM, 2026-07-29): the 4 architecture negative fixtures
// above each contain only ONE bare signal word and already passed on pre-fix
// code (below the old >=2-signal threshold) — they guard the enum, not the
// coOccurs logic. This fixture is the real pin: THREE bare architecture-
// vocabulary words (api + design + schema) co-occurring, which the OLD
// threshold classified as "architecture"; the new condition logic must not.
import { describe as describe2, it as it2 } from "node:test";
import assert2 from "node:assert/strict";
import { detectContentType as detect2 } from "../dist/helpers/auto-name.js";

describe2("auto-name — architecture coOccurs real pin (fails on pre-fix code)", () => {
  it2("multiple bare vocabulary words without a system-software condition stay non-architecture", () => {
    const r = detect2("The new landing page design looks much cleaner after the color update. Also rotated the expired API key in the billing dashboard.");
    assert2.notEqual(r, "architecture",
      "design (visual) + api (key rotation) in separate clauses must not classify as architecture — old >=2-signal threshold did");
  });
  it2("genuine system-architecture text still classifies (guard against over-tightening)", () => {
    const r = detect2("Redesigned the service architecture: split the API gateway schema into two system layers");
    assert2.equal(r, "architecture");
  });
});
