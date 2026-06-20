# AgentRecall: Memory → Understanding — Implementer Plan

> Status: PLAN (orchestrator deliverable). A terminal coding agent implements; this doc is the brief.
> **REDLINE (non-negotiable):** No version bump, no `npm publish`, no deploy, no `git push`, no cron creation in any step. Each wave delivers a branch + green build + passing tests, then STOPS for explicit human approval.
> Ground truth in this doc has been verified against the live tree (see "Verified facts" callouts). Refuted design assumptions have been corrected inline — do not carry the originals forward.

---

## 1. Thesis

AgentRecall today is **memory**: it collects sessions, corrections, and insights and surfaces them when asked. The goal is **understanding** — a system that anticipates rather than merely recalls. Two structural moves get us there. First, a **two-tier memory**: a lossless *archive* (raw journal, never lost) under a lossy *model* tier (compressed awareness/instinct), joined by a **bridge** — when the model tier is not confident, it drills down to the archive instead of answering thinly. Second, **predict-the-correction**: human corrections are not one input among many but *ground truth that overrides the model*, and from accumulated corrections we auto-derive the user's "Blind Spots" so the system can warn *before* the user has to correct. Memory recalls the past; understanding pushes a calibrated prior into the present, early — before the agent reasons, not as a fact retrieved after.

---

## 2. Target Architecture

```
                          ┌─────────────────────────────────────────┐
   session end  ────────► │  MECHANICAL ARCHIVE (lossless, verbatim)  │  ~/.agent-recall/projects/<slug>/
   (Stop hook,            │  journal/archive/raw/<date>--<uuid>.md    │  journal/ , corrections/ ,
    zero judgment)        │  appended on EVERY session, no summary    │  palace/{rooms,skills,pipeline,awareness}
                          └───────────────┬───────────────────────────┘
                                          │ consume-marker (.consumed.json / queue)
                          ┌───────────────▼───────────────────────────┐
   async dreaming  ─────► │  QUALITY COMPRESSION (lossy, reasoned)     │  awareness (rules), palace skills,
   (in-loop LLM, never    │  insights, crystallized principles,        │  FSRS reinforce/decay,
    in the Stop turn)     │  Blind-Spots profile, skill drafts         │  Plywood-encoded procedures
                          └───────────────┬───────────────────────────┘
                                          │ confidence < floor ⇒ BRIDGE
                          ┌───────────────▼───────────────────────────┐
   recall / check  ─────► │  RETRIEVAL = a FUNCTION (not an agent)     │  smartRecall, check, check_action
   session_start /        │  low-confidence ⇒ fetchVerbatim(archive)   │  → calibrated confidence on ONE scale
   hook-ambient           │  prior injected BEFORE reasoning (instinct)│  → drill-down attaches lossless source
                          └─────────────────────────────────────────────┘
```

Four design commitments hold across the whole plan:

