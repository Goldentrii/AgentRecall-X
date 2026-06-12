/**
 * agent-recall-core — shared business logic for AgentRecall.
 *
 * All types, palace operations, storage utilities, and helper functions
 * are re-exported from this barrel.
 */

// Types & constants
export {
  VERSION,
  SECTION_HEADERS,
  DEFAULT_PALACE_ROOMS,
  setRoot,
  resetRoot,
  getRoot,
  getLegacyRoot,
} from "./types.js";
export type {
  JournalEntry,
  ProjectInfo,
  SessionState,
  RoomMeta,
  PalaceIndex,
  GraphEdge,
  PalaceGraph,
  Importance,
  Urgency,
  Confidence,
  WalkDepth,
  MemoryCategory,
  PinStatus,
} from "./types.js";

// Palace — rooms
export {
  createRoom,
  getRoomMeta,
  updateRoomMeta,
  listRooms,
  roomExists,
  ensurePalaceInitialized,
  recordAccess,
  touchRoom,
  isRoomStale,
  countRoomEntries,
} from "./palace/rooms.js";

// Palace — graph
export {
  readGraph,
  writeGraph,
  addEdge,
  removeEdgesFor,
  getConnectionCount,
  getConnectedRooms,
} from "./palace/graph.js";

// Palace — fan-out
export { fanOut } from "./palace/fan-out.js";
export type { FanOutResult } from "./palace/fan-out.js";

// Palace — awareness
export {
  readAwareness,
  writeAwareness,
  readAwarenessState,
  writeAwarenessState,
  initAwareness,
  addInsight,
  detectCompoundInsights,
  renderAwareness,
  readAwarenessArchive,
  writeAwarenessArchive,
  resurrectFromArchive,
} from "./palace/awareness.js";
export type {
  Insight,
  CompoundInsight,
  AwarenessState,
} from "./palace/awareness.js";

// Palace — salience
export {
  computeSalience,
  ARCHIVE_THRESHOLD,
  AUTO_ARCHIVE_THRESHOLD,
  CATEGORY_DECAY,
  URGENCY_WEIGHTS,
} from "./palace/salience.js";

// Palace — insights index
export {
  readInsightsIndex,
  writeInsightsIndex,
  addIndexedInsight,
  recallInsights,
  findSimilarInsight,
  normalizeTitle,
  tokenOverlap,
} from "./palace/insights-index.js";
export type {
  IndexedInsight,
  InsightsIndex,
} from "./palace/insights-index.js";

// Palace — identity
export { readIdentity, writeIdentity } from "./palace/identity.js";

// Palace — index manager
export { readPalaceIndex, updatePalaceIndex } from "./palace/index-manager.js";

// Palace — obsidian
export {
  extractWikilinks,
  addBackReference,
  generateFrontmatter,
  roomReadmeContent,
} from "./palace/obsidian.js";

// Palace — log
export { appendToLog } from "./palace/log.js";

// Palace — consolidate
export { consolidateJournalToPalace } from "./palace/consolidate.js";
export type { ConsolidationResult } from "./palace/consolidate.js";

// Storage
export { journalDir, journalDirs, palaceDir, roomDir, sanitizeSlug, sanitizeProject } from "./storage/paths.js";
export { ensureDir, todayISO, readJsonSafe, writeJsonAtomic } from "./storage/fs-utils.js";
export { detectProject, resolveProject, listAllProjects } from "./storage/project.js";
export { readCwdAllowlist, addCwdToAllowlist, findProjectByCwd } from "./storage/cwd-allowlist.js";
export type { CwdAllowlist } from "./storage/cwd-allowlist.js";
export { getDreamHealth } from "./storage/dream-health.js";
export type { DreamHealth } from "./storage/dream-health.js";
export {
  readBehaviorPolicies,
  registerBehaviorRule,
  recordPolicyLoad,
} from "./storage/behavior-policies.js";
export type {
  BehaviorRule,
  BehaviorPoliciesFile,
  RegisterRuleInput,
  RegisterRuleResult,
} from "./storage/behavior-policies.js";
export { registerRule } from "./tools-logic/register-rule.js";
export type { RegisterRuleToolInput, RegisterRuleToolResult } from "./tools-logic/register-rule.js";
export { checkAction } from "./tools-logic/check-action.js";
export type {
  CheckActionInput,
  CheckActionResult,
  RuleMatch,
  CorrectionMatch,
  InsightMatch,
} from "./tools-logic/check-action.js";
export { getSessionId, journalFileName, captureLogFileName, resetOwnedFiles, resetSessionState } from "./storage/session.js";
export type { SaveType, SmartNameOpts } from "./storage/session.js";
export { acquireLock, withLock } from "./storage/filelock.js";

