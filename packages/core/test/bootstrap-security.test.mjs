/**
 * bootstrap-security.test.mjs — P4 cross-surface adapter security guard tests.
 *
 * Tests (per deliverable):
 *   1. Symlink escape — a scan dir containing a symlink -> outside home is
 *      REJECTED by the realpath jail in bootstrapImport.
 *   2. Fabricated scan_result — bootstrap_import without a valid nonce is REJECTED.
 *   3. Secret content — files with fake AKIA.../ghp_... are skipped/redacted.
 *   4. Consent gate — bootstrapScan reads NO file content (preview == "").
 *
 * NOTE: Tests 5 (brief determinism) and 6 (brief --full-only) were removed
 * 2026-07-05: brief MCP tool deleted in P3b purity pass (owner-approved).
 * The bootstrap security tests (1-4) are unchanged.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  bootstrapScan,
  bootstrapImport,
  scrubSecretContent,
} from "../dist/index.js";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const HOME = os.homedir();

/**
 * Create a temp directory under the user's home so it passes the scan-dir
 * home-prefix filter. Uses a .ar-test-* prefix to make cleanup easy.
 */
function makeTempDirUnderHome(prefix = "ar-sec-test-") {
  const dir = path.join(HOME, `.${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Create a minimal git repo (has .git/) so findGitRepos() recognises it. */
function makeGitRepo(base, name) {
  const dir = path.join(base, name);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// 1. Guard 1 — Symlink escape is blocked by realpath jail
// ---------------------------------------------------------------------------

describe("Guard 1 — symlink escape is blocked by realpath jail", () => {
  let scanBase;
  let secretDir;
  let arRoot;

  beforeEach(() => {
    // Both dirs under home so scanBase passes the home-prefix filter.
    scanBase = makeTempDirUnderHome("ar-sec-scan-");
    arRoot = makeTempDirUnderHome("ar-sec-root-");
    process.env.AGENT_RECALL_ROOT = arRoot;

    // The "secret" target must be OUTSIDE home so the realHome fallback in
    // isPathSafe does not accidentally allow it.
    // macOS tmpdir (/var/folders/...) is outside /Users/tongwu.
    secretDir = fs.mkdtempSync(path.join(tmpdir(), "ar-sec-esc-"));
    fs.writeFileSync(path.join(secretDir, "secret.txt"), "very sensitive content 12345");
  });

  afterEach(() => {
    delete process.env.AGENT_RECALL_ROOT;
    for (const d of [scanBase, arRoot]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    // secretDir is in system tmpdir (outside home) — cleanup separately
    if (secretDir) {
      try { fs.rmSync(secretDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("bootstrapImport skips items whose realpath resolves outside the repo's scan root", async () => {
    // Create a git repo inside scanBase with a symlink pointing outside scanBase
    const repo = makeGitRepo(scanBase, "legit-repo");
    // symlink: scanBase/legit-repo/escape-link.txt -> secretDir/secret.txt
    // The string starts with scanBase (passes naive startsWith check), but
    // after realpathSync it resolves to secretDir which is outside scanBase.
    fs.symlinkSync(
      path.join(secretDir, "secret.txt"),
      path.join(repo, "escape-link.txt"),
    );

    const scanResult = await bootstrapScan({ scan_dirs: [scanBase] });
    assert.ok(scanResult._session_nonce, "nonce must be present");

    // Find or build the legit-repo project entry
    let legitProj = scanResult.projects.find(p => p.slug === "legit-repo" || p.path === repo);
    if (!legitProj) {
      legitProj = {
        slug: "legit-repo",
        name: "legit-repo",
        path: repo,
        sources: [],
        already_in_ar: false,
        importable_items: [],
      };
      scanResult.projects.push(legitProj);
    }

    // Inject the symlink path as a malicious claudemd item.
    // String starts with scanBase (passes naive check) but resolves outside scanBase.
    legitProj.importable_items.push({
      id: "claudemd",
      type: "architecture",
      source_path: path.join(repo, "escape-link.txt"),
      size_bytes: 999,
      preview: "",
    });

    // Import ONLY the legit-repo project (so we don't also import real projects
    // from the user's ~/Projects/ that would pollute the assertion)
    const importResult = await bootstrapImport(scanResult, {
      project_slugs: ["legit-repo"],
    });

    // The symlink resolves to secretDir which is outside scanBase.
    // isPathSafe must reject the symlink-escaped path.
    // The secret content must never appear in the palace.
    const palaceDir = path.join(arRoot, "projects");
    if (fs.existsSync(palaceDir)) {
      function walkMd(d) {
        const found = [];
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) found.push(...walkMd(full));
          else if (e.name.endsWith(".md")) found.push(full);
        }
        return found;
      }
      for (const f of walkMd(palaceDir)) {
        const content = fs.readFileSync(f, "utf-8");
        assert.ok(
          !content.includes("very sensitive content 12345"),
          `Secret content must never appear in palace (found in ${path.relative(arRoot, f)})`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Guard 3 — Fabricated scan_result without valid nonce is rejected
// ---------------------------------------------------------------------------

describe("Guard 3 — fabricated scan_result without valid nonce is rejected", () => {
  let arRoot;

  beforeEach(() => {
    arRoot = makeTempDirUnderHome("ar-sec-ar-root-");
    process.env.AGENT_RECALL_ROOT = arRoot;
  });

  afterEach(() => {
    delete process.env.AGENT_RECALL_ROOT;
    try { fs.rmSync(arRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("rejects scan_result with no _session_nonce", async () => {
    const fabricated = {
      projects: [{
        slug: "evil",
        name: "evil",
        path: "/evil",
        sources: [],
        already_in_ar: false,
        importable_items: [{
          id: "claudemd",
          type: "architecture",
          source_path: "/etc/passwd",
          size_bytes: 999,
          preview: "",
        }],
      }],
      global_items: [],
      stats: { total_projects: 1, total_importable_items: 1, total_already_in_ar: 0, scan_duration_ms: 0 },
      // _session_nonce intentionally missing
      _scan_roots: [HOME],
    };

    const result = await bootstrapImport(fabricated, {});
    assert.ok(result.errors.length > 0, "fabricated result must produce errors");
    assert.equal(result.items_imported, 0, "must import 0 items from fabricated result");
    const nonceErr = result.errors.find((e) => e.error.toLowerCase().includes("nonce"));
    assert.ok(nonceErr, `expected nonce error, got: ${JSON.stringify(result.errors)}`);
  });

  it("rejects scan_result with fake/unknown nonce", async () => {
    const fabricated = {
      projects: [],
      global_items: [],
      stats: { total_projects: 0, total_importable_items: 0, total_already_in_ar: 0, scan_duration_ms: 0 },
      _session_nonce: "00000000-dead-beef-cafe-000000000000", // GUID not in nonce registry
      _scan_roots: [HOME],
    };

    const result = await bootstrapImport(fabricated, {});
    assert.ok(result.errors.length > 0, "fabricated nonce must produce errors");
    assert.equal(result.items_imported, 0, "must import 0 items with fake nonce");
    const nonceErr = result.errors.find((e) => e.error.toLowerCase().includes("nonce"));
    assert.ok(nonceErr, `expected nonce error, got: ${JSON.stringify(result.errors)}`);
  });

  it("rejects claudemd source_path pointing to /etc/passwd even with a valid nonce", async () => {
    // Run a real scan to get a valid nonce
    const scanBase = makeTempDirUnderHome("ar-sec-scan2-");
    makeGitRepo(scanBase, "safe-proj");

    const realScan = await bootstrapScan({ scan_dirs: [scanBase] });
    assert.ok(realScan._session_nonce, "real scan must have nonce");

    // Inject a malicious project with /etc/passwd as source_path
    realScan.projects.push({
      slug: "escape",
      name: "escape",
      path: "/private/etc",
      sources: [],
      already_in_ar: false,
      importable_items: [{
        id: "claudemd",
        type: "architecture",
        source_path: "/private/etc/passwd",
        size_bytes: 999,
        preview: "",
      }],
    });

    const result = await bootstrapImport(realScan, {});

    // /private/etc/passwd is outside home → isPathSafe returns false → skipped
    // We verify the secret never reaches the palace
    const palaceDir = path.join(arRoot, "projects");
    if (fs.existsSync(path.join(palaceDir, "escape"))) {
      function walkMd(d) {
        const found = [];
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) found.push(...walkMd(full));
          else if (e.name.endsWith(".md")) found.push(full);
        }
        return found;
      }
      for (const f of walkMd(path.join(palaceDir, "escape"))) {
        const c = fs.readFileSync(f, "utf-8");
        assert.ok(!c.includes("root:"), "passwd content must not reach palace");
      }
    }
    // Verify the claudemd content from /etc/passwd was not written to palace.
    // The architecture room gets a scaffold README.md (that's expected),
    // but must NOT contain passwd content or file-read content from /etc.
    const escapeProjPath = path.join(arRoot, "projects", "escape", "palace");
    if (fs.existsSync(escapeProjPath)) {
      const archRoom = path.join(escapeProjPath, "rooms", "architecture");
      if (fs.existsSync(archRoom)) {
        for (const fname of fs.readdirSync(archRoom)) {
          if (fname === "README.md") continue; // scaffold file — ok
          const content = fs.readFileSync(path.join(archRoom, fname), "utf-8");
          assert.ok(
            !content.includes("root:"),
            `passwd content must not appear in architecture room file ${fname}`,
          );
        }
        // project-conventions.md must NOT exist (claudemd was skipped by isPathSafe)
        const conventionsFile = path.join(archRoom, "project-conventions.md");
        assert.ok(
          !fs.existsSync(conventionsFile),
          "project-conventions.md must not exist (claudemd from /etc/passwd was rejected by isPathSafe)",
        );
      }
    }

    try { fs.rmSync(scanBase, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});

// ---------------------------------------------------------------------------
// 3. Guard 2 — Secret content is redacted/skipped before palace write
// ---------------------------------------------------------------------------

describe("Guard 2 — secret content in files is redacted before palace write", () => {
  let arRoot;
  let scanBase;

  beforeEach(() => {
    scanBase = makeTempDirUnderHome("ar-sec-g2-scan-");
    arRoot = makeTempDirUnderHome("ar-sec-g2-root-");
    process.env.AGENT_RECALL_ROOT = arRoot;
  });

  afterEach(() => {
    delete process.env.AGENT_RECALL_ROOT;
    for (const d of [scanBase, arRoot]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("file containing fake AKIA… key is redacted when imported as CLAUDE.md", async () => {
    const repo = makeGitRepo(scanBase, "secret-in-claude");
    // Use a properly-formatted fake AWS key (ends with alphanums so \b fires)
    fs.writeFileSync(
      path.join(repo, "CLAUDE.md"),
      `# My Project\n\nAWS_KEY=AKIAIOSFODNN7EXAMPLE\n\nNormal content.`,
    );

    const scanResult = await bootstrapScan({ scan_dirs: [scanBase] });
    // Only import the test project to avoid importing real projects
    await bootstrapImport(scanResult, { project_slugs: ["secret-in-claude"] });

    // Confirm the raw AKIA key is NOT in any palace file
    const palaceDir = path.join(arRoot, "projects");
    if (fs.existsSync(palaceDir)) {
      function walkMd(d) {
        const found = [];
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) found.push(...walkMd(full));
          else if (e.name.endsWith(".md")) found.push(full);
        }
        return found;
      }
      for (const f of walkMd(palaceDir)) {
        const c = fs.readFileSync(f, "utf-8");
        assert.ok(
          !c.includes("AKIAIOSFODNN7EXAMPLE"),
          `raw AKIA key must be redacted in palace file ${path.relative(arRoot, f)}`,
        );
      }
    }
  });

  it("file named .env.local is rejected by expanded filename denylist", async () => {
    const repo = makeGitRepo(scanBase, "env-local-test");
    fs.writeFileSync(path.join(repo, ".env.local"), "SECRET=my_secret_value");

    const scanResult = await bootstrapScan({ scan_dirs: [scanBase] });

    // .env.local must NOT appear as an importable item's source_path
    for (const proj of scanResult.projects) {
      for (const item of proj.importable_items) {
        assert.ok(
          !item.source_path.endsWith(".env.local"),
          `".env.local" must be excluded by secret filename denylist, found: ${item.source_path}`,
        );
      }
    }
  });

  it("file inside .ssh/ directory is rejected by secret parent-dir check", async () => {
    // Create a fake .ssh dir under scanBase (simulates a misconfigured ssh dir in project)
    const sshDir = path.join(scanBase, ".ssh");
    fs.mkdirSync(sshDir, { recursive: true });
    fs.writeFileSync(path.join(sshDir, "config"), "Host github.com\n  IdentityFile ~/.ssh/id_ed25519");

    // Also create a git repo so scan finds something
    makeGitRepo(scanBase, "normal-repo");

    const result = await bootstrapScan({ scan_dirs: [scanBase] });

    // .ssh/config must NOT appear in any importable_items
    for (const proj of result.projects) {
      for (const item of proj.importable_items) {
        assert.ok(
          !item.source_path.endsWith("/.ssh/config"),
          `file inside .ssh/ must be excluded by secret parent-dir guard, found: ${item.source_path}`,
        );
      }
    }
    for (const item of result.global_items) {
      assert.ok(
        !item.source_path.endsWith("/.ssh/config"),
        `global item inside .ssh/ must be excluded`,
      );
    }
  });

  it("scrubSecretContent correctly redacts fake ghp_ token in content", () => {
    const content = "My token: ghp_abcdefghijklmnopqrstuvwxyz1234 — very secret";
    const { content: scrubbed, redactedCount, labels } = scrubSecretContent(content);
    assert.ok(!scrubbed.includes("ghp_abcdefghijklmnopqrstuvwxyz1234"), "ghp_ token must be redacted");
    assert.equal(redactedCount, 1);
    assert.ok(labels.some(l => l.includes("GitHub")));
  });

  it("scrubSecretContent redacts a full PEM block — header, base64 body, AND footer", () => {
    // Realistic multi-line PEM private key fixture
    const pemBlock =
      "-----BEGIN RSA PRIVATE KEY-----\n" +
      "MIIEpAIBAAKCAQEA3e7vHK5hB+DJqN1hLOd8FzXaKqrS7bJPAT5WLQZ8fKcF\n" +
      "cHaLMN8+kFxT3mRpVnWsJ2qLd5yBvX4KmRwP9oZsE6t1VuNxGfD7gKhQiR3z\n" +
      "-----END RSA PRIVATE KEY-----";
    const content = `Some config:\n\n${pemBlock}\n\nOther stuff here.`;

    const { content: scrubbed, redactedCount } = scrubSecretContent(content);

    // The base64 body must be gone — not just the header line
    assert.ok(
      !scrubbed.includes("MIIEpA"),
      "PEM base64 body (MIIEpA) must be redacted — not just the BEGIN header line",
    );
    assert.ok(!scrubbed.includes("BEGIN RSA PRIVATE KEY"), "PEM BEGIN header must be redacted");
    assert.ok(!scrubbed.includes("END RSA PRIVATE KEY"), "PEM END footer must be redacted");
    assert.ok(redactedCount >= 1, "PEM block must be counted as a redaction");
    assert.ok(scrubbed.includes("Other stuff here."), "non-PEM content must be preserved");
  });
});

