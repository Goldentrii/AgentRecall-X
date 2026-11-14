/**
 * Shared types, interfaces, and constants for agent-recall-mcp.
 */

import * as path from "node:path";
import * as os from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const VERSION = "3.5.3";

// ---------------------------------------------------------------------------
// Root directory (configurable at runtime for SDK usage)
// ---------------------------------------------------------------------------

let _root: string | null = null;

/**
 * Per-call root scope (TOW2-324). withRoot() runs a (possibly async)
 * function with an explicit root that takes precedence over the
 * process-global `_root` for the duration of that call chain only.
 * AsyncLocalStorage propagates the scope across awaits/promises/timers
 * created inside the callback, and restores the outer context when the
 * callback returns, throws, or rejects — a failed call can never leak
 * its root onto subsequent unscoped calls.
 */
const _rootScope = new AsyncLocalStorage<string>();

/**
 * Set the storage root directory. This is process-global state —
 * only one root is active at a time. Call before any other operations.
 * Use resetRoot() to revert to environment/default resolution.
 * For per-instance/per-call scoping (e.g. multiple SDK instances in one
 * process), use withRoot() instead.
 */
export function setRoot(root: string): void {
  _root = root;
}

/**
 * Clear the explicitly-set root, reverting to AGENT_RECALL_ROOT env var
 * or the default ~/.agent-recall. Does not affect active withRoot() scopes.
 */
export function resetRoot(): void {
  _root = null;
}

/**
 * Run `fn` with `root` as the effective storage root for the duration of
 * the call (including its entire async continuation chain). Concurrent
 * scopes with different roots do not interfere: each interleaved call chain
 * sees its own root. Code outside any scope (CLI, MCP server) keeps
 * resolving via setRoot()/env/default exactly as before.
 *
 * Note: the scope propagates through promises, awaits, timers, and
 * callbacks REGISTERED inside `fn`. It does not follow manually detached
 * continuations (e.g. an EventEmitter whose listeners were registered
 * outside the scope) — bind those explicitly if ever needed.
 */
export function withRoot<T>(root: string, fn: () => T): T {
  return _rootScope.run(root, fn);
}

// ---------------------------------------------------------------------------
// Multi-tenant scope (hosted server). One process serves many users; every
// request runs inside withTenant(). Inside a tenant scope, everything that is
// process-global or tied to the server's OS user is switched off or derived
// from the tenant: storage root, session id, default project, legacy
// ~/.claude scans, Supabase/cloud-embedding config (process-wide singletons
// and env overrides that would cross tenants). See
// docs/superpowers/plans/2026-11-07-hosted-server-target.md.
// ---------------------------------------------------------------------------

export interface TenantContext {
  /** Absolute storage root for this tenant (e.g. DATA/tenants/<uid>). */
  root: string;
  /** Per-request/MCP-session id: lowercase hex/uuid chars only. */
  sid: string;
  /** Project slug used when a tool is called with project "auto". */
  defaultProject: string;
  /**
   * Owner gate. When true, this scope is an AGENT channel: check()'s structured
   * human_correction is staged for the owner instead of written to the active
   * ledger, and confirmPendingCorrection() refuses to run. The hosted server
   * sets it on every MCP request, because whoever holds a tenant's token (or
   * steers an agent that does) could otherwise plant an always-loaded P0 rule.
   * The operator CLI runs without it and is the only way to activate.
   */
  stageAgentCorrections?: boolean;
  /**
   * Where the owner approves staged corrections in a browser (the hosted server's
   * /review page). Set by the server from its own config, never from a request.
   * It is shown to agents so they can tell the user where to go.
   */
  reviewUrl?: string;
}

const _tenantScope = new AsyncLocalStorage<TenantContext>();
let _strictTenantMode = false;
const TENANT_SID_RE = /^[a-f0-9-]{6,64}$/;
const TENANT_PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REVIEW_URL_MAX = 200;