// Storage — corrections
export {
  writeCorrection,
  readCorrections,
  readActiveCorrections,
  readP0Corrections,
  retractCorrection,
  isLikelyRealCorrection,
} from "./storage/corrections.js";
export type {
  CorrectionRecord,
  WriteCorrectionResult,
  RetractCorrectionResult,
} from "./storage/corrections.js";

// Helpers
export {
  listJournalFiles,
  readJournalFile,
  extractTitle,
  extractMomentum,
  countLogEntries,
  updateIndex,
} from "./helpers/journal-files.js";
export { extractSection, appendToSection } from "./helpers/sections.js";

// Helpers — rollup
export { isoWeek, weekKey, groupByWeek, synthesizeWeek } from "./helpers/rollup.js";

// Helpers — auto-naming
export { generateSlug, detectContentType, extractKeywords, generateTopicName } from "./helpers/auto-name.js";
export type { SlugResult, SlugContext } from "./helpers/auto-name.js";

// Helpers — journal sig/theme classification
export type { SignificanceTag, ThemeTag } from "./helpers/journal-sig-theme.js";
export { autoClassifySig, autoClassifyTheme } from "./helpers/journal-sig-theme.js";

// Helpers — journal name parser
export { parseJournalFileName } from "./helpers/journal-name-parser.js";
export type { ParsedJournalName } from "./helpers/journal-name-parser.js";

// Helpers — consistency
export { consistencyCheck } from "./helpers/consistency.js";
export type { ConsistencyWarning, ConsistencyResult } from "./helpers/consistency.js";

// Helpers — tag generation
export { generateTags } from "./helpers/tag-generator.js";

// Helpers — normalize (stemming + synonyms)
export { stem, getSynonyms, expandQuery } from "./helpers/normalize.js";

// Helpers — journal filter
export { isJournalFile } from "./helpers/journal-filter.js";

// Helpers — alignment patterns
export { readAlignmentLog, extractWatchPatterns } from "./helpers/alignment-patterns.js";
export type { WatchForPattern } from "./helpers/alignment-patterns.js";

// Helpers — handoff artifact
export { generateHandoff, writeHandoff } from "./helpers/handoff.js";
export type { HandoffResult } from "./helpers/handoff.js";

// Tool logic functions (extracted from MCP tool handlers)
export { journalRead, type JournalReadInput, type JournalReadResult } from "./tools-logic/journal-read.js";
export { journalWrite, type JournalWriteInput, type JournalWriteResult } from "./tools-logic/journal-write.js";
export { journalCapture, type JournalCaptureInput, type JournalCaptureResult } from "./tools-logic/journal-capture.js";
export { journalList, type JournalListInput, type JournalListResult } from "./tools-logic/journal-list.js";
export { journalProjects, type JournalProjectsResult } from "./tools-logic/journal-projects.js";
export { projectBoard, type ProjectBoardResult, type ProjectEntry, type ProjectStatus } from "./tools-logic/project-board.js";
export { journalSearch, type JournalSearchInput, type JournalSearchResult } from "./tools-logic/journal-search.js";
export { journalState, stateFilePath, readState, type JournalStateInput, type JournalStateResult } from "./tools-logic/journal-state.js";
export { journalColdStart, type JournalColdStartInput, type JournalColdStartResult } from "./tools-logic/journal-cold-start.js";
export { journalArchive, type JournalArchiveInput, type JournalArchiveResult } from "./tools-logic/journal-archive.js";
export { journalRollup, type JournalRollupInput, type JournalRollupResult } from "./tools-logic/journal-rollup.js";
export { alignmentCheck, type AlignmentCheckInput, type AlignmentCheckResult } from "./tools-logic/alignment-check.js";
export { nudge, type NudgeInput, type NudgeResult } from "./tools-logic/nudge.js";
export { contextSynthesize, type ContextSynthesizeInput, type ContextSynthesizeResult } from "./tools-logic/context-synthesize.js";
export { knowledgeWrite, type KnowledgeWriteInput, type KnowledgeWriteResult } from "./tools-logic/knowledge-write.js";
export { knowledgeRead, type KnowledgeReadInput } from "./tools-logic/knowledge-read.js";
export { palaceRead, type PalaceReadInput, type PalaceReadResult } from "./tools-logic/palace-read.js";
export { palaceWrite, type PalaceWriteInput, type PalaceWriteResult } from "./tools-logic/palace-write.js";
export { palaceWalk, roomSummary, readRoomContent, type PalaceWalkInput, type PalaceWalkResult } from "./tools-logic/palace-walk.js";
export { palaceLint, type PalaceLintInput, type PalaceLintResult, type LintIssue } from "./tools-logic/palace-lint.js";
export { palaceSearch, type PalaceSearchInput, type PalaceSearchResult } from "./tools-logic/palace-search.js";
export { awarenessUpdate, type AwarenessUpdateInput, type AwarenessUpdateResult } from "./tools-logic/awareness-update.js";
export { recallInsight, type RecallInsightInput, type RecallInsightResult } from "./tools-logic/recall-insight.js";

