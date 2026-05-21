/**
 * Shared types, interfaces, and constants for agent-recall-mcp.
 */

import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const VERSION = "3.4.10";

// ---------------------------------------------------------------------------
// Root directory (configurable at runtime for SDK usage)
// ---------------------------------------------------------------------------

let _root: string | null = null;

/**
 * Set the storage root directory. This is process-global state —
 * only one root is active at a time. Call before any other operations.
 * Use resetRoot() to revert to environment/default resolution.
 */
export function setRoot(root: string): void {
  _root = root;
}

/**
 * Clear the explicitly-set root, reverting to AGENT_RECALL_ROOT env var
 * or the default ~/.agent-recall.
 */
export function resetRoot(): void {
  _root = null;
}

export function getRoot(): string {
  return _root ?? process.env.AGENT_RECALL_ROOT ?? path.join(os.homedir(), ".agent-recall");
}

export function getLegacyRoot(): string {
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
export type WalkDepth = "identity" | "active" | "relevant" | "full";

/** Category determines decay rate — architecture decisions decay slowly, daily blockers decay fast. */
export type MemoryCategory = "goal" | "architecture" | "decision" | "blocker" | "observation" | "lesson" | "general";

/** Pinned items never get replaced by the awareness merge-or-replace cycle. */
export interface PinStatus {
  pinned: boolean;
  reason?: string;        // "ultimate goal", "human override", etc.
  pinned_at?: string;     // ISO date
}
