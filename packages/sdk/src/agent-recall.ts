import * as os from "node:os";
import * as path from "node:path";
import { createMemoryRuntime, type MemoryRuntime } from "agent-recall-core/repository/runtime.js";
import {
  fenceMemory,
  type Importance, type WalkDepth,
  type AwarenessState,
  // Digest
  digestStore, type DigestStoreInput, type DigestStoreResult,
  digestRecall, type DigestRecallInput, type DigestRecallResult,
  digestRead, type DigestReadInput, type DigestReadResult,
  markStale as digestMarkStale,
  // Tool-logic functions
  journalRead, type JournalReadResult,
  journalWrite, type JournalWriteResult,
  journalCapture, type JournalCaptureResult,
  journalList, type JournalListResult,
  journalSearch, type JournalSearchResult,
  journalState, type JournalStateResult,
  journalColdStart, type JournalColdStartResult,
  journalArchive, type JournalArchiveResult,
  journalRollup, type JournalRollupResult,
  journalProjects, type JournalProjectsResult,
  palaceWrite, type PalaceWriteResult,
  palaceRead, type PalaceReadResult,
  palaceWalk, type PalaceWalkResult,
  palaceLint, type PalaceLintResult,
  palaceSearch, type PalaceSearchResult,
  awarenessUpdate, type AwarenessUpdateInput, type AwarenessUpdateResult,
  recallInsight, type RecallInsightResult,
  alignmentCheck, type AlignmentCheckInput,
  nudge, type NudgeInput,
  contextSynthesize, type ContextSynthesizeResult,
  knowledgeWrite, type KnowledgeWriteInput,
  knowledgeRead, type KnowledgeReadInput,
  readAwareness, readAwarenessState,
  // Modern (v3.4) composite API — same core functions the MCP tools
  // session_start / remember / recall / session_end / check delegate to.
  sessionStart, type SessionStartResult,
  smartRemember, type SmartRememberResult,
  smartRecall, type SmartRecallInput, type SmartRecallResult,
  sessionEnd, type SessionEndInput, type SessionEndResult,
  check, type CheckInput, type CheckResult,
  // Palace low-level
  ensurePalaceInitialized, createRoom, getRoomMeta, listRooms, roomExists,
  readGraph, addEdge, getConnectedRooms, type RoomMeta,
} from "agent-recall-core";

export interface AgentRecallOptions {
  /** Storage root directory. Default: ~/.agent-recall */
  root?: string;
  /** Project slug. Default: auto-detect from git/cwd */
  project?: string;
}

// ---------------------------------------------------------------------------
// P1 fence (TOW2-388, completeness-pass CRITICAL find) — SDK boundary.
//
// The SDK's methods are thin delegates to the SAME core tools-logic functions
// the MCP tools and CLI commands wrap (see this file's original header
// comment) — every method already classified "fenced" at its MCP or CLI
// entry point (packages/mcp-server/src/tools/*.ts, packages/cli/src/index.ts)
// carries the identical risk here: the SDK README's own usage example
// (`const ctx = await memory.recall("rate limiting")`) shows a caller taking
// the return value and using it as `ctx` — exactly "feeding results straight
// into agent context".
//
// Unlike CLI stdout / MCP tool_result text (both pre-rendered strings), the
// SDK's contract IS the typed return object — a consuming app may read
// individual fields programmatically, so fencing cannot rewrite every
// leaf string in place without either (a) breaking the O(1)-per-block
// design fenceMemory was built to guarantee (see content-guard.ts's own
// "token cost is O(1) per block" test) if applied per-field, or (b)
// changing the return TYPE from an object to a bare string if the whole
// object were JSON.stringify+fenced in place (the approach used by
// MCP tools with no per-field formatter, e.g. smart_recall/check) — a real
// breaking API change for a published package, out of scope for a
// no-version-bump fence-completeness pass.
//
// Fix: every "fenced" SDK method returns its ORIGINAL typed result UNCHANGED
// plus one ADDITIVE `fencedText` field — `fenceMemory(JSON.stringify(result))`
// — the exact same whole-blob strategy already proven at the MCP layer,
// computed ONCE per call (still O(1) per block), and purely additive so no
// existing field/type a consumer already reads is altered. `ctx.fencedText`
// is what a caller should hand to an LLM prompt; the original typed fields
// remain available for programmatic use exactly as before.
function withFenced<T extends object>(result: T): T & { fencedText: string } {
  return { ...result, fencedText: fenceMemory(JSON.stringify(result)) };
}

