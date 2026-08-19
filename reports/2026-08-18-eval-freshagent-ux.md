# Fresh-Agent UX Probe — AgentRecall v3.4.43 (CLI-only, cold, no cheating)

Channel: `node ~/Projects/AgentRecall/packages/cli/dist/index.js <cmd>` against `/tmp/ar-eval-snapshot`
(`AGENT_RECALL_ROOT=/tmp/ar-eval-snapshot HOME=/tmp/ar-eval-snapshot`). Real `~/.agent-recall` never touched.
No MCP tools, no codebase reads, no other reports read. Everything below is derived only from CLI stdout.

Projects tested: **novada-mcp** (big/active), **prismma-ai** (small/active), **build** (stale, 124 days),
**AgentRecall** (the hard test).

---

## 0. First surprise, before any scoring

`ar cold-start` (the onboarding command) does **not** key off the directory you're standing in the way
the CLI's own help text implies. Confirmed by direct experiment:

```
cd _probe/build            # dir literally named "build", a real project slug that exists
ar stats --project pareto-loop     # one explicit override, from the WRONG cwd
ar stats                            # bare call, same cwd, right after
→ "AgentRecall Stats — pareto-loop"   # not "build", not "AgentRecall" either — pareto-loop
```

Root cause, found by diffing the filesystem around the call: each project keeps a
`projects/<slug>/palace/cwd-allowlist.json` — a running list of every cwd that has ever resolved to
that project. A single explicit `--project X` call from *any* directory **appends that directory to
X's allowlist permanently**, with no expiry and no dedup against other projects' lists. Repeating the
experiment with prismma-ai / novada-test-engineering / pareto-loop in sequence, from the exact same
`_probe/build` directory, left that one path sitting inside **four different projects'** allowlists at
once:

```
AgentRecall/palace/cwd-allowlist.json:            .../_probe/build  (+ ~30 unrelated real paths, see below)
prismma-ai/palace/cwd-allowlist.json:              .../_probe/build
novada-test-engineering/palace/cwd-allowlist.json: .../_probe/build
pareto-loop/palace/cwd-allowlist.json:             .../_probe/build
```

Bare (no `--project`) resolution consistently returned "whichever project was most recently bound to
this cwd" — 4/4 reproductions. No warning is ever surfaced that the cwd is claimed by multiple projects.

This is not just a synthetic artifact of my probe directory. **The real AgentRecall project's own
allowlist (carried over in this snapshot from the live store) already contains dozens of paths that
are not AgentRecall at all**: `/Users/tongwu/Projects/novada-mcp`, `/Users/tongwu/Projects/novada-mcp/src`,
`/Users/tongwu/Projects/prismma-ai/brand`, `/Users/tongwu/Projects/prismma-ai/web`,
`/Users/tongwu/Projects/tchin-talk`, `/Users/tongwu/Downloads`, `/Users/tongwu/Library/CloudStorage/.../BAFA`,
`/Users/tongwu/novada-telemetry`, etc. — real, unrelated, currently-active project directories. If any of
those paths' *own* project-specific allowlist entry is ever stale, absent, or loses a resolution
tie-break, cd-ing into one of them and running a bare `ar cold-start` risks silently returning
**AgentRecall's** context instead of the project actually being worked in. This is a real, already-present
cross-contamination surface in the live data, not a hypothetical.

