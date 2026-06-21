/**
 * semantic-match.ts — LOCAL, zero-key, zero-network semantic similarity (Loop 5).
 *
 * WHY THIS EXISTS — Loop 3 measured the keyword predictor at an honest 0/13 on
 * the real corpus: of the 13 predictable corrections, 11 had ZERO lead-in↔trigger
 * token overlap and the other 2 maxed at 1 (below the MIN_OVERLAP=2 floor). The
 * relationship between a situation ("renaming the npm package and the README")
 * and the resolution it will provoke ("Rename everything to Novada Proxy") is
 * SEMANTIC, not lexical — different surface words, same concept.
 *
 * This module restores AgentRecall's local-by-default identity: NO OPENAI_API_KEY,
 * NO network, NO per-call LLM. It bridges vocabularies with three cheap, pure
 * signals over the situation text vs a blind-spot's trigger keywords:
 *
 *   1. LIGHT STEMMING — collapse morphology (publish/published/publishing,
 *      rename/renaming, customer/customers) so inflected forms match.
 *   2. SYNONYM / CONCEPT EXPANSION — a small built-in map keyed to the recurring
 *      AgentRecall domains (publish↔ship↔release, secret↔key↔token↔credential,
 *      name↔rename↔naming, approval↔permission, codex↔sonnet↔agent). This is the
 *      actual bridge between a situation's verbs and a resolution's nouns.
 *   3. CHARACTER-TRIGRAM COSINE — fuzzy overlap that catches shared roots and
 *      near-spellings even when whole stems differ.
 *
 * The combined score is `max(stemmed token-set cosine, char-trigram cosine)`
 * over the SYNONYM-EXPANDED stem sets — a value in [0,1]. Callers compare it to a
 * threshold to decide whether a risk fires.
 *
 * Pure, deterministic, no IO. The heavy lifting (set construction) is O(tokens);
 * any precompute a caller wants belongs at write/consolidation time, not here.
 */

import { tokenize } from "../tools-logic/check-action.js";

// ───────────────────────────────────────────────────────────────────────────
// Light Porter-ish stemming — strips common English suffixes. NOT a full Porter
// stemmer (no library dependency); just enough to collapse the inflections that
// actually appear in corrections. Order matters: longest/most-specific first.
// ───────────────────────────────────────────────────────────────────────────

/** Suffix rules applied in order; first match wins. Each only fires above a min stem length. */
const STEM_RULES: Array<{ suffix: string; minLen: number; replace?: string }> = [
  { suffix: "ization", minLen: 9, replace: "ize" }, // tokenization -> tokenize
  { suffix: "iveness", minLen: 9 },
  { suffix: "fulness", minLen: 9 },
  { suffix: "ousness", minLen: 9 },
  { suffix: " ", minLen: 99 }, // (never; placeholder kept out of hot path)
  { suffix: " ", minLen: 99 },
  { suffix: "ements", minLen: 8 },
  { suffix: "ables", minLen: 7 },
  { suffix: " ", minLen: 99 },
  { suffix: "ement", minLen: 7 },
  { suffix: "ation", minLen: 7, replace: "ate" }, // deprecation -> deprecate
  { suffix: "ingly", minLen: 7 },
  { suffix: "edly", minLen: 6 },
  { suffix: "ings", minLen: 6 }, // renamings -> renam (then -> rename via 'e' add below) — handled by 'ing'
  { suffix: "ies", minLen: 5, replace: "y" }, // dependencies -> dependency
  { suffix: "ied", minLen: 5, replace: "y" },
  { suffix: "ing", minLen: 5 }, // renaming -> renam ; publishing -> publish
  { suffix: "ers", minLen: 5 }, // builders -> build
  { suffix: "er", minLen: 5 }, // builder -> build (guarded by len so 'user' stays)
  { suffix: "ses", minLen: 5 }, // accesses -> acces -> (handled)
  { suffix: "es", minLen: 4 }, // changes -> chang ; aliases -> alias (len-guarded)
  { suffix: "ed", minLen: 4 }, // renamed -> renam ; changed -> chang
  { suffix: "ly", minLen: 5 }, // explicitly -> explicit
  { suffix: "s", minLen: 4 }, // customers -> customer ; tokens -> token
];