/** Direct-string surfaces (readAwareness/knowledgeRead) — no object to preserve, fence in place. */
function fenceString(s: string): string {
  return fenceMemory(s);
}

/**
 * RoomMeta.description is free text set at room-creation time (possibly by
 * an earlier, different session) and read back verbatim by getRoom/listRooms
 * — same risk class and same re-triage decision as the CLI `ar rooms`
 * command (P1 completeness-pass MEDIUM re-triage, 2026-08-19). Fenced
 * in-place on the ONE prose field; every other RoomMeta field (slug, counts,
 * timestamps, tags/connections — identifiers, not prose) is left untouched.
 */
function fenceRoomMeta(meta: RoomMeta | null): RoomMeta | null {
  if (!meta) return meta;
  return { ...meta, description: fenceMemory(meta.description) };
}

/**
 * P1 fix (TOW2-324, G1-root-sdk.md): this used to be the SDK's ONLY root
 * handling — a bare `setRoot(options.root)` writing the process-global root
 * (packages/core/src/types.ts's `_root`). Constructing a SECOND instance
 * silently redirected every earlier instance's subsequent calls too (the
 * "Case B" leak this exact fix closes). Not reading `getRoot()` here to
 * avoid tripping strict-mode (R2.9) once ANY instance in the process has
 * created a runtime — this duplicates just the plain env/home fallback.
 */
function defaultRoot(): string {
  return process.env.AGENT_RECALL_ROOT ?? path.join(os.homedir(), ".agent-recall");
}

export class AgentRecall {
  private readonly project: string | "auto";
  private readonly runtime: MemoryRuntime;

  constructor(options?: AgentRecallOptions) {
    const root = options?.root ?? defaultRoot();
    // mode "legacy": every method below still goes through the SAME
    // getRoot()-resolving core tools-logic as before (journal/palace files) —
    // this runtime exists purely to give THIS instance its own isolated root
    // via AsyncLocalStorage (R2.9), not to route through the Repository.
    this.runtime = createMemoryRuntime({ root, mode: "legacy" });
    this.project = options?.project ?? "auto";
  }

  /** Enter this instance's own isolated root context for the duration of `fn` (R2.9). */
  private run<T>(fn: () => T): T {
    return this.runtime.run(fn);
  }

  // --- L1: Working Memory (Capture) ---

  async capture(question: string, answer: string, opts?: { tags?: string[]; palaceRoom?: string }): Promise<JournalCaptureResult> {
    // Not fenced: write confirmation only (entry number, file path,
    // auto-tags derived from THIS call's own question/answer) — no
    // retrieved stored content is returned. Parity: CLI `ar capture` (N).
    return this.run(() => journalCapture({ question, answer, tags: opts?.tags, palace_room: opts?.palaceRoom, project: this.project }));
  }

  // --- L2: Episodic Memory (Journal) ---

  async journalRead(opts?: { date?: string; section?: string }): Promise<JournalReadResult & { fencedText: string }> {
    return withFenced(await this.run(() => journalRead({ date: opts?.date ?? "latest", section: opts?.section ?? "all", project: this.project })));
  }

  async journalWrite(content: string, opts?: { section?: string; palaceRoom?: string }): Promise<JournalWriteResult> {
    // Not fenced: write confirmation only (file path, routing hint) — no
    // retrieved stored content is returned. Parity: CLI `ar write` (N).
    return this.run(() => journalWrite({ content, section: opts?.section, palace_room: opts?.palaceRoom, project: this.project }));
  }

  async journalList(limit?: number): Promise<JournalListResult & { fencedText: string }> {
    return withFenced(await this.run(() => journalList({ project: this.project, limit: limit ?? 10 })));
  }

  async journalSearch(query: string, opts?: { section?: string; includePalace?: boolean }): Promise<JournalSearchResult & { fencedText: string }> {
    return withFenced(await this.run(() => journalSearch({ query, project: this.project, section: opts?.section, include_palace: opts?.includePalace })));
  }

