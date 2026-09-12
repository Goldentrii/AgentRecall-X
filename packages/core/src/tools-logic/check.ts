/**
 * check — measure understanding gap with predictive guidance.
 *
 * Replaces: alignment_check (enhanced with past-delta analysis)
 * Phase 5: auto-promotes strong correction patterns (3+) to awareness.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProject } from "../storage/project.js";
import { ensureDir, todayISO, writeTextAtomic } from "../storage/fs-utils.js";
import { extractKeywords, generateSlug } from "../helpers/auto-name.js";
import { generateTags } from "../helpers/tag-generator.js";
import { writeCorrection, splitSentences, detectSeverity } from "../storage/corrections.js";
import {
  stagePendingCorrection,
  resolvePendingCorrection,
  validateStructuredCorrection,
} from "../storage/pending.js";
import { scrubForCloud } from "../storage/content-guard.js";
import { classifyFailureClass, checkAction, type CheckActionResult } from "./check-action.js";
import { getSessionId } from "../storage/session.js";
import { withLock, LockContentionError } from "../storage/filelock.js";
import { recordLifecycleEvent } from "../storage/lifecycle-telemetry.js";
import {
  readAlignmentLog as readLog,
  extractWatchPatterns,
  type AlignmentRecord,
  type WatchForPattern,
} from "../helpers/alignment-patterns.js";
import { awarenessUpdate } from "./awareness-update.js";
import { projectSubPath } from "../storage/paths.js";
import { listRooms } from "../palace/rooms.js";
import { readTierCandidates } from "../retrieval/candidates.js";
import { palaceWrite } from "./palace-write.js";
import { predictCorrection, type PredictCorrectionResult } from "./predict-correction.js";

export interface EvidenceFactor {
  factor: string;
  direction: "supports" | "weakens";
  weight?: number;
}

/**
 * Fix #2 (dual-channel capture gate, 2026-09-11) — the STRUCTURED
 * human_correction form, the ONLY path into the active corrections ledger.
 * All fields optional at the type level (the MCP schema mirrors this);
 * completeness is enforced by validateStructuredCorrection with an
 * agent_instruction on failure. `pending_id` resolves a staged _pending/
 * item: with a valid {rule,why,applies_when} it PROMOTES it (default
 * resolution), with `resolution:"reject"` it discards it to
 * _pending/_rejected.jsonl (rule/why/applies_when not required for reject;
 * `why` doubles as the reject reason).
 */
export interface HumanCorrectionStructured {
  rule?: string;
  why?: string;
  applies_when?: string[];
  pending_id?: string;
  resolution?: "promote" | "reject";
}

export interface CheckInput {
  goal: string;
  confidence: "high" | "medium" | "low";
  assumptions?: string[];
  /**
   * Fix #2 (dual-channel capture gate, 2026-09-11) — additive union.
   * STRING form: STAGED to corrections/_pending/ for review — it no longer
   * reaches the active ledger, the alignment-log `corrections` field, or
   * watch_for. STRUCTURED form: validated {rule, why, applies_when} →
   * active ledger via writeCorrection (and feeds the alignment log).
   */
  human_correction?: string | HumanCorrectionStructured;
  /**
   * Fix #2 — capture-channel provenance for the staging path (e.g. the CLI
   * hook passes "hook-correction" so staged rows carry hook provenance).
   * Additive + optional; ignored on the structured/active path.
   */
  correction_source?: string;
  delta?: string;
  project?: string;
  prior?: number;
  evidence?: EvidenceFactor[];
  posterior?: number;
  outcome?: "confirmed" | "rejected" | "partial" | string;
  decision_id?: string;
  /**
   * C3 (TOW2-329) — what you're about to DO, one sentence, when this call is a
   * pre-action safety check rather than (or in addition to) an alignment
   * check. Provide this before publish/deploy/delete/credential/external-send/
   * irreversible-write actions. When set, `check()` folds in check_action's
   * matcher (see `action_check` on the result) so the SAME pre-action
   * correction-matching capability is reachable through the default 5-tool
   * surface, without exposing the standalone `check_action` tool.
   */
  action_description?: string;
}