**This one finding, if real in production, undermines the core promise of the tool** ("cd into a
project, cold-start gives you that project — automatically"). I flag it as the top structural risk of
the whole session; everything below assumes I explicitly pass `--project <slug>` to sidestep it, which
a genuinely fresh, uninstructed agent would not know to do.

---

## 1–2. Per-project orientation scorecard (cold-start only, `ar cold-start --project <slug>`)

Legend: ✅ fully-answered · 🟡 partially-answered · ❌ not-answered

| Project | (a) What is this project? | (b) Last thing done? | (c) Immediate next action? | (d) Rules/corrections not to violate? |
|---|---|---|---|---|
| **novada-mcp** (big) | 🟡 — `palace_context.identity` is **null**. No name/description/intention card at all. Only inferable indirectly from a `cache.hot` session brief mentioning `feat/oauth-restore`, "scrape/search/http/ai_monitor WIP" — you can guess "an MCP server product with OAuth + scraping tools" but it's never stated. | 🟡 — `cache.hot[0].brief`: "quick confirm: is another agent editing the oauth-restore WIP files?" + `## Last exchange` "how is our mcp server now?". Gives a real thread but is a fragment of one exchange, not a summary. `status --json .next` is **empty string**. | ❌ — no explicit next-step field populated; only inferable from the same fragment ("decide who can touch the WIP files"). | 🟡 — `p0_corrections` (5, project-scoped, real and useful: local-verified≠shipped, don't rollback placeholder-vs-real-secret, personal-vs-company key scope, customer-detection design question, AI-monitor scope). Global awareness top-insights (same for every project) add push/publish-approval CRITICAL rule. Good content, but nothing says "these are novada-mcp's rules" vs "global rules" — the two are mixed with no visual separation. |
| **prismma-ai** (small) | ❌ — identity also **null**. `cache.hot` brief mentions "Impressum" TODO / GmbH claim removed — you can infer "Prismma's web app, legal pages" but it's not stated anywhere. | 🟡 — `cache.hot[0].brief`: TODO about `app/impressum/page.tsx:36` GmbH claim + `## Last exchange` "let's go back to our prismma, how much can you recall?" — a real, usable thread. | ❌ — `status --json .next` empty; the TODO line is the closest thing to a next action but is buried inside `brief`, not surfaced as `next`. | 🟡 — `p0_corrections`: **0** (genuinely nothing recorded yet for this young project — correct, not a bug). Global awareness top-insights still present (push/publish CRITICAL etc.), so *some* guardrail is always visible even for a brand-new project. |
| **build** (stale, 124d) | 🟡 — the only project of the three with an actual identity card: *"Intention: Validate and improve the Website Genome SOP by building and replicating real sites from scratch."* Good, one clean sentence. | ❌ — `cache.hot` is **empty array**; `cache.cold.count: 1` but no entries surfaced in cold-start's payload (cold tier isn't inlined). `status --json .next` empty. A `resume-brief` palace room exists (1 recent entry, per `top_rooms`) but cold-start doesn't inline its content either — you'd have to separately run `ar palace read resume-brief`. | ❌ — same as above, nothing actionable surfaced without a follow-up command. | 🟡 — `p0_corrections`: 0 (plausible for a stale/thin project). Global insights still present. |
| **AgentRecall** (hard test, big+active) | 🟡 — identity card present: *"Build and ship AgentRecall — correction-first persistent memory for AI agents, zero infrastructure required."* Good sentence, but immediately followed by literal **"No description available."`** and "Language: unknown" — looks broken/half-populated right next to the one good line. | ✅ — `cache.hot` has 3 real entries incl. the full 2026-08-18 dream-consolidation report and a design discussion about the AgentRecall eval methodology itself. Rich and genuinely useful. | 🟡 — no `status --json .next` (empty, see §5), but `cache.hot`/`resurrect` surface a concrete decision point (5-layer vs L1+L3 eval scope) and Linear ticket TOW2-373. Requires reading `cache.hot`, not a dedicated "next action" field. | 🟡 — 5 project `p0_corrections`, all real (decision-menu format rule, "don't soften into vague language" rule, plywood-session-scoping rule, "we have no Codex channel" precision rule) + the global CRITICAL push/publish-approval insight. **Version-discipline specifically is not in this list** (see §4). |

**Time-to-context, qualitatively:** one `cold-start --project <slug>` call gets you 60–70% of the way for an
active project with real cache entries (novada-mcp, AgentRecall); it gets you almost nothing new for a
young/small project (prismma-ai, build) beyond the global rules — you have to already suspect there's more
and go fish with `ar resurrect`, `ar palace read <room>`, or `ar search` to fill in (a) and (c). That is 2–4
extra commands per project past the "ideal" of one screen. Nothing in cold-start's own output tells you
*which* follow-up command to run next when a field is empty (no "see `ar resurrect` for more" hint) — you
have to already know the CLI surface from `--help`.

---

## 3. Continuity test — `ar resurrect`

This is the strongest command in the whole CLI for the "what was I doing 10 minutes ago" use case.
Bare `ar resurrect` (pure recency) returned a clean, scannable list across projects — title, slug, date,
one-line goal, Linear ticket IDs, concrete next-step quotes, and provenance file paths:

```
## Novada MCP 页面设计回顾          ← mistitled, see below
## Check MCP server status
## Create ICS calendar event from image
```

`ar resurrect "what was I doing" --days 3` (keyword variant) worked too and surfaced 7 different
projects' latest threads with goal + next-steps + Linear refs each. This is genuinely close to the ideal
"one screen, I know what to do" — **if** you already know to run it. It is not mentioned anywhere in
`cold-start`'s own output.

Two defects surfaced here:

- **Mistitled entries carried across unrelated sessions.** The AgentRecall entry titled "Novada MCP 页面设计回顾" (Novada MCP page design review) is **not** about Novada MCP — its 2026-08-18 body is an AgentRecall
  self-evaluation design doc, its 2026-08-13 body (same `sid`) is an unrelated API-connectivity fire-fight,
  and its 2026-08-12 body is Linear ticket TOW2-373 planning. The `# ` H1 title was set once (apparently
  when that session id was first opened, actually about Novada MCP page design) and then **never updated**
  on later days despite the topic completely changing. A fresh agent scanning titles in `ar list`/
  `ar resurrect` would skip exactly the entry most relevant to "continue AgentRecall's own evaluation work"
  because its title points at an unrelated topic.
