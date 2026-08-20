# AgentRecall — Identity-Trust Fix Report (red-team CRITICAL-2/CRITICAL-3)

- SOP: plywood 2b249d59, wave/p1-identity
- Worktree: `/tmp/ar-p1b/ident`, branch `wave/p1-identity` @ `a7465ff` (v3.4.45 shipped)
- Evidence: `reports/2026-08-18-eval-redteam.md` CRITICAL-2 (WM-rescue hijack) + CRITICAL-3 (cwd-allowlist annexation)
- Meta-class: the store trusted an **unauthenticated cwd/slug claim** to route memory into a **real project**, with no cryptographic way to distinguish a genuine local file from a planted one (local single-user tool — the fix is trust-*ordering*, not fake auth).

## 1. Class enumeration

Every site where a claimed cwd/slug decides real-project routing, confirmed by grep across `packages/*/src`:

| Site | File | Trusts | Verified before this fix? | Action taken |
|---|---|---|---|---|
| `guessSlugFromWmLines` | `core/storage/working-memory.ts` | Self-claimed `cwd` field inside a WM `.jsonl` line, majority-voted | No — format-only (`isValidProjectSlug`) | Left as-is (the guess mechanism itself); consumers below now grade its OUTPUT |
| `rescueOrphanedWorkingMemory` → `distillOneSession` | `core/storage/working-memory.ts` | Any `<root>/working-memory/<sid>.jsonl` file, however it got there (dropped directly bypasses `wmAppend`'s scrub entirely) | No | Recency-ledger append now tagged `source: "working-memory-rescue"` (CRITICAL-2) |
| `resurrect()` Source 1 (recent-sessions.jsonl) | `core/tools-logic/resurrect.ts` | Ledger `slug`/`title` written by the rescue path above | No | Reads the new `source` tag → `untrusted` |
| `resurrect()` Source 3 (session cards) | `core/tools-logic/resurrect.ts` | Card frontmatter `slug` for a `source: working-memory-rescue` card | No | Reads `metadata.source` → `untrusted` |
| `resurrect()` Source 4 (WM-live) | `core/tools-logic/resurrect.ts` | Same `guessSlugFromWmLines` heuristic, ephemeral (no on-disk annexation) | No | **Deliberately left unfixed** — see §4 CHALLENGE/decision |
| `resolveProject` → `addCwdToAllowlist` | `core/storage/project.ts`, `core/storage/cwd-allowlist.ts` | `process.cwd()` for ANY explicit `--project X` write, no root check | No | Gated behind `isProjectRoot(cwd)` (CRITICAL-3) |
| `detectProject` → `findProjectByCwd` | `core/storage/project.ts`, `core/storage/cwd-allowlist.ts` | Longest-prefix allowlist match, before git identity, exact and ancestor matches treated identically | No | Ancestor (non-exact) matches now yield to the queried dir's own git identity (CRITICAL-3, defense in depth) |
| session-start.ts "live" continuity line | `core/tools-logic/session-start.ts:579` | Same `guessSlugFromWmLines`, but ephemeral (rendered once, never persisted) | No | Out of scope — not a routing/annexation vector, and its own content is already covered by the P1 fence-completeness harness (`session-start-continuity.test.mjs` is in the tracked fence manifest) |

No other call site matched `guessSlugFromWmLines`, `addCwdToAllowlist`, `findProjectByCwd`, `resolveProject`, or `detectProject` in a way that decides *which project's on-disk store* something lands in — `resolveProject` is called from ~30 tools-logic files, but all of them delegate the actual trust decision to `project.ts`, which is the single choke point fixed below.

## 2. CRITICAL-2 (WM-rescue hijack) — red → green

**Design decision (the CHALLENGE):** the SOP offered two shapes — (a) quarantine rescued cards out of the real project namespace, OR (b) keep `source: working-memory-rescue` cards structurally down-weighted in ranking. I found the codebase already has a **locked-in acceptance test that contradicts quarantine**: `packages/mcp-server/test/kill9-orphan-rescue.test.mjs` (the "mandatory kill-9 e2e round trip") asserts the rescued card lands under `projects/<slug>/journal/*.md` and that a recency entry exists keyed to that same slug — i.e. "rescued into a searchable session card" is a documented, tested contract, not accidental behavior. Moving rescue output to a quarantine directory would have broken that test and regressed a real durability guarantee (a genuinely crashed session must stay discoverable). **I implemented (b): structural down-weighting**, and made it a hard tier rather than a score multiplier so "cannot outrank" is a guarantee, not a probability.

**Fix, single trust boundary:**
1. `storage/recency-index.ts` — `RecentSessionEntry` gains an optional `source?: string` field.
2. `storage/working-memory.ts` — `distillOneSession`'s `appendRecentSession(...)` call is unconditionally tagged `source: "working-memory-rescue"` (this function has exactly two callers, `rescueOrphanedWorkingMemory` and `distillSessionToCard`, both rescue-context by construction — no per-branch reasoning needed).
3. `tools-logic/resurrect.ts` — `MergedSession`/`ContinuityBrief` gain an `untrusted: boolean` field. Set `true` when: Source 1's ledger row carries `source === "working-memory-rescue"`, OR Source 3's card frontmatter carries `metadata.source === "working-memory-rescue"`. OR-accumulated across sources — safe because a genuine card and a rescue card can never coexist under the same `(slug, sid)` key (`distillOneSession`'s `hasCard` idempotency guard refuses to write a rescue card once a real one exists for that sid).
4. **Ranking is a strict two-tier sort**, not a penalty: `briefs.sort((a,b) => a.untrusted !== b.untrusted ? (a.untrusted ? 1 : -1) : b.score - a.score)`. An untrusted entry can score arbitrarily high on keyword match and it still cannot cross the tier boundary.
5. `renderResurrectMarkdown` prints `- trust: unverified (working-memory-rescue — cwd claim was never independently corroborated)` for every untrusted brief, so the flag is visible in plain-markdown output too, not just the JSON `untrusted` field.

**Red → green, destination-proof (`resurrect()`'s own ranking output, not the source file):**

New test `packages/core/test/identity-trust-rescue-quarantine.test.mjs`, run against the **unmodified** baseline first to confirm RED:
```
✖ CRITICAL-2 repro: ... rescue-sourced/hijacked card (rank 0, score 50.95) must rank BELOW
  the genuine card (rank 1, score 0.11) even though the query terms were crafted to match
  the hijacked card's title verbatim
```
After the fix, same test, GREEN — hijacked entry ranks strictly below the genuine one regardless of score, `untrusted` is `true`/`false` correctly, and it is still discoverable (rescue is not disabled). A second test confirms an **ordinary crashed session with no injected content** is still rescued into a searchable card, still `resurrect()`-able, and correctly tagged `untrusted: true` (the tag reflects provenance, not intent — this is expected/desired, not a bug).

## 3. CRITICAL-3 (cwd-allowlist annexation) — red → green

**Two layers, per the threat model, both implemented (no CHALLENGE needed here — both halves of the suggested shape fit cleanly):**

**(b1) Root-check before allowlist registration** — `storage/project.ts`, new `isProjectRoot(dir)`: true iff `dir` itself (never a parent) contains `.git` or `package.json`. `resolveProject`'s explicit-slug branch now only calls `addCwdToAllowlist(project, cwd)` when `isProjectRoot(cwd)` is true. The explicit write **still resolves to the given slug unconditionally** — only the side effect of teaching the allowlist about this cwd for *future* `"auto"` calls is gated. This preserves the legitimate "prismma-web" precedent the allowlist was built for (an explicit write from a real project root whose slug legitimately differs from its own git remote name) while closing the shallow/parent-directory annexation.

**(b2) Git-toplevel identity wins over a broad allowlist claim in `detectProject`'s ordering** (defense in depth, for allowlist entries that predate this fix): `cwd-allowlist.ts` gains `findProjectByCwdWithExactness(cwd)`, returning `{slug, exact}` — `exact` is true only when the winning allowlist entry equals `cwd` itself, false when it only matched via a strict ancestor prefix. `detectProject` now: an **exact** match still wins outright (unchanged legit behavior); an **ancestor** match defers to `detectGitIdentity(cwd)` (factored out of the pre-existing git-remote/toplevel logic) when this exact directory has its own, different git identity — closing the gap for allowlist entries written by the old, unfixed code that are still sitting on a real user's disk.

**Red → green, destination-proof (`detectProject()`'s own resolved slug, not just "allowlist file exists"):**

New test `packages/core/test/identity-trust-cwd-root-gate.test.mjs`, RED against baseline:
```
✖ a non-root cwd must never be registered into the cwd-allowlist
✖ a legacy ANCESTOR-prefix allowlist entry must not outrank this directory's own git identity;
  got "legacy-broad-project"
```
GREEN after the fix: the shallow-dir explicit write still resolves to `shallow-project` but registers nothing; `cd` into the nested `legit-other-project` git repo and `detectProject()`/`resolveProject("auto")` both correctly resolve to `legit-other-project`, never annexed. A defense-in-depth test simulates a pre-existing broad allowlist entry (as if written by the old code) and confirms the nested repo's own git identity still wins. Two more tests lock in the legit cases: an **exact** allowlist registration from a real project root still wins outright even when it names the project differently from its own git remote (the original bug-fix use case), and a **package.json-only** root (no `.git`) still qualifies for registration.

## 4. Product-behavior confirmations needed from the owner

1. **Rescue-sourced content still surfaces by default**, just always ranked below every trusted entry and visibly labeled `untrusted`/"unverified" — it is not quarantined out of default `resurrect()` output. I chose this because (a) the existing kill-9 e2e test locks in "still searchable" as a durability contract, and (b) a strict two-tier sort already gives the "cannot outrank" guarantee without needing to hide the content. If you'd prefer rescue-sourced entries hidden from `resurrect()` unless an explicit flag is passed (closer to true quarantine), that's a small follow-up (filter `untrusted` briefs by default, add an `includeUnverified` input flag) — flag if you want it.
2. **`resurrect()`'s Source 4 (WM-live) is NOT tagged `untrusted`**, on purpose: unlike a rescue card, a live WM entry never gets written into a real project's on-disk store (no annexation), and "a live session outranks older completed work on pure recency" is an existing, separately-tested, intentional feature (`resurrect-wm-source.test.mjs`) that this fix must not regress. Residual gap I'm flagging, not fixing: a **freshly-dropped** (not yet aged into the orphan window) spoofed WM file can still win a keyword-crafted query via Source 4, since it bypasses `wmAppend`'s scrub and there's no orphan-sweep delay gating it. Narrower blast radius than CRITICAL-2 (ephemeral, no persisted card, no cross-project ledger propagation) — worth a follow-up ticket if you want it closed too.
3. No version bump, no push, no dependency changes made, per hard rules.

## 5. Harness (final, full run from repo root)

```
npm ci                                          # OK
npm run build                                   # OK, clean, all 4 workspaces
npm run lint  (tsc --noEmit ×4 workspaces)       # OK, zero errors
env -u AGENT_RECALL_SUPABASE_KEY npm test       # exit code 0
  core:        1197 pass / 0 fail / 0 todo
  mcp-server:    55 pass / 0 fail / 0 todo
  sdk:           39 pass / 0 fail / 1 todo   (pre-existing, TOW2-324, unrelated — confirmed identical on baseline a7465ff)
  cli:          190 pass / 0 fail / 1 todo   (pre-existing CJK-capture-gate xfail — confirmed identical on baseline a7465ff)
```
Zero attempts needed on the FIX/rerun loop (green on first full-suite run after implementation) — one intermediate self-correction: my first attempt marked ALL Source-4 (WM-live) `resurrect()` entries `untrusted` unconditionally, which broke the pre-existing `resurrect-wm-source.test.mjs` acceptance test (a live session must outrank older completed work on pure recency). Reverted that part per §4.2's reasoning before the final green run — no ESCALATE needed.

## 6. Invariant tests committed

- `packages/core/test/identity-trust-rescue-quarantine.test.mjs` — CRITICAL-2: spoofed rescue-sourced card cannot outrank genuine memory in `resurrect()`; genuine crash-rescue still works; rendered markdown visibly labels untrusted content.
- `packages/core/test/identity-trust-cwd-root-gate.test.mjs` — CRITICAL-3: non-root cwd cannot annex a git-identified nested project (fresh + legacy-allowlist-entry cases); exact-match and package.json-root legit cases preserved.

## 7. Files touched

- `packages/core/src/storage/cwd-allowlist.ts` — `findProjectByCwdWithExactness` (new), `findProjectByCwd` refactored onto shared `matchCwd`.
- `packages/core/src/storage/project.ts` — `isProjectRoot`, `detectGitIdentity` (factored out), `detectProject` reordering, `resolveProject`'s allowlist-registration gate.
- `packages/core/src/storage/recency-index.ts` — `RecentSessionEntry.source?`.
- `packages/core/src/storage/working-memory.ts` — tag rescue-sourced recency appends.
- `packages/core/src/tools-logic/resurrect.ts` — `untrusted` tracking (Sources 1/3), two-tier sort, render label.

Commit: `fix: stop trusting unauthenticated cwd/slug claims — rescue quarantine/downrank + cwd-root gate + git-identity precedence (red-team CRITICAL-2/3)` on `wave/p1-identity`.

---

SOP_ID: 2b249d59
FEEDBACK_HINTS: outcome=success edited=clean escalated=smooth
