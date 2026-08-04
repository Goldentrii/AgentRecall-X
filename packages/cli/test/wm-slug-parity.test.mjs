// packages/cli/test/wm-slug-parity.test.mjs
//
// H1 (review, post-build, v3.4.42 working-memory wave) — drift-guard fixture
// pinning core's `guessSlugFromWmLines` (packages/core/src/storage/
// working-memory.ts) against cli's `resolveSessionProject` ("F1",
// packages/cli/src/utils/transcript-reader.ts) for IDENTICAL cwd-only
// fixtures. Both functions independently implement the SAME cwd-regex family
// (`/^\/Users\/[^/]+\/(?:[Pp]rojects?)\/([^/]+)/`) because working-memory.ts
// cannot import from the cli package (core is a DEPENDENCY of cli, never the
// reverse — see working-memory.ts's own header comment on `guessSlugFromWmLines`).
// If someone tightens/loosens F1's regex without updating the WM copy (or
// vice versa), this file is the alarm that catches it.
//
// Two fixture classes, matching the two places the two functions are
// DELIBERATELY required to agree vs. deliberately allowed to diverge:
//   (A) an EXISTING on-disk project — both apply an "existing slug wins"
//       preference (F1's Signal 3; H1 added the same to guessSlugFromWmLines)
//       and must return the identical slug end-to-end.
//   (B) NO existing project anywhere — F1's full claim-not-generate policy
//       additionally requires content-signal corroboration (>=3 mentions in
//       real dialogue) before minting a brand-new slug, a signal that
//       structurally cannot exist in WM's cwd-only data (documented in
//       working-memory.ts's header) — so F1 correctly stays at "auto" while
//       guessSlugFromWmLines returns the cwd majority directly. This is a
//       DELIBERATE, documented divergence, not a bug — so this fixture pins
//       the underlying CANDIDATE the two regex families agree on (via F1's
//       `candidates` field) rather than pinning the two functions' final
//       `.slug` to be equal.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-wm-slug-parity-test-" + Date.now());

describe("H1 drift guard — guessSlugFromWmLines vs F1 resolveSessionProject (cwd-only fixtures)", () => {
  let reader;
  let core;

  before(async () => {
    reader = await import("../dist/utils/transcript-reader.js");
    core = await import("agent-recall-core");
  });

  after(() => {
    core.resetRoot?.();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    core.setRoot(TEST_ROOT);
  });

  it("(A) existing-slug case: both functions pick the SAME slug for identical cwd fixtures", () => {
    // "existing-project" has fewer cwd hits (1) than "noisy-project" (3), but
    // has a real on-disk project (journal entry, so core's own listAllProjects
    // recognizes it — the exact criterion H1 added to guessSlugFromWmLines)
    // AND a bare `projects/<slug>` dir (the criterion F1's own
    // listExistingProjectSlugs uses). Both signals point at the SAME
    // directory, so this fixture exercises both functions' "prefer existing"
    // tie-break identically.
    const journalDir = path.join(TEST_ROOT, "projects", "existing-project", "journal");
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(journalDir, "2026-08-04-note.md"), "# note\ncontent\n", "utf-8");

    const cwdA = "/Users/tongwu/Projects/existing-project";
    const cwdB = "/Users/tongwu/Projects/noisy-project";

    // guessSlugFromWmLines side — WM lines carry only ts/prompt/cwd.
    const wmLines = [
      { ts: "t0", prompt: "a", cwd: cwdB },
      { ts: "t1", prompt: "b", cwd: cwdB },
      { ts: "t2", prompt: "c", cwd: cwdB },
      { ts: "t3", prompt: "d", cwd: cwdA },
    ];
    const wmSlug = core.guessSlugFromWmLines(wmLines);

    // F1 side — same cwd values, as `cwd` fields on assistant/user records (no
    // real dialogue content mentioning either project by name, so the content
    // signal contributes 0 to both candidates — this fixture isolates the cwd
    // signal + existing-slug tie-break specifically, the part H1 pins).
    const line = (rec) => JSON.stringify(rec);
    const tailLines = [
      line({ type: "assistant", cwd: cwdB, message: { content: [{ type: "text", text: "ok" }] } }),
      line({ type: "assistant", cwd: cwdB, message: { content: [{ type: "text", text: "ok" }] } }),
      line({ type: "assistant", cwd: cwdB, message: { content: [{ type: "text", text: "ok" }] } }),
      line({ type: "assistant", cwd: cwdA, message: { content: [{ type: "text", text: "ok" }] } }),
    ].join("\n");
    const f1Result = reader.resolveSessionProject("", tailLines);

    assert.equal(wmSlug, "existing-project", `guessSlugFromWmLines should prefer the existing project; got ${wmSlug}`);
    assert.equal(f1Result.slug, "existing-project", `F1 should ALSO prefer the existing project; got ${JSON.stringify(f1Result)}`);
    assert.equal(wmSlug, f1Result.slug, "DRIFT ALARM: guessSlugFromWmLines and F1 resolveSessionProject disagree on the existing-slug case — their cwd-regex families and/or existing-slug tie-breaks have diverged");
  });

  it("(B) no-existing-slug case: the underlying cwd CANDIDATE agrees (documented selection-policy divergence in the final .slug)", () => {
    const cwd = "/Users/tongwu/Projects/candidate-only-project";

    const wmLines = [
      { ts: "t0", prompt: "a", cwd },
      { ts: "t1", prompt: "b", cwd },
    ];
    const wmSlug = core.guessSlugFromWmLines(wmLines);
    assert.equal(wmSlug, "candidate-only-project", "guessSlugFromWmLines returns the cwd majority directly when nothing exists on disk");

    const line = (rec) => JSON.stringify(rec);
    const tailLines = [
      line({ type: "assistant", cwd, message: { content: [{ type: "text", text: "ok" }] } }),
      line({ type: "assistant", cwd, message: { content: [{ type: "text", text: "ok" }] } }),
    ].join("\n");
    const f1Result = reader.resolveSessionProject("", tailLines);

    // DELIBERATE divergence (documented in working-memory.ts's header): F1's
    // full policy requires >=3 CONTENT-signal mentions (not cwd-signal) to
    // mint a brand-new slug — cwd-only data structurally never clears that
    // bar, so F1 correctly stays at "auto" here while guessSlugFromWmLines
    // (no minting gate) returns the majority directly. Assert the DIVERGENCE
    // explicitly so a future change that accidentally makes them agree here
    // is understood, not silently celebrated as "drift fixed" when it may
    // actually mean F1's minting gate broke.
    assert.equal(f1Result.slug, "auto", "F1 must NOT mint a new slug from cwd-only data (content-signal gate correctly unmet)");

    // What MUST agree: the underlying candidate + count the cwd-regex family
    // extracted — this is the actual drift-guard. If F1's CWD_PROJECT_RE
    // (transcript-reader.ts) and WM's CWD_SLUG_RE (working-memory.ts) ever
    // diverge on what counts as a valid `~/Projects/<name>` path, THIS
    // assertion is what catches it (independent of the minting-gate policy
    // difference above).
    const candidate = f1Result.candidates.find((c) => c.slug === wmSlug);
    assert.ok(candidate, `DRIFT ALARM: F1's cwd-regex family did not produce "${wmSlug}" as a candidate at all — got candidates ${JSON.stringify(f1Result.candidates)}`);
    assert.equal(candidate.count, wmLines.length, `DRIFT ALARM: F1 and WM extracted a different HIT COUNT for the same cwd fixture — got ${candidate.count}, expected ${wmLines.length}`);
  });
});
