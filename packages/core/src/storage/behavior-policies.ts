/**
 * Behavior policies — high-salience, always-loaded IF-THEN rules.
 *
 * Solves item 6 of the real-usage feedback brief: a user mid-session taught
 * the agent "humans use voice-to-text → reorganize before acting." The agent
 * had no tool to register this as a permanent behavior rule; it could only
 * save it as an insight string that might or might not surface again.
 *
 * Storage: ~/.agent-recall/projects/<slug>/palace/behavior-policies.json
 * Shape:   { rules: [{ id, name, when, do, created, hits }] }
 *
 * Always-loaded at session_start with HIGH salience (above regular insights).
 * These are behavior commitments, not facts — they police what the agent does,
 * not what it knows.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { palaceDir } from "./paths.js";
import { ensureDir } from "./fs-utils.js";
import { scrubForCloud } from "./content-guard.js";

export interface BehaviorRule {
  id: string;
  name: string;
  /** Trigger condition — when this rule applies. */
  when: string;
  /** Required action — what to do when triggered. */
  do: string;
  /** ISO timestamp of creation. */
  created: string;
  /** Times this rule was retrieved at session_start. Monotonic counter. */
  hits: number;
}

export interface BehaviorPoliciesFile {
  rules: BehaviorRule[];
}

function policyPath(slug: string): string {
  return path.join(palaceDir(slug), "behavior-policies.json");
}

function newRuleId(): string {
  return "rule_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

export function readBehaviorPolicies(slug: string): BehaviorPoliciesFile {
  const p = policyPath(slug);
  if (!fs.existsSync(p)) return { rules: [] };
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as BehaviorPoliciesFile;
    if (!parsed || !Array.isArray(parsed.rules)) return { rules: [] };
    return parsed;
  } catch {
    return { rules: [] };
  }
}

export interface RegisterRuleInput {
  project: string;
  name: string;
  when: string;
  do: string;
}

export interface RegisterRuleResult {
  success: boolean;
  rule_id?: string;
  total_rules?: number;
  error?: string;
}

/**
 * Register a new behavior policy. Idempotent: if a rule with the same name +
 * when + do already exists, returns the existing rule_id instead of duplicating.
 */
export function registerBehaviorRule(input: RegisterRuleInput): RegisterRuleResult {
  const name = (input.name ?? "").trim();
  const when = (input.when ?? "").trim();
  const doField = (input.do ?? "").trim();
  if (!name) return { success: false, error: "name required" };
  if (!when) return { success: false, error: "when (trigger) required" };
  if (!doField) return { success: false, error: "do (required action) required" };

  const current = readBehaviorPolicies(input.project);
  const existing = current.rules.find(
    (r) => r.name === name && r.when === when && r.do === doField,
  );
  if (existing) {
    return { success: true, rule_id: existing.id, total_rules: current.rules.length };
  }

  // Scrub the free-text fields before they ever enter the rule object — this
  // store is read directly at session_start (readBehaviorPolicies, above
  // regular-insight salience) AND surfaces in handoff.ts's "Behavior policies"
  // section, and had no scrub of any kind previously.
  const rule: BehaviorRule = {
    id: newRuleId(),
    name: scrubForCloud(name),
    when: scrubForCloud(when),
    do: scrubForCloud(doField),
    created: new Date().toISOString(),
    hits: 0,
  };
  const next: BehaviorPoliciesFile = { rules: [...current.rules, rule] };
  const dir = palaceDir(input.project);
  ensureDir(dir);
  const target = policyPath(input.project);
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, target);
  return { success: true, rule_id: rule.id, total_rules: next.rules.length };
}

/**
 * Increment the `hits` counter on every rule. Called from session_start when
 * rules are loaded — lets us see which rules are "alive" via dashboard later.
 */
export function recordPolicyLoad(slug: string): void {
  const current = readBehaviorPolicies(slug);
  if (current.rules.length === 0) return;
  const next: BehaviorPoliciesFile = {
    rules: current.rules.map((r) => ({ ...r, hits: r.hits + 1 })),
  };
  const target = policyPath(slug);
  try {
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch {
    // best-effort — counter loss is acceptable
  }
}