- **Same session id (`sid`) attributed to two different project slugs** in one `resurrect` call
  (`3f79f23e-...` appears once under `slug: novada-mcp` and once under `slug: novada-test-engineering`,
  same title "Check MCP server status", different `goal` text). Could be a legitimately cross-project
  session, but presented with zero disambiguation — a fresh agent can't tell if this is one session that
  touched two repos or a slug-classification error.

---

## 4. The hard test — resuming AgentRecall itself (v3.4.43)

Using only `ar cold-start --project AgentRecall` + one `ar resurrect` + one `ar search "version" --include-palace`:

- **Current version (v3.4.43):** ❌ **not visible anywhere in `cold-start`, `status`, or `stats` output.**
  Verified directly — `ar status --json` and `ar stats` print no version string; the `v3.4.43` banner only
  appears on `ar --help`, which is a side door, not the intended onboarding path. A fresh agent following
  only `cold-start` would not know what version is currently shipped.
- **Open follow-ups:** 🟡 partial. `cold-start`'s `trajectory` field says "follow-ups 三张票排队" (3 tickets
  queued) but names none of them. `cache.hot` + `resurrect` together surface a real, concrete decision
  point (Linear TOW2-373: full 5-layer eval scorecard vs. L1+L3-only) and two owner-todo items ("rule on
  proposals C6/C8/C10", "fix Codex form username to Goldentrii"). Reachable, but only by chaining 2 extra
  commands past cold-start.
- **Version-discipline rule:** 🟡 partial. Cold-start's global awareness top-insights **does** include a
  CRITICAL rule ("never push/publish without explicit approval — do not inflate version numbers on
  untested code"), so the guardrail is visible without extra digging. But it's sourced/tagged to
  `proxy4agent`, not AgentRecall by name, so a fresh agent has to trust that a generically-tagged insight
  applies here too. The *sharp*, AgentRecall-specific version of the rule — "AgentRecall (v3.5.0
  version-number decision)", "one-version-per-release correction", "VERSION constant in types.ts can
  silently drift from package.json" — only surfaces via a deliberate `ar search "version" --include-palace`
  follow-up (found in the project's own `palace:predictions` room). It is invisible to `cold-start` alone.

**Verdict on the hard test:** a fresh agent resuming AgentRecall from `cold-start` alone would correctly
inherit the *general* "don't touch versions without approval" instinct, would get a real (if
under-labeled) sense of the pending decision, but **would not know the current version number or that a
v3.5.0 decision is specifically pending** unless it thought to run `ar search version`. That is exactly the
kind of mistake AR's own CLAUDE.md worries about ("Version discipline... confirm the number before
applying") — the memory system holds the right fact, but doesn't push it through the one command a fresh
agent is told to run first.

---

## 5. Concrete moments AR left me stranded or misled

1. **`trajectory` and `awareness_summary` are global, not project-scoped, despite `cold-start` being a
   per-project command.** Byte-identical (verified via md5) across all 4 tested projects. For prismma-ai
   and build this actively misleads: `trajectory` claims "AgentRecall: review a week of WM + Train-C
   production data → v4 gate decision" even when the requested project is prismma-ai or build, which have
   nothing to do with that work. A fresh agent trusting the field name would think it describes *this*
   project's arc.
2. **cwd → project resolution is a mutable, unbounded, cross-writable allowlist** (§0) — the single most
   dangerous structural finding; already shows real cross-project pollution in the live snapshot data
   itself, not just my synthetic probe.
3. **Journal entry titles can go permanently stale** relative to their own content when a session id is
   reused across days on unrelated topics (§3) — actively hides the most relevant entry from a
   title-scanning fresh agent.
4. **`status --json .next` is empty for exactly the projects most worth checking** — both of the two
   *active, same-day* big projects (AgentRecall, novada-mcp) and the small one (prismma-ai) all show
   `"next": ""`, while several stale/idle projects (pareto-loop, Novada, aam, novadalabs-github) have it
   populated. From the AgentRecall project's own 2026-08-18 dream-report entry (surfaced via
   `ar resurrect`), the mechanism appears to be: a "resume brief" gets generated once, on the exact night a
   project crosses an inactivity-day threshold, and a missed nightly run permanently skips that window for
   some projects. The one field most likely to answer "what do I do right now" is populated by inactivity-
   day-count luck, not systematically for every project on every cold-start call.
5. **`palace_context.identity` is null for both the big project (novada-mcp) and the small project
   (prismma-ai)**, while it's populated for the barely-touched stale project (build) and AgentRecall. There
   is no consistent guarantee that "what is this project" gets answered — it's inversely correlated with
   how much you'd want it (missing for the two most actively-worked projects tested).
6. Minor: AgentRecall's own identity card reads *"...zero infrastructure required.\n# AgentRecall\nNo
   description available."* — a good sentence immediately undercut by a literal "No description
   available" placeholder rendered right next to it, and "Language: unknown" — looks broken even though
   part of the card is genuinely good content.

---

## Can a zero-context agent resume real work on AR output alone?

**Partial yes, with real risk.** For an actively-worked, well-instrumented project (AgentRecall, and to a
lesser extent novada-mcp) a fresh agent chaining `cold-start` → `resurrect` → (if needed) `search` gets a
usable, mostly-correct picture of what happened last and what's pending, plus real project-scoped
corrections. For a small or stale project, `cold-start` alone is close to useless beyond the global rules —
you need `resurrect`/`palace read` to get anything concrete, and there's no hint from `cold-start` telling
you to go look. And underneath all of it sits a cwd-resolution mechanism that can silently hand you a
*different* project's memory with no error, which is already visibly true in the real accumulated data, not
just a hypothetical edge case.

## Proposed grade (lived UX, not mechanism): **C+ / 6 out of 10**

The individual retrieval primitives (`resurrect`, project-scoped `p0_corrections`, `cache.hot` briefs) are
genuinely good and would score higher in isolation. The grade is capped by: a broken per-project
`trajectory`/`awareness` distinction, an unreliable/gameable cwd→project resolver, stale entry titles, and
an inconsistent "next action" field that's most often empty exactly where it matters most. None of these
are exotic edge cases — all four were hit within the first ~15 CLI calls of an honestly-cold session.

## #1 fix that would most improve a fresh agent's experience

**Make `cold-start` self-sufficient and honest about scope.** Concretely: (1) stop returning a global
`trajectory`/`awareness_summary` under a per-project command — either scope it for real or rename/label it
clearly as cross-project so it can't be mistaken for "this project's arc"; (2) when `status.next` /
`identity` are empty, have `cold-start` say so explicitly and name the exact follow-up command to run
(`ar resurrect`, `ar palace read resume-brief`) instead of silently returning blank fields; (3) fix cwd
resolution so an explicit `--project` call from an unrelated directory never contaminates that directory's
future bare-call resolution (require confirmation, or scope the allowlist entry to session-only, or dedupe
across projects and surface a conflict warning). Of these, cwd-resolution safety is the one with the
highest blast radius, since it's already observably polluted in the live store.

---

SOP_ID: c36ba121
FEEDBACK_HINTS: outcome=partial edited=clean escalated=smooth