- **Two-tier with a bridge (Decisions #1, #2).** Lossless archive below, compressed model above, and a confidence signal so the model knows when to fall back. The mature output is a *prior pushed early* ("this feels wrong") via ambient hooks, not a RAG fact pulled late.
- **Retrieval is a function; consolidation is async dreaming (Decision #3).** No spawned per-recall storage agent (that adds a lossy brief + cold start). Synchronous recall is `smartRecall()`. Quality compression happens later, in the existing dreaming loop, off the Stop turn.
- **Self-describing, substrate-independent memory (Decision #5).** A single `MEMORY-PROTOCOL.md` lets a cold agent (Cursor/Codex/OpenCode, no MCP) read and write the folder. Local-first, with an *optional* local git commit substrate — remote push deferred until the privacy split is proven.
- **Privacy boundary before any sync (Decision #6).** Personal model (corrections-derived Blind Spots, awareness behavioral layer) is separable from project knowledge and is **excluded from sync by default**.

> **Decision #4 (Plywood procedural encoding) is scoped as additive metadata only** (an optional `plywood?:` field on skills/behavior rules). The episodic=NL / semantic=structured / procedural=Plywood discipline and any migration of existing prose skills is **punted this cycle** (lowest ROI of the eight) unless explicitly requested.

---

## 3. Sequenced Roadmap (Waves)

Each wave = a branch, a green build (`npm run build` at repo root), passing tests (`npm test` at root), then STOP for human review. **Build order is load-bearing: privacy first, lossless floor next, then compression, then the bridge, then the north-star.**

| Wave | Workstream | Why this order | Hard deps |
|------|-----------|----------------|-----------|
| **1** | Privacy classification + plug the **live** Supabase awareness leak | The personal/behavioral layer leaks to Supabase **today** (verified). Decision #6 mandates the split precede any sync. | none |
| **2** | **Archive tier + auto-save (MERGED — build ONE)** | Lossless floor must exist before the bridge can drill into it. | Wave 1 (raw tier on the sync denylist) |
| **3** | Compression tier: FSRS revival + in-repo decay pass + crystallization-candidate detector | Turns COLLECT-by-count into COMPRESS-into-rules; activates dormant code (high leverage, low risk). | Wave 2 (consume-marker seam) |
| **4** | Bridge: unify confidence on one calibrated scale + uncertainty-triggered drill-down + prior-injection | The model→archive fallback + early prior. | Wave 2 (clean archive), shares confidence primitive w/ Wave 3 |
| **5** | Corrections-prediction (authoritative override, Blind Spots, predictCorrection, honest heeded/recurred) **+** compression remainder (versioned consolidation prompt, `ar consolidate`, dreaming repoint) | North-star; deepest behavior change; coordinates the external `~/.aam` prompt (human-approved). | Waves 1, 4, verified check-action primitives |

### Per-wave exit criteria

- **Wave 1:** `classifyStore`/`classifyPath` land with a unit test; `syncToSupabase(..., "awareness")` and any `_global` palace write are gated behind `sync_personal=false` (default). A test fails if a personal store has no matching sync gate. **Open decision surfaced (not silently picked):** whether the war-room dashboard's dependence on `ar_awareness` in Supabase means awareness-only stays synced — human call.
- **Wave 2:** A session with **zero captures** leaves a verbatim file under `journal/archive/raw/`; idempotent on session UUID; empty/blank stdin exits 0 with no throw; existing `/arsave` + MCP `session_end` still consolidate palace inline (no behavior change for in-turn callers); raw tier never routes through `syncToSupabase`. Stop-hook stdin contract **empirically captured** before relied upon.
- **Wave 3:** A recall hit reinforces a skill's FSRS state (stability up, status climbs), throttled to avoid write-amplification; decay pass flags `archive_candidate` skills with `archived:true` **and the readers honor the flag** (not inert); crystallization detector returns clusters (candidates) but writes no synthesized principle.
- **Wave 4:** All recall backends route through one `calibratedConfidence`; a low-confidence top hit attaches a verbatim `bridged` source equal to `readJournalFile` output; drill-down capped (≤2 items, ≤1200 chars) with a kill-switch; ambient hook emits a correction-derived prior **above** the fact list.
- **Wave 5:** An authoritative P0 correction (not a noise-candidate) yields `verdict:"blocked"` in `check_action`; `predictCorrection` returns a likelihood band from plan↔Blind-Spots overlap and instruments `predicted`/`predict_hit`; default-heeded only fires when no real `check_action` outcome exists for that correction today (expect a precision **drop** — correct, not a regression).

---

## 4. Workstreams

> **Universal Done-Definition (every workstream, before "done"):**
> 1. Trace ≥1 error path manually (catch/finally/throw; `process.exit()` skipping `finally{}`).
> 2. Assume **no global binaries** — tests import compiled functions directly; never call a global `ar` on PATH.
> 3. Ternary ordering: highest threshold first (`r>=0.85?'hot':r>=0.6?'warm':…`).
> 4. Time logic vs TODAY: a future-dated `last_confirmed` must not yield R>1.
>
> **Universal test contract (corrects every area's original SOP):**
> - Tests are `packages/<pkg>/test/<name>.test.mjs`, written with `node:test` + `node:assert/strict`, importing from **`../dist/...`** (compiled output).
> - There is **no vitest, no `.test.ts`, no pnpm**. Runner is `node --test test/*.test.mjs`. Package manager is **npm workspaces**.
> - "RED before GREEN" means: write the `.test.mjs`, `npm run build` (which omits the new module → import fails), then implement and rebuild. **You must build to `dist` before any test can exercise new code.** Do NOT "ignore dist" — the suite imports from it.
> - Verify with `npm run build` then `npm test` **at repo root** (builds all 4 packages in dependency order: core → mcp-server → sdk → cli).
>
> **Review-by:** `code-reviewer` agent (fresh eyes, never self-review) on each wave's diff. `security-reviewer` additionally on Waves 1, 2 (untrusted stdin → fs paths; sync gating).

---

### Wave 1 — Privacy classification + plug the live Supabase leak

**Goal.** Land the personal-vs-project split as the single source of truth, and cap what leaves the machine **today**. This must precede every other wave.

> **Verified fact (corrects the original design framing):**
> - Awareness/insights sync to Supabase **right now**: `awareness.ts:84,88` and `insights-index.ts:132` call `syncToSupabase(..., "awareness")` synchronously on every write. The `store` union is `"journal"|"palace"|"awareness"|"digest"` (`sync.ts:111`). This is the real, live personal-data leak.
> - **Corrections are NEVER synced** (`grep` of `corrections.ts` for supabase = 0 hits). There is no `corrections` store. So the "gate the corrections leak" rationale is moot for Supabase — corrections only matter for the future git `.gitignore`.
> - Awareness syncs with the project string **`"global"`**, NOT `_global`. A `project==="_global"` gate would miss it. Gate on **`store==="awareness"`** for the awareness leak; gate `_global` only for its **palace** writes (bootstrap path writes palace with project `_global`).
> - `~/.agent-recall` is **NOT a git repo** — so no GitHub-mirror leak exists for AR data today. The `~/.claude` auto-push (`session-stop-sync.sh`) targets a different tree. Do not conflate.

**Changes (files).**
- NEW `packages/core/src/storage/classification.ts` — `type Tier = "personal"|"project"`; `PERSONAL_STORES` set; `classifyStore(store, opts?): Tier` (`store==="awareness"` ⇒ personal; `opts.project==="_global"` ⇒ personal; else project); `classifyPath(absPath): Tier` (markers: `/corrections/`, `/awareness`, `behavior-policies.json`, `/projects/_global/`, future `/personal/`); `isPersonalProject(slug)`. Pure, no IO. Document that `classifyStore` covers the **sync** surface (only `awareness` + `_global` palace are reachable as personal there) while `classifyPath` covers the **git/.gitignore** surface (corrections, behavior-policies). Disjoint by design.
- MODIFY `packages/core/src/supabase/config.ts` — add `sync_personal?: boolean` (default `false`) to `SupabaseConfig`; env override `AGENT_RECALL_SYNC_PERSONAL`.
- MODIFY `packages/core/src/supabase/sync.ts` — in `syncToSupabase()` and `backfill()`, before upsert: `if (classifyStore(store, {project}) === "personal" && config.sync_personal !== true) return;` (skip silently — preserves fire-and-forget).
- MODIFY `packages/core/src/index.ts` — barrel-export classification.
- NEW `packages/core/test/classification.test.mjs` — corrections⇒personal (via `classifyPath`), palace rooms⇒project, awareness store⇒personal, `_global` palace⇒personal; **a test that fails if any `PERSONAL_STORES` member lacks a sync gate** (the single-source guarantee).

**Plywood SOP.**
```
CORE = "packages/core/src"
// REDLINE: no version bump / publish / deploy / push.

// STEP 0 — test first (build-then-run semantics)
WRITE(CORE/../test/classification.test.mjs, cases=[awareness=>personal, palace=>project, _global-palace=>personal, gate-coverage])
RUN("npm run build && npm test -w packages/core")     // RED: classification module absent

// STEP 1 — the load-bearing primitive (single source of truth)
WRITE(CORE/storage/classification.ts):
  EXPORT type Tier = "personal" | "project"
  EXPORT PERSONAL_STORES = Set{ "awareness" }          // the ONLY personal value reachable via sync `store`
  EXPORT classifyStore(store, opts?):
    IF store == "awareness": return "personal"
    IF opts?.project == "_global": return "personal"   // _global palace writes
    return "project"
  EXPORT classifyPath(abs):
    for m of ["/corrections/","/awareness","behavior-policies.json","/projects/_global/","/personal/"]:
      IF abs.includes(m): return "personal"
    return "project"
  EXPORT isPersonalProject(slug) => slug === "_global"
INSERT barrel export into CORE/index.ts

// STEP 2 — config flag
EDIT(CORE/supabase/config.ts): add sync_personal?:boolean (default false) + env AGENT_RECALL_SYNC_PERSONAL

// STEP 3 — gate the live leak
EDIT(CORE/supabase/sync.ts) in syncToSupabase() AND backfill(), BEFORE upsert:
  IF classifyStore(store,{project}) == "personal" AND readSupabaseConfig()?.sync_personal !== true:
    return                                             // silent skip, fire-and-forget contract

// STEP 4 — verify + escalate the dashboard decision
RUN("npm run build && npm test")                       // GREEN
IF exitCode != 0: FIX; RUN(again); IF still red: ESCALATE
// trace error path: classifyStore on unknown store => "project" (no throw)
ESCALATE_TO_HUMAN("DECISION NEEDED: war-room dashboard reads ar_awareness from Supabase. " +
                  "sync_personal=false STOPS awareness reaching Supabase → dashboard may go blank. " +
                  "Keep awareness-only synced, or accept blank until git-mirror? Do not silently pick.")
```

**Review-by.** `code-reviewer` + `security-reviewer` (data egress gate).

---

### Wave 2 — Archive tier + auto-save (MERGED into ONE archive design)

**Goal.** A mechanical, lossless, judgment-free verbatim dump on **every** session end — the "never lost" floor — plus an async consume seam handing quality compression to dreaming. **Build exactly one transcript reader and one Stop-hook rewrite.**

> **Verified facts (correct the originals):**
> - `transcript_path` appears **NOWHERE** in the repo or `~/.claude/settings.json`. The Stop-hook stdin contract is **unverified**. A live Stop payload MUST be captured (log raw stdin to a temp file once) before relying on field names. Until then, fall back to the proven `readTodaySessions` discovery (scans `~/.claude/projects/-Users-<user>/*.jsonl` by mtime).
> - `hook-end` reads **no stdin** (relies on `CLAUDE_SESSION_ID` env) and **already** exits 0 silently when there are no captures (`index.ts:599-607`). So the only real change to that gate is **dropping the 60-char `Auto-saved:` stub string** (lines 588-591) — NOT adding a data-gate (the gate already exists).
> - The Stop matcher has **4 commands**, not 1 (`session-stop-sync.sh` git-pushes `~/.claude`, then the `hook-end` node command, then two notify scripts). Appending a 5th is fine, but do not describe the current state as "only hook-end".
> - `readHeadTail` exists (`transcript-reader.ts:41-63`, head 60KB / tail 25KB), is module-private. **Reuse it** — do not add a second reader.
> - The transcript filename basename **is** the session UUID — use it as the dedup key (NOT the date, which collides across same-day sessions).
> - There is **no `projectFromCwd` helper**. The only detector is `detectProject()` keyed on `process.cwd()`/env. Resolving project from a stdin `cwd` field needs a new helper or an explicit `--project`; do not assume it exists.

**Changes (files).**
- MODIFY `packages/cli/src/utils/transcript-reader.ts` — add `readTranscriptByPath(filePath)` reusing `readHeadTail`/`parseLines`/`extractProjectSlug`/`extractFirstUserMessage`; returns the parsed `SessionInfo` **plus** a verbatim `rawTail` (head+tail joined, cap ~80KB). Do NOT touch `readTodaySessions`.
- NEW `packages/core/src/storage/archive-write.ts` — `archiveSession({project, sessionId, transcriptPath, rawTranscript, summary?})`. Writes verbatim to `journalDir(slug)/archive/raw/<date>--<sanitizeSlug(sessionId)>.md`. **`sessionId` is untrusted (stdin) → MUST pass through `sanitizeSlug` before `path.join`** (MCP-security rule). Idempotent: no-op if file exists. Small frontmatter (`project, sessionId, savedAt, source:hook-archive`), then raw bytes. Appends one line to `journal/archive/index.md`. Maintains a `journal/archive/raw/.consumed.json` (`{lastConsumedOffset, lastConsumedAt}`) via existing `writeJsonAtomic`. **Never** throws to caller (`return {path:"",bytes:0}` on error). **Never** imports `journal-write` / `syncToSupabase` (raw tier is local-only — privacy).
- MODIFY `packages/core/src/storage/paths.ts` — add `archiveRawDir(project)` mirroring `digestDir` (lines 137-143) with `assertInsideRoot`; extend `journalDirs(project, includeArchive)` so `includeArchive=true` ALSO pushes `journal/archive/raw` if it exists (default counting path unchanged → raw dumps don't inflate session counts but become recall-reachable).
- MODIFY `packages/core/src/storage/session.ts` — add `'hook-archive'` to the `SaveType` union (line 35) + doc comment (line 9).
- NEW `packages/core/src/storage/consolidation-queue.ts` — `enqueueConsolidation(job)` appends a JSONL line to `~/.agent-recall/.consolidation-queue/<date>.jsonl`; `drainConsolidationQueue(handler)` reads pending, marks done, one bad job never blocks the rest.
- MODIFY `packages/core/src/tools-logic/session-end.ts` — add `deferConsolidation?: boolean` to `SessionEndInput`; when true (only `hook-end` passes it) skip inline `consolidateJournalToPalace` (step 3, lines 321-328) and `enqueueConsolidation()` instead. Default false ⇒ zero change for `/arsave`, `/arsaveall`, MCP `session_end`.
- MODIFY `packages/cli/src/index.ts`:
  - Rewrite `case "hook-end"` (560-651): read stdin first (`for await chunk of process.stdin`, mirror hook-correction/ambient/pretool), defensive `JSON.parse`. **UNCONDITIONALLY before any short-circuit**, if a usable transcript source resolves, call `readTranscriptByPath` (or fall back to `readTodaySessions` if `transcript_path` is absent) then `core.archiveSession(...)` then `core.enqueueConsolidation(...)`. Reorder so the `if(!summary) exit 0` guards run AFTER archiving. Keep the `.hook-end-lock`. Drop the 60-char stub. Keep the capture→summary path but pass `deferConsolidation:true` to `sessionEnd`. **Guard** the semantic-prefetch block (623-647) and arstatus-cache write (614-621) against empty `summary` (they depend on it). Every failure path exits 0.
  - Add `case "consolidate-async"`: drains the queue, per job runs `consolidateJournalToPalace(slug)` (pure regex, headless-safe).
- NEW `packages/core/src/storage/memory-protocol.ts` — `writeMemoryProtocol(slug)` writes `~/.agent-recall/projects/<slug>/MEMORY-PROTOCOL.md` (write-once if absent) documenting folder layout, the two-tier model + bridge rule, `.consolidation-queue/` drain format, and cold-agent read/write conventions. Called from `archiveSession`. **This is the SINGLE protocol generator (see Non-goals: do not also build `protocol-doc.ts`).**
- MODIFY `packages/core/src/index.ts` — export `archiveSession`, `enqueueConsolidation`, `drainConsolidationQueue`, `writeMemoryProtocol`.
- MODIFY `packages/core/src/tools-logic/session-end-reflect.ts` — add optional `raw_unconsumed: Array<{file;excerpt;bytes}>` to `ReflectInputBundle`, populated from raw segments after `.consumed.json` offset; append a prompt line telling the in-loop LLM to distill them and advance the marker. **No LLM call added to core** (keep it deterministic, matches reflect.ts's stance).
- MODIFY `packages/core/src/tools-logic/journal-capture.ts` — add a one-line comment at the 2000/5000 truncation (lines 61-62) declaring capture = curated stream, `journal/archive/raw` = lossless tier. Keep the caps.
- NEW tests: `packages/core/test/archive-write.test.mjs`, `packages/core/test/consolidation-queue.test.mjs`, `packages/cli/test/hook-end-archive.test.mjs`.

**Plywood SOP.**
```
CORE="packages/core/src"; CLI="packages/cli/src/index.ts"
// REDLINE: no version bump/publish/deploy/push. Reuse readHeadTail; do NOT add a 2nd reader.

// STEP 0 — capture the live Stop payload BEFORE trusting field names
ESCALATE_OR_PROBE("Add a one-off: log raw Stop-hook stdin to /tmp/ar-stop-payload.json, " +
                  "trigger one Stop, inspect actual keys (transcript_path? session_id? cwd?). " +
                  "If keys differ, adapt; if no transcript path, use readTodaySessions fallback.")

// STEP 1 — tests first
WRITE(test/archive-write.test.mjs, cases=[
  zero_capture_session_still_dumps, verbatim_no_truncation, idempotent_per_uuid,
  bad_transcript_returns_false_no_throw, journalDirs_includeArchive_reaches_raw,
  archiveSession_never_calls_supabase])
WRITE(test/consolidation-queue.test.mjs, cases=[enqueue_then_drain_marks_done, second_drain_noop, one_bad_job_doesnt_block])
WRITE(packages/cli/test/hook-end-archive.test.mjs, cases=[empty_stdin_exit0_no_throw, captures_still_write_summary_additive])
RUN("npm run build && npm test")                      // RED

// STEP 2 — reader (reuse, don't duplicate)
INSERT readTranscriptByPath(path) into transcript-reader.ts:
  IF !exists(path): return null
  {head,tail} = readHeadTail(path)                    // REUSE 41-63
  return { ...SessionInfo(parseLines(head)+parseLines(tail)), rawTail: (head+"\n…\n"+tail).slice(0,80_000) }
// do NOT modify readTodaySessions

// STEP 3 — core archive writer (lossless, idempotent, never-throw, local-only)
EDIT(CORE/storage/session.ts): SaveType += "hook-archive" (line 35) + doc (line 9)
EDIT(CORE/storage/paths.ts): add archiveRawDir(project) mirror digestDir(137-143) w/ assertInsideRoot;
     journalDirs(p,includeArchive): IF includeArchive AND exists(primary+"/archive/raw"): dirs.push(it)
WRITE(CORE/storage/archive-write.ts):
  archiveSession({project,sessionId,transcriptPath,rawTranscript,summary?}):
    try:
      slug = sanitizeProject(project)
      sid  = sanitizeSlug(sessionId)                   // UNTRUSTED stdin → sanitize before path.join
      dir  = path.join(journalDir(slug),"archive","raw"); ensureDir(dir)
      dest = path.join(dir, `${todayISO()}--${sid}.md`)
      IF exists(dest): return {path:dest,bytes:0}      // idempotent on UUID
      writeFileSync(dest, frontmatter{project,sessionId:sid,savedAt,source:"hook-archive"} + rawTranscript)
      appendLine(join(journalDir(slug),"archive","index.md"), `${todayISO()} ${sid} ${summary??""}`)
      IF !exists(dir+"/.consumed.json"): writeJsonAtomic(dir+"/.consumed.json",{lastConsumedOffset:0})
      writeMemoryProtocol(slug)                        // write-once
      return {path:dest, bytes:rawTranscript.length}
    catch: return {path:"",bytes:0}                    // NEVER throw into Stop
  // NB: NO syncToSupabase, NO journal-write import. NO min-length gate.
WRITE(CORE/storage/consolidation-queue.ts): enqueueConsolidation + drainConsolidationQueue (one bad job ≠ block)
WRITE(CORE/storage/memory-protocol.ts): writeMemoryProtocol(slug) — SINGLE generator
EDIT(CORE/index.ts): export archiveSession, enqueue/drainConsolidationQueue, writeMemoryProtocol

// STEP 4 — defer inline consolidation for the harness-driven Stop path only
EDIT(CORE/tools-logic/session-end.ts): add deferConsolidation?:boolean
  at step-3 (321-328): IF input.deferConsolidation: enqueueConsolidation(...); palaceConsolidated=false
                       ELSE: existing inline consolidateJournalToPalace (unchanged for /arsave,/arsaveall,MCP)

// STEP 5 — rewire hook-end (THE fix): archive ALWAYS, before the short-circuits
EDIT(CLI case "hook-end" 560-651):
  raw=""; try: for await c of process.stdin: raw+=c; catch: raw=""
  stop = safeJsonParse(raw) ?? {}
  sid  = basename(stop.transcript_path ?? "", ".jsonl") || stop.session_id || env.CLAUDE_SESSION_ID || endToday
  KEEP .hook-end-lock guard (key `${sid}-end`)
  // ---- MECHANICAL ARCHIVE — unconditional, zero dependence on captures ----
  src = stop.transcript_path && exists(stop.transcript_path)
          ? readTranscriptByPath(stop.transcript_path)
          : pickFrom(readTodaySessions())               // proven fallback if no transcript_path
  IF src:
    proj = project ?? src.projectGuess ?? "auto"
    core.archiveSession({project:proj, sessionId:sid, transcriptPath:stop.transcript_path, rawTranscript:src.rawTail, summary:src.firstUserMessage})
    core.enqueueConsolidation({project:proj, sessionId:sid, reason:"hook-end archive"})
  // ---- existing capture→summary path, now deferred + stub dropped ----
  ...compute summary from log answers...               // DROP the 60-char "Auto-saved:" stub string
  MOVE the `if(!summary && existingToday) exit0` / `if(!summary) exit0` guards to AFTER the archive block
  IF summary:
    core.sessionEnd({summary, project, saveType:"hook-end", deferConsolidation:true})
    GUARD arstatus-cache(614-621) + semantic-prefetch(623-647) behind `if(summary)` (they read summary)
  // every catch → stderr, exit 0
ADD case "consolidate-async": core.drainConsolidationQueue(job => consolidateJournalToPalace(job.project))

// STEP 6 — reflect seam + capture comment
EDIT(CORE/tools-logic/session-end-reflect.ts): add raw_unconsumed[] to ReflectInputBundle, populate from
     archiveRawDir segments past .consumed.json offset; append distill-and-advance prompt line. NO LLM in core.
EDIT(CORE/tools-logic/journal-capture.ts 61-62): comment "capture=curated stream; lossless=journal/archive/raw"

// STEP 7 — settings wiring is a CONFIG EDIT, gated on build-first (NOT in this branch's code)
//   ~/.claude/settings.json Stop matcher: append a 5th command
//     `node /Users/tongwu/Projects/AgentRecall/packages/cli/dist/index.js hook-archive || true`  (if a separate
//   command is preferred) OR rely on the rewired hook-end. Build dist FIRST. Write a .bak. HUMAN-APPROVED.

// STEP 8 — verify
RUN("npm run build && npm test")                       // GREEN
IF red: FIX; RUN(again); IF still red: ESCALATE
// trace: blank stdin → no throw, exit 0, no archive; bad transcript path → {path:"",bytes:0}
ASSERT zero-capture session leaves a file in journal/archive/raw/   // headline regression fixed
ASSERT /arsave + MCP session_end still consolidate inline           // deferConsolidation default false
// RETENTION (do NOT defer): cap rawTail (≤80KB); add prune-or-gzip of raw segments once .consumed marks them
//   distilled, reusing journalArchive's older_than_days pattern. Bound ~/.agent-recall growth.
ESCALATE_TO_HUMAN("settings.json edit + retention policy need approval before enabling for all users")
```

**Review-by.** `code-reviewer` + `security-reviewer` (untrusted `sessionId`/`transcript_path` → fs; confirm no `syncToSupabase` from the raw tier).

---

### Wave 3 — Compression tier (FSRS revival + decay pass + crystallization candidates)

**Goal.** Make "what you use survives" real in code, and surface crystallization candidates to the reasoner — without faking synthesis.

> **Verified facts (correct the originals):**
> - FSRS is dormant: `fsrs.ts` exports `reinforce/score/penalize` but only `initFsrs` is called (`skills.ts:206`). Zero reinforcement loop. `reinforce`/`penalize`/`score` have no non-test call sites.
> - **There is NO existing room auto-archive path.** `AUTO_ARCHIVE_THRESHOLD` is consumed nowhere except a re-export. `computeSalience` is called to *store* salience; only `palace-lint.ts` compares it (to emit a WARNING, never archives). So "rooms already decay, don't double-decay" overstates reality — but still route rooms through the **salience** path (not FSRS) to keep one decay model per object type.
> - `computeSalience` does **NOT** accept a room meta object. Signature: `computeSalience({importance,lastUpdated,accessCount,connectionCount,urgency?,category?,pin?,keystone?}) → number`. Map fields explicitly (mirror `palace-lint.ts:63`).
> - **The `archived` flag is inert today** — zero readers anywhere. Setting `archived:true` is a no-op unless `listSkills`/room readers/recall/session_start are ALSO updated to filter it. This reader-side filtering is **load-bearing, not optional**.
> - Awareness is a **global singleton** — `readAwarenessState`/`detectCompoundInsights` take no project arg. `findCrystallizationCandidates` cannot be project-scoped; the insight field is `appliesWhen` (camelCase) in `awareness.ts`, not `applies_when`.
> - `writeSkill` does NOT use `withLock` (atomic tmp+rename + symlink guard only). The real risk is **write-amplification** in git-mirrored memory — add the throttle.

**Changes (files).**
- MODIFY `packages/core/src/palace/skills.ts` — add `reinforceSkillFsrs(project, slug, now?)` (read skill, `meta.fsrs = reinforce(meta.fsrs ?? initFsrs(meta.created))`, atomic write-back via existing render path, keep `order`; **throttle: skip write if `last_confirmed` within N hours** to bound churn; best-effort try/catch — a recall hit must never throw). Extend `recallSkillsByIntent` return objects with `retrievability` + `status` via `score(meta.fsrs)`. **Add `archived` filtering to `listSkills`/recall consumers.**
- MODIFY `packages/core/src/tools-logic/skill-recall.ts` — after `recallSkillsByIntent` returns ranked (line 53), call `reinforceSkillFsrs` per returned skill inside try/catch.
- NEW `packages/core/src/palace/decay-pass.ts` — `runDecayPass(project, {dryRun}): DecayReport`. Skills: `score(meta.fsrs ?? initFsrs(created))`; if `status==='archive_candidate'` set non-destructive `archived:true` (never unlink — compress.ts §6 invariant). Rooms: route through `computeSalience({importance, lastUpdated:room.updated, accessCount:room.access_count, connectionCount})` and the salience threshold — do NOT FSRS-decay rooms. Skip rooms in `{corrections, critical_path}` and `keystone===true`.
- MODIFY `packages/core/src/palace/consolidate.ts` — wire `runDecayPass(project,{dryRun:false})` after `markKeystones` (line ~185) in the existing best-effort try/catch; add `decay` to the `appendToLog` payload.
- MODIFY `packages/core/src/palace/awareness.ts` — add `findCrystallizationCandidates({minCluster:3, minTotalConfirm:5})`: cluster `topInsights` sharing ≥2 `appliesWhen` keywords (reuse `extractKeywords`), keep clusters with size≥3 AND sum(confirmations)≥5, exclude any title prefixed `CRYSTALLIZED`/`CRITICAL`. **Returns clusters (candidates) only — writes no synthesized principle** (synthesis is the LLM's job). No project arg (global singleton).
- MODIFY `packages/core/src/tools-logic/session-end-reflect.ts` — add `crystallization_candidates` to `ReflectInputBundle`.
- MODIFY `packages/core/src/index.ts` — export `runDecayPass`, `findCrystallizationCandidates`, `reinforceSkillFsrs`.
- NEW tests: `packages/core/test/fsrs-reinforce.test.mjs`, `decay-pass.test.mjs`, extend `awareness.test.mjs`.

**Plywood SOP.**
```
CORE="packages/core/src"
// REDLINE: no version bump/publish/deploy/push. Do NOT rewrite fsrs.ts math. Do NOT write synthesized principles in code.

RUN("npm run build && npm test")                       // baseline green; else ESCALATE

// PHASE 1 — reinforce-on-recall (revive the dead loop) + reader filtering
EDIT(CORE/palace/skills.ts):
  add reinforceSkillFsrs(project,slug,now?):
    try:
      sk = parseSkillFile(fileFor(project,slug))
      IF withinHours(sk.meta.fsrs?.last_confirmed, N): return    // THROTTLE write-amp
      sk.meta.fsrs = reinforce(sk.meta.fsrs ?? initFsrs(sk.meta.created), now)
      writeSkill(project, sk.meta, sk.body, order=parsedOrder(sk))  // atomic tmp+rename, keep order
    catch: return                                         // recall must never throw
  recallSkillsByIntent return mapping: add {retrievability,status}=score(meta.fsrs ?? initFsrs(meta.created))
  listSkills (+ recall/session_start consumers): FILTER OUT meta.archived === true   // make the flag live
EDIT(CORE/tools-logic/skill-recall.ts after line 53):
  for s of ranked: try: reinforceSkillFsrs(slug, s.skill.meta.slug) catch: /*swallow*/

// PHASE 2 — in-repo decay pass (skills via FSRS, rooms via salience — never both)
WRITE(CORE/palace/decay-pass.ts):
  runDecayPass(project,{dryRun=false}):
    report={scanned:0, archived_candidates:[], skipped:[]}
    for sk of listSkills(project, {includeArchived:true}):
      st = score(sk.meta.fsrs ?? initFsrs(sk.meta.created)); report.scanned++
      IF st.status=="archive_candidate":
        IF !dryRun: setSkillFlag(sk,"archived",true)      // NEVER unlink
        report.archived_candidates.push({slug:sk.meta.slug, r:st.retrievability})
    for roomJson of glob(palaceDir(project)+"/rooms/**/_room.json"):
      m = read(roomJson)
      IF m.slug in {"corrections","critical_path"} OR m.keystone: report.skipped.push(m.slug); continue
      sal = computeSalience({importance:m.importance??"medium", lastUpdated:m.updated, accessCount:m.access_count, connectionCount:countConns(m)})
      IF sal <= SALIENCE_ARCHIVE_THRESHOLD AND !dryRun: setRoomFlag(roomJson,"archived",true); report.archived_candidates.push({slug:m.slug,r:0})
    return report
EDIT(CORE/palace/consolidate.ts after markKeystones ~185):
  let decay=null; try: decay=runDecayPass(project,{dryRun:false}); catch {}
  appendToLog payload += {decay}
EXPORT runDecayPass from CORE/index.ts

// PHASE 3 — crystallization CANDIDATES (raw material, NOT synthesis)
EDIT(CORE/palace/awareness.ts near detectCompoundInsights):
  findCrystallizationCandidates({minCluster:3,minTotalConfirm:5}):
    state=readAwarenessState(); IF !state: return []
    clusters = group topInsights where sharedKeywords(appliesWhen) >= 2     // reuse extractKeywords; FIELD = appliesWhen
    keep size>=minCluster AND sum(confirmations)>=minTotalConfirm
    drop clusters whose title is prefixed CRYSTALLIZED|CRITICAL
    return clusters                                       // NO principle string written here
EDIT(CORE/tools-logic/session-end-reflect.ts): ReflectInputBundle += crystallization_candidates = findCrystallizationCandidates()

// PHASE 4 — tests + verify
WRITE(test/fsrs-reinforce.test.mjs): recall hit grows stability, status climbs; throttle skips a same-hour 2nd write;
      reinforce on unreadable/symlinked skill does NOT throw out of recall
WRITE(test/decay-pass.test.mjs): stale skill → archived:true AND fs.existsSync still true (NOT deleted);
      keystone/corrections rooms skipped; archived skill is FILTERED from listSkills (flag is live, not inert)
EXTEND(test/awareness.test.mjs): 3 insights sharing 2 keywords sum>=5 → 1 cluster; CRITICAL-prefixed excluded; <5 confirms → none
RUN("npm run build && npm test"); IF red: FIX; RUN(again); IF still red: ESCALATE
// ternary order high-first in any status buckets; future-dated last_confirmed must not yield R>1
```

**Review-by.** `code-reviewer`. **Critical review gate:** reject any in-code synthesized "principle" string in `findCrystallizationCandidates` (it must stay a candidate detector). Confirm the `archived` flag has live readers (else the wave is inert).

---

### Wave 4 — Bridge (one calibrated confidence + drill-down + prior-injection)

**Goal.** Unify confidence onto one scale, drill into the lossless archive when the model tier is unsure, and push a correction-derived prior **before** the agent reasons.

> **Verified facts (correct the originals):**
> - `scoreLabel` is duplicated in **3 files** with **divergent thresholds and on different scales**: `smart-recall.ts:96` (5 call sites — 349/385/420 feed a 0–1 `internalScore`, 465/579 feed the post-RRF `score`), `supabase/recall-backend.ts:14` (5 call sites on cosine / reciprocal-rank / RRF — three scales), `vector/local-vector-backend.ts:14` (cosine 0–1). Unify FIRST, and **tag each call site with the scale it actually feeds** — a single `'rrf-local'` tag for all of smart-recall is wrong (the internalScore sites are already ~0–1).
> - The local post-RRF `score` is mutated by hot-window boosts (×3/×2/×1.3) AND a Beta feedback multiplier (×up to 2) AFTER RRF — so the "0.12 RRF max" divisor is wrong; a boosted recent item can reach ~0.7. **The bridge gate must read the stored `calibrated` field set at scoring time, not re-derive from the mutated final score.** Treat divisors as tunable constants, not trusted gates.
> - `tokenize`/`overlap` are **private** in `check-action.ts:79/90` — promote to exports before reuse.
> - `[[journal/DATE]]` backlinks live only on markdown **heading** lines, which `palace-search.ts:117` explicitly **skips** — so they essentially never appear in `r.excerpt`. The "lift sourceRefs from excerpt" mechanism is unsound; rely on the `{kind:'palace',room,file}` locator instead.
> - The Supabase backend maps **no `date` field** and folds slug into `title` — drill-down is effectively **local-only** unless the remote query is extended to select `created_at`/slug. Scope drill-down to local for this wave.
> - `extractSection` extracts a **named** markdown section, not "around the match" — it cannot center on a query hit. Cap by a simple char window; don't claim match-centering.
> - `getRoot` is exported from `types.ts:37`, not `storage/paths.js` (both re-exported from the barrel).

**Changes (files).**
- NEW `packages/core/src/tools-logic/confidence.ts` — `ConfidenceLabel='high'|'medium'|'low'|'weak'`; `CONFIDENCE_FLOOR={high:0.66,medium:0.4,low:0.2}`; `calibratedConfidence(score, scale)` mapping each backend's native score onto a shared 0–1 axis then binning. Delete the three private `scoreLabel`s; route each call site through `calibratedConfidence` with **the correct per-site scale tag**. Add `calibrated:number` to `SmartRecallResultItem` set **at scoring time**.
- MODIFY `smart-recall.ts` — add `verbatimKey?:{kind:'journal'|'palace',date?,room?,file?}` to result items (journal loop ~369: `{kind:'journal',date:r.date}`; palace loop ~326: `{kind:'palace',room:r.room,file:r.file}`); add `drilldown?:boolean` (default true) to input and `bridged?:Array<{forItemId,source,verbatim}>` to result (mirror the `degraded` field). After the final sort (~584), if `drilldown!==false` and results non-empty: take top ≤2 items whose **stored** `calibrated < CONFIDENCE_FLOOR.medium` with a `verbatimKey`, `fetchVerbatim` each, attach to `bridged`. Skip high-confidence; skip graph-walk items (no `verbatimKey`).
- NEW `packages/core/src/tools-logic/drill-down.ts` — `fetchVerbatim(project, key)`. journal: validate `/^\d{4}-\d{2}-\d{2}$/`, reuse `readJournalFile`. palace: `path.join(palaceDir, 'rooms', sanitizeSlug(room), sanitizeSlug(file)+'.md')` with the compress.ts path-escape assertion (169-173). Cap text ~1200 chars. Never throws.
- MODIFY `packages/core/src/tools-logic/memory-query.ts` + `packages/mcp-server/src/tools/memory-query.ts` — call `smartRecall({drilldown:true})`; keep the confidence filter for the primary list but when filtered is empty OR all low, attach `bridged` to a new `fallback` field and switch guidance to "Low-confidence match — verbatim source attached; verify before relying." Update the file-header contract docstring (lines 6-8) that currently promises suppression.
- MODIFY `packages/mcp-server/src/tools/recall.ts` — after `formatResults`, if `bridged.length`, append a "— Verbatim source (low-confidence drill-down):" block.
- MODIFY `packages/cli/src/index.ts` `hook-ambient` (~821): **prior pass BEFORE the keyword `smartRecall`** — read `readP0Corrections(project)` and `readAwarenessState().blindSpots`; for any P0 correction whose rule/tags overlap prompt tokens (reuse `ambientTokens`/`wordOverlap`, start at **≥2** overlap), emit `⚠ [AgentRecall instinct] Resembles a past correction — <rule>. Check before proceeding.` ABOVE the fact list; blind-spots get a softer line. Cap 2 priors. For surfaced low-confidence items, append the bridged verbatim under the existing block. Keep rate-limiting/dedup/feedback unchanged. **Extract the prior-builder into a pure exported fn** so it's unit-testable without spawning the CLI.
- MODIFY `packages/core/src/tools-logic/check-action.ts` — export `tokenize`, `overlap`.
- NEW tests: `packages/core/test/confidence.test.mjs`, `drill-down.test.mjs`, `memory-query.test.mjs`.

**Plywood SOP.**
```
core="packages/core/src"
// REDLINE: no version bump/publish/deploy/push. Land calibratedConfidence as its own small commit FIRST.

// STEP 1 — one calibrated scale (per-site scale tags!)
WRITE(core/tools-logic/confidence.ts):
  EXPORT type ConfidenceLabel="high"|"medium"|"low"|"weak"
  EXPORT CONFIDENCE_FLOOR={high:0.66,medium:0.4,low:0.2}
  EXPORT calibratedConfidence(score,scale):
    norm = scale=="rrf-local"?score/0.12 : scale=="rrf-supabase"?score/0.049 : score   // cosine/internal already 0..1
    c=clamp(norm,0,1)
    label = c>=FLOOR.high?"high":c>=FLOOR.medium?"medium":c>=FLOOR.low?"low":"weak"
    return {label, calibrated:c}
for f in [smart-recall.ts, supabase/recall-backend.ts, vector/local-vector-backend.ts]:
  DELETE private scoreLabel
  ROUTE each call site with its TRUE scale:
    smart-recall internalScore sites (349/385/420) → scale="cosine"   // already 0..1
    smart-recall post-RRF site (465) + final (579)  → scale="rrf-local"
    supabase cosine sites (99/111)                   → "cosine"
    supabase reciprocal-rank (123)                   → "cosine"        // 1/(idx+1) is 0..1
    supabase RRF (155)                               → "rrf-supabase"
    local-vector (47)                                → "cosine"
ADD `calibrated:number` to SmartRecallResultItem; SET it where confidence is set (carry .calibrated)
RUN("npm run build"); retry-once; ESCALATE if still red
// ship THIS as a standalone commit so the scale change is observable before drill-down rides on it

// STEP 2 — provenance locator (NO excerpt-backlink lift — unsound)
EDIT(smart-recall.ts): add verbatimKey?:{kind,date?,room?,file?}
  journal loop ~369: verbatimKey={kind:"journal",date:r.date}
  palace loop ~326:  verbatimKey={kind:"palace",room:r.room,file:r.file}

// STEP 3 — verbatim fetch (local-only this wave)
WRITE(core/tools-logic/drill-down.ts):
  import readJournalFile from "../helpers/journal-files.js"; palaceDir,sanitizeSlug from "../storage/paths.js"; getRoot from "../types.js"
  fetchVerbatim(project,key):
    try:
      IF key.kind=="journal":
        IF !/^\d{4}-\d{2}-\d{2}$/.test(key.date): return null
        t=readJournalFile(project,key.date); return t ? {found:true,source:"journal/"+key.date,text:cap(t,1200)} : null
      else:
        p=join(palaceDir(project),"rooms",sanitizeSlug(key.room),sanitizeSlug(key.file)+".md")
        ASSERT p.startsWith(getRoot()+sep) ELSE throw "path escape"   // copy compress.ts 169-173
        return exists(p) ? {found:true,source:"palace/"+key.room+"/"+key.file,text:cap(read(p),1200)} : null
    catch: return null                                     // never throw into recall

// STEP 4 — the bridge (gate on STORED calibrated, not mutated score)
EDIT(smart-recall.ts): add drilldown?:boolean to input; bridged?:[] to result (mirror `degraded`)
  AFTER final sort ~584, BEFORE return:
    bridged=[]
    IF input.drilldown!==false AND results.length>0:
      low = results.filter(it => it.calibrated < CONFIDENCE_FLOOR.medium AND it.verbatimKey)   // STORED calibrated
      for it of low.slice(0,2): v=fetchVerbatim(input.project,it.verbatimKey); IF v?.found: bridged.push({forItemId:it.id,source:v.source,verbatim:v.text})
    spread ...(bridged.length?{bridged}:{})

// STEP 5 — invert memory_query; STEP 6 — render in recall.ts + memory-query MCP
EDIT(memory-query.ts): smartRecall({drilldown:true}); IF filtered empty OR all low: result.fallback=bridged; guidance="Low-confidence match — verbatim source attached; verify before relying."
  UPDATE the "Only returns high/medium" header docstring (6-8)
EDIT(mcp-server recall.ts): IF bridged.length: append "— Verbatim source (low-confidence drill-down):" block
EDIT(mcp-server memory-query.ts): render `fallback` when present

// STEP 7 — prior-injection in hook-ambient (target #2)
EDIT(check-action.ts): EXPORT tokenize, overlap
EXTRACT a pure buildPriors(prompt, corrections, blindSpots) fn (exported, testable)
EDIT(cli hook-ambient ~821 BEFORE keyword smartRecall ~946):
  priors = buildPriors(prompt, core.readP0Corrections(project), core.readAwarenessState()?.blindSpots ?? [])
  // correction overlap gate >=2 (start strict); cap 2; emit ⚠ instinct lines ABOVE the fact block
  IF priors.length: stdout.write(priors.slice(0,2).join("\n")+"\n")
  ...existing fact block + low-conf bridged verbatim lines unchanged...

// STEP 8 — tests + verify
WRITE(test/confidence.test.mjs): same calibrated → same label across scales; floors monotonic
WRITE(test/drill-down.test.mjs): low-conf journal hit → bridged.text == readJournalFile; high-conf → none; palace path-escape blocked, no throw
WRITE(test/memory-query.test.mjs): empty/low filtered → returns `fallback` not the bare caution string
WRITE(prior-builder test): prompt overlapping a P0 correction emits instinct line above facts
RUN("npm run build && npm test"); IF red: FIX; RUN(again); IF still red: ESCALATE
// trace: fetchVerbatim null + zero results both leave existing empty-state guidance intact
```

**Review-by.** `code-reviewer`. Confirm the gate reads the **stored** `calibrated`, not the boosted final score; confirm drill-down kill-switch + caps exist.

---

### Wave 5 — Corrections-prediction (north-star) + compression remainder

**Goal.** Make human correction *override* the model, auto-derive Blind Spots, and predict the correction before the user makes it. Land the versioned consolidation prompt + `ar consolidate` CLI and coordinate the external `~/.aam` dreaming prompt (human-approved retirement/repoint).

> **Verified facts (correct the originals):**
> - `CorrectionRecord` lacks `authoritative`/`predict_*`; `applyCorrectionDefaults` (117-125) is the right place for an `authoritative` default keyed on `kind==='correction'`. `CorrectionOutcome.kind` is `'retrieved'|'heeded'|'recurred'` — extend with `'predicted'|'predict_hit'`. Don't touch the existing `precision = heeded/retrieved` math; add a separate `predict_precision`.
> - `tokenize`/`overlap` are now exported (Wave 4). `predict-correction.ts` reuses them.
> - The MCP "predictive warnings from past corrections" string is in **`packages/mcp-server/src/index.ts` (lines 101, 143)** + READMEs — **NOT** in `tools/check.ts`. Edit the right file.
> - Awareness `blindSpots` is a `string[]` on the global state — the derived Blind-Spots **profile** is new and must live in a **personal** tier (`projects/<slug>/personal/blind-spots.json`, mode 0600), registered in `classification.ts` (Wave 1) so it never syncs.
> - `session-start.ts` `autoBackfill` (470-505) scans journal + palace/rooms only (non-recursive) — `personal/` is safe by omission today, but add a guard/test so a future recursive scan can't leak it.
> - The over-block gate must be `authoritative!==false AND severity==='p0' AND NOT noise_candidate` (noise = `precision<0.3 && retrieved>=3`, the existing `getCorrectionKPIs` signal) — else stale P0s veto legitimate plans.

**Changes (files).**
- MODIFY `packages/core/src/storage/corrections.ts` — add `authoritative?`, `predicted_count?`, `predict_hits?`, `predict_precision?`, `last_predicted?` to `CorrectionRecord`; extend `CorrectionOutcome.kind` with `'predicted'|'predict_hit'`; default `authoritative` in `applyCorrectionDefaults`; extend `recordOutcome` switch (don't touch existing precision); add shared `readOutcomesForToday(slug)` (used by 4 call sites — single source).
- NEW `packages/core/src/helpers/blind-spots.ts` — `deriveBlindSpots(corrections, alignmentLog): BlindSpotProfile`. Reuse `extractKeywords` + `cleanRule` clustering from `alignment-patterns.ts` (do NOT fork the matching grammar). Cluster ≥2 (≥1 if P0) ⇒ `BlindSpot{tendency, evidence_count, severity, trigger_keywords[], example_rule, last_seen}`. Pure, no LLM. Normalize alignment-log entries (`corrections:string[]`/`delta`) vs correction records (`.rule`) — explicit contract.
- NEW `packages/core/src/storage/blind-spots-store.ts` — write to `personalDir(slug)/blind-spots.json` (atomic, 0600); write a one-line `personal/README` marking it sync-excluded; `readBlindSpots(slug)` returns null when absent.
- MODIFY `packages/core/src/storage/paths.ts` — add `personalDir(project)` mirroring `palaceDir` with `assertInsideRoot`.
- NEW `packages/core/src/tools-logic/predict-correction.ts` — `predictCorrection({plan, project}): {likelihood, top_risks[], matched_blind_spots[], suggested_guard}`. Reuse exported `tokenize`/`overlap`; load profile (lazy recompute if missing) + active corrections; weighted overlap lifted by recurrence + `predict_precision`; **high-threshold-first ternary** band (`>=0.6?'high':>=0.3?'medium':'low'`); for each fired risk `recordOutcome(kind:'predicted')`. Synchronous (no spawned agent — Decision #3).
- MODIFY `packages/core/src/tools-logic/check.ts` — attach a `prediction` block; when `likelihood==='high' && input.confidence==='high'` append an over-confidence line to `calibration_note`.
- MODIFY `packages/mcp-server/src/index.ts` (lines 101, 143) + READMEs — reword "predictive warnings from past corrections" to reflect forward anticipation.
- MODIFY `packages/core/src/tools-logic/check-action.ts` — add `verdict:'advisory'|'blocked'`; `blocked` only when a matched correction is `authoritative!==false && severity==='p0' && NOT noise_candidate`; prepend a `⛔ CONFLICT: a human correction OVERRIDES this plan` line. Also `recordOutcome(heeded|recurred)` when a surfaced correction shows compliance/violation signal (real outcome).
- MODIFY `packages/cli/src/index.ts` `hook-pretool` (~1092, case spans 1027-1190) — surface `verdict==='blocked'` first, still capped at 6 lines. Add `case "blind-spots"` (`--recompute` flag for the dream prompt). Add `case "consolidate"` (mirror `synthesize` ~404): `runDecayPass` (default `--dry-run`), `buildConsolidationPrompt` + `findCrystallizationCandidates`, `proposeSkillsFromPhases`; print prompt + candidates. **No cron creation.**
- MODIFY `packages/core/src/tools-logic/session-end.ts` — weaken the default-heeded block (~233): only default-heeded when `readOutcomesForToday` has no real outcome for that correction; close `predict_hit` when a `predicted` later `recurred`. In step-3 consolidation (async), guarded fire-and-forget `recomputeBlindSpots(slug)`.
- MODIFY `packages/core/src/tools-logic/session-start.ts` — add `blind_spots` (top 2 from `readBlindSpots`) + `predicted_risks` (run `predictCorrection` against active phase goal + latest journal `## Next`, top 2) to the orientation block (prior pushed early); reuse the 1/day `recordOutcome('retrieved')` guard. READ only — derivation is async.
- NEW `packages/core/src/prompts/consolidation-prompt.ts` — `CONSOLIDATION_PROMPT_TEMPLATE` + `buildConsolidationPrompt(slug, bundle)`, porting **only Phase B (candidate-finding)** of T1 Step 4.5 into the bundle and leaving Phase C (synthesis) to the LLM. Refactor `session-end-reflect.ts:buildPrompt()` to import it (single source). Verify tsconfig globs `src/**/*` so `prompts/` compiles to `dist/prompts/`.
- NEW `packages/core/src/tools-logic/skill-propose.ts` — `proposeSkillsFromPhases(slug)`: scan closed milestones' `how_solved`/`synthesis` (via `listMilestones`) for repeated procedural shape; emit DRAFT `SkillBody` (`source:'auto_reflection'`) into `ReflectResult`. **Do not auto-write** — agent confirms (agent-as-author).
- MODIFY `packages/core/src/index.ts` — export `deriveBlindSpots`, `readBlindSpots`, `recomputeBlindSpots`, `predictCorrection`, `proposeSkillsFromPhases`, `buildConsolidationPrompt`, `readOutcomesForToday`, types.
- NEW tests: `packages/core/test/blind-spots.test.mjs`, `predict-correction.test.mjs`, extend `corrections.test.mjs`, `check-action` verdict test, `personal-not-backfilled.test.mjs`.

**Plywood SOP.**
```
CORE="packages/core/src"; MCP="packages/mcp-server/src"; CLI="packages/cli/src/index.ts"
// REDLINE: no version bump/publish/deploy/push/cron. Barrel-export new fns BEFORE the .test.mjs that import them. Build before every test.

// PHASE 0 — tests first (correct harness: .test.mjs importing ../dist, build-then-run)
WRITE(test/blind-spots.test.mjs): 3 same-keyword corrections cluster into 1 blind spot
WRITE(test/predict-correction.test.mjs): high-recurrence correction + overlapping plan → likelihood "high"; empty store → "low", no throw
WRITE(test/corrections.test.mjs additions): recordOutcome("predicted"|"predict_hit") updates predict_precision, leaves precision untouched
WRITE(check-action verdict test): authoritative p0 (not noise) → "blocked" + CONFLICT line; noise p0 → "advisory"
WRITE(test/personal-not-backfilled.test.mjs): autoBackfill never reads projects/<slug>/personal/
RUN("npm run build && npm test")                       // RED

// PHASE 1 — schema backbone
EDIT(CORE/storage/corrections.ts): + authoritative?,predicted_count?,predict_hits?,predict_precision?,last_predicted?
  CorrectionOutcome.kind += "predicted"|"predict_hit"
  applyCorrectionDefaults: authoritative = rec.authoritative ?? ((rec.kind??"correction")==="correction")
  recordOutcome: predicted→predicted_count++,last_predicted=at ; predict_hit→predict_hits++ ;
                 predict_precision = predicted_count>0 ? min(1,predict_hits/predicted_count) : undefined   // DO NOT touch `precision`
  add readOutcomesForToday(slug): Map<id,Set<kind>>     // shared by predict/check-action/session-start/session-end

// PHASE 2 — personal tier (privacy boundary; registered in classification.ts from Wave 1)
EDIT(CORE/storage/paths.ts): add personalDir(project) mirror palaceDir w/ assertInsideRoot
WRITE(CORE/storage/blind-spots-store.ts): writeBlindSpots(slug,profile) atomic 0600 to personalDir/blind-spots.json + personal/README "DO NOT sync"; readBlindSpots(slug)→null if absent; recomputeBlindSpots(slug)
WRITE(CORE/helpers/blind-spots.ts): deriveBlindSpots(corrections, alignmentLog) — reuse extractKeywords+cleanRule; normalize alignment(corrections[]/delta) vs record(.rule)

// PHASE 3 — predictor (reuse Wave-4 exported tokenize/overlap; synchronous)
WRITE(CORE/tools-logic/predict-correction.ts):
  predictCorrection({plan,project}):
    slug=resolveProject(project); profile=readBlindSpots(slug) ?? recomputeBlindSpots(slug)
    pt=tokenize(plan); risks=[]
    for bs of profile.blind_spots:
      ov=overlap(pt,Set(bs.trigger_keywords)); IF ov.length>=2:
        score = ov.length*(bs.severity=="p0"?1.5:1)*(1+0.2*(matchingCorrection?.recurrence_count??0))
        risks.push({tendency:bs.tendency,score,matched:ov,correction_id})
    raw=normalize(sum(score),pt.size)
    likelihood = raw>=0.6?"high":raw>=0.3?"medium":"low"   // HIGH-THRESHOLD-FIRST
    for r of topRisks: try recordOutcome({correction_id:r.correction_id,project:slug,kind:"predicted",at:nowISO}) catch{}
    return {likelihood, top_risks:topRisks.slice(0,3), matched_blind_spots, suggested_guard}

// PHASE 4 — wire prediction into check(); reword the RIGHT MCP file
EDIT(CORE/tools-logic/check.ts): try result.prediction=predictCorrection({plan:input.goal,project:slug}) catch{}
  IF prediction.likelihood=="high" AND input.confidence=="high": calibration_note += "OVER-CONFIDENCE GUARD: a prior correction predicts this plan is likely to be corrected — reconcile first."
EDIT(MCP/index.ts lines 101,143 + READMEs): reword "predictive warnings from past corrections" → forward anticipation

// PHASE 5 — authoritative override in check_action (gated against noise)
EDIT(CORE/tools-logic/check-action.ts): add verdict
  authP0 = matches.find(c => record(c).authoritative!==false && c.severity=="p0" && !isNoiseCandidate(c))
  verdict = authP0 ? "blocked" : "advisory"
  IF blocked: warning = "⛔ CONFLICT: a human correction OVERRIDES this plan — reconcile before proceeding.\n"+warning
  ALSO recordOutcome(heeded|recurred) on real compliance/violation signal
EDIT(CLI hook-pretool ~1092): IF verdict=="blocked": push CONFLICT line first (still cap 6 lines)

// PHASE 6 — honest heeded loop + async derivation
EDIT(CORE/tools-logic/session-end.ts ~233): todayOut=readOutcomesForToday(slug)
  for c: IF todayOut.get(c.id) has heeded|recurred: CONTINUE  // real outcome beats default
         IF todayOut.get(c.id) has "predicted" AND now recurred/warned-then-heeded: recordOutcome(predict_hit)
  step-3 (async consolidation): try recomputeBlindSpots(slug) catch{}   // NOT in the Stop hook
EDIT(CORE/tools-logic/session-start.ts): READ blind_spots(top2)+predicted_risks(top2 from predictCorrection over phase goal + latest ## Next); reuse 1/day retrieved-guard

// PHASE 7 — versioned consolidation prompt + skill drafts + CLI (in-repo replacement for ~/.aam prompt)
WRITE(CORE/prompts/consolidation-prompt.ts): CONSOLIDATION_PROMPT_TEMPLATE + buildConsolidationPrompt(slug,bundle) — PORT ONLY Phase B (candidates); Phase C synthesis stays the LLM's job
EDIT(session-end-reflect.ts buildPrompt): import buildConsolidationPrompt (single source)
WRITE(CORE/tools-logic/skill-propose.ts): proposeSkillsFromPhases(slug) → DRAFT SkillBody[]{source:"auto_reflection"} into ReflectResult (NO writeSkill)
EDIT(CLI): case "consolidate": print runDecayPass(slug,{dryRun:!hasFlag("--apply")}) + buildConsolidationPrompt + findCrystallizationCandidates + proposeSkillsFromPhases
           case "blind-spots": --recompute ? recomputeBlindSpots(slug) : readBlindSpots(slug) ?? "none yet"
EDIT(CORE/index.ts): export deriveBlindSpots,readBlindSpots,recomputeBlindSpots,predictCorrection,proposeSkillsFromPhases,buildConsolidationPrompt,readOutcomesForToday,types

// PHASE 8 — verify
RUN("npm run build && npm test"); IF red: FIX; RUN(again); IF still red: ESCALATE
// trace: predictCorrection on empty store → "low", no throw; check-action with no matches → "advisory"
DISPATCH(code-reviewer)                                  // never self-review
ESCALATE_TO_HUMAN("Plan complete. Coordinate retiring/repointing the external ~/.aam/dreams prompt to `ar consolidate` " +
                  "(human-approved op). Communicate that a precision DROP after removing optimistic-heeded bias is EXPECTED, not a regression.")
```

**Review-by.** `code-reviewer` + `security-reviewer` (personal-tier path stays off sync/backfill). Confirm the `blocked` verdict is gated against noise-candidates.

---

## 5. Risks & Mitigations

| # | Risk | Sev | Mitigation |
|---|------|-----|-----------|
| 1 | **PRIVACY — personal model already leaking to Supabase TODAY** (`syncToSupabase(...,"awareness")` runs synchronously now; Blind-Spots/awareness behavioral layer is the highest-sensitivity artifact). | **Critical** | Wave 1 FIRST. `sync_personal=false` default. Derive any future `.gitignore` from `classification.ts` (single source) + a test that fails if a personal store lacks a gate. Raw tier (Wave 2) writes local-only, never `syncToSupabase`. Confirm `autoBackfill` never reaches `personal/`. **Surface (don't pick) the awareness-vs-dashboard sync decision.** |
| 2 | **Migration / breaking 51 existing projects (12M).** Dropping the 60-char stub means hook-end may write nothing; `arstatus` cache, dashboard counts, `.last-session-summary.txt`, and the semantic-prefetch block all read `summary`. 80KB verbatim per session is unbounded. | High | Guard semantic-prefetch + arstatus-cache behind `if(summary)`. `journalDirs(includeArchive=false)` already excludes archive from counting — verify dashboard/project-status globs do too. Define retention (cap tailBytes; prune/gzip raw once `.consumed` marks distilled) **as part of Wave 2**, reusing `journalArchive`'s `older_than_days`. |
| 3 | **Test-harness mismatch** — every original SOP assumed vitest/`.test.ts`/pnpm. None exist. | High | Universal test contract (§4): `.test.mjs` + `node:test`, import from `dist`, build before test, `npm` workspaces. RED = module-not-found after a build that omits the new module. |
| 4 | **Stop-hook stdin contract unverified** — `transcript_path` appears nowhere; hook-end reads no stdin today; Stop can double-fire; empty `session_id` collides on date. | High | Capture a live Stop payload before relying on field names; fall back to proven `readTodaySessions`. Dedup key = transcript filename UUID, not date. Append-only + cap bytes + exit-0 fast. CLI test: empty stdin → exit 0 silent. |
| 5 | **REDLINE** — version bump / publish / deploy / push / cron. Repo mid SEO/MCP-registry push. settings.json edits are cross-repo (git-backed `Goldentrii/claude`); git-mirror has a push path. | High | Every wave delivers branch + green + tests, then STOP. No auto-push from any hook/dreaming path (commit-only at most, deferred). No cron — `ar consolidate`/`consolidate-async`/`blind-spots` are invocable only. settings.json: build dist first, write a `.bak`, human-approved. |
| 6 | **Over-blocking** from `verdict:'blocked'`; precision metric will (correctly) DROP after removing optimistic-heeded bias. | Medium | Gate `blocked` on `authoritative!==false && p0 && NOT noise_candidate` (`precision<0.3 && retrieved>=3`). Communicate up front that the precision drop is expected and correct. Thresholds are tunable constants. |
| 7 | **Duplicate-area waste** — archive-tier ≈ auto-save-hooks (two writers, two Stop rewrites). | Medium | **Merged into ONE** archive design (Wave 2). One reader (reuse `readHeadTail`), one Stop command, one consume marker, one `MEMORY-PROTOCOL.md` generator. |
| 8 | **Confidence calibration untuned** — divisors (0.12/0.049) are theoretical maxima; the local post-RRF score is boosted ×3–6 after RRF, so the gate must read the **stored** `calibrated`, not the mutated final score. | Medium | Land scale-unification as a standalone commit; gate on stored `calibrated`. Cap drill-down ≤2 items / ≤1200 chars + a `drilldown:false` kill-switch. Prior-overlap starts at ≥2, loosen only if recall too low. Tune against a fixture corpus before trusting the medium floor. |
| 9 | **FSRS write-amplification** — reinforce-on-recall mutates skill files on every hit in git-tracked memory. | Medium | Throttle: skip write if `last_confirmed` within N hours. Atomic tmp+rename (already in `writeSkill`). Backfill missing `fsrs` via `initFsrs` lazily. |
| 10 | **Inert `archived` flag** — zero readers today; writing it without reader-side filtering is a no-op. | Medium | Wave 3 adds `archived` filtering to `listSkills` + recall + session_start consumers; a test asserts an archived skill is filtered out (flag is live). |

---

## 6. Non-Goals / YAGNI

- **No live/synchronous sidecar storage agent.** Retrieval stays a function (`smartRecall`/`check`); consolidation stays the async dreaming agent. No spawned per-recall agent, no cold-start brief (Decision #3). *Add a one-line ADR note in `MEMORY-PROTOCOL.md` locking this so a future contributor doesn't reintroduce it.*
- **Do NOT build both archive writers.** archive-tier and auto-save-hooks are duplicates → one merged design (Wave 2). No second transcript reader — reuse `readHeadTail`.
- **No standalone MCP `predict_correction` tool.** Fold prediction into `check()` (Agent-First simplicity). Same for a standalone `git_mirror` tool beyond the minimum.
- **No cron / scheduler creation** for `ar consolidate` / `consolidate-async` / `blind-spots --recompute`. Ship invocable commands; the human or AAM wires scheduling (human-approved).
- **No git-mirror PUSH path / GitHub remote this cycle.** Decision #6: design the privacy split before sync. Local-commit substrate at most; remote push deferred until the privacy boundary is proven AND the awareness-vs-dashboard sync question is resolved.
- **No Plywood migration of existing skills** (Decision #4). The additive `plywood?:` field is cheap and may land opportunistically, but rewriting prose skills into pseudocode is scope creep — punt unless named.
- **Do NOT expand the Hopfield/associative-memory machinery** (`hopfield.ts`) — unreferenced by any of the 8 decisions. Resist infra-for-infra.
- **Do NOT run the external `~/.aam` T1/T4 prompts in parallel with an in-repo port** (two diverging sources). Either repoint the external cron to the in-repo job (human-approved) or leave it external — not both.

---

## 7. North-Star Metric: Predict-the-Correction

**Definition.** Anticipate a correction *before* the user makes it. The system wins when a fired prediction reliably precedes an actual correction/recurrence.

**Instrumentation (lands in Wave 5, already in the schema plan):**
- `recordOutcome(kind:'predicted')` when `predictCorrection` fires a risk for a correction.
- `recordOutcome(kind:'predict_hit')` when a `predicted` correction later `recurred` (or was warned-then-heeded) the same period.
- `predict_precision = min(1, predict_hits / predicted_count)` per correction — **kept separate** from the existing `precision = heeded/retrieved`.

**How to measure (the eval the critic flagged as missing — build it as the Wave 5 verifier, not a tool):**
```
// offline replay eval — packages/core/test/predict-eval.test.mjs (or a benchmark/*.mjs)
GIVEN a fixture corpus of real correction histories (anonymized; from a temp-root, NOT live ~/.agent-recall)
for each correction C with a known first-occurrence date D and recurrence date D':
  build the Blind-Spots profile from corrections BEFORE D'           // no look-ahead leakage
  run predictCorrection({plan: the-plan-text-at-D', project})
  record: did a top_risk match C with likelihood >= medium?
REPORT:
  recall    = (# recurrences predicted) / (# recurrences)            // did we see it coming?
  precision = (# predictions that preceded a real correction) / (# predictions fired)
  lead_time = median(D' - prediction_time)                           // how early
ACCEPT only if recall and precision beat a keyword-baseline on the fixture; thresholds (0.6/0.3) are tunable
```
Without this offline replay, prediction quality is unfalsifiable — so the eval is the gate, not an afterthought.

**The "auto-derive Blind Spots" test (Wave 5 unit test):**
```
// packages/core/test/blind-spots.test.mjs
GIVEN 3 corrections sharing >=2 cleaned keywords (e.g. "infra over revenue") with sum(confirmations) >= 5
WHEN deriveBlindSpots(corrections, alignmentLog) runs
THEN exactly 1 BlindSpot is produced with evidence_count==3, the shared trigger_keywords, severity by P0-presence
AND a single P0 correction (count==1) still yields a BlindSpot (>=1-if-P0 rule)
AND the profile is written ONLY to personalDir/blind-spots.json (mode 0600), NEVER under palace/ or any sync path
AND classifyPath(thatFile) === "personal"                          // privacy invariant
```

This closes the loop from Decision #8: corrections are ground truth that overrides the model (`verdict:'blocked'`), and their accumulation auto-derives the user's behavioral profile, which `predictCorrection` pushes as an early prior at `session_start` and `hook-ambient` — memory becoming understanding.