/**
 * Stem a single lowercased token. Applies the first matching suffix rule, then a
 * light "double consonant" fixup so e.g. `renam` (from `renaming`) collapses with
 * `rename` by re-adding a trailing `e` when the stem ends in a consonant cluster
 * that commonly drops an `e`. Deterministic and dependency-free.
 */
export function stem(token: string): string {
  let t = token;
  for (const rule of STEM_RULES) {
    if (rule.minLen >= 99) continue;
    if (t.length >= rule.minLen && t.endsWith(rule.suffix)) {
      t = t.slice(0, t.length - rule.suffix.length) + (rule.replace ?? "");
      break;
    }
  }
  // Collapse a doubled trailing consonant (running -> runn -> run).
  if (t.length > 3 && /([^aeiou])\1$/.test(t)) t = t.slice(0, -1);
  // Re-add a dropped silent 'e' for common verb stems so the -ing/-ed form and the
  // bare form converge (renam->rename, declar->declare). Only when the stem ends in
  // a consonant preceded by a vowel-consonant and is a plausible verb root length.
  if (t.length >= 4 && /[bcdfgklmnprstvz]$/.test(t) && /[aeiou][^aeiou]$/.test(t)) {
    // heuristic: nam->name, renam->rename, declar->declare. Add 'e' to canonicalize.
    // Guarded against words that should stay bare by only firing for endings that
    // frequently dropped an 'e' before -ing/-ed (a small, deterministic allowlist).
    if (/(?:am|ar|at|iz|ut|os|us|iv|ac|ic|ag|ap|ip|op|ur)$/.test(t)) t = t + "e";
  }
  return t;
}

/** Stem every token in a set, returning a new stemmed set. */
export function stemSet(tokens: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) out.add(stem(t));
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Synonym / concept groups — the bridge between situation verbs and resolution
// nouns. Each group is a set of STEMS that should be treated as the same concept.
// Kept small and domain-grounded (the AgentRecall correction corpus): publishing,
// naming, secrets, approval, agents, products/memory. Adding a group widens
// recall; a too-broad group risks false positives, so groups stay tight.
// ───────────────────────────────────────────────────────────────────────────

const SYNONYM_GROUPS: string[][] = [
  // ship / release / deploy / publish — the most common situation→correction bridge.
  ["publish", "ship", "release", "deploy", "push", "launch", "npm", "version",
    "bump", "registry", "rollout", "roll", "artifact"],
  // naming / rename / identity-of-a-thing.
  ["name", "rename", "naming", "title", "label", "brand", "rebrand", "heading",
    "docs", "readme"],
  // secrets / credentials / keys.
  ["secret", "key", "token", "credential", "api-key", "apikey", "auth",
    "password", "vault"],
  // permission / approval / gating.
  ["approval", "approve", "permission", "permit", "gate", "consent", "confirm",
    "explicit"],
  // agents / models / orchestration (codex/sonnet/opus context).
  ["codex", "sonnet", "opus", "agent", "subagent", "sub-agent", "orchestrate",
    "model", "prompt", "instruction"],
  // customer / user / buyer.
  ["customer", "user", "buyer", "client", "visitor"],
  // memory / understanding / recall (the product itself).
  ["memory", "understand", "recall", "remember", "knowledge", "context"],
  // compliance / safety / risk.
  ["compliance", "compliant", "safety", "safe", "risk", "secure", "security"],
  // build / scratch / reuse.
  ["build", "create", "make", "implement", "scratch", "reuse", "port", "offer",
    "product"],
  // email / contact / inbox.
  ["email", "inbox", "contact", "mail", "alias"],
  // price / cost / margin / economics.
  ["cost", "margin", "price", "pricing", "economics", "spread", "basis", "expose"],
  // config / settings / store / environment.
  ["config", "settings", "store", "environment", "env", "live", "production"],
  // detail / thorough / explicit-text.
  ["detailed", "thorough", "detail", "explicit", "verbose"],
];

