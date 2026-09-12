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
  DecayClass,
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
  findCrystallizationCandidates,
  renderAwareness,
  readAwarenessArchive,
  writeAwarenessArchive,
  resurrectFromArchive,
} from "./palace/awareness.js";
export type {
  Insight,
  CompoundInsight,
  AwarenessState,
  CrystallizationCandidate,
} from "./palace/awareness.js";

// Palace — decay pass (Wave 3 compression tier)
export { runDecayPass } from "./palace/decay-pass.js";
export type { DecayReport, DecayCandidate, DecayOptions } from "./palace/decay-pass.js";

// Palace — salience
export {
  computeSalience,
  ARCHIVE_THRESHOLD,
  AUTO_ARCHIVE_THRESHOLD,
  CATEGORY_DECAY,
  URGENCY_WEIGHTS,
  KEYSTONE_FLOOR,
} from "./palace/salience.js";

// Palace — keystone detection
export {
  scanKeystoneMemories,
  isKeystone,
  markKeystones,
  type KeystoneMatch,
} from "./palace/keystone.js";

// Palace — compression (dream-cycle dedup)
export {
  compressTopic,
  compressRoom,
  compressProject,
  type CompressResult,
  type CompressEntry,
  type CompressCluster,
} from "./palace/compress.js";

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

// Tools-logic — login-free / LLM-free background safety consolidation (L2)
export {
  runSafetyConsolidation,
  DEFAULT_ARCHIVE_RETENTION_DAYS,
  DEFAULT_GRADUATION_MIN_CONFIRMATIONS,
} from "./tools-logic/safety-consolidation.js";
export type {
  SafetyConsolidationResult,
  SafetyConsolidationOptions,
  SafetyDecayResult,
  SafetyPruneResult,
  SafetyGraduateResult,
} from "./tools-logic/safety-consolidation.js";

// Storage — privacy classification (Wave 1, single source of truth)
export { classifyStore, classifyPath, isPersonalProject, PERSONAL_STORES } from "./storage/classification.js";
export type { Tier } from "./storage/classification.js";

// Storage
// fix5: projectSubPath exported so the CLI's few remaining raw
// `path.join(root, "projects", …)` sites can route through the ONE sanctioned
// project-path builder (case-fold reuse + path-escape guard + staging-sentinel
// routing) instead of hand-rolling the literal join.
export { journalDir, journalDirs, palaceDir, roomDir, sanitizeSlug, sanitizeProject, archiveRawDir, pickProjectDirEntry, projectSubPath } from "./storage/paths.js";
export { ensureDir, todayISO, readJsonSafe, writeJsonAtomic } from "./storage/fs-utils.js";

// Storage — _unclaimed staging namespace (fix5, 2026-09-11): failed/zero-
// confidence resolutions stage here instead of materializing projects/ dirs.
export {
  UNCLAIMED_DIRNAME,
  UNCLAIMED_PROJECT,
  isUnclaimedProject,
  unclaimedRootDir,
  unclaimedSessionDir,
} from "./storage/paths.js";
export {
  UNCLAIMED_TTL_MS,
  recordUnclaimedProvenance,
  listUnclaimedCards,
  countUnclaimedSessions,
  findUnclaimedCardForSid,
  archiveExpiredUnclaimed,
  claimUnclaimedSession,
  undoClaimUnclaimedSession,
  readClaimsLog,
  type UnclaimedProvenance,
  type UnclaimedCardInfo,
  type ClaimResult,
} from "./storage/unclaimed.js";

