import { recallInsights, readInsightsIndex } from "../palace/insights-index.js";
import { readAwareness } from "../palace/awareness.js";

export interface RecallInsightInput {
  context: string;
  limit?: number;
  include_awareness?: boolean;
}

export interface RecallInsightResult {
  context: string;
  matching_insights: Array<{
    title: string;
    relevance: number;
    severity: string;
    applies_when: string[];
    confirmed: number;
    file: string | null;
  }>;
  total_in_index: number;
  awareness: string | null;
}

export async function recallInsight(input: RecallInsightInput): Promise<RecallInsightResult> {
  const limit = input.limit ?? 5;
  const insights = recallInsights(input.context, limit);

  let awareness: string | null = null;
  if (input.include_awareness !== false) {
    const raw = readAwareness();
    if (raw) {
      awareness = raw.split("\n").slice(0, 200).join("\n");
    }
  }

  return {
    context: input.context,
    matching_insights: insights.map((i) => ({
      title: i.title,
      relevance: Math.round(i.relevance * 100) / 100,
      severity: i.severity,
      applies_when: i.applies_when,
      confirmed: i.confirmed_count,
      file: i.file ?? null,
    })),
    total_in_index: readInsightsIndex().insights.length,
    awareness,
  };
}