// ---------------------------------------------------------------------------
// 4. Guard 4 — Consent gate: bootstrapScan reads NO file content
// ---------------------------------------------------------------------------

describe("Guard 4 — consent gate: bootstrapScan reads NO file content", () => {
  let arRoot;
  let scanBase;

  beforeEach(() => {
    scanBase = makeTempDirUnderHome("ar-sec-g4-scan-");
    arRoot = makeTempDirUnderHome("ar-sec-g4-root-");
    process.env.AGENT_RECALL_ROOT = arRoot;
  });

  afterEach(() => {
    delete process.env.AGENT_RECALL_ROOT;
    for (const d of [scanBase, arRoot]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("file-backed ImportableItem.preview fields are empty strings after bootstrapScan", async () => {
    const repo = makeGitRepo(scanBase, "consent-test");
    fs.writeFileSync(path.join(repo, "CLAUDE.md"), "# Real Content\n\nThis must not appear in preview.");
    fs.writeFileSync(path.join(repo, "README.md"), "A test project.");

    const result = await bootstrapScan({ scan_dirs: [scanBase] });

    // Items backed by actual FILE content (claudemd, memory) must have empty previews.
    // Identity and trajectory items have metadata-only previews (not file content) —
    // those are excluded from this assertion.
    for (const proj of result.projects) {
      for (const item of proj.importable_items) {
        if (item.id === "identity" || item.id === "git-trajectory") continue; // metadata-only
        assert.strictEqual(
          item.preview,
          "",
          `file-backed item preview must be "" during scan (Guard 4), got "${item.preview}" for ${item.id} in ${proj.slug}`,
        );
      }
    }
    for (const item of result.global_items) {
      assert.strictEqual(item.preview, "", `global item preview must be "" during scan`);
    }
  });

  it("scan result does not include any actual CLAUDE.md file content", async () => {
    const repo = makeGitRepo(scanBase, "no-content-test");
    const sensitiveContent = "THIS_IS_SENSITIVE_CONTENT_ABCXYZ_12345";
    fs.writeFileSync(path.join(repo, "CLAUDE.md"), sensitiveContent);

    const result = await bootstrapScan({ scan_dirs: [scanBase] });

    const serialised = JSON.stringify(result);
    assert.ok(
      !serialised.includes(sensitiveContent),
      "Sensitive CLAUDE.md content must not appear anywhere in scan result JSON",
    );
  });
});


// Sections 5 & 6 (brief tool tests) removed 2026-07-05.
// brief MCP tool and brief() core function deleted in P3b purity pass (owner-approved).
// bootstrap CLI command and bootstrapScan/bootstrapImport core logic are unaffected.