// Storage — archive tier (Wave 2, lossless verbatim floor; local-only)
export { archiveSession } from "./storage/archive-write.js";
export type { ArchiveSessionInput, ArchiveSessionResult } from "./storage/archive-write.js";
export { pruneRawArchive } from "./storage/archive-prune.js";
export type { PruneRawArchiveOptions, PruneRawArchiveResult } from "./storage/archive-prune.js";
export { enqueueConsolidation, drainConsolidationQueue } from "./storage/consolidation-queue.js";
export type { ConsolidationJob, DrainReport } from "./storage/consolidation-queue.js";
export { writeMemoryProtocol } from "./storage/memory-protocol.js";
export { ensureStoreManifest } from "./storage/store-manifest.js";
export { detectProject, resolveProject, listAllProjects, isValidProjectSlug } from "./storage/project.js";
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
export { checkAction, tokenize, overlap } from "./tools-logic/check-action.js";
export type {
  CheckActionInput,
  CheckActionResult,
  RuleMatch,
  CorrectionMatch,
  InsightMatch,
} from "./tools-logic/check-action.js";
export { getSessionId, journalFileName, captureLogFileName, resetOwnedFiles, resetSessionState } from "./storage/session.js";
export type { SaveType, SmartNameOpts } from "./storage/session.js";
// C2 (2026-07-26) — per-process lifecycle idempotency (session_start /
// session_end double-call safety). See storage/session.ts for the doctrine.
export {
  claimSessionStartOnce,
  getCachedSessionEnd,
  setCachedSessionEnd,
  resetIdempotencyState,
} from "./storage/session.js";
// C2 — zero-cloud lifecycle telemetry (counters only, no transcript content).
export { recordLifecycleEvent, lifecycleStats } from "./storage/lifecycle-telemetry.js";
export type { LifecycleEvent, LifecycleTelemetryRow, LifecycleStats } from "./storage/lifecycle-telemetry.js";
// fix9 (2026-09-12): acquireLockSync/withLockSync retired — the async
// primitive is the only locking surface (see filelock.ts header).
export { acquireLock, withLock, STALE_LOCK_MS, LockContentionError } from "./storage/filelock.js";

// Host profile — 3-tier lifecycle-capability model (Tier A hooks / Tier B
// mcp-instructions / Tier C manual) + the single canonical lifecycle-
// instructions source consumed by packages/mcp-server/src/server.ts and by
// AGENTS.md's authored content.
export { resolveHostProfile, lifecycleInstructions, isHookOwnedHost } from "./host-profile.js";
export type { HostTier, Lifecycle, HostProfile } from "./host-profile.js";

// Storage — corrections
export {
  writeCorrection,
  readCorrections,
  readActiveCorrections,
  readP0Corrections,
  retractCorrection,
  isLikelyRealCorrection,
  dropHardNoise,
  logRejectedCorrection,
  readRejectedCorrections,
  getRejectedStats,
  GATE_VERSION,
  splitSentences,
  isStaleCorrection,
  reviewNoiseCorrections,
  rankCorrections,
  // v4 W1 — computed truth-decay classification (annotate-only; never stored).
  decayClassOf,
  // v4 W2 — effective confidence (post-defaults), shared by rankCorrections
  // and getCorrectionKPIs' annotation output (annotate-only; never stored).
  effectiveConfidenceOf,
  // Fix #2 (dual-channel capture gate, 2026-09-11) — CJK-aware consolidation
  // identity + the severity classifier (shared with the pending staging path).
  distillRuleIdentity,
  detectSeverity,
} from "./storage/corrections.js";

// Storage — pending-corrections staging area (Fix #2, dual-channel capture
// gate, 2026-09-11): low-trust captures await review here; the active ledger
// is reachable only through check()'s validated structured form or an
// explicit promote.
export {
  PENDING_CAP,
  PENDING_TTL_DAYS,
  pendingDir,
  stagePendingCorrection,
  listPendingCorrections,
  resolvePendingCorrection,
  validateStructuredCorrection,
  validateInsightCompleteness,
  isRealAppliesWhenToken,
} from "./storage/pending.js";
export type {
  PendingRecord,
  PendingKind,
  PendingChannel,
  StagePendingInput,
  StagePendingResult,
  ResolvePendingResult,
  CompletenessResult,
  CompletenessFailure,
} from "./storage/pending.js";
export type {
  CorrectionRecord,
  WriteCorrectionResult,
  RetractCorrectionResult,
  RejectedCorrectionRecord,
  RejectedStats,
  NoiseReview,
  // v4 W1 — assertion confidence + provenance (see CorrectionRecord).
  CorrectionProvenance,
  // v4 W2 — rankCorrections' return shape (CorrectionRecord + decay_class +
  // effective confidence annotations).
  RankedCorrection,
} from "./storage/corrections.js";

