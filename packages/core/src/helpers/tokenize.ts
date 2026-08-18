/**
 * Shared CJK-aware tokenizer — SINGLE SOURCE OF TRUTH for every recall/search
 * tokenization site in this package (class-not-instance fix).
 *
 * Extracted from `tools-logic/check-action.ts` (CJK fix, 2026-07-25,
 * audit-cjk-check-action.test.mjs) — that file was the ONLY tokenizer in the
 * codebase that correctly handled Chinese/Japanese text. Every other
 * recall/search site (palace_search, journal_search, smart_recall,
 * recall_insight, skill_recall, resurrect) independently reimplemented the
 * SAME broken grammar: `str.split(/\s+/).filter(w => w.length > N)` —
 * whitespace-only splitting. Since Chinese/Japanese is written with no
 * spaces between words, an unspaced CJK sentence becomes ONE giant token
 * that must match another giant token byte-for-byte to register any overlap
 * — this is the root cause behind the 2026-08-18 L1 retrieval eval's
 * CJK hit@5 = 0/6 (see reports/2026-08-18-eval-L1-retrieval.md §4).
 *
 * check-action.ts's fix — script-detect Han runs (`\p{Script=Han}`), segment
 * them with `Intl.Segmenter` (falling back to character bigrams when
 * unavailable), and give them their own no-length-floor path separate from
 * the Latin/ASCII path — is the ONLY correct implementation. This module
 * is that implementation, generalized so every call site can share it
 * instead of forking it again.
 */

// Detects/extracts Han-script runs (Chinese hanzi, and CJK-shared Kanji/Hanja).
// `\p{Script=Han}` needs the `u` flag; both are widely supported (Node >=18,
// this package's floor per root package.json "engines").
export const HAN_CHAR_RE = /\p{Script=Han}/u;
export const HAN_RUN_RE = /\p{Script=Han}+/gu;

// Feature-detected once at module load. Node >=18 (this project's engines
// floor) ships Intl.Segmenter unconditionally, but we still feature-detect
// defensively rather than assume every runtime that imports this module is
// Node >=18 — falls back to a deterministic character-bigram scheme below.
let cjkSegmenter: Intl.Segmenter | undefined;
try {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    cjkSegmenter = new Intl.Segmenter("zh", { granularity: "word" });
  }
} catch {
  cjkSegmenter = undefined;
}

/**
 * Deterministic fallback for runtimes without `Intl.Segmenter` (defensive
 * only — Node >=18 always has it). Character bigrams approximate word-level
 * CJK tokens well enough for overlap matching without a dictionary; a lone
 * single-character run still yields a one-character token so it is never
 * silently dropped.
 */
function bigramFallback(run: string): string[] {
  const chars = Array.from(run); // code-point aware (avoids UTF-16 surrogate splits)
  if (chars.length <= 1) return chars;
  const out: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
  return out;
}

/** Segments one Han-script run into word-level (or bigram-fallback) tokens. */
function segmentHanRun(run: string): string[] {
  if (cjkSegmenter) {
    const out: string[] = [];
    for (const seg of cjkSegmenter.segment(run)) {
      // isWordLike is only meaningful with granularity:"word"; pure Han runs
      // (already isolated by HAN_RUN_RE below) should all be word-like, but
      // the check + HAN_CHAR_RE test are defense-in-depth against a segmenter
      // ever handing back a stray non-ideograph segment.
      if (seg.isWordLike !== false && HAN_CHAR_RE.test(seg.segment)) {
        out.push(seg.segment);
      }
    }
    return out;
  }
  return bigramFallback(run);
}