  async state(action: "read" | "write", data?: string, date?: string): Promise<JournalStateResult & { fencedText: string }> {
    // Fenced conservatively regardless of action: the read path returns the
    // raw stored SessionState verbatim (parity: CLI `ar state read`, F);
    // the write path's confirmation shape gains a harmless additive field.
    return withFenced(await this.run(() => journalState({ action, data, date: date ?? "latest", project: this.project })));
  }

  async coldStart(): Promise<JournalColdStartResult & { fencedText: string }> {
    return withFenced(await this.run(() => journalColdStart({ project: this.project })));
  }

  async archive(olderThanDays?: number): Promise<JournalArchiveResult & { fencedText: string }> {
    // `summaries[]` quotes the first line of each archived entry's own
    // stored Brief section verbatim — retrieved content, not administrative
    // counts alone (re-audited during the P1 completeness pass; the prior
    // pass's CLI table did not carry an explicit `ar archive` row).
    return withFenced(await this.run(() => journalArchive({ older_than_days: olderThanDays ?? 7, project: this.project })));
  }

  async rollup(opts?: { minAgeDays?: number; minEntries?: number; dryRun?: boolean }): Promise<JournalRollupResult & { fencedText: string }> {
    // `summariesCreated[]` is synthesizeWeek()'s output — quotes journal
    // decisions/blockers/completed/next-step text verbatim across the
    // rolled-up week (see packages/core/src/helpers/rollup.ts).
    return withFenced(await this.run(() => journalRollup({ min_age_days: opts?.minAgeDays ?? 7, min_entries: opts?.minEntries ?? 2, dry_run: opts?.dryRun ?? false, project: this.project })));
  }

  async projects(): Promise<JournalProjectsResult> {
    // Not fenced: slugs + last-entry dates + counts — structural metadata,
    // no prose. Parity: no CLI/MCP surface disputes this classification.
    return this.run(() => journalProjects());
  }

  // --- L3: Memory Palace ---

  async palaceWrite(room: string, content: string, opts?: { topic?: string; connections?: string[]; importance?: Importance }): Promise<PalaceWriteResult> {
    // Not fenced: write confirmation only. Parity: CLI `ar palace write` (N).
    return this.run(() => palaceWrite({ room, content, topic: opts?.topic, connections: opts?.connections, importance: opts?.importance, project: this.project }));
  }

  async palaceRead(room?: string, topic?: string): Promise<PalaceReadResult & { fencedText: string }> {
    return withFenced(await this.run(() => palaceRead({ room, topic, project: this.project })));
  }

  async walk(depth?: WalkDepth, focus?: string): Promise<PalaceWalkResult & { fencedText: string }> {
    return withFenced(await this.run(() => palaceWalk({ depth: depth ?? "active", focus, project: this.project })));
  }

  async lint(fix?: boolean): Promise<PalaceLintResult> {
    // Not fenced: template-generated diagnostic strings ("Room 'X' has no
    // connections") + room slugs, not retrieved prose. Parity: `ar palace lint` (N).
    return this.run(() => palaceLint({ fix: fix ?? false, project: this.project }));
  }

  async palaceSearch(query: string, room?: string): Promise<PalaceSearchResult & { fencedText: string }> {
    return withFenced(await this.run(() => palaceSearch({ query, room, project: this.project })));
  }

  // --- L4: Awareness ---

  async awarenessUpdate(insights: AwarenessUpdateInput["insights"], opts?: { trajectory?: string; blindSpots?: string[]; identity?: string }): Promise<AwarenessUpdateResult> {
    // Not fenced: `insights_processed` echoes back THIS call's own
    // just-submitted `insights` argument (same-turn trust, same reasoning
    // as MCP `session_end`/`register_rule`) — not memory read back from an
    // earlier, possibly different session.
    return this.run(() => awarenessUpdate({ insights, trajectory: opts?.trajectory, blind_spots: opts?.blindSpots, identity: opts?.identity }));
  }

  readAwareness(): string {
    // Fenced: parity with `ar awareness read` (CLI) and the
    // agent-recall://awareness MCP resource, both already fenced.
    return this.run(() => fenceString(readAwareness()));
  }

  readAwarenessState(): AwarenessState | null {
    // Not fenced: established `--json`/structured-resource precedent.
    // Parity: `ar awareness read --json` and the agent-recall://awareness/state
    // MCP resource, both deliberately left as raw machine-parseable contracts.
    return this.run(() => readAwarenessState());
  }