export interface WatchFor {
  pattern: string;
  frequency: number;
  suggestion: string;
}

export interface PastDelta {
  date: string;
  goal: string;
  delta: string;
}

export interface CheckResult {
  recorded: boolean;
  project: string;
  watch_for: WatchFor[];
  similar_past_deltas: PastDelta[];
  auto_promoted?: number;
  decision_id?: string;
  decision_trail_saved?: boolean;
  calibration_note?: string;
  /**
   * Set when the correction quality gate rejected the human_correction
   * (Sprint-0 review: silent gate rejection = invisible data loss). The
   * caller should rephrase as an actionable rule and retry.
   */
  correction_gate_rejected?: string;
  /**
   * fix6-locks (review LOW-3, same "never silent" doctrine as
   * correction_gate_rejected): set when this call's alignment record could
   * NOT be persisted because another live process held the alignment-log
   * lock past the timeout. The record still informed THIS result's
   * watch_for/similar_past_deltas; it is absent from future calls' history.
   */
  alignment_log_skipped?: true;
  /**
   * Fix #2 (dual-channel capture gate, 2026-09-11) — outcome of the
   * human_correction disposition when it did NOT directly become an active
   * record: "staged" (string form → _pending/), "rejected_junk" (hard noise
   * → _pending/_rejected.jsonl), "invalid_structured" (structured form
   * failed completeness → staged + agent_instruction), "promoted" /
   * "review_rejected" (pending_id resolution), "not_found" (unknown
   * pending_id). Absent on the plain valid-structured path.
   */
  correction_pending?: {
    id?: string;
    status: "staged" | "rejected_junk" | "invalid_structured" | "promoted" | "review_rejected" | "not_found" | "staging_failed";
    reason?: string;
    agent_instruction?: string;
  };
  /**
   * Wave 5 — forward anticipation: does this goal resemble a tendency the user
   * has been corrected on? Pushed as an early prior, not a fact pulled late.
   * Absent when prediction could not run or no blind-spots profile exists.
   */
  prediction?: PredictCorrectionResult;
  /**
   * C3 (TOW2-329) — present only when `action_description` was provided.
   * REUSES check_action's matcher (`checkAction` in ./check-action.js) verbatim
   * — no duplicated matching logic. Carries the same matching_rules /
   * matching_corrections / matching_insights / warning / verdict shape as the
   * standalone check_action tool. `verdict: "blocked"` means an authoritative
   * P0 correction OVERRIDES the plan — matching_corrections is already sorted
   * P0-before-P1 (severity DESC, then match strength), so the blocking
   * correction (if any) always leads that list.
   */
  action_check?: CheckActionResult;
}

function alignmentLogPath(project: string): string {
  // F2 fix (independent review, 2026-07-20): was a naive local sanitizer (no
  // lowercase, no existing-dir reuse), duplicated from
  // helpers/alignment-patterns.ts's own copy — routes through paths.ts now.
  return projectSubPath(project, "alignment-log.json");
}

function writeAlignmentLog(project: string, records: AlignmentRecord[]): void {
  const p = alignmentLogPath(project);
  ensureDir(path.dirname(p));
  // Scrub BEFORE the local write — session-start.ts reads this file directly
  // (readAlignmentLog) into every session_start briefing, and check() itself
  // re-reads it into similar_past_deltas on every future call. goal/
  // human_correction/delta/assumptions are all free-text check() params that
  // previously reached disk completely unscrubbed (this store has never had
  // any scrub, cloud or local).
  // Atomic: readAlignmentLog callers (session-start briefing, check() itself)
  // are lock-free — never let them observe a truncated file.
  writeTextAtomic(p, scrubForCloud(JSON.stringify(records, null, 2)));
}

// Severity classification: Fix #2 review fix (2026-09-11, code-review MEDIUM)
// — this file used to carry its own inline p0Patterns copy, documented as
// "kept byte-identical to storage/corrections.ts's detectSeverity" and it had
// ALREADY drifted twice (see the C-1 history in detectSeverity's doc comment).
// corrections.ts now EXPORTS detectSeverity precisely so staging and capture
// share one classifier; this file reuses it (class-not-instance: the
// classifier exists once). Applied to the structured form's RULE sentence only
// — the why/evidence must never escalate severity (see the severity-rule-only
// battery test).