export interface TokenizeOptions {
  /**
   * Minimum length for non-Han (ASCII/Latin) tokens. Han (CJK) tokens are
   * NEVER length-filtered — most meaningful Chinese/Japanese words are 1-3
   * CHARACTERS (发布, 确认, 删除, 不要); applying an English-tuned length
   * floor to them would silently drop ordinary short CJK content right back
   * to empty (this is the "Layer 2" bug check-action.ts's fix history
   * documents — see its `tokenize()` doc comment). Default 3 (equivalent to
   * every pre-fix call site's `w.length > 2`).
   */
  minLength?: number;
  /**
   * Stopwords excluded from the non-Han token stream ONLY — Han tokens are
   * never stopword-filtered (STOPWORDS lists are English word lists).
   * Default: none (most pre-fix call sites had no stopword filtering at
   * all; only check-action.ts did).
   */
  stopwords?: ReadonlySet<string>;
  /**
   * When provided, the non-Han remainder is NFKD-normalized then has every
   * character NOT matched by this pattern's *complement* replaced with a
   * space before splitting — e.g. `/[^a-z0-9\s-]+/g` (check-action.ts's
   * original grammar) strips punctuation/accents while preserving hyphens.
   * Omit to preserve a call site's original "just lowercase and split on
   * whitespace" behavior EXACTLY (this is the default for every site except
   * check-action.ts and skills.ts, which had their own punctuation-strip
   * step pre-fix and must keep it byte-identical).
   */
  asciiStripRegex?: RegExp;
}

/**
 * Tokenize a string into content words, CJK-aware.
 *
 * Returns an ORDERED array (Han-script tokens first, in the order their runs
 * appear in the source string, followed by ASCII/Latin tokens in original
 * order; both may contain duplicates — callers that want a deduplicated
 * token set should use `tokenize()` below or wrap in `new Set(...)`
 * themselves). Preserving order/duplicates matters for call sites that
 * anchor an excerpt on "the first keyword match" or otherwise care about
 * position — a Set would silently discard that.
 *
 * ASCII-only input is BYTE-IDENTICAL to `s.toLowerCase().split(/\s+/)`
 * (optionally further stripped via `asciiStripRegex`) — `HAN_RUN_RE` never
 * matches, so the "drop Han runs first" step below is a no-op, and NFKC
 * normalization of already-composed ASCII text is also a no-op. This is
 * the ASCII no-regression guarantee every retrieval site depends on.
 */
export function tokenizeWords(s: string, opts: TokenizeOptions = {}): string[] {
  const { minLength = 3, stopwords, asciiStripRegex } = opts;

  // NFKC first (compose full-width/compatibility forms — e.g. fullwidth
  // Latin, CJK compatibility ideographs — into their canonical form). This
  // is a no-op on already-composed ASCII text.
  const normalized = s.normalize("NFKC");

  const out: string[] = [];

  // --- CJK path: extract Han-script runs and segment them independently of
  // the ASCII path (which would otherwise erase every Han character, or —
  // for call sites with no punctuation-strip step — let raw unsegmented Han
  // characters leak through as pseudo-ASCII "tokens"). ---
  const hanRuns = normalized.match(HAN_RUN_RE);
  if (hanRuns) {
    for (const run of hanRuns) {
      for (const tok of segmentHanRun(run)) out.push(tok);
    }
  }

  // --- ASCII/Latin path ---
  // Always drop Han runs from the remainder FIRST so they can never leak
  // through unsegmented as pseudo-ASCII tokens (they were already tokenized
  // above) or get double-counted. For pure-ASCII input this is a no-op.
  let rest = normalized.replace(HAN_RUN_RE, " ").toLowerCase();
  if (asciiStripRegex) {
    rest = rest.normalize("NFKD").replace(asciiStripRegex, " ");
  }

  const asciiTokens = rest
    .split(/\s+/)
    // `w.length > 0` guards independently of `minLength` (even minLength:0,
    // used by call sites that had NO length floor pre-fix): stripping Han
    // runs to a single space before splitting can produce boundary empty
    // strings (`" ".split(/\s+/)` === `["", ""]`) for input that is ENTIRELY
    // Han script — a bare empty-string "token" would match EVERY candidate
    // via `.includes("")` at every consuming site, silently turning "no
    // length floor for CJK" into "any all-CJK keyword matches everything".
    // No pre-fix call site's `.split(/\s+/)` relied on emitting genuinely
    // empty tokens either — they only ever appeared from pathological
    // leading/trailing whitespace in the ORIGINAL string, never as a
    // deliberate feature — so this guard costs no real ASCII behavior.
    .filter((w) => w.length > 0 && w.length >= minLength && !(stopwords?.has(w)));
  out.push(...asciiTokens);

  return out;
}

/** Set-returning convenience wrapper over `tokenizeWords` (dedup, no order). */
export function tokenize(s: string, opts?: TokenizeOptions): Set<string> {
  return new Set(tokenizeWords(s, opts));
}