  // --- L5: Insight Index ---

  async recallInsight(context: string, opts?: { limit?: number; includeAwareness?: boolean }): Promise<RecallInsightResult & { fencedText: string }> {
    return withFenced(await this.run(() => recallInsight({ context, limit: opts?.limit ?? 5, include_awareness: opts?.includeAwareness ?? true })));
  }

  // --- Alignment & Knowledge ---

  async alignmentCheck(input: Omit<AlignmentCheckInput, "project"> & { project?: string }): Promise<{ success: boolean; date: string; confidence: string; delta: string; file: string }> {
    // Not fenced: `confidence`/`delta` echo THIS call's own submitted
    // input.confidence/input.delta verbatim (see alignment-check.ts) — no
    // stored content is read back and returned.
    return this.run(() => alignmentCheck({ ...input, project: input.project ?? this.project }));
  }

  async nudge(input: Omit<NudgeInput, "project"> & { project?: string }): Promise<{ success: boolean; date: string; category: string; file: string }> {
    // Not fenced: `category` echoes THIS call's own input; write-only,
    // no readback of stored content (see nudge.ts).
    return this.run(() => nudge({ ...input, project: input.project ?? this.project }));
  }

  async synthesize(opts?: { entries?: number; focus?: string; includePalace?: boolean; consolidate?: boolean }): Promise<ContextSynthesizeResult & { fencedText: string }> {
    return withFenced(await this.run(() => contextSynthesize({ entries: opts?.entries ?? 5, focus: (opts?.focus ?? "full") as "full" | "decisions" | "blockers" | "goals", include_palace: opts?.includePalace ?? true, consolidate: opts?.consolidate ?? false, project: this.project })));
  }

  async knowledgeWrite(input: Omit<KnowledgeWriteInput, "project"> & { project?: string }): Promise<{ success: boolean; project: string; category: string; title: string; severity: string; file: string; palace: { room: string; topic: string } | null }> {
    // Not fenced: write confirmation only. Parity: CLI `ar knowledge write` (N).
    return this.run(() => knowledgeWrite({ ...input, project: input.project ?? this.project }));
  }

  async knowledgeRead(opts?: Omit<KnowledgeReadInput, never>): Promise<string> {
    // Fenced: parity with `ar knowledge read` (CLI, F) — raw Q&A content.
    return fenceString(await this.run(() => knowledgeRead(opts ?? {})));
  }

  // --- Modern composite API (v3.4) ---
  // These wrap the SAME core functions the MCP tools of the same name
  // delegate to (session_start, remember, recall, session_end, check) —
  // see packages/mcp-server/src/tools/{session-start,remember,recall,
  // session-end,check}.ts for the 1:1 mapping this mirrors.

  async sessionStart(opts?: { context?: string }): Promise<SessionStartResult & { fencedText: string }> {
    return withFenced(await this.run(() => sessionStart({ project: this.project, context: opts?.context })));
  }

  async remember(content: string, opts?: { context?: string }): Promise<SmartRememberResult> {
    // Not fenced: write confirmation only (dest path, retrieval hint).
    // Parity: MCP `remember` (N).
    return this.run(() => smartRemember({ content, context: opts?.context, project: this.project }));
  }

  /**
   * P1 fence (TOW2-388) — this is the EXACT surface this package's own
   * README demonstrates as `const ctx = await memory.recall(...)`, i.e.
   * "feeding results straight into agent context". Result keeps its
   * original typed shape; use `ctx.fencedText` for the prompt-safe string.
   */
  // fix4b review LOW-3 (2026-09-12): `freshnessBias` is Omit-ted from the
  // public typed surface — the legacy multiplicative hot-window boost is
  // contracted to exactly ONE audited internal caller (the CLI ambient
  // hook; see SmartRecallInput.freshnessBias). Exposing it here would
  // silently widen that contract to every SDK consumer's autocomplete.
  async recall(query: string, opts?: Omit<SmartRecallInput, "query" | "project" | "freshnessBias"> & { project?: string }): Promise<SmartRecallResult & { fencedText: string }> {
    return withFenced(await this.run(() => smartRecall({ query, project: opts?.project ?? this.project, ...opts })));
  }

