import {
  setRoot, getRoot,
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
  readGraph, addEdge, getConnectedRooms,
} from "agent-recall-core";

export interface AgentRecallOptions {
  /** Storage root directory. Default: ~/.agent-recall */
  root?: string;
  /** Project slug. Default: auto-detect from git/cwd */
  project?: string;
}

export class AgentRecall {
  private readonly project: string | "auto";

  constructor(options?: AgentRecallOptions) {
    if (options?.root) {
      setRoot(options.root);
    }
    this.project = options?.project ?? "auto";
  }

  // --- L1: Working Memory (Capture) ---

  async capture(question: string, answer: string, opts?: { tags?: string[]; palaceRoom?: string }): Promise<JournalCaptureResult> {
    return journalCapture({ question, answer, tags: opts?.tags, palace_room: opts?.palaceRoom, project: this.project });
  }

  // --- L2: Episodic Memory (Journal) ---

  async journalRead(opts?: { date?: string; section?: string }): Promise<JournalReadResult> {
    return journalRead({ date: opts?.date ?? "latest", section: opts?.section ?? "all", project: this.project });
  }

  async journalWrite(content: string, opts?: { section?: string; palaceRoom?: string }): Promise<JournalWriteResult> {
    return journalWrite({ content, section: opts?.section, palace_room: opts?.palaceRoom, project: this.project });
  }

  async journalList(limit?: number): Promise<JournalListResult> {
    return journalList({ project: this.project, limit: limit ?? 10 });
  }

  async journalSearch(query: string, opts?: { section?: string; includePalace?: boolean }): Promise<JournalSearchResult> {
    return journalSearch({ query, project: this.project, section: opts?.section, include_palace: opts?.includePalace });
  }

  async state(action: "read" | "write", data?: string, date?: string): Promise<JournalStateResult> {
    return journalState({ action, data, date: date ?? "latest", project: this.project });
  }

  async coldStart(): Promise<JournalColdStartResult> {
    return journalColdStart({ project: this.project });
  }

  async archive(olderThanDays?: number): Promise<JournalArchiveResult> {
    return journalArchive({ older_than_days: olderThanDays ?? 7, project: this.project });
  }

  async rollup(opts?: { minAgeDays?: number; minEntries?: number; dryRun?: boolean }): Promise<JournalRollupResult> {
    return journalRollup({ min_age_days: opts?.minAgeDays ?? 7, min_entries: opts?.minEntries ?? 2, dry_run: opts?.dryRun ?? false, project: this.project });
  }

  async projects(): Promise<JournalProjectsResult> {
    return journalProjects();
  }

  // --- L3: Memory Palace ---

  async palaceWrite(room: string, content: string, opts?: { topic?: string; connections?: string[]; importance?: Importance }): Promise<PalaceWriteResult> {
    return palaceWrite({ room, content, topic: opts?.topic, connections: opts?.connections, importance: opts?.importance, project: this.project });
  }

  async palaceRead(room?: string, topic?: string): Promise<PalaceReadResult> {
    return palaceRead({ room, topic, project: this.project });
  }

  async walk(depth?: WalkDepth, focus?: string): Promise<PalaceWalkResult> {
    return palaceWalk({ depth: depth ?? "active", focus, project: this.project });
  }

  async lint(fix?: boolean): Promise<PalaceLintResult> {
    return palaceLint({ fix: fix ?? false, project: this.project });
  }

  async palaceSearch(query: string, room?: string): Promise<PalaceSearchResult> {
    return palaceSearch({ query, room, project: this.project });
  }

  // --- L4: Awareness ---

  async awarenessUpdate(insights: AwarenessUpdateInput["insights"], opts?: { trajectory?: string; blindSpots?: string[]; identity?: string }): Promise<AwarenessUpdateResult> {
    return awarenessUpdate({ insights, trajectory: opts?.trajectory, blind_spots: opts?.blindSpots, identity: opts?.identity });
  }

  readAwareness(): string {
    return readAwareness();
  }

  readAwarenessState(): AwarenessState | null {
    return readAwarenessState();
  }

  // --- L5: Insight Index ---