// Tool logic — journal merge
export { journalMerge, type JournalMergeInput, type MergeReceipt } from "./tools-logic/journal-merge.js";

// Tool logic — smart routing
export { smartRemember, type SmartRememberInput, type SmartRememberResult } from "./tools-logic/smart-remember.js";
export { smartRemember as remember } from "./tools-logic/smart-remember.js";
export { smartRecall, type SmartRecallInput, type SmartRecallResult, type SmartRecallResultItem, type SmartRecallDegraded } from "./tools-logic/smart-recall.js";

// Tool logic — v3.4 composite tools (5-tool surface)
export { sessionStart, type SessionStartInput, type SessionStartResult } from "./tools-logic/session-start.js";
export { sessionEnd, checkInsightQuality, type SessionEndInput, type SessionEndResult, type InsightQualityWarning, type MergeSuggestion } from "./tools-logic/session-end.js";
export { promoteConfirmedInsights, type PromotionResult } from "./tools-logic/insight-promotion.js";
export { check, type CheckInput, type CheckResult, type WatchFor, type PastDelta } from "./tools-logic/check.js";
export { memoryQuery, type MemoryQueryInput, type MemoryQueryResult, type MemoryQueryItem } from "./tools-logic/memory-query.js";
export { projectStatus, type ProjectStatusInput, type ProjectStatusResult } from "./tools-logic/project-status.js";

// Digest — context cache (v4.0)
export {
  type DigestEntry,
  type DigestIndex,
  type DigestInvalidation,
  type DigestStoreInput,
  type DigestStoreResult,
  type DigestRecallInput,
  type DigestRecallResult,
  type DigestReadInput,
  type DigestReadResult,
  type MatchedDigest,
  DEFAULT_TTL_HOURS,
  MAX_DIGESTS_PER_PROJECT,
  MIN_MATCH_THRESHOLD,
  REFRESH_OVERLAP_THRESHOLD,
  DIGEST_HALF_LIFE_DAYS,
} from "./digest/types.js";
export { createDigest, readDigest, listDigests, markStale, checkExpiry, pruneStale, recordAccess as recordDigestAccess } from "./digest/store.js";
export { findMatchingDigests, keywordOverlap } from "./digest/match.js";
export { digestDir, digestGlobalDir } from "./storage/paths.js";

// Tool logic — digest (v4.0)
export { digestStore } from "./tools-logic/digest-store.js";
export { digestRecall } from "./tools-logic/digest-recall.js";
export { digestRead } from "./tools-logic/digest-read.js";

// Tool logic — bootstrap (layered scan + selective import)
export {
  bootstrapScan,
  bootstrapImport,
  type BootstrapScanResult,
  type DiscoveredProject,
  type ImportableItem,
  type ImportSelection,
  type ImportResult,
} from "./tools-logic/bootstrap.js";

// Supabase — config
export { readSupabaseConfig, writeSupabaseConfig } from "./supabase/config.js";
export type { SupabaseConfig } from "./supabase/config.js";

// Supabase — client
export { getSupabaseClient, resetSupabaseClient } from "./supabase/client.js";

// Supabase — embedding
export { OpenAIEmbedding, VoyageEmbedding, zeroPad, createEmbeddingProvider } from "./supabase/embedding.js";
export type { EmbeddingProvider } from "./supabase/embedding.js";

// Supabase — sync
export { syncToSupabase, backfill, contentHash, parseMemoryFile, deriveSlug, logSyncError } from "./supabase/sync.js";
export type { ParsedMemoryFile } from "./supabase/sync.js";

// RecallBackend
export { LocalRecallBackend, getRecallBackend, resetRecallBackend, recordRemoteFailure, recordRemoteSuccess } from "./tools-logic/recall-backend.js";
export type { RecallBackend } from "./tools-logic/recall-backend.js";

// Supabase — recall backend
export { SupabaseRecallBackend } from "./supabase/recall-backend.js";

// Local vector backend (no-Supabase semantic recall)
export { LocalVectorRecallBackend } from "./vector/local-vector-backend.js";
export { embed } from "./vector/embedding.js";
export { upsertVector, queryVector, vectorIndexPath } from "./vector/local-vector-store.js";
export type { VectorItem } from "./vector/local-vector-store.js";

