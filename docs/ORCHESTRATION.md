# AgentRecall — Orchestration Handoff

How three parties collaborate on AgentRecall so work moves fast without losing
quality or control. Hand this file to the terminal agent; the orchestrator reads
it too.

---

## Roles

| Party | Who | Does | Never |
|-------|-----|------|-------|
| **Driver / Approver** | tongwu (you) | Decides what to build; approves every push, publish, version bump, and merge-to-main | — |
| **Implementer** | terminal agent (e.g. `claude` in `~/Projects/AgentRecall`) | Research → code → test → docs. Appends an UPDATE-LOG entry after each task | Push / publish / bump version / merge to main without explicit approval |
| **Orchestrator** | Claude (chat) | Strategy, review, feedback, catches mistakes. Reads the log, judges each change | Write code |

The orchestrator is a **reviewer of the log, not of the diff** — so the log must
carry enough evidence (test output, not claims) to judge the work. See the entry
template below.

---

## The loop (per task)

```
USER states a goal
  ↓
IMPLEMENTER:
    research → plan → execute → VERIFY (build + regression suites)
    for any non-trivial change: a fresh-eyes self-review before "done"
    append one UPDATE-LOG entry (template below)
    SYNC the changelog: run `node "~/Downloads/ar warroom/gen-changelog.mjs"`
        (UPDATE-LOG.md and the changelog HTML always move together)
  ↓
ORCHESTRATOR reads the entry, applies the review rubric, returns one of:
    APPROVE   — sound, serves the goal
    REVISE    — specific issues + why (implementer fixes, re-logs)
    ESCALATE  — a decision only USER can make
  ↓
USER approves push / merge, or redirects
```

The orchestrator never sees the code directly, so the loop's integrity depends on
the implementer **running the tests and reporting real results** — the same
discipline the done-definition checklist enforces.

---

## UPDATE-LOG entry template

Append to `UPDATE-LOG.md` — newest at the relevant section, never rewrite history.

```markdown
## <short title> (YYYY-MM-DD)
- What:   <the change, 1–2 lines>
- Why:    <goal / problem it solves>
- Files:  <paths touched>
- Verify: <commands run + RESULTS — build, suites, manual checks>
- Risks:  <known gaps / follow-ups / what is NOT done>
- Status: local commit <hash> | uncommitted | pushed (only if approved)
```

A future bilingual entry on the changelog page is derived from this log — see
`~/Downloads/ar warroom/gen-changelog.mjs`.

---

## Hard rules (REDLINE — non-negotiable)

1. **No `git push`, `npm publish`, deploy, or version bump without explicit user approval.**
2. Branch off `main` for any change; `main` stays clean and releasable.
3. Never skip tests. No test → write one first. Report failures honestly.
4. **Done-definition 4-point self-check** before declaring done: trace one error
   path; assume no global binaries (CI has none of your local tools); verify
   ternary/threshold ordering; check time-based logic against today's date.
5. MCP input security: any `z.string()` flowing into `path.join` / `RegExp` /
   `fs.*` needs a regex constraint or allowlist sanitization.
6. Consistency: when you change one place, update ALL places (code, docs,
   the arstatus CLI, the dashboard exporter — they must agree).

---

## Orchestrator review rubric

1. **Goal fit** — does it serve the current goal/OKR, or is it a detour?
   (Flag infrastructure-over-revenue; ask "5-minute version or 2-hour version?")
2. **Consistency** — agrees with `arstatus`, existing code, and docs?
3. **Correctness** — is the claim backed by test output, not assertion? Trace one
   error path the implementer may have happy-pathed.
4. **Blind spots** — elaborate-over-simple? built-before-searched-GitHub?
5. **Reversibility** — anything irreversible (push, delete, settings) → ESCALATE
   to USER, never auto-approve.

---

## Key paths

| What | Path |
|------|------|
| **Update log** | `~/Projects/AgentRecall/UPDATE-LOG.md` |
| Changelog (local, bilingual) | `~/Downloads/ar warroom/changelog.html` (+ `gen-changelog.mjs`, `changelog.zh.json`) |
| War-room dashboard | `~/.agent-recall/dashboard.html` · data `~/.agent-recall/dashboard.json` |
| Regression suites | `benchmark/{consistency,funnel,heeded-guard,room-slug-guards}.mjs` |
| Build | `npm run build --workspace=packages/core` (and `…/mcp-server`) |

---

## Appendix — external contributions (the 52 forks)

Target model: contributors work on **forks / feature branches**, open PRs; `main`
is protected; **merge requires tongwu's approval**; CI must be green first.

Minimal setup to make this real (in priority order):

1. **Branch protection on `main`** (GitHub → Settings → Branches): require a PR,
   require 1 approving review (you / CODEOWNERS), require status checks to pass,
   block direct pushes. *(Only the repo owner can set this — orchestrator advises,
   you click.)*
2. **CI workflow** `.github/workflows/ci.yml` — on `pull_request`: `npm ci`,
   `npm run build`, then the four regression suites. No secrets needed (suites use
   a throwaway root), so it runs safely on fork PRs.
3. **CODEOWNERS** → auto-requests your review on every PR.
4. **PR template** `.github/PULL_REQUEST_TEMPLATE.md` — checklist: tests pass, no
   version bump, no unrelated changes, done-definition checklist.
5. `CONTRIBUTING.md` already exists — extend it with branch naming + "run the
   suites locally before opening a PR."

Note: external contributors **cannot push branches to this repo** without write
access — they fork and PR from their fork. Reserve in-repo branches for trusted
collaborators.