// Tools-logic — P2 supersession (contradiction → supersede; suggest-default)
export { detectCorrectionConflicts, reviewSupersessions, listCorrectionConflicts } from "./tools-logic/supersession.js";
export type { SupersessionMatch, SupersessionReview, CorrectionConflict } from "./tools-logic/supersession.js";

// Storage — A/B injection experiment (C4)
export {
  computeArm,
  assignArm,
  logABResult,
  readABArms,
  isExperimentEnabled,
  getForcedArm,
  warnForcedWithoutEnabled,
} from "./storage/ab-experiment.js";
export type { Arm, ABLedgerRow, ABResultRow, ABAssignment } from "./storage/ab-experiment.js";

// Storage — durable intent (save-trigger vocabulary + arbiter)
export { DURABLE_INTENT_PATTERNS, saveTriggerKind } from "./storage/durable-intent.js";

// Storage — capture router (two-lane pivot)
export { routeCapture } from "./storage/capture-router.js";
export type { CaptureRouteInput, CaptureRouteResult, CaptureRouteKind } from "./storage/capture-router.js";

// Storage — content guard (cloud egress scrub)
export { scrubForCloud, scrubPromptInjection, scrubSecretContent, scrubForExport, SecretScanError, fenceMemory } from "./storage/content-guard.js";
export type { SecretScanResult } from "./storage/content-guard.js";

// Tools-logic — corrections export (vendor-neutral, fail-closed-scrubbed egress contract)
export { exportCorrections, CORRECTION_EXPORT_SCHEMA_VERSION } from "./tools-logic/export-corrections.js";
export type { CorrectionExport, ExportCorrectionsOptions } from "./tools-logic/export-corrections.js";

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
export { journalList, QUARANTINE_TITLE, type JournalListInput, type JournalListResult } from "./tools-logic/journal-list.js";
export { journalProjects, type JournalProjectsResult } from "./tools-logic/journal-projects.js";
export { projectBoard, type ProjectBoardResult, type ProjectEntry, type ProjectStatus } from "./tools-logic/project-board.js";
export { renderBoard, renderDreamBanner, fitToWidth, displayWidth, charDisplayWidth, type DreamStatus, type RenderBoardOptions } from "./display/board-render.js";
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
export {
  runStoreDoctor,
  storeDoctorBanner,
  INDEX_DRIFT_TOLERANCE,
  LOCK_RED_MS,
  DREAM_NULL_MARKER_WARN_DAYS,
  type StoreDoctorResult,
  type DoctorCheck,
  type DoctorLevel,
  type DoctorStatus,
} from "./tools-logic/store-doctor.js";
export {
  runStoreRepair,
  storeRepairSummary,
  type StoreRepairResult,
  type StoreRepairOptions,
  type RepairSnapshot,
  type RepairStepProjects,
  type RepairStepLocks,
} from "./tools-logic/store-repair.js";
// hygiene — DETECTION-ONLY store trash audit (sibling to store-doctor above,
// different axis: junk/trash rather than structural integrity). CLI/core
// only — deliberately NOT wired as an MCP tool (see tool-surface-purity test).
export {
  runHygieneScan,
  applyBaseline,
  updateBaseline,
  hygieneBaselinePath,
  HYGIENE_BASELINE_FILENAME,
  type HygieneFinding,
  type HygieneScanResult,
  type HygieneBaseline,
  type ApplyBaselineResult,
  type HygieneSeverity,
  type HygieneGrade,
} from "./storage/hygiene.js";
export { palaceSearch, type PalaceSearchInput, type PalaceSearchResult } from "./tools-logic/palace-search.js";
export { awarenessUpdate, type AwarenessUpdateInput, type AwarenessUpdateResult } from "./tools-logic/awareness-update.js";
export { recallInsight, type RecallInsightInput, type RecallInsightResult } from "./tools-logic/recall-insight.js";

