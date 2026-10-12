/**
 * identity-trust-cwd-root-gate.test.mjs — red-team CRITICAL-3 invariant
 * (reports/2026-08-18-eval-redteam.md, SOP 2b249d59, wave/p1-identity).
 *
 * THE CLAIM UNDER TEST: `resolveProject(project)` — for ANY explicit,
 * non-"auto" slug — unconditionally registered `process.cwd()` into that
 * project's cwd-allowlist, with no check that the cwd was itself a
 * recognizable project root. `detectProject()` then consulted the
 * allowlist (longest-prefix match) BEFORE git-remote identity. One ordinary
 * `ar write "..." --project shallow-project` run from a shallow/parent
 * directory therefore permanently annexed every distinctly-identified git
 * repo nested underneath it: a `cd`+`ar write --project auto` from inside
 * `legit-other-project` (its own real git remote) resolved to
 * `shallow-project` instead, and `legit-other-project` never got its own
 * project directory at all.
 *
 * FIX UNDER TEST (two layers, per the report's threat model):
 *  (b1) `resolveProject` only registers `process.cwd()` into the allowlist
 *       when that EXACT directory is a recognizable project root (`.git` or
 *       `package.json` present directly inside it) — a parent/staging
 *       directory can never enter the allowlist going forward.
 *  (b2) `detectProject`'s cwd-allowlist check only wins outright on an EXACT
 *       path match. An ANCESTOR-prefix match must yield to the queried
 *       directory's OWN git identity when it has one and it disagrees —
 *       defense in depth against allowlist entries that predate this fix.
 *
 * The pre-existing "prismma-web" legitimate override use case (cwd-allowlist
 * header comment) — an EXPLICIT write from a real project root whose slug
 * legitimately differs from its own git remote name — must keep working
 * unchanged; this suite asserts that too.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

const TEST_ROOT = path.join(os.tmpdir(), "ar-identity-trust-cwd-root-" + Date.now());
const WORK_ROOT = path.join(os.tmpdir(), "ar-identity-trust-cwd-root-work-" + Date.now());

function gitInit(dir, remoteName) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", `https://github.com/someorg/${remoteName}.git`], { cwd: dir });
}

const IS_WIN = process.platform === "win32";

/**
 * 8.3 short form of an existing directory, via the Scripting.FileSystemObject
 * COM API (array-args execFileSync — no cmd.exe quoting pitfalls). Returns
 * null when unavailable, or the long path unchanged when the volume has 8.3
 * name generation disabled (caller must detect and skip).
 */