// Pipeline — project narrative spine (phases / milestones)
export {
  pipelineDir,
  milestoneFileName,
  parseMilestoneFile,
  listMilestones,
  findActiveMilestone,
  nextOrder,
  renderMilestone,
  writeMilestone,
  summarize as summarizeMilestone,
} from "./palace/pipeline.js";
export type {
  Milestone,
  MilestoneMeta,
  MilestoneSections,
  MilestoneSummary,
  PhaseStatus,
} from "./palace/pipeline.js";
export { pipelineOpen } from "./tools-logic/pipeline-open.js";
export type { PipelineOpenInput, PipelineOpenResult } from "./tools-logic/pipeline-open.js";
export { pipelineClose } from "./tools-logic/pipeline-close.js";
export type { PipelineCloseInput, PipelineCloseResult } from "./tools-logic/pipeline-close.js";
export { pipelineList } from "./tools-logic/pipeline-list.js";
export type { PipelineListInput, PipelineListResult } from "./tools-logic/pipeline-list.js";
export { pipelineCurrent } from "./tools-logic/pipeline-current.js";
export type { PipelineCurrentInput, PipelineCurrentResult } from "./tools-logic/pipeline-current.js";
export { pipelineShow } from "./tools-logic/pipeline-show.js";
export type { PipelineShowInput, PipelineShowResult, SubstrateStats } from "./tools-logic/pipeline-show.js";

// Naming system v1 — unified scope/type/topic/temporal/slug grammar
export {
  toSlug,
  canonicalPath,
  parseCanonicalName,
  validateCanonicalName,
  isValidType,
  buildIndexEntry,
  legacyToCanonicalType,
} from "./naming.js";
export type { MemoryScope, MemoryType, CanonicalName, NamingIndexEntry } from "./naming.js";

// Modern Hopfield — energy-based associative retrieval (Ramsauer 2020)
export { hopfieldRecall, hopfieldRerank } from "./palace/hopfield.js";
export type {
  HopfieldRecallInput,
  HopfieldRecallResult,
  RerankInput,
  RerankItem,
} from "./palace/hopfield.js";

// FSRS-lite — decay + reinforcement scoring
// (FSRS_ARCHIVE_THRESHOLD aliased to avoid collision with palace/salience ARCHIVE_THRESHOLD)
export {
  initFsrs,
  score as scoreFsrs,
  reinforce as reinforceFsrs,
  penalize as penalizeFsrs,
  ARCHIVE_THRESHOLD as FSRS_ARCHIVE_THRESHOLD,
  HOT_THRESHOLD as FSRS_HOT_THRESHOLD,
  DEFAULT_INITIAL_STABILITY as FSRS_DEFAULT_INITIAL_STABILITY,
} from "./palace/fsrs.js";
export type { FsrsState, FsrsScore } from "./palace/fsrs.js";

// Skills — procedural memory layer (5th type)
export {
  skillsDir,
  listSkills,
  nextSkillOrder,
  writeSkill,
  parseSkillFile,
  recallSkillsByIntent,
} from "./palace/skills.js";
export type { Skill, SkillMeta, SkillBody } from "./palace/skills.js";

export { skillWrite } from "./tools-logic/skill-write.js";
export type { SkillWriteInput, SkillWriteResult } from "./tools-logic/skill-write.js";
export { skillRecall } from "./tools-logic/skill-recall.js";
export type { SkillRecallInput, SkillRecallResult, SkillRecallHit } from "./tools-logic/skill-recall.js";
export { skillList } from "./tools-logic/skill-list.js";
export type { SkillListInput, SkillListResult, SkillListItem } from "./tools-logic/skill-list.js";

// Corrections — outcome tracking (V9)
export {
  recordOutcome,
  getCorrectionKPIs,
} from "./storage/corrections.js";
export type { CorrectionOutcome, CorrectionKPI } from "./storage/corrections.js";

// session_start lite (V6)
export { sessionStartLite } from "./tools-logic/session-start-lite.js";
export type { SessionStartLiteInput, SessionStartLiteResult } from "./tools-logic/session-start-lite.js";

// session_end reflection (V2)
export { sessionEndReflect } from "./tools-logic/session-end-reflect.js";
export type { ReflectInput, ReflectResult, ReflectInputBundle } from "./tools-logic/session-end-reflect.js";

// Dashboard export (V8)
export { dashboardExport } from "./tools-logic/dashboard-export.js";
export type {
  DashboardExportInput,
  DashboardExportResult,
  DashboardSnapshot,
  DashboardProjectSnapshot,
} from "./tools-logic/dashboard-export.js";