// Tool logic — journal merge
export { journalMerge, type JournalMergeInput, type MergeReceipt } from "./tools-logic/journal-merge.js";

// Tool logic — smart routing
export { smartRemember, type SmartRememberInput, type SmartRememberResult } from "./tools-logic/smart-remember.js";
export { smartRemember as remember } from "./tools-logic/smart-remember.js";
export { smartRecall, fuseRemoteWithLocal, type SmartRecallInput, type SmartRecallResult, type SmartRecallResultItem, type SmartRecallDegraded, type BridgedSource } from "./tools-logic/smart-recall.js";
export { calibratedConfidence, CONFIDENCE_FLOOR, type ConfidenceLabel, type ConfidenceScale, type CalibratedConfidence } from "./tools-logic/confidence.js";
export { fetchVerbatim, type VerbatimKey, type VerbatimSource } from "./tools-logic/drill-down.js";
export { buildPriors, type PriorCorrection } from "./tools-logic/prior-builder.js";

// Tool logic — v3.4 composite tools (5-tool surface)
export {
  sessionStart,
  isCurrentProjectContinuityEntry,
  continuityEntryMarker,
  continuityHeaderText,
  type SessionStartInput,
  type SessionStartResult,
  type SlimCorrection,
} from "./tools-logic/session-start.js";
export {
  buildRecognition,
  PERSON_LOW_CONFIDENCE_CAVEAT,
  type RecognitionPayload,
  type RecognitionWho,
  type RecognitionCapabilities,
  type RecognitionProject,
  type RecognitionPerson,
  type BuildRecognitionOptions,
} from "./tools-logic/recognition-builder.js";
export { sessionEnd, checkInsightQuality, type SessionEndInput, type SessionEndResult, type InsightQualityWarning, type MergeSuggestion } from "./tools-logic/session-end.js";
export { promoteConfirmedInsights, type PromotionResult } from "./tools-logic/insight-promotion.js";
export { check, type CheckInput, type CheckResult, type WatchFor, type PastDelta, type HumanCorrectionStructured } from "./tools-logic/check.js";
// Tool logic — cross-surface adapter (P4): bootstrap exports
// brief, memoryQuery, projectStatus removed 2026-07-05 (owner-approved P3b purity deletions)
export {
  bootstrapScan,
  bootstrapImport,
  type BootstrapScanResult,
  type ImportableItem,
  type DiscoveredProject,
  type ImportSelection,
  type ImportResult,
} from "./tools-logic/bootstrap.js";

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
// fix9 (2026-09-12): markStale is async-only (Promise<boolean>); the
// markStaleAsync twin is folded into it.
export { createDigest, readDigest, listDigests, markStale, checkExpiry, pruneStale, recordAccess as recordDigestAccess } from "./digest/store.js";
export { findMatchingDigests, keywordOverlap } from "./digest/match.js";
export { digestDir, digestGlobalDir } from "./storage/paths.js";

// Tool logic — digest (v4.0)
export { digestStore } from "./tools-logic/digest-store.js";
export { digestRecall } from "./tools-logic/digest-recall.js";
export { digestRead } from "./tools-logic/digest-read.js";

// (bootstrap exports moved up to cross-surface-adapter block above)

// Supabase — config
export { readSupabaseConfig, writeSupabaseConfig } from "./supabase/config.js";
export type { SupabaseConfig } from "./supabase/config.js";

// Supabase — client
export { getSupabaseClient, resetSupabaseClient } from "./supabase/client.js";

// Supabase — embedding
export { OpenAIEmbedding, VoyageEmbedding, zeroPad, createEmbeddingProvider } from "./supabase/embedding.js";
export type { EmbeddingProvider } from "./supabase/embedding.js";

