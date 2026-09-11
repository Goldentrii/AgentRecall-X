import * as path from "node:path";
import {
  readAwarenessState,
  mutateAwarenessState,
  createInitialState,
  initAwareness,
  addInsight,
  detectCompoundInsights,
} from "../palace/awareness.js";
import { addIndexedInsight } from "../palace/insights-index.js";
import { getRoot } from "../types.js";

export interface AwarenessUpdateInput {
  insights: Array<{
    title: string;
    evidence: string;
    applies_when: string[];
    source: string;
    source_project?: string;
    severity?: "critical" | "important" | "minor";
  }>;
  project?: string;
  trajectory?: string;
  blind_spots?: string[];
  identity?: string;
}

export interface AwarenessUpdateResult {
  success: boolean;
  insights_processed: Array<{ title: string; action: string }>;
  compound_insights_detected: number;
  total_insights: number;
  /** Exact path of the awareness file written */
  file_path: string;
}

export async function awarenessUpdate(input: AwarenessUpdateInput): Promise<AwarenessUpdateResult> {
  let state = readAwarenessState();
  if (!state) {
    state = await initAwareness(input.identity || "(unknown user)");
  }

  if (input.identity) {
    // NOTE (pre-existing, preserved verbatim): this in-memory identity update
    // is discarded by the re-read below — identity only persists via the
    // initAwareness path. Flagged in the fix6-locks report; fixing it is out
    // of scope for the locking change.
    state.identity = input.identity;
  }

  const results: Array<{ title: string; action: string }> = [];
  for (const insight of input.insights) {
    const result = await addInsight({
      title: insight.title,
      evidence: insight.evidence,
      appliesWhen: insight.applies_when,
      source: insight.source,
      source_project: insight.source_project ?? input.project ?? "_global",
    });
    // Rejected by quality gate — record reason, skip indexing
    if ("accepted" in result) {
      results.push({ title: insight.title, action: `rejected:${result.reason}` });
      continue;
    }
    results.push({ title: insight.title, action: result.action });

    await addIndexedInsight({
      title: insight.title,
      source: insight.source,
      applies_when: insight.applies_when,
      projects: input.project ? [input.project] : undefined,
      file: undefined,
      severity: insight.severity ?? "important",
    });
  }

  // Re-read + mutate + write as ONE locked span (fix6-locks: the old unlocked
  // read-here/write-below shape could overwrite a concurrent session's
  // addInsight between the re-read and the write).
  await mutateAwarenessState((current) => {
    // initAwareness/addInsight above make existence overwhelmingly likely, but
    // never throw inside the lock on a torn/vanished state file — rebuild.
    const s = current ?? createInitialState(input.identity || "(unknown user)");
    if (input.trajectory) {
      s.trajectory = input.trajectory;
    }
    if (input.blind_spots && input.blind_spots.length > 0) {
      s.blindSpots = input.blind_spots.slice(0, 10);
    }
    s.lastUpdated = new Date().toISOString();
    return { state: s, result: undefined };
  });

  const compounds = await detectCompoundInsights();

  return {
    success: true,
    insights_processed: results,
    compound_insights_detected: compounds.length,
    total_insights: readAwarenessState()?.topInsights.length ?? 0,
    file_path: path.join(getRoot(), "awareness.md"),
  };
}