  async sessionEnd(summary: string, opts?: Omit<SessionEndInput, "summary" | "project"> & { project?: string }): Promise<SessionEndResult> {
    // Not fenced: `card`/quality-warnings echo THIS session's own
    // just-submitted summary/insights (same-turn trust) + single-token
    // keyword merge-suggestions (no coherent injection payload possible).
    // Parity: MCP `session_end` (N). Note: sessionEnd() may additionally
    // trigger writeHandoff() — that surface is ALREADY fenced independently
    // at generation time in packages/core/src/helpers/handoff.ts (one of
    // the 13 pre-existing fenced surfaces), so no separate obligation here.
    return this.run(() => sessionEnd({ summary, project: opts?.project ?? this.project, ...opts }));
  }

  async check(input: Omit<CheckInput, "project"> & { project?: string }): Promise<CheckResult & { fencedText: string }> {
    return withFenced(await this.run(() => check({ ...input, project: input.project ?? this.project })));
  }

  // --- Digest (context cache) ---

  async digestStore(input: Omit<DigestStoreInput, "project"> & { project?: string }): Promise<DigestStoreResult> {
    // Not fenced: echoes this-turn's own submission / success flag only.
    // Parity: MCP `digest` store/invalidate actions (N).
    return this.run(() => digestStore({ ...input, project: input.project ?? this.project }));
  }

  async digestRecall(query: string, opts?: Omit<DigestRecallInput, "query" | "project"> & { project?: string }): Promise<DigestRecallResult & { fencedText: string }> {
    return withFenced(await this.run(() => digestRecall({ query, project: opts?.project ?? this.project, ...opts })));
  }

  async digestRead(digestId: string, opts?: { project?: string }): Promise<DigestReadResult & { fencedText: string }> {
    return withFenced(await this.run(() => digestRead({ digest_id: digestId, project: opts?.project ?? this.project })));
  }

  /**
   * Invalidate (soft-delete) a digest by marking it stale.
   *
   * SEMVER NOTE (fix9, 2026-09-12): this signature changed from the
   * synchronous `(...): void` to `async (...): Promise<void>` — existing
   * callers must now `await` it (or handle the returned promise). The old
   * sync signature was the last consumer of the event-loop-blocking
   * Atomics.wait lock variant (fix6-locks review MEDIUM-2); the wait is now
   * async. Lock scope and invalidation semantics are unchanged.
   */
  async digestInvalidate(project: string, digestId: string, reason?: string, global?: boolean): Promise<void> {
    // Not fenced: resolves with no content (Promise<void>), nothing to fence.
    await this.run(() => digestMarkStale(project, digestId, reason ?? "manually invalidated", global));
  }

  // --- Low-level access ---

  get palace() {
    const project = this.project === "auto" ? "default" : this.project;
    return {
      // Not fenced: void return.
      ensureInitialized: () => this.run(() => ensurePalaceInitialized(project)),
      // Not fenced: echoes back THIS call's own just-submitted
      // name/description/tags (same-turn trust) — the RoomMeta returned is
      // the one just created from this call's own arguments, not memory
      // read back from an earlier session.
      createRoom: (slug: string, name: string, description: string, tags?: string[]) =>
        this.run(() => createRoom(project, slug, name, description, tags)),
      // Fenced: `.description` is free text set at room-creation time,
      // possibly by an earlier session, read back verbatim — same
      // completeness-pass MEDIUM re-triage decision as CLI `ar rooms`.
      getRoom: (slug: string) => this.run(() => fenceRoomMeta(getRoomMeta(project, slug))),
      listRooms: () => this.run(() => listRooms(project).map((r) => fenceRoomMeta(r) as RoomMeta)),
      // Not fenced: boolean, no content.
      roomExists: (slug: string) => this.run(() => roomExists(project, slug)),
    };
  }

  get graph() {
    // Not fenced: edges carry room slugs + a fixed edge-type token
    // ("references") + numeric weight/timestamp — structural identifiers,
    // no free-form prose. getConnectedRooms returns slugs only.
    return {
      readGraph: (...args: Parameters<typeof readGraph>) => this.run(() => readGraph(...args)),
      addEdge: (...args: Parameters<typeof addEdge>) => this.run(() => addEdge(...args)),
      getConnectedRooms: (...args: Parameters<typeof getConnectedRooms>) => this.run(() => getConnectedRooms(...args)),
    };
  }
}