// Supabase — sync
export { syncToSupabase, backfill, gatherProjectBackfillFiles, contentHash, parseMemoryFile, deriveSlug, logSyncError } from "./supabase/sync.js";
export type { ParsedMemoryFile } from "./supabase/sync.js";

// RecallBackend
export { LocalRecallBackend, getRecallBackend, resetRecallBackend, recordRemoteFailure, recordRemoteSuccess } from "./tools-logic/recall-backend.js";
export type { RecallBackend } from "./tools-logic/recall-backend.js";

// MemoryBackend — symmetric WRITE seam for external belief stores.
// DELIBERATELY NOT exported: LocalArchiveMemoryBackend / todayDateString — the
// local-archive backend is a reference implementation, not stable API. Barrel-
// exporting a concrete backend would invite adapter authors to call retain()
// with hand-constructed CorrectionExport objects, bypassing the
// exportCorrections() scrub chain. Reach it via getMemoryBackend() with
// AR_MEMORY_BACKEND=local-archive; tests import its module path directly.
export { DisabledMemoryBackend, getMemoryBackend, resetMemoryBackend } from "./tools-logic/memory-backend.js";
export type { MemoryBackend, RetainResult } from "./tools-logic/memory-backend.js";

// Supabase — recall backend
export { SupabaseRecallBackend, mapSemanticRows, mapFtsRows, buildFtsQuery } from "./supabase/recall-backend.js";
export type { RecallResultItem } from "./supabase/recall-backend.js";

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
  reinforceSkillFsrs,
  setSkillArchived,
} from "./palace/skills.js";
export type { Skill, SkillMeta, SkillBody } from "./palace/skills.js";

export { skillWrite } from "./tools-logic/skill-write.js";
export type { SkillWriteInput, SkillWriteResult } from "./tools-logic/skill-write.js";
export { skillRecall } from "./tools-logic/skill-recall.js";
export type { SkillRecallInput, SkillRecallResult, SkillRecallHit } from "./tools-logic/skill-recall.js";
export { skillList } from "./tools-logic/skill-list.js";
export type { SkillListInput, SkillListResult, SkillListItem } from "./tools-logic/skill-list.js";

// Corrections — outcome tracking (V9 + C3 + C3b)
export {
  recordOutcome,
  getCorrectionKPIs,
  readOutcomesForToday,
  readOutcomesBefore,
  readOutcomesOnDate,
  readAllOutcomeKinds,
  listUnknownVerdicts,
  runOutcomesRebuild,
  recomputeCorrectionCounters,
  computeLedgerDivergence,
} from "./storage/corrections.js";
export type {
  CorrectionOutcome,
  CorrectionKPI,
  UnknownVerdictCandidate,
  MalformedOutcomeRow,
  RecomputedCounters,
  DivergenceEntry,
  OutcomesRebuildOptions,
  OutcomesRebuildCorrectionDiff,
  OutcomesRebuildResult,
} from "./storage/corrections.js";

// Wave 5 — corrections-prediction (north-star) + compression remainder
export { deriveBlindSpots } from "./helpers/blind-spots.js";
export type { BlindSpot, BlindSpotProfile } from "./helpers/blind-spots.js";
export { writeBlindSpots, readBlindSpots, recomputeBlindSpots } from "./storage/blind-spots-store.js";
export { personalDir } from "./storage/paths.js";
// Loop 9 — The Mirror (visible, correctable self-model)
export { buildMirror, renderMirror, deriveCrossProjectPatterns } from "./tools-logic/mirror-builder.js";
export type {
  MirrorReflection,
  MirrorObservation,
  MirrorReaders,
  CrossProjectPattern,
} from "./tools-logic/mirror-builder.js";
export { predictCorrection } from "./tools-logic/predict-correction.js";
export type {
  PredictCorrectionInput,
  PredictCorrectionResult,
  PredictedRisk,
} from "./tools-logic/predict-correction.js";
export { proposeSkillsFromPhases } from "./tools-logic/skill-propose.js";
export type { ProposedSkill } from "./tools-logic/skill-propose.js";
export {
  buildConsolidationPrompt,
  CONSOLIDATION_PROMPT_TEMPLATE,
  CONSOLIDATION_PROMPT_VERSION,
} from "./prompts/consolidation-prompt.js";