function shortPathOf(dir) {
  try {
    const script =
      `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${dir.replace(/'/g, "''")}').ShortPath`;
    const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf-8",
      timeout: 30_000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

describe("resolveProject/detectProject — a non-root cwd cannot annex a git-identified project", () => {
  let core;
  let originalCwd;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    core = await import("../dist/index.js");
    core.setRoot(TEST_ROOT);
    originalCwd = process.cwd();
  });

  after(() => {
    process.chdir(originalCwd);
    core.resetRoot?.();
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.rmSync(WORK_ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Leave WORK_ROOT before deleting it: the previous test may have
    // chdir'd inside, and Windows refuses to remove the process cwd (EPERM).
    process.chdir(originalCwd);
    fs.rmSync(path.join(TEST_ROOT, "projects"), { recursive: true, force: true });
    fs.rmSync(WORK_ROOT, { recursive: true, force: true });
    fs.mkdirSync(WORK_ROOT, { recursive: true });
  });

  it("CRITICAL-3 repro: a shallow-dir explicit write must not annex a nested, distinctly-identified git repo", async () => {
    const shallowDir = WORK_ROOT; // NOT a project root itself — no .git, no package.json
    const nestedRepo = path.join(WORK_ROOT, "legit-other-project");
    gitInit(nestedRepo, "legit-other-project");

    process.chdir(shallowDir);
    const resolvedShallow = await core.resolveProject("shallow-project");
    assert.equal(resolvedShallow, "shallow-project", "the explicit write itself must still resolve to the given slug");

    // The allowlist file must NOT have been created for shallow-project,
    // because `shallowDir` is not itself a recognizable project root.
    const allowlistPath = path.join(TEST_ROOT, "projects", "shallow-project", "palace", "cwd-allowlist.json");
    assert.ok(!fs.existsSync(allowlistPath), "a non-root cwd must never be registered into the cwd-allowlist");

    process.chdir(nestedRepo);
    const detected = await core.detectProject();
    assert.equal(
      detected,
      "legit-other-project",
      `DESTINATION PROOF: detectProject() from inside the nested git repo must resolve to its OWN git identity, not the ancestor's allowlisted slug; got "${detected}"`,
    );

    const autoResolved = await core.resolveProject("auto");
    assert.equal(autoResolved, "legit-other-project", "resolveProject(\"auto\") from the nested repo must not be annexed by the shallow ancestor's slug");
  });

  it("defense in depth: a PRE-EXISTING broad allowlist entry (predating this fix) must still yield to a nested repo's own git identity", async () => {
    // Simulate legacy on-disk state: an allowlist entry registered for a
    // broad ancestor path by code that predates the root-check fix.
    const ancestorDir = WORK_ROOT;
    const nestedRepo = path.join(WORK_ROOT, "legit-other-project-2");
    gitInit(nestedRepo, "legit-other-project-2");

    const allowlistDir = path.join(TEST_ROOT, "projects", "legacy-broad-project", "palace");
    fs.mkdirSync(allowlistDir, { recursive: true });
    fs.writeFileSync(
      path.join(allowlistDir, "cwd-allowlist.json"),
      JSON.stringify({ paths: [fs.realpathSync(ancestorDir)] }, null, 2),
      "utf-8",
    );

    process.chdir(nestedRepo);
    const detected = await core.detectProject();
    assert.equal(
      detected,
      "legit-other-project-2",
      `a legacy ANCESTOR-prefix allowlist entry must not outrank this directory's own git identity; got "${detected}"`,
    );
  });

  it("legit case preserved: an EXACT allowlist registration (explicit write from a real project root) still wins outright", async () => {
    const projectRoot = path.join(WORK_ROOT, "prismma-web-precedent");
    gitInit(projectRoot, "prismma"); // git remote name deliberately differs from the intended slug

    process.chdir(projectRoot);
    const resolved = await core.resolveProject("prismma-gateway");
    assert.equal(resolved, "prismma-gateway");

    const allowlistPath = path.join(TEST_ROOT, "projects", "prismma-gateway", "palace", "cwd-allowlist.json");
    assert.ok(fs.existsSync(allowlistPath), "a genuine project ROOT (has its own .git) must still be registered into the allowlist");

    const detected = await core.detectProject();
    assert.equal(
      detected,
      "prismma-gateway",
      "an EXACT cwd-allowlist match must still win outright over this directory's own (differently-named) git identity — the whole point of the allowlist override",
    );
  });

  it("CRITICAL-2 regression fix (2026-08-20): a SUBDIRECTORY of an overridden root inherits the override, not raw git identity", async () => {
    // Reproduces reports/2026-08-20-identity-trust-review.md's CRITICAL-2:
    // the "legit case preserved" test above only ever calls detectProject()
    // from the project ROOT itself. A LATER session running from a
    // subdirectory of that SAME repo (the single most common real-world
    // calling pattern — an IDE/agent cwd is rarely the literal repo root)
    // used to fall through to raw git identity ("prismma") instead of
    // inheriting the override ("prismma-gateway"), silently misfiling into
    // a different, real, pre-existing project.
    const projectRoot = path.join(WORK_ROOT, "prismma-web-subdir-precedent");
    gitInit(projectRoot, "prismma"); // git remote name deliberately differs from the intended slug

    process.chdir(projectRoot);
    const resolved = await core.resolveProject("prismma-gateway");
    assert.equal(resolved, "prismma-gateway");

    const subDir = path.join(projectRoot, "src", "components");
    fs.mkdirSync(subDir, { recursive: true });
    process.chdir(subDir);

    const detected = await core.detectProject();
    assert.equal(
      detected,
      "prismma-gateway",
      `DESTINATION PROOF: detectProject() from a SUBDIRECTORY of the overridden root must inherit the override (directory identity), not fall back to the raw git remote name; got "${detected}"`,
    );

    const autoResolved = await core.resolveProject("auto");
    assert.equal(autoResolved, "prismma-gateway", "resolveProject(\"auto\") from the subdirectory must also inherit the override");
  });

  it("a genuinely DIFFERENT nested repo under an overridden root still wins on its own identity (directory-identity fix does not reopen CRITICAL-3)", async () => {
    // The directory-identity fix must not regress CRITICAL-3's own repro:
    // a distinctly-identified git repo NESTED under an overridden root is a
    // different directory (its own git toplevel != the override's
    // registered path) and must still win on its own identity, not be
    // annexed by the ancestor override.
    const projectRoot = path.join(WORK_ROOT, "prismma-web-nested-precedent");
    gitInit(projectRoot, "prismma");

    process.chdir(projectRoot);
    await core.resolveProject("prismma-gateway");

    const nestedRepo = path.join(projectRoot, "vendor", "some-other-checkout");
    gitInit(nestedRepo, "some-other-checkout");

    process.chdir(nestedRepo);
    const detected = await core.detectProject();
    assert.equal(
      detected,
      "some-other-checkout",
      `a genuinely nested, distinctly-identified repo must win on its own git identity, not the ancestor override; got "${detected}"`,
    );
  });

  // CI windows-latest regression (2026-10-12, run 38230438655): GitHub's
  // windows runner TEMP is C:\Users\RUNNER~1\... — an 8.3 SHORT name
  // ("runneradmin" > 8 chars). The allowlist stored one spelling of the
  // project root while `git rev-parse --show-toplevel` returned the other,
  // and normalizePath used fs.realpathSync (the JS implementation), which
  // resolves symlinks but NOT 8.3 aliases — so the CRITICAL-2 directory-
  // identity gate's strict string compare failed and detection fell through
  // to the raw git remote name ("prismma"). fs.realpathSync.native resolves
  // 8.3 aliases to the canonical long form on win32; comparisons are
  // additionally case-folded on win32 (NTFS is case-insensitive).
  it(
    "win32 CI regression (2026-10-12): override inheritance survives an 8.3 short-name cwd (RUNNER~1-style temp)",
    { skip: !IS_WIN },
    async (t) => {
      const projectRoot = path.join(WORK_ROOT, "prismma-web-shortname-precedent");
      gitInit(projectRoot, "prismma");

      // Register the override from the LONG spelling of the root.
      process.chdir(projectRoot);
      const resolved = await core.resolveProject("prismma-gateway");
      assert.equal(resolved, "prismma-gateway");

      const shortRoot = shortPathOf(fs.realpathSync(projectRoot));
      if (!shortRoot || shortRoot.toLowerCase() === fs.realpathSync(projectRoot).toLowerCase()) {
        t.skip("volume has 8.3 name generation disabled — no short form to exercise");
        return;
      }

      // Later session: cwd reaches a SUBDIRECTORY through the 8.3 spelling.
      fs.mkdirSync(path.join(projectRoot, "src", "components"), { recursive: true });
      process.chdir(path.join(shortRoot, "src", "components"));
      if (process.cwd().toLowerCase() === path.join(fs.realpathSync(projectRoot), "src", "components").toLowerCase()) {
        t.skip("OS canonicalized the short-name cwd — nothing to exercise");
        return;
      }

      const detected = await core.detectProject();
      assert.equal(
        detected,
        "prismma-gateway",
        `an 8.3 short-name spelling of the SAME overridden root must inherit the override ` +
        `(realpath-normalized directory identity), not fall back to the raw git remote name; got "${detected}"`,
      );
    },
  );

  it(
    "win32: override inheritance is case-insensitive (NTFS) — a case-mangled cwd still inherits",
    { skip: !IS_WIN },
    async (t) => {
      const projectRoot = path.join(WORK_ROOT, "prismma-web-case-precedent");
      gitInit(projectRoot, "prismma");

      process.chdir(projectRoot);
      const resolved = await core.resolveProject("prismma-gateway");
      assert.equal(resolved, "prismma-gateway");

      const sub = path.join(projectRoot, "src");
      fs.mkdirSync(sub, { recursive: true });
      // Mangle the case of the LAST root component (NTFS resolves it to the
      // same directory) and flip the drive letter's case for good measure.
      const base = path.basename(projectRoot).toUpperCase();
      const mangled = path.join(path.dirname(projectRoot), base, "src");
      const driveFlipped = mangled[0] === mangled[0].toUpperCase()
        ? mangled[0].toLowerCase() + mangled.slice(1)
        : mangled[0].toUpperCase() + mangled.slice(1);
      process.chdir(driveFlipped);
      if (process.cwd() === sub) {
        t.skip("OS canonicalized the case-mangled cwd — nothing to exercise");
        return;
      }

      const detected = await core.detectProject();
      assert.equal(
        detected,
        "prismma-gateway",
        `a case-differing spelling of the SAME overridden root must inherit the override; got "${detected}"`,
      );
    },
  );

  it("a project root with only package.json (no git) can still be registered", async () => {
    const projectRoot = path.join(WORK_ROOT, "no-git-project");
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "no-git-project" }), "utf-8");

    process.chdir(projectRoot);
    await core.resolveProject("no-git-project");
    const allowlistPath = path.join(TEST_ROOT, "projects", "no-git-project", "palace", "cwd-allowlist.json");
    assert.ok(fs.existsSync(allowlistPath), "a package.json root (no .git) must still qualify as a project root");
  });
});
