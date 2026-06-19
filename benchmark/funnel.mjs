#!/usr/bin/env node
/**
 * funnel.mjs — WS-2 "Confirm-first session_end" regression suite.
 *
 * Guards the insight funnel compounding behavior introduced in v4 Sprint 1:
 *   - Near-duplicate insights confirm existing entries (count++) instead of
 *     creating new ones (the root cause of 198/200 insights stuck at count=1).
 *   - Clearly-different insights create new entries as expected.
 *   - Cap eviction preserves high-confirmed entries (count>=2) when flooding
 *     the 200-entry index with new count-1 entries.
 *
 * Run: node benchmark/funnel.mjs
 * Exit 0 = all pass, 1 = any fail.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Point the storage root at a throwaway dir BEFORE importing core.
const AR_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ar-funnel-"));
process.env.AGENT_RECALL_ROOT = AR_ROOT;

const core = await import("../packages/core/dist/index.js");
const {
  sessionEnd,
  readInsightsIndex,
  writeInsightsIndex,
  findSimilarInsight,
  normalizeTitle,
  tokenOverlap,
} = core;

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  if (cond) { console.log("  ✅", label); pass++; }
  else { console.log("  ❌", label, detail ? "→ " + detail : ""); fail++; }
};

const PROJ = "funnel-test";

console.log(`\n[funnel] AR_ROOT=${AR_ROOT}\n`);

// ── T0: normalizeTitle and tokenOverlap unit checks ──────────────────────────
console.log("[T0] normalizeTitle + tokenOverlap unit");

const tokA = normalizeTitle("Multi-agent review catches blind-spot bugs in worker code");
const tokB = normalizeTitle("Multi-agent review catches blind spot bugs in workers' code");
const overlap0 = tokenOverlap(tokA, tokB);
check(
  "near-duplicate titles overlap >= 0.6",
  overlap0 >= 0.6,
  `got ${overlap0.toFixed(3)}`
);

const tokC = normalizeTitle("Supabase RLS enforces row-level security per tenant");
const overlap1 = tokenOverlap(tokA, tokC);
check(
  "clearly-different titles overlap < 0.6",
  overlap1 < 0.6,
  `got ${overlap1.toFixed(3)}`
);

// ── T1: near-duplicate insight → ONE entry at count=2 ───────────────────────
console.log("[T1] near-duplicate insight confirms existing entry");

await sessionEnd({
  project: PROJ,
  summary: "Session 1 — introduced multi-agent review pattern.",
  insights: [{
    title: "Multi-agent review catches blind-spot bugs in worker code",
    evidence: "Reviewer caught a process.exit() skipping finally{} cleanup",
    applies_when: ["multi-agent", "code-review", "workers"],
    severity: "important",
  }],
});

await sessionEnd({
  project: PROJ,
  summary: "Session 2 — same pattern observed again with different wording.",
  insights: [{
    title: "Multi-agent review catches blind spot bugs in workers' code",
    evidence: "Second reviewer session caught a ternary ordering bug",
    applies_when: ["multi-agent", "review", "ternary"],
    severity: "important",
  }],
});

{
  const idx = readInsightsIndex();
  const multiAgentEntries = idx.insights.filter((i) =>
    i.title.toLowerCase().includes("multi-agent") ||
    i.title.toLowerCase().includes("multi agent")
  );
  check(
    "T1: exactly ONE entry for multi-agent review insight",
    multiAgentEntries.length === 1,
    `found ${multiAgentEntries.length} entries: ${multiAgentEntries.map(i => i.title).join(" | ")}`
  );
  check(
    "T1: confirmed_count === 2",
    multiAgentEntries[0]?.confirmed_count === 2,
    `got confirmed_count=${multiAgentEntries[0]?.confirmed_count}`
  );
  check(
    "T1: applies_when merged (has both 'code-review' and 'ternary')",
    multiAgentEntries[0]?.applies_when?.includes("code-review") &&
    multiAgentEntries[0]?.applies_when?.includes("ternary"),
    `got: ${multiAgentEntries[0]?.applies_when?.join(", ")}`
  );
}

// ── T2: clearly-different insight → second entry added ─────────────────────
console.log("[T2] clearly-different insight creates a new entry");

await sessionEnd({
  project: PROJ,
  summary: "Session 3 — supabase rls decision.",
  insights: [{
    title: "Supabase RLS enforces row-level isolation without application code",
    evidence: "Chose it during architecture decision for multi-tenant app",
    applies_when: ["supabase", "rls", "multi-tenant"],
    severity: "important",
  }],
});

{
  const idx = readInsightsIndex();
  const supabaseEntries = idx.insights.filter((i) =>
    i.title.toLowerCase().includes("supabase")
  );
  check(
    "T2: Supabase insight added as separate entry",
    supabaseEntries.length === 1,
    `found ${supabaseEntries.length}`
  );
  check(
    "T2: Supabase insight confirmed_count === 1",
    supabaseEntries[0]?.confirmed_count === 1,
    `got ${supabaseEntries[0]?.confirmed_count}`
  );
  // Total entries should be 2 now
  check(
    "T2: total index has 2 entries",
    idx.insights.length === 2,
    `got ${idx.insights.length}`
  );
}

// ── T3: session_end result reports insights_confirmed and insights_added ─────
console.log("[T3] SessionEndResult.insights_confirmed / insights_added fields");

const r1 = await sessionEnd({
  project: PROJ,
  summary: "Session 4 — confirming the multi-agent insight one more time.",
  insights: [{
    title: "Multi-agent review catches blind spot bugs in worker output",
    evidence: "Third reviewer session caught an unreachable ternary branch",
    applies_when: ["multi-agent", "review"],
    severity: "important",
  }],
});
check(
  "T3: insights_confirmed === 1 (near-dup confirmed)",
  r1.insights_confirmed === 1,
  `got ${r1.insights_confirmed}`
);
check(
  "T3: insights_added === 0 (no new entry)",
  r1.insights_added === 0,
  `got ${r1.insights_added}`
);

const r2 = await sessionEnd({
  project: PROJ,
  summary: "Session 5 — a brand new insight.",
  insights: [{
    title: "TypeScript strict null checks prevent undefined access crashes at runtime",
    evidence: "Enabled strict mode and eliminated 12 potential runtime errors",
    applies_when: ["typescript", "strict", "null-checks"],
    severity: "important",
  }],
});
check(
  "T3: insights_added === 1 (new entry)",
  r2.insights_added === 1,
  `got ${r2.insights_added}`
);
check(
  "T3: insights_confirmed === 0 (no confirmation)",
  r2.insights_confirmed === 0,
  `got ${r2.insights_confirmed}`
);

// ── T4: cap eviction — count-3 entry survives a count-1 flood ───────────────
console.log("[T4] cap eviction — count>=2 entries survive count-1 flood");

// Manually seed a count-3 insight directly into the index
{
  const idx = readInsightsIndex();
  idx.insights.push({
    id: "idx-anchor",
    title: "ANCHOR-INSIGHT that must survive cap eviction flood",
    source: "manual-seed",
    applies_when: ["anchor", "eviction-test"],
    severity: "critical",
    confirmed_count: 3,
    last_confirmed: new Date().toISOString(),
  });
  writeInsightsIndex(idx);
}

// Flood the index with 200+ count-1 entries via session_end
// (we need enough unique entries to push past the 200 cap)
const currentSize = readInsightsIndex().insights.length;
const needed = 200 - currentSize + 5; // fill past cap

for (let i = 0; i < needed; i++) {
  // Direct write to index — faster than session_end for flooding
  const idx = readInsightsIndex();
  if (idx.insights.length < 200) {
    idx.insights.push({
      id: `idx-flood-${i}`,
      title: `Flood insight number ${i} for cap eviction testing with unique content ${Math.random()}`,
      source: "flood-test",
      applies_when: ["flood", `item-${i}`],
      severity: "minor",
      confirmed_count: 1,
      last_confirmed: new Date(Date.now() - (needed - i) * 1000).toISOString(),
    });
    writeInsightsIndex(idx);
  }
}

// Now trigger addIndexedInsight via session_end which will need to evict
await sessionEnd({
  project: PROJ,
  summary: "Session after flood — adding one more new insight that needs eviction.",
  insights: [{
    title: "Cap eviction test insight that triggers oldest count-1 removal",
    evidence: "This was added when the cap was full of count-1 entries",
    applies_when: ["eviction", "cap", "overflow"],
    severity: "minor",
  }],
});

{
  const idx = readInsightsIndex();
  const anchorEntry = idx.insights.find((i) => i.id === "idx-anchor");
  check(
    "T4: ANCHOR-INSIGHT (count=3) survived the count-1 flood",
    anchorEntry !== undefined,
    anchorEntry ? "found" : "NOT FOUND — evicted incorrectly"
  );
  check(
    "T4: ANCHOR-INSIGHT still has confirmed_count >= 3",
    (anchorEntry?.confirmed_count ?? 0) >= 3,
    `got ${anchorEntry?.confirmed_count}`
  );
  check(
    "T4: index size stays at or below 200",
    idx.insights.length <= 200,
    `got ${idx.insights.length}`
  );
  // No count-1 entries should have been evicted before count>=2
  const count2Plus = idx.insights.filter((i) => i.confirmed_count >= 2);
  const anchorInCount2Plus = count2Plus.some((i) => i.id === "idx-anchor");
  check(
    "T4: all count>=2 entries are preserved (anchor in count>=2 group)",
    anchorInCount2Plus,
    `count>=2 entries: ${count2Plus.length}, anchor present: ${anchorInCount2Plus}`
  );
}

// ── T5: malformed insights-index.json → session_end still succeeds ───────────
console.log("[T5] malformed insights-index.json — graceful degradation");

// Corrupt the index file
const idxPath = `${AR_ROOT}/insights-index.json`;
if (fs.existsSync(idxPath)) {
  fs.writeFileSync(idxPath, "{ this is not valid JSON }", "utf-8");
}

let t5Error = null;
let t5Result = null;
try {
  t5Result = await sessionEnd({
    project: PROJ,
    summary: "Session after corrupted index — should still succeed.",
    insights: [{
      title: "Recovery from corrupted index works correctly in session_end",
      evidence: "session_end completed without throwing after index corruption",
      applies_when: ["recovery", "error-handling"],
      severity: "important",
    }],
  });
} catch (err) {
  t5Error = err;
}

check(
  "T5: session_end does not throw on corrupted insights-index.json",
  t5Error === null,
  t5Error ? String(t5Error) : ""
);
check(
  "T5: session_end reports success despite corrupted index",
  t5Result?.success === true,
  `success=${t5Result?.success}, journal_written=${t5Result?.journal_written}`
);

// ── cleanup ──────────────────────────────────────────────────────────────────
try { fs.rmSync(AR_ROOT, { recursive: true, force: true }); } catch {}

console.log(`\n[funnel] PASS ${pass} / FAIL ${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