/** A plain http(s) URL, printable ASCII only, no credentials: it is printed inside agent-facing text. */
function assertReviewUrl(raw: string): string {
  let u: URL | undefined;
  try {
    u = new URL(raw);
  } catch {
    u = undefined;
  }
  const ok = u !== undefined && (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password
    && raw.length <= REVIEW_URL_MAX && /^[\x21-\x7e]+$/.test(raw);
  if (!ok) throw new Error("withTenant: reviewUrl must be a plain http(s) URL of at most " + REVIEW_URL_MAX + " printable characters");
  return raw;
}

/**
 * Run `fn` as tenant `ctx`. Validates the context: a malformed root/sid/project
 * is a server bug, so it throws rather than silently falling back.
 */
export function withTenant<T>(ctx: TenantContext, fn: () => T): T {
  if (!path.isAbsolute(ctx.root)) throw new Error("withTenant: root must be absolute");
  if (!TENANT_SID_RE.test(ctx.sid)) throw new Error("withTenant: sid must match " + TENANT_SID_RE);
  if (!TENANT_PROJECT_RE.test(ctx.defaultProject)) throw new Error("withTenant: defaultProject must match " + TENANT_PROJECT_RE);
  // The owner gate never lifts by nesting: a scope opened inside an agent channel is one too.
  const outer = _tenantScope.getStore();
  const stage = ctx.stageAgentCorrections === true || outer?.stageAgentCorrections === true;
  // Like the gate, the review URL is inherited by a nested scope that does not set its own.
  const reviewUrl = ctx.reviewUrl !== undefined ? assertReviewUrl(ctx.reviewUrl) : outer?.reviewUrl;
  return _tenantScope.run({
    ...ctx,
    root: path.resolve(ctx.root),
    ...(stage ? { stageAgentCorrections: true } : {}),
    ...(reviewUrl !== undefined ? { reviewUrl } : {}),
  }, fn);
}

/** The page where the owner approves staged corrections, when the server has one (see TenantContext.reviewUrl). */
export function ownerReviewUrl(): string | undefined {
  return _tenantScope.getStore()?.reviewUrl;
}

export function getTenantContext(): TenantContext | undefined {
  return _tenantScope.getStore();
}

export function isTenantScoped(): boolean {
  return _tenantScope.getStore() !== undefined;
}

/** True inside an agent channel whose corrections need the owner's confirmation (see TenantContext). */
export function agentCorrectionsStaged(): boolean {
  return _tenantScope.getStore()?.stageAgentCorrections === true;
}

/**
 * Hosted server only: from now on, getRoot() outside a tenant scope THROWS
 * instead of falling back to the server user's default store. Defence in
 * depth: any code path that loses the tenant context fails loudly instead of
 * reading/writing another store. Irreversible for the process lifetime.
 */
export function enableStrictTenantMode(): void {
  _strictTenantMode = true;
}

export function getRoot(): string {
  const tenant = _tenantScope.getStore();
  if (tenant) return tenant.root;
  if (_strictTenantMode) {
    throw new Error("[agent-recall] getRoot() called outside a tenant scope while strict tenant mode is on");
  }
  return _rootScope.getStore() ?? _root ?? process.env.AGENT_RECALL_ROOT ?? path.join(os.homedir(), ".agent-recall");
}

/** Prefix shown to agents in place of the hosted tenant root. */
export const HOSTED_DISPLAY_ROOT = "hosted:";

/**
 * A store path as shown to the agent. Locally: the root becomes
 * "~/.agent-recall" (unchanged behaviour). Inside a tenant: the root becomes
 * "hosted:" with forward slashes, so responses never reveal the server's
 * filesystem layout and never point the agent at a local ~/.agent-recall.
 */
export function toDisplayPath(p: string): string {
  const tenant = _tenantScope.getStore();
  if (!tenant) return p.replace(getRoot(), "~/.agent-recall");
  if (p !== tenant.root && !p.startsWith(tenant.root + path.sep)) {
    // Fail closed: an absolute path outside the tenant is server layout, not the agent's business.
    return path.isAbsolute(p) ? `${HOSTED_DISPLAY_ROOT}<outside-tenant>` : p;
  }
  return HOSTED_DISPLAY_ROOT + p.slice(tenant.root.length).replace(/\\/g, "/");
}

/**
 * Hosted backstop: replace every occurrence of the tenant root in free text
 * (tool results, error messages) with "hosted:". Covers the native form, the
 * forward-slash form and the JSON-escaped form (Windows backslashes doubled).
 * Identity outside a tenant scope.
 */
export function redactTenantPaths(s: string): string {
  const tenant = _tenantScope.getStore();
  if (!tenant || !s) return s;
  const forms = new Set([tenant.root, tenant.root.replace(/\\/g, "/"), tenant.root.replace(/\\/g, "\\\\")]);
  let out = s;
  for (const form of [...forms].sort((a, b) => b.length - a.length)) out = out.split(form).join(HOSTED_DISPLAY_ROOT);
  return out;
}

export function getLegacyRoot(): string {
  // Inside a tenant, never scan the server OS user's ~/.claude/projects:
  // return a tenant-local path that does not exist, so every caller's
  // existsSync() guard skips the legacy scan.
  const tenant = _tenantScope.getStore();
  if (tenant) return path.join(tenant.root, "_legacy-disabled");
  return path.join(os.homedir(), ".claude", "projects");
}

export const SECTION_HEADERS: Record<string, string> = {
  brief: "## Brief",
  qa: "## Q&A Log",
  completed: "## Completed",
  status: "## Status",
  blockers: "## Blockers",
  next: "## Next",
  decisions: "## Decisions",
  reflection: "## Reflection",
  files: "## Files Changed",
  observations: "## Observations",
};

export const DEFAULT_PALACE_ROOMS = [
  { slug: "goals", name: "Goals", description: "Active goals, completed goals, goal evolution", tags: ["planning"] },
  { slug: "architecture", name: "Architecture", description: "Technical decisions, patterns, tech stack", tags: ["technical"] },
  { slug: "decisions", name: "Decisions", description: "Decision trails with prior/posterior tracking, evidence chains, and outcomes. Bayesian-inspired audit trail for major decisions.", tags: ["technical"] },
  { slug: "blockers", name: "Blockers", description: "Current and resolved blockers", tags: ["status"] },
  { slug: "alignment", name: "Alignment", description: "Frequently misunderstood areas, human corrections", tags: ["communication"] },
  { slug: "knowledge", name: "Knowledge", description: "Learned lessons by category", tags: ["learning"] },
] as const;

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface JournalEntry {
  date: string;
  file: string;
  dir: string;
}

export interface ProjectInfo {
  slug: string;
  lastEntry: string;
  entryCount: number;
}

export interface SessionState {
  version: string;
  date: string;
  project: string;
  timestamp: string;
  completed: Array<{ task: string; result: string; files_changed?: string[] }>;
  failures: Array<{ task: string; what_went_wrong: string; root_cause: string; fixed: boolean }>;
  state: Record<string, { status: string; details: string }>;
  next_actions: Array<{ priority: string; task: string }>;
  insights: Array<{ claim: string; confidence: string; evidence: string }>;
  counts: Record<string, number>;
}

export interface RoomMeta {
  slug: string;
  name: string;
  description: string;
  created: string;
  updated: string;
  salience: number;
  access_count: number;
  last_accessed: string;
  tags: string[];
  connections: string[];
  /**
   * Keystone memories occupy load-bearing structural positions — referenced
   * from pipeline milestone "How solved" or "Synthesis" sections.
   * When true, salience never drops below KEYSTONE_FLOOR regardless of
   * access frequency. Set by markKeystones() during consolidation.
   */
  keystone?: boolean;
  /**
   * Wave 3: non-destructive archive flag. Set by the decay pass when a room's
   * salience falls at/below the archive threshold. The room dir is NEVER
   * deleted — the flag is advisory and lets readers down-rank/hide it.
   */
  archived?: boolean;
}

export interface PalaceIndex {
  version: string;
  project: string;
  created: string;
  rooms: Record<string, { salience: number; memory_count: number; last_updated: string }>;
  identity_hash: string;
  last_lint: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: string;
  weight: number;
  created: string;
}

export interface PalaceGraph {
  edges: GraphEdge[];
}

export type Importance = "high" | "medium" | "low";
export type Urgency = "today" | "this-week" | "eventual" | "none";
export type Confidence = "high" | "medium" | "low";
/**
 * v4 W1 (2026-07-02 schema-infrastructure.md §5, field-design-options.md §A.5) —
 * truth-decay classification. NEVER a stored field by default (Option 2, the
 * proposal's recommendation): computed at read time from record-class-specific
 * rules (e.g. corrections.ts's `decayClassOf`), with an optional per-record
 * `*_override` escape hatch on record types that carry one. Shared here because
 * the proposal frames `decay_class` as a cross-record-class concept (corrections,
 * palace memories, insights) even though v4 Wave 1 wires it into CorrectionRecord
 * only — see docs/proposals/2026-07-02-field-design-options.md §A.1/§A.5.
 */
export type DecayClass = "static" | "slow" | "volatile";
export type WalkDepth = "identity" | "active" | "relevant" | "full";

/** Category determines decay rate — architecture decisions decay slowly, daily blockers decay fast. */
export type MemoryCategory = "goal" | "architecture" | "decision" | "blocker" | "observation" | "lesson" | "general";

/** Pinned items never get replaced by the awareness merge-or-replace cycle. */
export interface PinStatus {
  pinned: boolean;
  reason?: string;        // "ultimate goal", "human override", etc.
  pinned_at?: string;     // ISO date
}
