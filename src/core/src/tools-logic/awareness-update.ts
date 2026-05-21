import {
  readAwarenessState,
  writeAwarenessState,
  initAwareness,
  addInsight,
  detectCompoundInsights,
  renderAwareness,
} from "../palace/awareness.js";
import { addIndexedInsight } from "../palace/insights-index.js";

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
}

export async function awarenessUpdate(input: AwarenessUpdateInput): Promise<AwarenessUpdateResult> {
  let state = readAwarenessState();
  if (!state) {
    state = initAwareness(input.identity || "(unknown user)");
  }

  if (input.identity) {
    state.identity = input.identity;
  }

  const results: Array<{ title: string; action: string }> = [];
  for (const insight of input.insights) {
    const result = addInsight({
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

    addIndexedInsight({
      title: insight.title,
      source: insight.source,
      applies_when: insight.applies_when,
      projects: input.project ? [input.project] : undefined,
      file: undefined,
      severity: insight.severity ?? "important",
    });
  }

  // Re-read state after addInsight loop (addInsight writes its own state)
  state = readAwarenessState()!;

  if (input.trajectory) {
    state.trajectory = input.trajectory;
  }

  if (input.blind_spots && input.blind_spots.length > 0) {
    state.blindSpots = input.blind_spots.slice(0, 10);
  }

  state.lastUpdated = new Date().toISOString();
  writeAwarenessState(state);
  renderAwareness(state);

  const compounds = detectCompoundInsights();

  return {
    success: true,
    insights_processed: results,
    compound_insights_detected: compounds.length,
    total_insights: readAwarenessState()?.topInsights.length ?? 0,
  };
}
