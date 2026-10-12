# v3.5.0

First minor release since 3.4.0 — and the release where our versioning starts meaning what semver says it means. The 3.4.x line shipped feature waves as patch bumps because minor bumps were owner-gated; from here: features → minor, fixes → patch, breaking → major, notes on every tag. All four packages (`agent-recall-core`, `agent-recall-mcp`, `agent-recall-cli`, `agent-recall-sdk`) move to 3.5.0 in lockstep.

## Highlights

- **CI is green again, on two platforms.** `main` had been red since 2026-07-27 (the heeded-guard regression suite called `writeCorrection`/`recordOutcome` without awaiting them after they became async in 3.4.49). Fixed, and the workflow now runs the full build + regression suites + tests on `ubuntu-latest` **and** `windows-latest`, with a `build-and-test` fan-in job for branch protection.
- **Windows is a first-class platform.** `fileURLToPath` sweep for every `import.meta.url` path, Windows-correct path jails (`assertInsideRoot`, cwd allowlist, realpath jail, `classifyPath`), cross-platform npm scripts (no `rm -rf`/`cp`/`chmod`), and POSIX-only tests self-skip with named reasons. Ports and extends community PRs #24 and #22 (@buer5) and #19 (@lonelyhty) — thank you.
- **SDK: per-instance root isolation.** Concurrent `AgentRecall` instances no longer share mutable root state (`withRoot` via AsyncLocalStorage in core); the todo-marked contract test is now a hard regression guard.
- **Retrieval you can measure.** A golden-set retrieval harness with a committed, hash-locked synthetic fixture (`scripts/eval/fixtures/golden-v1`, 26 queries in 4 categories incl. CJK and freshness traps): hit@5 **73.1 %** keyword-only, **80.8 %** with the opt-in local embeddings model (the latter measured locally — the model is never downloaded in CI). Plus `session_start` injection-size and warm-latency benches with committed baselines (fixture v1: median **244 tokens**, p95 session_start **97 ms** on the reference PC). README now states for every number whether it regenerates from the repo or was self-measured on a private store.

## Fixes

- `filelock`: progress-aware contention deadline (a healthy busy lock no longer trips the 5 s skip), and a persistent `EPERM` with no lock owner ever observed now surfaces as `EPERM` instead of a contention error (win32).
- Embeddings config cache keyed on `ino:size:mtime:ctime` (same-tick rewrites no longer serve a stale entry); incremental journal index re-reads on equal mtime.
- Linux `npm test` is green as a non-root user (destination-proof suite, sync-errors scoping).
- Docs: SKILL.md tool counts (5 default / 6 `--full` / 13 with `AR_EXTRAS=1`), reproduction clone URL, UPDATE-LOG §C0 bin name, stale repository links, CHANGELOG entry for 3.4.51.

## Behaviour changes & upgrade notes

- No breaking API changes. New core export: `withRoot(root, fn)`.
- If you consumed 3.4.x casually, notable behaviour already shipped in that line: memory fencing wrappers (3.4.45), the unified `queryMemory` read pipeline (3.4.47), opt-in local embeddings `AGENT_RECALL_EMBEDDINGS=1` (3.4.49), evidence-grounded heed semantics (3.4.36/3.4.51). See CHANGELOG.md.

## Windows support

Known-good on Windows 11 + Git Bash (the shell steps need bash); CI runs `ubuntu-latest` and `windows-latest`. Four POSIX-only tests self-skip on Windows with named reasons (signal delivery ×3, symlink privilege); one mode-bit assertion is platform-guarded.

## Contributors

- @buer5 — deriveSlug path separator (#24), cross-platform npm scripts (#22)
- @lonelyhty — sync-errors root scoping (#19)

## Reproduce it yourself

    git clone https://github.com/Goldentrii/AgentRecall-X && cd AgentRecall-X
    npm ci && npm run build && npm test
    npm run bench            # correction-transfer bench on the hash-locked corpus (determinism + claim gates)
    npm run bench:golden     # golden-set retrieval hit@5 on fixture golden-v1
    npm run bench:injection  # session_start payload size (tokens, chars/4)
    npm run bench:latency    # warm recall / session_start latency (non-deterministic; schema-only in CI)

Engineering record for this release: `reports/2026-10-12-HANDOFF-STATUS.md`, `reports/RELEASE-3.5.0-draft.md` (semver rationale).