  async recallInsight(context: string, opts?: { limit?: number; includeAwareness?: boolean }): Promise<RecallInsightResult> {
    return recallInsight({ context, limit: opts?.limit ?? 5, include_awareness: opts?.includeAwareness ?? true });
  }

  // --- Alignment & Knowledge ---

  async alignmentCheck(input: Omit<AlignmentCheckInput, "project"> & { project?: string }): Promise<{ success: boolean; date: string; confidence: string; delta: string; file: string }> {
    return alignmentCheck({ ...input, project: input.project ?? this.project });
  }

  async nudge(input: Omit<NudgeInput, "project"> & { project?: string }): Promise<{ success: boolean; date: string; category: string; file: string }> {
    return nudge({ ...input, project: input.project ?? this.project });
  }

  async synthesize(opts?: { entries?: number; focus?: string; includePalace?: boolean; consolidate?: boolean }): Promise<ContextSynthesizeResult> {
    return contextSynthesize({ entries: opts?.entries ?? 5, focus: (opts?.focus ?? "full") as "full" | "decisions" | "blockers" | "goals", include_palace: opts?.includePalace ?? true, consolidate: opts?.consolidate ?? false, project: this.project });
  }

  async knowledgeWrite(input: Omit<KnowledgeWriteInput, "project"> & { project?: string }): Promise<{ success: boolean; project: string; category: string; title: string; severity: string; file: string; palace: { room: string; topic: string } | null }> {
    return knowledgeWrite({ ...input, project: input.project ?? this.project });
  }

  async knowledgeRead(opts?: Omit<KnowledgeReadInput, never>): Promise<string> {
    return knowledgeRead(opts ?? {});
  }

  // --- Modern composite API (v3.4) ---
  // These wrap the SAME core functions the MCP tools of the same name
  // delegate to (session_start, remember, recall, session_end, check) —
  // see packages/mcp-server/src/tools/{session-start,remember,recall,
  // session-end,check}.ts for the 1:1 mapping this mirrors.

  async sessionStart(opts?: { context?: string }): Promise<SessionStartResult> {
    return sessionStart({ project: this.project, context: opts?.context });
  }

  async remember(content: string, opts?: { context?: string }): Promise<SmartRememberResult> {
    return smartRemember({ content, context: opts?.context, project: this.project });
  }

  async recall(query: string, opts?: Omit<SmartRecallInput, "query" | "project"> & { project?: string }): Promise<SmartRecallResult> {
    return smartRecall({ query, project: opts?.project ?? this.project, ...opts });
  }

  async sessionEnd(summary: string, opts?: Omit<SessionEndInput, "summary" | "project"> & { project?: string }): Promise<SessionEndResult> {
    return sessionEnd({ summary, project: opts?.project ?? this.project, ...opts });
  }

  async check(input: Omit<CheckInput, "project"> & { project?: string }): Promise<CheckResult> {
    return check({ ...input, project: input.project ?? this.project });
  }

  // --- Digest (context cache) ---

  async digestStore(input: Omit<DigestStoreInput, "project"> & { project?: string }): Promise<DigestStoreResult> {
    return digestStore({ ...input, project: input.project ?? this.project });
  }

  async digestRecall(query: string, opts?: Omit<DigestRecallInput, "query" | "project"> & { project?: string }): Promise<DigestRecallResult> {
    return digestRecall({ query, project: opts?.project ?? this.project, ...opts });
  }

  async digestRead(digestId: string, opts?: { project?: string }): Promise<DigestReadResult> {
    return digestRead({ digest_id: digestId, project: opts?.project ?? this.project });
  }

  digestInvalidate(project: string, digestId: string, reason?: string, global?: boolean): void {
    digestMarkStale(project, digestId, reason ?? "manually invalidated", global);
  }

  // --- Low-level access ---

  get palace() {
    const project = this.project === "auto" ? "default" : this.project;
    return {
      ensureInitialized: () => ensurePalaceInitialized(project),
      createRoom: (slug: string, name: string, description: string, tags?: string[]) =>
        createRoom(project, slug, name, description, tags),
      getRoom: (slug: string) => getRoomMeta(project, slug),
      listRooms: () => listRooms(project),
      roomExists: (slug: string) => roomExists(project, slug),
    };
  }

  get graph() {
    return { readGraph, addEdge, getConnectedRooms };
  }
}