/** stem -> canonical concept id (index into SYNONYM_GROUPS). Built once at module load. */
const CONCEPT_OF = new Map<string, number>();
for (let g = 0; g < SYNONYM_GROUPS.length; g++) {
  for (const w of SYNONYM_GROUPS[g]) CONCEPT_OF.set(stem(w), g);
}

/**
 * Canonicalize a stemmed token set into CONCEPT space: every token that belongs
 * to a synonym group is REPLACED by its shared concept token (`__concept_<g>`);
 * tokens with no concept pass through unchanged. Collapsing synonyms onto one
 * shared dimension (rather than appending a marker alongside the surface stems)
 * is what lets "publish package npm" and "ship release registry" overlap
 * meaningfully — both reduce to the same `__concept_0`, so the cosine sees a real
 * shared term instead of a diluted one. That is the semantic bridge.
 */
export function expandConcepts(stems: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const t of stems) {
    const g = CONCEPT_OF.get(t);
    out.add(g !== undefined ? `__concept_${g}` : t);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Cosine similarities
// ───────────────────────────────────────────────────────────────────────────

/** Set-cosine over two token sets (binary term vectors): |A∩B| / sqrt(|A|·|B|). */
export function setCosine(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter++;
  return inter / Math.sqrt(a.size * b.size);
}

/** Character trigrams of a token set's joined text (fuzzy root/near-spelling overlap). */
export function charTrigrams(tokens: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const tok of tokens) {
    const s = `  ${tok} `;
    for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  }
  return out;
}

/**
 * The local semantic similarity in [0,1] between a SITUATION text and a
 * blind-spot's matching MATERIAL (free text: its tendency / example rule and its
 * trigger keywords joined together). Both sides are tokenized with the production
 * grammar, stemmed, and concept-expanded; the score is the MAX of the expanded
 * token-set cosine and the character-trigram cosine. Pure and deterministic.
 *
 * Passing the blind spot's full text (not just its sparse trigger_keywords) is
 * what gives the semantic path material to work with — Loop 3's diagnostic showed
 * trigger_keywords are frequently EMPTY for the predictable cases, so matching on
 * keywords alone reproduces the 0/13. The richer text is the seed rule the
 * correction was about, which DOES carry concept-bearing words.
 *
 * @param situation       free-text plan / lead-in (the situation the agent is in)
 * @param blindSpotText   the blind spot's tendency / example_rule + trigger keywords
 */
export function semanticSimilarity(situation: string, blindSpotText: string): number {
  const sitTokens = tokenize(situation);
  const bsTokens = tokenize(blindSpotText);
  if (sitTokens.size === 0 || bsTokens.size === 0) return 0;

  const sitStem = stemSet(sitTokens);
  const bsStem = stemSet(bsTokens);

  const sitExp = expandConcepts(sitStem);
  const bsExp = expandConcepts(bsStem);

  const tokenCos = setCosine(sitExp, bsExp);
  const triCos = setCosine(charTrigrams(sitStem), charTrigrams(bsStem));

  return Math.max(tokenCos, triCos);
}

/**
 * Build the semantic matching MATERIAL for a blind spot: its concept-bearing
 * tendency / example rule text plus its trigger keywords, joined into one string.
 * Centralizes what "the blind spot's text" means so production code and the LOO
 * harness score the SAME way (no fork — the harness imports this).
 */
export function blindSpotConcepts(bs: {
  tendency?: string;
  example_rule?: string;
  trigger_keywords?: string[];
}): string {
  const parts = [bs.tendency ?? "", bs.example_rule ?? "", ...(bs.trigger_keywords ?? [])];
  return parts.filter(Boolean).join(" ");
}