// session_start lite (V6)
export { sessionStartLite } from "./tools-logic/session-start-lite.js";
export type { SessionStartLiteInput, SessionStartLiteResult } from "./tools-logic/session-start-lite.js";

// session_end reflection (V2)
export { sessionEndReflect } from "./tools-logic/session-end-reflect.js";
export type { ReflectInput, ReflectResult, ReflectInputBundle } from "./tools-logic/session-end-reflect.js";

// Dashboard export removed 2026-07-05 (owner-approved P3b purity deletions)

// Helpers — activity feed
export { buildRecentActivity } from "./helpers/activity-feed.js";
export type { ActivityEvent } from "./helpers/activity-feed.js";

// Continuity wave (2026-07-31) — F3: mechanical session-card distillation
export { buildSessionCard, writeSessionCard } from "./storage/session-card.js";
export type { SessionCardMeta, SessionCardInput, SessionCardResult, WriteSessionCardResult } from "./storage/session-card.js";

// F2 — cross-project recency index (continuity wave, 2026-07-31)
export { appendRecentSession, readRecentSessions, formatAgo } from "./storage/recency-index.js";
export type { RecentSessionEntry } from "./storage/recency-index.js";

// Continuity wave F5 — fail-loud hook health (2026-07-31)
export { recordHookFailure, readHookHealth } from "./storage/hook-health.js";
export type { HookFailureRow, HookHealthState } from "./storage/hook-health.js";

// Continuity wave F6 — `ar resurrect` core: read-only cross-slug dead-session finder (2026-07-31)
export { resurrect, renderResurrectMarkdown } from "./tools-logic/resurrect.js";
export type { ContinuityBrief, ResurrectInput } from "./tools-logic/resurrect.js";

// M8 (review fix, 2026-07-31) — shared UTF-8-safe byte-boundary truncation helpers
export { truncateUtf8Bytes, utf8SafeEndBoundary, utf8SafeStartBoundary } from "./storage/fs-utils.js";

// v3.4.42 working-memory wave (2026-08-04) — minutes-level, crash-proof capture tier
export {
  wmAppend,
  wmList,
  wmRead,
  wmDelete,
  guessSlugFromWmLines,
  rescueOrphanedWorkingMemory,
  distillSessionToCard,
  WM_LINE_CAP,
  WM_PROMPT_BYTE_CAP,
  WM_LIVE_WINDOW_MS,
  WM_ORPHAN_WINDOW_MS,
} from "./storage/working-memory.js";
export type { WorkingMemoryLine, WorkingMemoryFileInfo } from "./storage/working-memory.js";

// Wave 1 retrieval pipeline (2026-08-29, reports/2026-08-29-pipe-w1-readers-report.md,
// plywood SOP 58053587) — shared tier reader with identity-trust tagging baked in.
//
// W2 independent-review fix (2026-08-30, reports/2026-08-30-pipe-w2-fixes-report.md):
// `readTierCandidates` is now safe-by-default (drops untrusted candidates
// unless `includeUntrusted: true` is passed) — a direct caller no longer
// needs to know about `untrusted` at all to get trusted-only content.
// `filterTrusted` is the same canonical trust predicate this default
// delegates to, exported so a caller that legitimately needs
// `includeUntrusted: true` (or any other pre-fetched MemoryCandidate[]) has
// a public, correct way to filter — not a private implementation detail a
// second surface would have to reinvent.
export { readTierCandidates, filterTrusted, listCandidateStubs } from "./retrieval/candidates.js";
export type {
  MemoryCandidate,
  MemoryTier,
  CandidateSourceKind,
  ReadTierCandidatesOpts,
  CandidateStub,
} from "./retrieval/candidates.js";