/**
 * Fix #2 review fix (2026-09-11, code-review MEDIUM — class-not-instance):
 * capture-channel table for `correction_source` → pending channel. A source
 * value not in this table stages as "check_string" but its RAW value is still
 * carried in the staged row's provenance (never silently discarded).
 */
const SOURCE_CHANNEL_TABLE: Record<string, "hook"> = {
  "hook-correction": "hook",
};

export async function check(input: CheckInput): Promise<CheckResult> {
  const slug = await resolveProject(input.project);

  // Set when the correction quality gate rejects a human_correction (surfaced
  // in the result so the rejection is never silent).
  let gateRejection: string | undefined;
  // Fix #2 — staging/promotion outcome for the caller (see CheckResult doc).
  let correctionPending: CheckResult["correction_pending"];
  // Fix #2 — set ONLY by the validated structured form; feeds the alignment
  // record's `corrections` field below (the string form no longer does).
  let activatedRule: string | undefined;

  // 1a. Fix #2 (dual-channel capture gate): human_correction disposition.
  const hc = input.human_correction;
  if (typeof hc === "string") {
    if (!hc.trim()) {
      // Review fix (2026-09-11, code-review LOW): a whitespace-only string is
      // content-free — report it instead of silently no-op'ing (the pre-fix
      // gate would have rejected it as "too short").
      correctionPending = { status: "rejected_junk", reason: "empty human_correction — nothing to capture" };
    } else {
      // Legacy STRING form → STAGED to corrections/_pending/, never active.
      const stageRes = await stagePendingCorrection(slug, {
        kind: "correction",
        channel: SOURCE_CHANNEL_TABLE[input.correction_source ?? ""] ?? "check_string",
        text: hc,
        reason: "string-form human_correction — awaiting structured confirmation via check()",
        // Provenance carries the raw source when supplied (a source value
        // missing from SOURCE_CHANNEL_TABLE is preserved here, not discarded).
        source: input.correction_source ?? getSessionId(),
      });
      if (stageRes.staged) {
        correctionPending = {
          id: stageRes.id,
          status: "staged",
          agent_instruction:
            `human_correction was STAGED for review, not activated. To activate it, re-call check() with ` +
            `human_correction as an OBJECT: {rule: "<ONE imperative sentence>", why: "<concrete evidence>", ` +
            `applies_when: ["<context>", ...], pending_id: "${stageRes.id}"}. ` +
            `To discard it: {pending_id: "${stageRes.id}", resolution: "reject"}.`,
        };
      } else if (stageRes.rejected) {
        correctionPending = { status: "rejected_junk", reason: stageRes.reason };
      } else {
        // Review fix (2026-09-11, code-review LOW): an I/O staging failure is
        // NOT junk — label it honestly (it is still audit-logged best-effort
        // by stagePendingCorrection itself).
        correctionPending = { status: "staging_failed", reason: stageRes.reason };
      }
    }
  } else if (hc && typeof hc === "object") {
    if (hc.resolution === "reject") {
      if (!hc.pending_id) {
        correctionPending = { status: "not_found", reason: "resolution:'reject' requires a pending_id" };
      } else {
        const res = await resolvePendingCorrection(slug, hc.pending_id, "reject", { reason: hc.why });
        correctionPending = res.success
          ? { id: hc.pending_id, status: "review_rejected" }
          : { id: hc.pending_id, status: "not_found", reason: res.error };
      }
    } else {
      const validation = validateStructuredCorrection(hc);
      if (!validation.ok) {
        // Incomplete structured form: rejected with a restructure instruction,
        // and STAGED (never silently dropped).
        const reason = validation.failures.map((f) => `${f.field}: ${f.reason}`).join("; ");
        gateRejection = reason;
        const stageRes = await stagePendingCorrection(slug, {
          kind: "correction",
          channel: "check_structured_incomplete",
          text: [hc.rule?.trim(), hc.why?.trim()].filter(Boolean).join("\n\nWhy: ") || "(empty structured correction)",
          rule: hc.rule,
          applies_when: hc.applies_when,
          reason,
          source: getSessionId(),
        });
        correctionPending = {
          ...(stageRes.id ? { id: stageRes.id } : {}),
          status: "invalid_structured",
          reason,
          agent_instruction: validation.agent_instruction,
        };
      } else {
        // Validated STRUCTURED form → the active corrections ledger.
        try {
          const rule = hc.rule!.trim();
          const why = hc.why!.trim();
          const appliesWhen = hc.applies_when!;
          const corrText = `${rule}\n\nWhy: ${why}`;
          const corrDate = todayISO();
          // v3 (Loop 8): decimal-safe title slice — the rule is one sentence by
          // validation, so this is normally the full rule.
          const corrRule = (splitSentences(rule)[0] ?? rule).slice(0, 100);
          // Severity from the RULE sentence ONLY — evidence text must never
          // escalate a p1 preference into a p0 override. Shared classifier
          // (corrections.ts detectSeverity) — see the module-level note above.
          const severity: "p0" | "p1" = detectSeverity(rule);
          // applies_when tokens fold into tags (the existing p1 context-match
          // mechanism) alongside the auto-generated ones.
          const corrTags = Array.from(new Set([...generateTags(`${rule} ${why}`), ...appliesWhen]));
          const corrId = `${corrDate}-${corrRule.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)}`;
          const writeResult = await writeCorrection(slug, {
            id: corrId,
            date: corrDate,
            severity,
            project: slug,
            rule: corrRule,
            context: corrText,
            tags: corrTags,
            applies_when: appliesWhen,
            // RD-1 (owner decision 2026-07-14): failure_class is auto-derived at
            // capture — keyword classifier over the FULL correction text (rule +
            // why for the structured form), using only the shared tokenize/
            // overlap grammar. Zero/tied hits → "other".
            failure_class: classifyFailureClass(`${rule} ${why}`),
            // C2 (2026-07-26): stamp the recording session's identity into the
            // existing `holder` field (documented as "who recorded this — defaults
            // to date/session proxy") so corrections captured via check() carry a
            // consistent session identity, same as corrections.ts's own recordOutcome
            // call sites in session-start.ts/session-end.ts.
            holder: getSessionId(),
          });
          if (!writeResult.written) {
            // Surface the gate rejection instead of silently dropping the
            // correction — the agent must know it was NOT stored.
            gateRejection = writeResult.reason ?? "rejected by correction quality gate";
          } else {
            activatedRule = rule;
            if (hc.pending_id) {
              const res = await resolvePendingCorrection(slug, hc.pending_id, "promote", {
                correction_id: writeResult.id,
              });
              correctionPending = res.success
                ? { id: hc.pending_id, status: "promoted" }
                : { id: hc.pending_id, status: "not_found", reason: res.error };
            }
          }
        } catch (err) {
          // Review fix (2026-09-11, code-review MEDIUM): a throw on the
          // validated-structured write path must never be a SILENT loss —
          // surface it on the same never-silent field the gate uses. (The
          // string/insight paths already guarantee "lands in _pending/ or the
          // audit log"; this closes the last silent window.)
          gateRejection = `correction write failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
  }

  // 1. Record this alignment check. Fix #2: the `corrections` field is fed
  // ONLY by the validated structured form (activatedRule) — the string form
  // stages to _pending/ and must not seed watch_for/auto-promote from here.
  //
  // DELTA SIDE-DOOR (review fix 2026-09-11, code-review HIGH-1):
  // extractWatchPatterns treats `past.delta` as a correction too
  // (helpers/alignment-patterns.ts — `if (past.delta) corrections.push(...)`),
  // and the two string-form callers this gate exists for (the CLI hook and
  // `ar correct`) pack the SAME un-reviewed correction text into `delta`.
  // Recording delta alongside a NON-activated human_correction would therefore
  // re-open the exact watch_for/auto-promote bypass the corrections-field flip
  // just closed. Class rule: an alignment record may carry corrective
  // free-text (corrections OR delta) only from the validated channel — so
  // delta is recorded when no human_correction was supplied (pure alignment
  // note) or when the structured form activated; it is suppressed whenever the
  // accompanying human_correction was merely staged/rejected.
  const deltaAllowed = input.human_correction === undefined || activatedRule !== undefined;
  const record: AlignmentRecord = {
    date: todayISO(),
    goal: input.goal,
    confidence: input.confidence,
    assumptions: input.assumptions ?? [],
    corrections: activatedRule ? [activatedRule] : undefined,
    delta: deltaAllowed ? input.delta : undefined,
  };

  // fix6-locks: alignment-log.json is PER-PROJECT and appended by every
  // check() call from every live session on that project — the old unlocked
  // read→push→write span dropped concurrent sessions' records
  // (alignment-log-concurrency.test.mjs reproduced 31/40 lost on main HEAD).
  // Lock name is project-scoped, mirroring `corrections-${project}`.
  let trimmed: AlignmentRecord[];
  let alignmentLogSkipped = false;
  try {
    trimmed = await withLock(`alignment-${slug}`, () => {
      const log = readLog(slug);
      log.push(record);
      const t = log.slice(-50);
      writeAlignmentLog(slug, t);
      return t;
    });
  } catch (err) {
    if (err instanceof LockContentionError) {
      // Best-effort skip, loudly: one alignment record lost under pathological
      // live contention beats stealing the lock mid-write (old behavior) or
      // failing the whole check() call. Downstream analysis still sees the
      // in-memory record so this call's result is unaffected. The skip is
      // surfaced BOTH on stderr (host log) and in the result
      // (alignment_log_skipped — review LOW-3: a success-shaped result must
      // not hide a persistence failure from the calling agent).
      console.error(`[agent-recall] check(): ${err.message} — this alignment record was NOT persisted.`);
      alignmentLogSkipped = true;
      const log = readLog(slug);
      log.push(record);
      trimmed = log.slice(-50);
    } else {
      throw err;
    }
  }

  // 2. Find similar past goals — check BOTH alignment-log AND palace alignment room
  const goalKeywords = extractKeywords(input.goal, 5);
  const similarDeltas: PastDelta[] = [];

  // 2a. From alignment-log.json
  for (const past of trimmed.slice(0, -1)) {
    if (!past.delta && !past.corrections?.length) continue;

    const pastKeywords = extractKeywords(past.goal, 5);
    const overlap = goalKeywords.filter((k) => pastKeywords.some((pk) => pk.includes(k) || k.includes(pk)));

    if (overlap.length >= 2) {
      similarDeltas.push({
        date: past.date,
        goal: past.goal.slice(0, 80),
        delta: (past.delta ?? past.corrections?.join("; ") ?? "").slice(0, 200),
      });
    }
  }

  // 2b. From palace alignment room — rich correction history agents store there.
  // Wave 3a (P0 palace-room KNOWN-GAP closure, 2026-08-30): routed through the
  // shared, trust-safe FETCH stage (readTierCandidates) instead of this
  // surface's own raw fs.readdirSync+readFileSync glob — a rescue-tagged room
  // file's parsed "Human correction"/"Delta" excerpt can no longer be echoed
  // back through similar_past_deltas. README.md/_room.json are excluded here
  // (as before) since readTierCandidates includes README.md by default and
  // _room.json is not a `.md` entry parsed by the `### DATE` pattern below.
  try {
    const rooms = listRooms(slug);
    const alignmentRoom = rooms.find((r) => r.name.toLowerCase() === "alignment" || r.slug === "alignment");
    if (alignmentRoom) {
      const candidates = readTierCandidates("palace-room", slug, { room: alignmentRoom.slug });
      for (const candidate of candidates) {
        if (candidate.file === "README.md") continue;
        const content = candidate.content;
        // Parse entries: ### DATE — CONFIDENCE blocks with Goal + Human correction
        const entryPattern = /###\s+(\d{4}-\d{2}-\d{2})[^\n]*\n([\s\S]*?)(?=###|\s*$)/g;
        let match: RegExpExecArray | null;
        while ((match = entryPattern.exec(content)) !== null) {
          const date = match[1];
          const block = match[2];
          const goalMatch = block.match(/\*\*Goal\*\*:\s*(.+)/);
          const correctionMatch = block.match(/\*\*Human correction\*\*:\s*([\s\S]+?)(?=\*\*|$)/);
          const deltaMatch = block.match(/\*\*Delta\*\*:\s*([\s\S]+?)(?=\*\*|$)/);
          if (!goalMatch) continue;

          const pastGoal = goalMatch[1].trim();
          const correction = correctionMatch?.[1].trim() ?? "";
          const delta = deltaMatch?.[1].trim() ?? correction;
          if (!delta) continue;

          const pastKeywords = extractKeywords(pastGoal, 5);
          const overlap = goalKeywords.filter((k) => pastKeywords.some((pk) => pk.includes(k) || k.includes(pk)));
          // Also check if goal keywords appear in the correction text (broader match)
          const correctionKeywords = extractKeywords(delta, 5);
          const correctionOverlap = goalKeywords.filter((k) => correctionKeywords.some((ck) => ck.includes(k) || k.includes(ck)));

          if (overlap.length >= 1 || correctionOverlap.length >= 2) {
            similarDeltas.push({
              date,
              goal: pastGoal.slice(0, 80),
              delta: delta.slice(0, 200),
            });
          }
        }
      }
    }
  } catch {
    // Palace alignment room is optional
  }

  // 3. Extract patterns using shared helper
  const watchFor = extractWatchPatterns(trimmed, 3);

  // 4. Phase 5: auto-promote strong patterns (3+) to awareness
  // Quality gate: skip patterns that are raw speech fragments, not actionable insights.
  let autoPromoted = 0;
  for (const w of watchFor) {
    if (w.frequency >= 3) {
      const words = w.pattern.split(/\s+/).filter((word: string) => word.length > 1);
      // Quality filters: must be ≥5 meaningful words and contain an action verb signal
      const hasActionSignal = /\b(don't|never|always|must|should|use|avoid|prefer|stop|skip|check|verify|wait|need)\b/i.test(w.pattern);
      if (words.length < 5 || !hasActionSignal) continue;
      try {
        // W4 fix (2026-08-30, root-cause of the PROJECT_INSIGHT_BUDGET
        // never-fired gap — session-start.ts's project-scoped insight slot,
        // :439-474): this call previously omitted BOTH `project` (top-level)
        // and `source_project` (per-insight) — `awarenessUpdate` derives
        // `IndexedInsight.projects` from the TOP-LEVEL `project` field only
        // (see awareness-update.ts's `addIndexedInsight` call: `projects:
        // input.project ? [input.project] : undefined`), so every insight
        // auto-promoted here got `projects: undefined` forever and could
        // never match session-start.ts's `(i.projects ?? []).includes(slug)`
        // filter. `source_project` separately stamps `Insight.source_project`
        // in awareness.md's topInsights (palace/awareness.ts's `addInsight`,
        // defaults to "_global" when omitted) — a different store, same
        // missing-attribution bug. Matches the exact pattern already used at
        // session-end.ts:650/653 and smart-remember.ts:226/229 (both pass
        // `project: slug` top-level AND `source_project: slug` per-insight)
        // — not an invented convention. `slug` is already resolved above
        // (line 128). Additive/non-regressing: worst case is correctly
        // attributing an insight that was previously mis-filed global.
        await awarenessUpdate({
          insights: [{
            title: `Human preference: ${w.pattern.slice(0, 60)}`,
            evidence: `Detected from ${w.frequency} corrections in alignment log`,
            applies_when: w.pattern.split(/[\s\-:()]+/).filter((word: string) => word.length > 3).slice(0, 5),
            source: `check auto-promote ${todayISO()}`,
            source_project: slug,
            severity: "important",
          }],
          project: slug,
        });
        autoPromoted++;
      } catch {
        // Best effort
      }
    }
  }

  // 5. Decision trail: persist when outcome is closed. ID only generated when writing.
  let decisionId: string | undefined;
  let decisionTrailSaved = false;
  let calibrationNote: string | undefined;

  if (input.outcome !== undefined) {
    decisionId = input.decision_id ?? `decision-${Date.now()}`;
    try {
      const decisionContent = [
        `# Decision: ${input.goal}`,
        ``,
        `## Summary`,
        `- Prior: ${input.prior ?? "not set"}`,
        `- Posterior: ${input.posterior ?? "not set"}`,
        `- Outcome: ${input.outcome}`,
        `- Date: ${todayISO()}`,
        `- Confidence: ${input.confidence}`,
        ``,
        input.evidence?.length ? `## Evidence chain` : "",
        ...(input.evidence ?? []).map(
          (e, i) =>
            `${i + 1}. [${e.direction}] ${e.factor}${e.weight !== undefined ? ` (weight: ${e.weight})` : ""}`
        ),
        ``,
        input.assumptions?.length ? `## Assumptions` : "",
        ...(input.assumptions ?? []).map((a) => `- ${a}`),
        input.delta ? `\n## Correction\n${input.delta}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const topicSlug = generateSlug(input.goal, { room: "decisions" }).slug;
      await palaceWrite({
        room: "decisions",
        topic: topicSlug,
        content: decisionContent,
        project: slug,
      });
      decisionTrailSaved = true;

      // Simple calibration hint: flag when prior is high but outcome is rejected
      if (
        input.prior !== undefined &&
        input.prior >= 0.7 &&
        input.outcome === "rejected"
      ) {
        calibrationNote = `Prior was ${input.prior} but outcome was rejected — consider revisiting confidence calibration for similar goals.`;
      } else if (
        input.prior !== undefined &&
        input.prior <= 0.3 &&
        input.outcome === "confirmed"
      ) {
        calibrationNote = `Prior was ${input.prior} but outcome was confirmed — you may be underestimating confidence on similar goals.`;
      }
    } catch {
      // Best effort — never block the check flow
    }
  }

  // 6. Wave 5: forward anticipation — predict whether this goal is likely to be
  // corrected, based on the corrections-derived Blind-Spots profile. Pushed as
  // an early prior. Best-effort: prediction must never break the check flow.
  let prediction: PredictCorrectionResult | undefined;
  try {
    prediction = await predictCorrection({ plan: input.goal, project: slug });
  } catch {
    prediction = undefined;
  }
  // Over-confidence guard: a high-likelihood prediction against a high-confidence
  // self-assessment is exactly the mismatch worth flagging before acting.
  if (prediction && prediction.likelihood === "high" && input.confidence === "high") {
    const guardLine =
      "OVER-CONFIDENCE GUARD: a prior correction predicts this plan is likely to be corrected — reconcile first.";
    calibrationNote = calibrationNote ? `${calibrationNote} ${guardLine}` : guardLine;
  }

  // 7. C3 (TOW2-329) — fold check_action's pre-action matcher into the default
  // surface. Only runs when the caller supplied `action_description`; reuses
  // `checkAction` verbatim (same matching_rules/corrections/insights + verdict
  // semantics, incl. `blocked` for an authoritative P0 match) so the standalone
  // check_action tool's capability is reachable through the default 5 tools
  // without duplicating its matching logic. Best-effort: must never break the
  // check flow.
  let actionCheck: CheckActionResult | undefined;
  const actionDescription = input.action_description?.trim();
  if (actionDescription) {
    try {
      actionCheck = await checkAction({ action_description: actionDescription, project: slug });
    } catch {
      actionCheck = undefined;
    }
  }

  // C2 — lifecycle telemetry: counters only, never transcript content.
  // check() has no idempotency-suppression concept (task scope is limited to
  // session_start/session_end), so dup is always false here.
  recordLifecycleEvent("check", getSessionId(), slug, false);

  return {
    recorded: true,
    project: slug,
    watch_for: watchFor,
    similar_past_deltas: similarDeltas.slice(0, 3),
    auto_promoted: autoPromoted > 0 ? autoPromoted : undefined,
    decision_id: decisionId,
    decision_trail_saved: decisionTrailSaved || undefined,
    calibration_note: calibrationNote,
    correction_gate_rejected: gateRejection,
    ...(alignmentLogSkipped ? { alignment_log_skipped: true as const } : {}),
    ...(correctionPending ? { correction_pending: correctionPending } : {}),
    ...(prediction ? { prediction } : {}),
    ...(actionCheck ? { action_check: actionCheck } : {}),
  };
}
