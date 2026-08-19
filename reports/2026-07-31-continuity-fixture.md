# Continuity Fixture — "novada mcp 页面设计" misfiling incident (2026-07-31)

Role: 数据分析工兵ᅠ| Read-only over `~/.agent-recall`ᅠ| No AgentRecall source touched.

## 0. HEADLINE CORRECTION (read this first)

The task brief's premise is **wrong on the facts**, verified by direct evidence below:

> `e577afbf-...` (project `novada-mcp-funnel`) is **not** the main "novada MCP 页面设计" dialogue.

`e577afbf` is a session about editing the hero card on the `novada-mcp-funnel` **docs site**
(`novada-ai-docs-rewrite-2026-07-30/index.html`) and explaining what an `.mcpb` bundle is — topically
unrelated. Its only "MCP原型/V13" text is the generic `folder-lint` startup-hook warning that fires in
**every** session that day (it also fires, verbatim, in `4c113109` and `6c9644e8`) because three stray
files sit in `~` root. Likewise `4c113109` (project `auto`) is an unrelated PLG/flywheel strategy
discussion — same boilerplate false lead.

The **real** main dialogue is a 4th file, not in the original list, found by chasing the palace/insight
graph rather than the raw text: **`~/.agent-recall/projects/novada-mcp/journal/archive/raw/2026-07-31--8a02c8b2-d37b-4681-8bf2-bcf0b6b9d37d.md`** (project slug `novada-mcp` — the MCP *server* monorepo
slug, also wrong, just less wrong). `6c9644e8` (project `AgentRecall`) is a genuine but *secondary*
diagnostic session that immediately preceded it (same opening line: "how much can you recall on our
mcp page design?"), in which the assistant discovered recall() was empty, `ls`'d `~` to find the V13/V14
files, then continued into (or was followed by) `8a02c8b2` where the user actually dictated the design
feedback and the epic got written.

**Second-order bug found live**: inside `8a02c8b2` itself, the assistant called
`mcp__agent-recall__remember()` to leave a pointer for future recall — and that pointer **itself cites
the wrong raw file** (`novada-mcp-funnel/.../e577afbf-*.md`), and the `remember()` call **itself** got
auto-filed under project `AgentRecall` instead of `novada-mcp` or a dedicated slug. The assistant flagged
this live in its own transcript: *"even my `remember()` got auto-filed under 'AgentRecall' — the
fragmentation bug reproducing live."* So the task brief's wrong pointer was not invented upstream of AR —
**AR's own memory wrote the bad citation that misled whoever briefed this task.** This is the incident,
reproducing itself one layer up.

No file among any of the 4 sessions contains "TOW2-357" **as body text needing extraction** except by
following this chain — it was not sitting in the file the brief named. `TOW2-357` and the 9 children ARE
real (see §3), sourced from `8a02c8b2` and cross-confirmed by the already-written canonical memory
`~/.claude/projects/-Users-tongwu/memory/project_novada_mcp_page.md`.

Four project slugs are entangled in this one incident: `novada-mcp` (real dialogue, wrong slug — it's
the server monorepo's slug), `AgentRecall` (diagnostic session + the mis-cited remember() call),
`novada-mcp-funnel` (unrelated, red herring), `auto` (unrelated, fallback default). None of the four is
the correct home. The correct work-line name is **`novada-mcp-page`** (§3.6).

---

## 1. Raw archive structure

All 4 files share one shape:

```yaml
---
project: <slug>
sessionId: <uuid>
savedAt: <ISO8601>
source: hook-archive
transcriptPath: "<absolute path to ~/.claude/projects/.../<uuid>.jsonl>"
---
<body: near-verbatim slice of the Claude Code transcript JSONL>
```

**Frontmatter** — 5 keys, plain YAML, 100% machine-extractable, always present, never truncated.

**Body** — looks like JSONL (one record per `wc -l` line) but is **not valid line-delimited JSON**:
- Record types seen: `last-prompt`, `mode`, `permission-mode`, `attachment` (hook stdout, incl.
  `SessionStart:startup` boilerplate — orchestrator brief, folder-lint, memory-stale-check, Plywood
  protocol dump), `file-history-snapshot`, `ai-title`, and the real `user`/`assistant` message records
  (Claude message schema: `text` / `thinking` / `tool_use` / `tool_result` blocks).
- Many "lines" contain **literal unescaped newline/control characters** inside JSON string values (not
  `\n` escapes), so a single logical record spans multiple physical lines — naive `sed -n Np` or
  strict `JSON.parse` per line silently corrupts or drops records. A `JSONDecoder(strict=False)` +
  `raw_decode` scan (skipping to the next record on failure) recovers the large majority; some records
  still fail (embedded literal `"` inside e.g. Linear ticket bodies or shell commands breaks even that).
- **Hard truncation, confirmed empirically**: body is capped at **exactly 80,000 characters** in 3 of 4
  files (`e577afbf`: 80000, `4c113109`: 80000, `8a02c8b2`: 80000; `6c9644e8`: 79992, i.e. the source
  transcript was itself just under the cap). Truncation cuts the **tail**, not the head — every file
  ends mid-JSON-string, never with a clean closing brace. This is the worst possible truncation policy
  for a "session card": it preserves low-value session-start hook noise at the top and discards the
  newest/most-summary-dense messages at the bottom. For any session whose real content exceeds ~80K
  chars (a "long conversation with different topics," exactly as the user described this one), the
  ending — typically where decisions/next-steps live — is at risk of being silently cut off. `8a02c8b2`
  survived mostly intact by luck (its closing question happened to land just before the cutoff); this
  should not be assumed to hold in general.
- Did not find the source of the 80,000-char cap inside AgentRecall's own package dist
  (`packages/core/dist/storage/archive-write.js` has no `80000` literal); it likely lives in the
  Claude Code hook glue that feeds the archiver, outside AR's own repo. Not chased further (out of
  read-only scope for this task; flagging for whoever owns the fix).

---

## 2. Session-card field feasibility (goal / state / decisions / artifacts / linear / next-steps)

| Field | Mechanical? | Notes |
|---|---|---|
| project / sessionId / savedAt / transcriptPath | **Yes, 100%** | YAML frontmatter, always present, never truncated. |
| Goal | **No — LLM required** | Buried in the first user message, which can itself be an unstructured meeting-transcript dump ("this is a very long conversation... I need you to make it straight" — literally asking the agent to do what this task is doing). No structural marker separates "goal" from noise. |
| State / what was done | **No — LLM required**, but tool-call inventory is free | Regex over `"name":"..."` inside `tool_use` blocks gives a mechanical list of tools invoked (Bash/Edit/Linear/recall calls) — a decent skeleton — but turning that into readable "what happened" prose needs LLM synthesis. |
| Key decisions | **Partially mechanical — a real shortcut** | If the session called `mcp__agent-recall__remember()` or `ar palace write` itself, the decision text is *already distilled* and sits in the `tool_use.input.content` field verbatim (regex `"name":"mcp__agent-recall__remember"` → grab `input.content`). This worked perfectly here. **Caveat**: the distilled text can itself be wrong (see §0 — this session's own `remember()` call cited the wrong raw file), so mechanical extraction of "a decision was recorded" is reliable; trusting its *content* as ground truth is not — needs a diff-against-source spot check. |
| Artifacts (file paths) | **Mechanical with a precision rule** | Naive regex for `/Users/tongwu/...` or `~/...` paths anywhere in the body is high-recall but **catastrophically low-precision** — it is exactly how this task's brief got fooled (V13/V14 paths appear in every session that day purely via the folder-lint hook string, regardless of topic). Fix: only trust paths that appear (a) inside `Edit`/`Write`/`NotebookEdit` `tool_use.input.file_path`, or (b) inside a `Bash`/`ls` `tool_result` listing — never inside an `attachment`/`hook_success` content string. With that rule, mechanical extraction is precise. |
| Linear refs (epic/children) | **Mechanical with the same precision rule** | Regex `TOW2-\d+` catches everything, including unrelated IDs quoted in the orchestrator-brief hook boilerplate (saw `TOW2-310`, `TOW2-276` leak in from unrelated projects). When the session calls `mcp__linear__save_issue` directly, the identifier is unambiguous and 100% mechanical. Otherwise needs LLM/contextual filtering to separate "this session's own epic" from "an ID mentioned in passing." |
| Next steps | **No — LLM required**, last-assistant-text is a decent seed | Heuristic "take the final assistant text block" worked here (it was literally a closing (a)/(b) question) but is fragile given the tail-truncation risk in §1 — for a session that actually got cut off, this heuristic returns a fragment, not a next-step. |
| Correct project/work-line slug | **No — this is the bug itself** | The one field structural/regex extraction cannot fix, because it's a classification problem, not an extraction problem. The working fix observed in the data is *not* automatic reclassification — it's a hand-written canonical local `.md` (see `project_novada_mcp_page.md`) that the agent created *specifically because* it distrusted the auto-slug. |

**Bottom line for the orchestrator**: a session-card distiller can be ~70% mechanical (frontmatter,
tool inventory, remember()/palace-write payloads when present, Linear IDs from direct tool calls, file
paths from Edit/Write/ls-result contexts only) but the remaining 30% (goal, narrative state, next-steps,
and — critically — *which slug this belongs to*) needs an LLM pass, and that LLM pass must be told
explicitly to distrust hook-boilerplate text as a source of artifacts/IDs, or it will reproduce this
exact incident.

---

## 3. Continuity fixture — `8a02c8b2-d37b-4681-8bf2-bcf0b6b9d37d` (real main dialogue)

Source: `~/.agent-recall/projects/novada-mcp/journal/archive/raw/2026-07-31--8a02c8b2-d37b-4681-8bf2-bcf0b6b9d37d.md`
(savedAt 2026-07-31T10:44:34.940Z). Preceded by diagnostic session `6c9644e8` (project `AgentRecall`,
savedAt 10:32:25, opening line "let's go back to novada mcp 页面设计, how much did you recall?" —
same question repeated as `8a02c8b2`'s own opener 12 min later, i.e. this is one continuous piece of
work split across ≥2 Claude Code session files).

### 3.1 Goal
Resume and "make straight" a long, topic-jumping design-review conversation about the **Novada MCP
config/onboarding page** (product surface: `novada-web` repo's `app/mcp/page.tsx` wizard), based on
feedback the owner's domestic team gave in a meeting reviewing prototype **V14**. Secondary ask:
write the organized feedback into Linear.

### 3.2 What was done
1. Recall audit: owner asked "how much can you recall on our mcp page design?" Structured `recall()`
   returned almost nothing (only a stale, unrelated "novada-mcp is Chinese-first" insight). The
   folder-lint startup hook was the only lead, flagging 4 stray files in `~`.
2. Manually `ls`'d home dir, found (real timestamps): `交付物2_MCP原型_V14.html` (newest, Jul 31 10:28),
   `交付物2_MCP原型_V13.html` (Jul 23), `交付物2_MCP原型_V13_修改说明_2026-07-23.md` (Jul 23),
   `mcp_log_create_接口文档.md` (Jul 24). Read V14's head to confirm it's a single-file HTML,
   Novada purple `#7c3aed`, topbar + left sidebar + tabs console layout, `lang="zh-CN"`.
3. Owner then dictated ~13 minutes (11:44–11:57am) of raw, unstructured meeting-feedback transcript —
   8 friction points from the domestic team's review of V14:
   - Confusion between SSE and Streamable HTTP shown together in one box — competitor ("Bright"/BrightData-like reference, "image 11/14") separates them, asked to do the same.
   - Split "AI setup" (agent does everything, human just pastes) vs "Manual setup" (human does it themselves).
   - Don't gate tool access behind a per-tool confirm step — all tools are already unlocked; just communicate "you can use 30% of your capability," auto-expand the first category (search & extract).
   - Add current balance display in the top-right corner; anonymous users get $10 free credit and can walk the whole page without registering (funnel, not gate).
   - "novada key" / auth-vs-authorization naming makes no sense to the owner or to customers — needs a plain-language "when do you need this" framing.
   - Local setup should mirror a competitor's clean 1-2-3 flow + working "advanced settings."
   - n8n integration flagged — wants it built now (for Linear tracking) but not highlighted yet (not ready).
   - Aside, unrelated to the page: a separate session already submitted an API-key-change request; OAuth is still pending, owner will ask the team.
4. Assistant organized the 8 items into a locked spec and created a **Linear epic (TOW2-357) with 9
   child issues (TOW2-358..366)**, mapped 1:1 to the feedback (see §3.4).
5. Assistant called `mcp__agent-recall__remember()` to leave a recall pointer — the pointer's raw-file
   citation is **wrong** (see §0) and the call itself landed under project `AgentRecall`.
6. Assistant then hand-wrote the canonical local memory file
   `~/.claude/projects/-Users-tongwu/memory/project_novada_mcp_page.md` (new) and inserted an index
   line into `~/.claude/projects/-Users-tongwu/memory/MEMORY.md`'s Projects section, explicitly as a
   more reliable fix than trusting AR's auto-classification.
7. Session ends on an open fork put to the owner (§3.5).

### 3.3 Artifacts
| Path | Status this session | Note |
|---|---|---|
| `~/交付物2_MCP原型_V14.html` | Pre-existing (Jul 31 10:28), read/confirmed only | Latest standalone prototype. **Reference only — not the ship target** (per canonical memory). |
| `~/交付物2_MCP原型_V13.html` | Pre-existing (Jul 23) | Prior version. |
| `~/交付物2_MCP原型_V13_修改说明_2026-07-23.md` | Pre-existing (Jul 23) | V13 changelog. |
| `~/mcp_log_create_接口文档.md` | Pre-existing (Jul 24) | API doc log. |
| `~/.claude/projects/-Users-tongwu/memory/project_novada_mcp_page.md` | **Created this session** | Canonical local memory — the real distilled spec, verified accurate against the raw dialogue during this audit. |
| `~/.claude/projects/-Users-tongwu/memory/MEMORY.md` | **Edited this session** | Inserted `novada-mcp page redesign` line under Projects. |
| `~/.agent-recall/projects/AgentRecall/palace/rooms/decision/novada-mcp-page.md` | **Created this session** | Palace decision note — contains the wrong e577afbf citation (defect artifact, not clean). |
| `novada-web` repo `app/mcp/page.tsx` (+ `novada-mcp-page-v2.html` per canonical memory) | **Not touched yet** | The actual ship target — implementation is the next step, not done in this session. |

### 3.4 Linear refs
Epic **TOW2-357** (team TongWu), spec locked by owner 2026-07-31, 9 children:
- **TOW2-358** P1 — Step 01 capability overview (not a gate): 30-tool taxonomy across 7 categories, auto-expand first group.
- **TOW2-359** P1 — Step 02 split: AI setup (primary) vs Manual (secondary).
- **TOW2-360** P2 — AI-setup module + finalized paste-prompt. **Flagged URGENT / most important piece.**
- **TOW2-361** P3 — Manual/Remote decluttered: Streamable HTTP only, no SSE tab.
- **TOW2-362** P3 — Manual/Local: 1-2-3 flow + working Advanced settings.
- **TOW2-363** P3 — Summary sidebar as funnel (logged-in real balance / anonymous $10 CTA); open delta not yet folded in: also show balance in top-right topbar.
- **TOW2-364** P4 — Completion: confetti + demoted test/endpoint.
- **TOW2-365** — n8n integration (build now, highlight later).
- **TOW2-366** — backlog: SSE-compat assessment, decision-gated.

(Not independently re-verified against live Linear in this task — scope was read-only over
`~/.agent-recall`; the above is sourced from the raw dialogue + the already-written canonical memory,
which agree with each other.)

### 3.5 Next steps (explicit, from the session's closing message)
Owner fork, unresolved at session end:
- **(a)** Stop here — only the memory/recall problem gets fixed; no page implementation yet, **or**
- **(b)** Proceed: read the `novada-web` wizard source (`app/mcp/page.tsx`) and implement **P1
  (TOW2-358/359) + P2 (TOW2-360)** — spec is approved, pure local implementation. **REDLINE: novada-web
  is a product repo — do not deploy; deploy is owner-gated.**

Also pending/open:
- Separate-session API-key-change request already submitted; OAuth still pending — owner to ask team.
- Un-ticketed delta: fold "balance visible in top-right topbar" into TOW2-363.
- Un-ticketed delta: confirm exact wording of the "+30% of your agent's capability" marketing line before shipping it.

### 3.6 Work-line name this session should be filed under
**`novada-mcp-page`** — matches the palace room topic (`decision/novada-mcp-page`) and the canonical
memory file's own frontmatter `name: project-novada-mcp-page`. This is a 4th, currently-unlisted
project distinct from all three slugs actually used that day: `novada-mcp` (server monorepo, where the
real dialogue landed), `novada-mcp-funnel` (docs/landing site, unrelated red herring), and `AgentRecall`
(memory tool itself, where the diagnostic session + the mis-citing `remember()` call landed).

---

## 4. CLI probe (`node packages/cli/dist/index.js`)

`ar --help` (v3.4.40) — relevant read/query subcommands:
- `ar search <query> [--include-palace]` — journal full-text search.
- `ar insight <context>` / `ar recall <context>` (alias) — **this is what the MCP `recall()` tool wraps.**
- `ar palace search <query>` — palace-only search.
- `ar digest recall <query>` — separate context-cache layer.

**Test 1 — `ar search "MCP原型 页面设计" --project AgentRecall --include-palace`**: **HIT.** Returned ~20
excerpts, several verbatim-matching raw-archive JSONL text from `6c9644e8` (the "let's go back to
novada mcp 页面设计" line, the ls output finding V14, the assistant's own honest "recall 状态基本为空"
report) — i.e. `ar search` **does** reach into raw/archived journal text, not just curated summaries.
This falsifies a blanket "raw is never searchable" claim: raw text is discoverable via this CLI path.

**Test 2 — `ar recall "MCP原型 页面设计" --project AgentRecall`** (= the actual `recall()` MCP tool
path): returned 5 results, `sources_queried: [palace, insight, journal]` — **no raw archive text**, but
it *did* surface the palace decision note (`decision / novada-mcp-page`, score 0.016, confidence "low")
because that note happens to exist (created within the incident itself, §0). Everything else returned
was low-confidence and off-topic.

**Conclusion**: the "raw 不被检索" hypothesis is **confirmed true specifically for `recall()`/`ar insight`**
(the tool an agent calls by default) — it only queries palace/insight/journal-summary, never raw/, and
without the palace note existing it would have returned nothing useful at all. It is **false as a
blanket claim about the whole product** — `ar search` (a different, less-discoverable CLI surface) does
full-text-search raw archive content and would have found the real conversation immediately, just not
through the tool call agents reach for first.

---

## Summary (≤15 lines)
- Task brief's "主对话 = e577afbf" is **wrong**: that file is an unrelated hero-card-edit session; the shared "MCP原型 V13" text is generic folder-lint hook boilerplate firing in every session that day, not conversation content.
- Real main dialogue = `~/.agent-recall/projects/novada-mcp/journal/archive/raw/2026-07-31--8a02c8b2-d37b-4681-8bf2-bcf0b6b9d37d.md` (preceded by diagnostic session `6c9644e8` under project `AgentRecall`), found only by following the palace/insight graph, not by trusting the raw text pointer.
- Second-order bug: inside that very session, the assistant's own `remember()` call cited the wrong raw file and got auto-filed to project `AgentRecall` — AR's own memory generated the bad lead that misdirected this task's brief.
- Raw body is hard-capped at exactly 80,000 characters, truncating the tail (not head) — worst-case policy, risks losing exactly the decisions/next-steps a session card needs.
- Session-card fields: frontmatter 100% mechanical; tool-call inventory, `remember()`/palace-write payloads, and direct Linear tool-call IDs are mechanical *with* a precision rule (never trust hook-boilerplate/attachment text as artifact/ID source); goal, narrative state, next-steps, and correct project slug all need LLM synthesis.
- Full fixture (goal/state/artifacts/Linear TOW2-357+358..366/next-steps/correct slug `novada-mcp-page`) written in §3.
- CLI: `ar search --include-palace` DOES hit raw-archive text; `ar recall`/`ar insight` (what `recall()` wraps) does NOT — confirmed empirically, not just asserted.

Full report: `/Users/tongwu/Projects/AgentRecall/reports/2026-07-31-continuity-fixture.md`