// Wave 2 retrieval pipeline (2026-08-30, reports/2026-08-29-pipe-w2-query-report.md,
// plywood SOP ecbd4351) — queryMemory() as a MANDATORY pipeline (fetch ->
// trust-filter -> tokenize+score -> scope -> rank/fuse -> fence). smart_recall
// is migrated onto this this wave; journalSearch/recallInsight join it in
// Wave 3b (2026-08-30, reports/2026-08-30-pipe-w3b-migrate-report.md);
// palaceSearch/resurrect/session_start remain on their own paths.
export { queryMemory, queryArchiveFallback } from "./retrieval/query-memory.js";
export type {
  QueryMemoryTier,
  QueryMemorySource,
  QueryMemoryItem,
  QueryMemoryInput,
  QueryMemoryResult,
} from "./retrieval/query-memory.js";

// Wave 3b SCOPE stage (2026-08-30) — exported so a caller (or test) can
// apply the same per-candidate project-attribution filter directly to any
// `{projects?: string[]}[]` array without going through queryMemory() or
// recallInsight() — see retrieval/scope.ts's own doc comment.
export { applyScope } from "./retrieval/scope.js";

// Wave 5a CONTRADICTION stage (2026-08-31) — exported so a test (or a later
// caller) can exercise the pure comparator directly without going through
// queryMemory() — see retrieval/contradiction.ts's own doc comment.
export { detectContradictions } from "./retrieval/contradiction.js";
export type { ContradictionItem, ContradictionResult } from "./retrieval/contradiction.js";
// v4 pre-ship gate fix (2026-09-08) — the shared high-precision version-token
// extractor `tools-logic/supersession.ts`'s `compareForConflicts` now imports
// (see that file's own header). Exported here too, alongside its sibling
// contradiction-stage exports above, so a test can exercise it directly.
export { extractHighPrecisionVersionTokens } from "./retrieval/contradiction.js";

// fix7 (2026-09-12, plan-v2 #7) — OPT-IN local embeddings for the semantic-
// paraphrase retrieval gap. Everything here is inert unless the
// AGENT_RECALL_EMBEDDINGS opt-in (or config.json embeddings_enabled) is set;
// the CLI's `ar embeddings setup|rebuild|status` commands consume the build/
// status APIs, and tests exercise the leg + index directly. See
// packages/core/src/embeddings/config.ts's header for the design contract
// (opt-in only, zero-cloud, model never ships in the package, silent-safe
// degrade).
export {
  embeddingsEnabled,
  resolveEmbeddingModel,
  embeddingsHome,
  embeddingsRuntimeDir,
  embeddingsModelsDir,
  embeddingsIndexPath,
  EMBEDDING_MODELS,
  DEFAULT_EMBEDDING_MODEL,
} from "./embeddings/config.js";
export type { EmbeddingModelSpec } from "./embeddings/config.js";
export {
  getEmbedder,
  resetEmbedderCache,
  runtimeInstalled,
  modelCached,
  RUNTIME_PACKAGE,
  RUNTIME_PACKAGE_RANGE,
} from "./embeddings/runtime.js";
export type { Embedder, EmbedderError } from "./embeddings/runtime.js";
export { chunkProject, chunkGlobalInsights } from "./embeddings/chunker.js";
export type { EmbeddingChunk } from "./embeddings/chunker.js";
export {
  readEmbeddingIndex,
  writeEmbeddingIndex,
  resetEmbeddingIndexCache,
} from "./embeddings/index-store.js";
export type { EmbeddingIndex, IndexReadError } from "./embeddings/index-store.js";
export { buildEmbeddingsIndex, embeddingsStatus } from "./embeddings/indexer.js";
export type { BuildEmbeddingsOptions, BuildEmbeddingsReport, EmbeddingsStatus } from "./embeddings/indexer.js";
export { runSemanticLeg } from "./retrieval/semantic-leg.js";
export type { SemanticLegNote, SemanticLegResult, SemanticLegInput } from "./retrieval/semantic-leg.js";
