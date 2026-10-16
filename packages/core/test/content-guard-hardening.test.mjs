/**
 * content-guard-hardening.test.mjs — 3.5.2 scrub hardening (rigorous-eval
 * finding 4, §7 item 5).
 *
 * Extends the 12-prefix scrubber with:
 *   A. Secret VALUES — KEY=value / "key": "value" assignments whose key name
 *      matches /(secret|token|passwd|password|api[_-]?key|private[_-]?key|
 *      access[_-]?key)/i; AWS secret access keys (40-char base64 after an
 *      aws-secret-ish key, spaces allowed); high-entropy tokens (Shannon
 *      ≥ 4.5 bits/char, length ≥ 32, ≥ 2 digits, never hex/UUID/SRI shapes).
 *   B. PII — email (RFC-2606 + noreply allowlisted), IBAN (mod-97 validated),
 *      card PAN (IIN prefix + Luhn validated). Typed placeholders.
 *
 * BOUNDARY (the load-bearing design decision of this change):
 *   - Context-identified secret values (KV, URL userinfo, Authorization/
 *     bearer, webhooks, prefixes) go into scrubForCloud → applied to LOCAL
 *     writes too (P0-a class: local journal content is surfaced cross-session
 *     and pasted via handoff, so raw secrets must never sit on disk).
 *   - PII AND the statistical entropy detector are EGRESS-ONLY
 *     (scrubForExport / Supabase sync path). A user's own local journal
 *     legitimately contains their emails/contacts and high-entropy
 *     identifiers; redacting those locally would destroy user data.
 *
 * FALSE-POSITIVE POLICY (documented, each row tested below):
 *   - KV values skipped when: < 8 chars; no digit at all (letter-only
 *     passwords are a documented false negative); numeric-only shapes
 *     (counts/IDs/floats); ISO-date-shaped; placeholder/reference starts
 *     ($VAR, <paste-here>, [REDACTED…], *); http(s) URLs.
 *   - Entropy detector NEVER fires on hex-only strings (git SHAs, SHA-256,
 *     UUIDs — also mathematically excluded: hex max entropy 4.0 < 4.5),
 *     SRI "shaNNN-…" integrity hashes, digit-only or letter-only runs.
 *     Hex-form secrets are a documented false negative of THIS detector
 *     (the KV rule still catches them when assigned to a secret-named key).
 *   - PAN requires known IIN prefix (4/51-55/22-27/34/37/6011/65/35) +
 *     13–19 digits + Luhn → 13-digit ms-timestamps and Luhn-valid IDs with
 *     other prefixes never match.
 *   - IBAN requires [A-Z]{2}\d{2} shape + 15–34 length + mod-97 == 1.
 *   - Phone numbers: deliberately NOT scrubbed (no country context → regex
 *     would eat issue numbers/timestamps; brief listed phone as optional).
 *
 * Also asserts: idempotency (placeholders never re-match any detector —
 * scrubForExport's fail-closed post-scan depends on it) and regex safety
 * (adversarial inputs must scale LINEARLY from 100 KB to 800 KB — ratio
 * assertion, load-robust; absolute wall-clock bounds flaked under suite load).
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let guard;
before(async () => {
  guard = await import("../dist/storage/content-guard.js");
});

// ---------------------------------------------------------------------------
// A. Secret values — must be redacted by scrubForCloud (local + cloud)
// ---------------------------------------------------------------------------

const SECRET_POSITIVES = [
  {
    name: "env assignment KEY=value",
    input: "deploy used API_KEY=zX9mQ4bL8pR2wT6y today",
    gone: "zX9mQ4bL8pR2wT6y",
    placeholder: "[REDACTED:secret-value]",
    keeps: "API_KEY=",
  },
  {
    name: "shell export with single-quoted value",
    input: "export DB_PASSWORD='Sup3r-Secret-Pass!'",
    gone: "Sup3r-Secret-Pass!",
    placeholder: "[REDACTED:secret-value]",
    keeps: "DB_PASSWORD=",
  },
  {
    name: "JSON double-quoted key and value",
    input: '{"apiKey": "zT4mW8qN1vB6xC3k"}',
    gone: "zT4mW8qN1vB6xC3k",
    placeholder: "[REDACTED:secret-value]",
    keeps: "apiKey",
  },
  {
    name: "YAML access_token",
    input: "access_token: ya29.a0AfH6SMBx8kQ2",
    gone: "ya29.a0AfH6SMBx8kQ2",
    placeholder: "[REDACTED:secret-value]",
    keeps: "access_token:",
  },
  {
    name: "key with prefix before keyword (AUTH_TOKEN, no word boundary)",
    input: "AUTH_TOKEN=abc123def456ghi789",
    gone: "abc123def456ghi789",
    placeholder: "[REDACTED:secret-value]",
    keeps: "AUTH_TOKEN=",
  },
  {
    name: "private_key JSON field",
    input: '"private_key": "MIIEvQIBADANBg2023xx"',
    gone: "MIIEvQIBADANBg2023xx",
    placeholder: "[REDACTED:secret-value]",
    keeps: "private_key",
  },
  {
    name: "AWS secret access key, prose form with spaces",
    input: "the aws secret access key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY leaked",
    gone: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    placeholder: "[REDACTED:secret-value]",
  },
  {
    name: "AWS secret access key, env form",
    input: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    gone: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    placeholder: "[REDACTED:secret-value]",
  },
  {
    name: "URL-embedded credential, IP host (review HIGH-1)",
    input: "db at https://root:T0pSecr3t@10.20.30.40/admin failed",
    gone: "root:T0pSecr3t",
    placeholder: "[REDACTED:secret-value]",
    keeps: "@10.20.30.40",
  },
  {
    name: "URL-embedded credential, redis host:port",
    input: "cache redis://default:MyRedisPw1@127.0.0.1:6379 is up",
    gone: "MyRedisPw1",
    placeholder: "[REDACTED:secret-value]",
    keeps: "@127.0.0.1:6379",
  },
  {
    name: "URL-embedded credential, symbol password + compound scheme",
    input: "mongodb+srv://svc:P4ssw0rd!x@cluster0.abc.mongodb.net/db",
    gone: "P4ssw0rd!x",
    placeholder: "[REDACTED:secret-value]",
    keeps: "@cluster0.abc.mongodb.net",
  },
  {
    name: "URL-embedded credential inside a KV line (KV exempts https URLs)",
    input: "API_TOKEN=https://user:Pa55word@internal:8443/x",
    gone: "Pa55word",
    placeholder: "[REDACTED:secret-value]",
    keeps: "@internal:8443",
  },
  {
    name: "Authorization: Bearer with short opaque token (review MEDIUM-2)",
    input: "sent Authorization: Bearer d4f8a2b9c1e3 header",
    gone: "d4f8a2b9c1e3",
    placeholder: "[REDACTED:secret-value]",
    keeps: "Authorization: Bearer",
  },
  {
    name: "authorization = Basic <base64>",
    input: "authorization = 'Basic dXNlcjpwYXNzd29yZDE='",
    gone: "dXNlcjpwYXNzd29yZDE=",
    placeholder: "[REDACTED:secret-value]",
  },
  {
    name: "bare bearer token (curl snippet)",
    input: "curl -H bearer Xy12Ab34Cd56 /api",
    gone: "Xy12Ab34Cd56",
    placeholder: "[REDACTED:secret-value]",
  },
  {
    name: "Slack webhook URL (review MEDIUM-3)",
    input: "notify https://hooks.slack.com/services/T00000000/B00000000/XXXXxxxx1234 on deploy",
    gone: "T00000000/B00000000/XXXXxxxx1234",
    placeholder: "[REDACTED:secret-value]",
    keeps: "hooks.slack.com/services/",
  },
  {
    name: "GitLab PAT prefix (glpat-)",
    input: "ci uses glpat-" + "xQ3vR7mK9pL2nW4jT8bZ for pulls",
    gone: "glpat-" + "xQ3vR7mK9pL2nW4jT8bZ",
    placeholder: "[REDACTED-SECRET]",
  },
  {
    name: "Slack legacy token prefix (xoxs-)",
    input: "old xoxs-1234567890-abcdefghij token",
    gone: "xoxs-1234567890-abcdefghij",
    placeholder: "[REDACTED-SECRET]",
  },
];

// Redacted ONLY on egress (scrubForExport) — the entropy detector must not
// touch local writes (review MEDIUM-4, owner decision: a legit ≥32-char
// base64 identifier in the user's own journal must survive at rest).
const EGRESS_SECRET_POSITIVES = [
  {
    name: "high-entropy standalone token (32 distinct base62 chars)",
    input: "rotated to aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY overnight",
    gone: "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY",
    placeholder: "[REDACTED:high-entropy]",
  },
];

// Things scrubForCloud must leave COMPLETELY unchanged.
const SECRET_NEGATIVES = [
  { name: "normal prose with keyword words", input: "We discussed the token bucket algorithm and password hygiene policy." },
  { name: "git SHA (40 hex)", input: "fixed in commit 9b84e68f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a on main" },
  { name: "SHA-256 (64 hex)", input: "digest e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
  { name: "UUID", input: "request id 550e8400-e29b-41d4-a716-446655440000 failed" },
  { name: "ISO timestamp", input: "started 2026-10-16T12:34:56.789Z and finished later" },
  { name: "token count (pure digits)", input: "token_count: 12845667" },
  { name: "token estimate (float)", input: "tokenEstimate = 12845.667" },
  { name: "token expiry (ISO date value)", input: "TOKEN_EXPIRY=2026-12-31T23:59:59Z" },
  { name: "letter-only placeholder password (documented FN)", input: "password: changeme" },
  { name: "env-var reference value", input: "api_key: $OPENAI_API_KEY and secret: ${VAULT_SECRET}" },
  { name: "angle-bracket placeholder value", input: "token: <paste-token-here-123>" },
  { name: "URL value under secret-ish key", input: "TOKEN_URL=https://auth.example.com/oauth2/token" },
  { name: "already-redacted placeholder value", input: "API_KEY=[REDACTED:secret-value]" },
  { name: "long camelCase identifier, no digits", input: "const configurationManagerFactoryBuilder = makeThing();" },
  { name: "long camelCase identifier with 2 digits (low entropy)", input: "call getUserAccountById42AndValidate99 first" },
  { name: "low-entropy repeated run", input: "padding aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb123 end" },
  { name: "SRI integrity hash (sha512-…)", input: 'integrity "sha512-mN8xV2kQ7pL4wE9rT1yU6iO3aSdF5gHjKzXcVbNmQw==" ok' },
  { name: "kebab-case slug with date", input: "branch feature-flag-rollout-2026-10-16-variant deployed" },
  { name: "version string", input: '"version": "3.5.1-beta.2+build.998877"' },
  { name: "13-digit ms timestamp", input: "at 1760612345678 the job ran" },
  { name: "URL with port, no credentials", input: "see https://example.com:8443/path for details" },
  { name: "URL path with colon segment (no userinfo)", input: "read https://en.wikipedia.org/wiki/Foo:Bar today" },
  // localhost (no dot) keeps this out of the email rule too, so the fixture
  // also survives the kitchen-sink's scrubForExport pass — the point here is
  // only that user@host WITHOUT a scheme/password never trips the URL rule.
  { name: "ssh-style user@host (no scheme, no password)", input: "clone via git@localhost as usual" },
  { name: "bearer as English word", input: "the bearer of good news arrived early" },
  { name: "bearer with ISO-date value", input: "token bearer 2026-10-16 rotation planned" },
  { name: "bare 'basic' word with digits (only authorization-context counts)", input: "basic 12345678 reps done" },
  { name: "already-redacted Authorization header", input: "Authorization: Bearer [REDACTED:secret-value]" },
  { name: "already-redacted URL credential", input: "db https://[REDACTED:secret-value]@10.20.30.40/x" },
  { name: "slack domain without /services/ path", input: "see hooks.slack.com docs for setup" },
];

describe("scrubForCloud: secret-value hardening (KV, AWS, entropy)", () => {
  for (const t of SECRET_POSITIVES) {
    it(`redacts: ${t.name}`, () => {
      const out = guard.scrubForCloud(t.input);
      assert.ok(!out.includes(t.gone), `raw secret must be gone\n  in:  ${t.input}\n  out: ${out}`);
      assert.ok(out.includes(t.placeholder), `typed placeholder expected\n  out: ${out}`);
      if (t.keeps) assert.ok(out.includes(t.keeps), `key context "${t.keeps}" must survive\n  out: ${out}`);
    });
  }
  for (const t of SECRET_NEGATIVES) {
    it(`leaves alone: ${t.name}`, () => {
      assert.equal(guard.scrubForCloud(t.input), t.input);
    });
  }

  it("existing prefix rules still fire with legacy placeholder", () => {
    const out = guard.scrubForCloud("key sk-" + "a".repeat(30) + " and AKIAIOSFODNN7EXAMPLE");
    assert.ok(!out.includes("sk-aaa"), "sk- redacted");
    assert.ok(!out.includes("AKIA"), "AKIA redacted");
    assert.ok(out.includes("[REDACTED-SECRET]"), "legacy placeholder preserved");
  });

  it("BOUNDARY: entropy detector is egress-only — scrubForCloud keeps local base64 identifiers", () => {
    // Review MEDIUM-4 (owner decision): a legit high-entropy identifier in
    // the user's own journal must survive the LOCAL write scrub...
    for (const t of EGRESS_SECRET_POSITIVES) {
      assert.equal(guard.scrubForCloud(t.input), t.input, `scrubForCloud must keep: ${t.name}`);
    }
  });

  for (const t of EGRESS_SECRET_POSITIVES) {
    it(`redacts on egress only: ${t.name}`, () => {
      // ...while the SAME content is redacted the moment it heads off-machine.
      const out = guard.scrubForExport(t.input);
      assert.ok(!out.includes(t.gone), `raw token must be gone on egress\n  out: ${out}`);
      assert.ok(out.includes(t.placeholder), `typed placeholder expected\n  out: ${out}`);
    });
  }

  for (const t of SECRET_NEGATIVES) {
    it(`egress scrub also leaves alone: ${t.name}`, () => {
      assert.equal(guard.scrubForExport(t.input), t.input);
    });
  }
});

// ---------------------------------------------------------------------------
// B. PII — egress-only (scrubForExport / scrubPii), never scrubForCloud
// ---------------------------------------------------------------------------

const PII_POSITIVES = [
  { name: "email", input: "reach me at jane.doe+ci@company.io please", gone: "jane.doe+ci@company.io", placeholder: "[REDACTED:email]" },
  { name: "IBAN plain (DE, mod-97 valid)", input: "pay to DE89370400440532013000 by Friday", gone: "DE89370400440532013000", placeholder: "[REDACTED:iban]" },
  { name: "IBAN plain (GB, mod-97 valid)", input: "acct GB82WEST12345698765432 ok", gone: "GB82WEST12345698765432", placeholder: "[REDACTED:iban]" },
  { name: "IBAN spaced groups", input: "IBAN: DE89 3704 0044 0532 0130 00 end", gone: "DE89 3704 0044 0532 0130 00", placeholder: "[REDACTED:iban]" },
  { name: "PAN Visa 16", input: "card 4012888888881881 charged", gone: "4012888888881881", placeholder: "[REDACTED:pan]" },
  { name: "PAN Visa spaced", input: "card 4111 1111 1111 1111 charged", gone: "4111 1111 1111 1111", placeholder: "[REDACTED:pan]" },
  { name: "PAN Mastercard dashed", input: "card 5555-5555-5555-4444 on file", gone: "5555-5555-5555-4444", placeholder: "[REDACTED:pan]" },
  { name: "PAN Amex 15", input: "amex 378282246310005 used", gone: "378282246310005", placeholder: "[REDACTED:pan]" },
  { name: "PAN Discover", input: "disc 6011111111111117 used", gone: "6011111111111117", placeholder: "[REDACTED:pan]" },
];

const PII_NEGATIVES = [
  { name: "RFC-2606 example.com email (allowlist)", input: "docs use user@example.com as the sample" },
  { name: "noreply email (allowlist)", input: "Co-Authored-By: Bot <noreply@anthropic.com>" },
  { name: "IBAN shape failing mod-97", input: "bogus DE89370400440532013001 here" },
  { name: "Luhn-failing 16 digits with Visa prefix", input: "order 4111111111111112 shipped" },
  { name: "Luhn-valid 16 digits with unknown IIN prefix", input: "ref 1111111111111117 logged" },
  { name: "13-digit ms timestamp (PAN shape, bad prefix)", input: "at 1760612345678 the job ran" },
  { name: "ISO date", input: "due 2026-10-16 at the latest" },
  { name: "git SHA", input: "see 9b84e68f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a" },
  { name: "20-digit run (too long for PAN)", input: "serial 41111111111111111111 noted" },
];

describe("scrubPii / scrubForExport: PII redaction with checksum gates", () => {
  for (const t of PII_POSITIVES) {
    it(`redacts (export path): ${t.name}`, () => {
      const out = guard.scrubForExport(t.input);
      assert.ok(!out.includes(t.gone), `PII must be gone\n  in:  ${t.input}\n  out: ${out}`);
      assert.ok(out.includes(t.placeholder), `typed placeholder expected\n  out: ${out}`);
    });
  }
  for (const t of PII_NEGATIVES) {
    it(`leaves alone (export path): ${t.name}`, () => {
      assert.equal(guard.scrubForExport(t.input), t.input);
    });
  }

  it("scrubPii is exported standalone and reports labels", () => {
    const r = guard.scrubPii("mail jane.doe@company.io card 4111111111111111");
    assert.equal(r.redactedCount, 2);
    assert.ok(r.content.includes("[REDACTED:email]") && r.content.includes("[REDACTED:pan]"));
  });

  it("BOUNDARY: scrubForCloud does NOT touch PII (local writes keep user data)", () => {
    const localContent =
      "Applied at ACME: contact jane.doe@company.io, refund to DE89370400440532013000, card 4111111111111111.";
    assert.equal(guard.scrubForCloud(localContent), localContent);
  });
});

// ---------------------------------------------------------------------------
// C. Idempotency — scrubForExport's fail-closed post-scan depends on this
// ---------------------------------------------------------------------------

describe("idempotency: placeholders never re-match any detector", () => {
  const ALL_POSITIVE_INPUTS = [...SECRET_POSITIVES, ...EGRESS_SECRET_POSITIVES, ...PII_POSITIVES].map(
    (t) => t.input,
  );

  it("scrubForExport(scrubForExport(x)) === scrubForExport(x), never throws", () => {
    for (const input of ALL_POSITIVE_INPUTS) {
      const once = guard.scrubForExport(input);
      const twice = guard.scrubForExport(once);
      assert.equal(twice, once, `not idempotent for: ${input}`);
    }
  });

  it("scrubForCloud double-apply is stable", () => {
    for (const input of ALL_POSITIVE_INPUTS) {
      const once = guard.scrubForCloud(input);
      assert.equal(guard.scrubForCloud(once), once, `not idempotent for: ${input}`);
    }
  });

  it("mixed kitchen-sink document survives export scrub without throwing", () => {
    const doc = [
      ...SECRET_POSITIVES.map((t) => t.input),
      ...EGRESS_SECRET_POSITIVES.map((t) => t.input),
      ...PII_POSITIVES.map((t) => t.input),
      ...SECRET_NEGATIVES.map((t) => t.input),
      ...PII_NEGATIVES.map((t) => t.input),
    ].join("\n");
    const out = guard.scrubForExport(doc);
    for (const t of [...SECRET_POSITIVES, ...EGRESS_SECRET_POSITIVES, ...PII_POSITIVES]) {
      assert.ok(!out.includes(t.gone), `kitchen-sink: ${t.name} must be gone`);
    }
    // Negatives survive verbatim inside the larger doc too.
    for (const t of [...SECRET_NEGATIVES, ...PII_NEGATIVES]) {
      assert.ok(out.includes(t.input), `kitchen-sink: negative "${t.name}" must survive`);
    }
  });
});

// ---------------------------------------------------------------------------
// D. Regex safety — adversarial inputs must scale linearly (1x → 8x ratio)
// ---------------------------------------------------------------------------

describe("regex safety: no catastrophic backtracking", () => {
  // Each fixture is a FACTORY so the same shape can be built at 1x (~100 KB)
  // and 8x (~800 KB) for the scaling assertion below.
  const ADVERSARIAL = [
    { name: "repeated bare keys, no values", make: (m) => "password=".repeat(11_200 * m) },
    { name: "single letter run", make: (m) => "a".repeat(100_000 * m) },
    { name: "single digit run", make: (m) => "1".repeat(100_000 * m) },
    { name: "unterminated quoted value", make: (m) => 'token="' + "a".repeat(99_000 * m) },
    { name: "keyword/suffix ambiguity bait", make: (m) => "token_as".repeat(12_500 * m) },
    { name: "single entropy candidate", make: (m) => "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY".repeat(3_125 * m) },
    { name: "email local-part bait (no domain)", make: (m) => ("a".repeat(63) + "@").repeat(1_560 * m) },
    { name: "PAN-dense input (Luhn checks per 20 bytes)", make: (m) => "4111 1111 1111 1111 ".repeat(5_000 * m) },
    { name: "IBAN-shaped caps soup", make: (m) => "DE89 ABCD 1234 ".repeat(6_700 * m) },
    { name: "bearer keyword flood (values too short)", make: (m) => "bearer ".repeat(14_000 * m) },
    { name: "URL-credential flood (one redaction per 12 bytes)", make: (m) => "https://u:p@".repeat(8_200 * m) },
    { name: "authorization keyword flood (digit-free values)", make: (m) => "authorization:".repeat(7_000 * m) },
  ];

  // SCALING assertion, not a wall-clock budget (review LOW-5 + rv-correct
  // addendum: the former absolute bounds — 50 ms, then 250 ms — measured
  // 50.1 ms and 174–206 ms under merged-suite load while passing standalone;
  // any absolute number is a bet on machine load). What the test must catch
  // is the CLASS regression: super-linear backtracking. Linear patterns give
  // time(8x)/time(1x) ≈ 8 (plus noise); quadratic gives ≈ 64; catastrophic
  // is unbounded. Assert ratio < 40 on min-of-5 — the minimum is the run least
  // disturbed by GC/scheduler noise, and 40 sits between the worst linear
  // ratio observed on a loaded 2-vCPU windows-latest runner (28.3, PR #43 CI)
  // and the quadratic signature (≈ 64). Locally, every fixture doubles
  // cleanly 1x→32x. A very generous
  // 2 s absolute ceiling on the 8x run stays as a backstop that only true
  // catastrophic blowup (or a hung engine) can hit.
  const RATIO_MAX = 40;
  const CEILING_8X_MS = 2_000;

  function minScrubMs(input) {
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      guard.scrubForExport(input);
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  }

  for (const t of ADVERSARIAL) {
    it(`${t.name}: 1x→8x scaling ratio < ${RATIO_MAX} (linear), 8x < ${CEILING_8X_MS} ms`, () => {
      const in1 = t.make(1);
      const in8 = t.make(8);
      guard.scrubForExport(in1); // warm-up: shed first-run JIT/regex-compile cost
      guard.scrubForExport(in8); // warm-up: first large-string allocation/GC
      const t1 = minScrubMs(in1);
      const t8 = minScrubMs(in8);
      // Floor the denominator at 0.5 ms: timer jitter on a sub-ms base run
      // must not explode the ratio. A real quadratic still fails — 8x of a
      // quadratic sub-ms 100 KB run lands ≥ tens of ms → ratio ≥ 60.
      const ratio = t8 / Math.max(t1, 0.5);
      assert.ok(
        t8 < CEILING_8X_MS,
        `8x input (${Math.round(in8.length / 1024)} KB) took ${t8.toFixed(1)} ms — catastrophic-backtracking ceiling`,
      );
      assert.ok(
        ratio < RATIO_MAX,
        `scaling ratio ${ratio.toFixed(1)} (1x: ${t1.toFixed(2)} ms, 8x: ${t8.toFixed(1)} ms) — super-linear growth`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// E. logSyncError — best-effort, never throws (review LOW-3)
// ---------------------------------------------------------------------------

describe("logSyncError: best-effort logging never escapes doSync's catch", () => {
  let sync;
  before(async () => {
    sync = await import("../dist/supabase/sync.js");
  });

  it("writes the line when the root is writable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-logguard-ok-"));
    try {
      sync.logSyncError("scrub refused: test-entry", dir);
      const logged = fs.readFileSync(path.join(dir, "sync-errors.log"), "utf-8");
      assert.ok(logged.includes("scrub refused: test-entry"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT throw when the root path is a file (every fs op inside fails)", () => {
    // scrubForExport throwing is an EXPECTED path into doSync's catch now; if
    // logSyncError threw here, the fire-and-forget `void doSync(...)` promise
    // would reject unhandled and crash the process on Node >= 15.
    const fileAsRoot = path.join(os.tmpdir(), `ar-logguard-file-${Date.now()}`);
    fs.writeFileSync(fileAsRoot, "not a directory", "utf-8");
    try {
      assert.doesNotThrow(() => sync.logSyncError("boom", fileAsRoot));
    } finally {
      fs.rmSync(fileAsRoot, { force: true });
    }
  });
});
