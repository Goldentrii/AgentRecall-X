/**
 * embeddings/chunker.ts — fix7: ONE deterministic chunking of the four
 * retrievable tiers, shared byte-identically by the INDEXER (embed + store
 * by content hash) and the QUERY-TIME semantic leg (re-chunk the live,
 * trust-filtered candidates and look their hashes up in the index).
 *
 * THE SHARING IS THE SECURITY MODEL: the index stores ONLY hash→vector — no
 * text, no provenance, no trust bits. At query time the semantic leg never
 * reads content FROM the index; it re-reads the store through the SAME
 * `readTierCandidates`/`filterTrusted` trust chokepoint every lexical tier
 * scorer uses (here in the reader's safe-by-default posture — see
 * chunkProject's doc comment), re-chunks with THIS function, and only then
 * looks up vectors by hash. An untrusted/planted item therefore cannot
 * surface through the semantic leg even if its vector is somehow IN the
 * index (poisoned index file): its candidate never survives the trust
 * filter, so its hash is never looked up — proven by the fix7 adversarial
 * tests.
 *
 * Chunk granularity mirrors each tier's lexical one-vote unit (fix4 C1/C2):
 *   - corrections: one chunk per record (rule + context — the exact
 *     matchText scoreCorrectionsTier scores), id = the record's own id →
 *     a correction found BOTH lexically and semantically accumulates RRF
 *     contributions in applyRRF's per-id map, the multi-evidence behavior
 *     RRF exists for.
 *   - palace: ≤CHUNK_TARGET_CHARS paragraphs per room file, ONE vote per
 *     document (best chunk), id = stableId("palace", "room/file") — same id
 *     the lexical palace tier mints, same accumulation property.
 *   - journal: chunks within each `## section`, ONE vote per (date, section)
 *     — the same granularity smart_recall's perSectionDedupe enforces on
 *     the lexical side. Ids are per-chunk (the lexical journal id embeds
 *     line+excerpt and cannot be reproduced here — documented divergence;
 *     fuseCanonical's excerpt identity still collapses true duplicates).
 *   - insight: one chunk per indexed insight (title + applies_when +
 *     skill_tags), id = stableId("insight", title) — same id as the lexical
 *     insight tier; carries `projects` so the SCOPE stage applies to
 *     semantic insight candidates exactly as it does to lexical ones.
 */

import * as crypto from "node:crypto";
import { readTierCandidates, filterTrusted, type MemoryCandidate } from "../retrieval/candidates.js";
import { stableId } from "../retrieval/query-memory.js";
import { readInsightsIndex } from "../palace/insights-index.js";

export interface EmbeddingChunk {
  /** Raw chunk text — the content-hash basis AND the embed input (the
   *  model's passage prefix is applied at embed time, never hashed). */
  text: string;
  /** sha256 hex of `text` — the index key. Path-independent: identical
   *  content in two files/projects embeds once. */
  hash: string;
  /** Native tier — semantic candidates keep their real source label so
   *  every downstream contract (verbatimKey, fences, display) is unchanged. */
  tier: "journal" | "palace" | "insight" | "corrections";
  /** QueryMemoryItem id this chunk materializes as (see file header for the
   *  per-tier id conventions and which ones accumulate with lexical legs). */
  id: string;
  title: string;
  /** Display excerpt (whitespace-collapsed, ≤400 chars). */
  excerpt: string;
  /** One-doc-one-vote key: best-cosine chunk per docKey wins (fix4 C1's
   *  anti-flooding invariant, applied to the semantic leg from day one). */
  docKey: string;
  room?: string;
  file?: string;
  date?: string;
  line?: number;
  severity?: string;
  /** insight only — scope attribution (applyScope input). */
  projects?: string[];
  /** insight only — fusion identity override, byte-matching
   *  scoreInsightTier's fusionKey so cross-leg dedup works. */
  fusionKey?: string;
}

/** Target/max chars per chunk. 480 chars stays under the 512-token input
 *  cap of the registry's models for both ASCII and Han text. */
const CHUNK_TARGET_CHARS = 480;
/** Chunks shorter than this (after trim) are noise — skipped. */
const MIN_CHUNK_CHARS = 30;
/** Defensive per-candidate cap (pathologically huge files). */
const MAX_CHUNKS_PER_CANDIDATE = 120;
const EXCERPT_CHARS = 400;

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

function toExcerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > EXCERPT_CHARS ? collapsed.slice(0, EXCERPT_CHARS) + "..." : collapsed;
}

/** Greedy line-accumulating splitter: flush when adding the next line would
 *  exceed the target. Deterministic; no lookahead. */
function splitLines(lines: string[], startLine: number): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  let buf: string[] = [];
  let bufStart = startLine;
  let bufLen = 0;
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text.length >= MIN_CHUNK_CHARS) out.push({ text, line: bufStart });
    buf = [];
    bufLen = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (bufLen > 0 && bufLen + line.length + 1 > CHUNK_TARGET_CHARS) flush();
    if (buf.length === 0) bufStart = startLine + i;
    buf.push(line.length > CHUNK_TARGET_CHARS ? line.slice(0, CHUNK_TARGET_CHARS) : line);
    bufLen += Math.min(line.length, CHUNK_TARGET_CHARS) + 1;
  }
  flush();
  return out;
}

function chunkCorrections(candidates: MemoryCandidate[]): EmbeddingChunk[] {
  const out: EmbeddingChunk[] = [];
  for (const candidate of candidates) {
    const meta = candidate.meta ?? {};
    const context = meta.context ?? "";
    // Exactly scoreCorrectionsTier's matchText — the semantic leg scores the
    // same text surface the lexical corrections tier scores.
    const matchText = context ? `${candidate.content}\n${context}` : candidate.content;
    const text = matchText.length > 2000 ? matchText.slice(0, 2000) : matchText;
    if (text.trim().length < MIN_CHUNK_CHARS) continue;
    const id = meta.correction_id || candidate.file.replace(/\.json$/, "");
    out.push({
      text,
      hash: sha256(text),
      tier: "corrections",
      id,
      // Same title/excerpt conventions as scoreCorrectionsTier (truncate 300 /
      // truncate-to-excerpt) so a semantic-only surfaced correction renders
      // indistinguishably from a lexically surfaced one.
      title: candidate.content.length > 300 ? candidate.content.slice(0, 300) + "..." : candidate.content,
      excerpt: matchText.length > 300 ? matchText.slice(0, 300) + "..." : matchText,
      docKey: `corrections/${id}`,
      date: candidate.date || undefined,
      severity: meta.severity,
    });
  }
  return out;
}

function chunkPalace(candidates: MemoryCandidate[]): EmbeddingChunk[] {
  const out: EmbeddingChunk[] = [];
  for (const candidate of candidates) {
    const room = candidate.room ?? "";
    const file = candidate.file.replace(/\.md$/, "");
    const title = `${room}/${file}`;
    const pieces = splitLines(candidate.content.split("\n"), 1).slice(0, MAX_CHUNKS_PER_CANDIDATE);
    for (const piece of pieces) {
      out.push({
        text: piece.text,
        hash: sha256(piece.text),
        tier: "palace",
        // SAME id as the lexical palace tier (stableId("palace", room/file))
        // — one-doc-one-vote holds ACROSS legs: applyRRF folds a doc found
        // both ways into one entry with summed contributions.
        id: stableId("palace", title),
        title,
        excerpt: toExcerpt(piece.text),
        docKey: `palace/${title}`,
        room,
        file,
        date: candidate.date || undefined,
        line: piece.line,
      });
    }
  }
  return out;
}

function chunkJournal(candidates: MemoryCandidate[]): EmbeddingChunk[] {
  const out: EmbeddingChunk[] = [];
  for (const candidate of candidates) {
    const date = candidate.date || candidate.file;
    const lines = candidate.content.split("\n");
    // Section walk mirrors scoreJournalTier's exactly (same "top" default,
    // same lowercase/underscore normalization) so titles — and therefore the
    // per-(date,section) vote key — match the lexical journal tier's.
    let currentSection = "top";
    let sectionLines: string[] = [];
    let sectionStart = 1;
    const chunks: EmbeddingChunk[] = [];
    const flushSection = () => {
      if (sectionLines.length === 0) return;
      const title = `${date} / ${currentSection}`;
      for (const piece of splitLines(sectionLines, sectionStart)) {
        chunks.push({
          text: piece.text,
          hash: sha256(piece.text),
          tier: "journal",
          // Per-chunk id (hash-derived): the lexical journal id embeds
          // line+excerpt and cannot be reproduced here — see file header.
          id: stableId("journal", `${title}::sem::${sha256(piece.text).slice(0, 16)}`),
          title,
          excerpt: toExcerpt(piece.text),
          docKey: `journal/${title}`,
          date,
          line: piece.line,
        });
      }
      sectionLines = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("## ")) {
        flushSection();
        currentSection = line.slice(3).trim().toLowerCase().replace(/\s+/g, "_");
        sectionStart = i + 2;
        continue;
      }
      if (sectionLines.length === 0) sectionStart = i + 1;
      sectionLines.push(line);
    }
    flushSection();
    out.push(...chunks.slice(0, MAX_CHUNKS_PER_CANDIDATE));
  }
  return out;
}

function chunkInsights(): EmbeddingChunk[] {
  const out: EmbeddingChunk[] = [];
  const index = readInsightsIndex();
  for (const insight of index.insights) {
    const applies = (insight.applies_when ?? []).join(", ");
    const tags = (insight.skill_tags ?? []).join(", ");
    const text = `${insight.title}. ${applies}${tags ? ` (${tags})` : ""}`.trim();
    if (text.length < MIN_CHUNK_CHARS) continue;
    // Excerpt + fusionKey byte-match scoreInsightTier's, so fuseCanonical
    // collapses a semantic insight hit with its lexical twin.
    const rawExcerpt = `[${insight.severity}] ${applies}`;
    const fusionSeed = `${insight.title} ${rawExcerpt}`;
    out.push({
      text,
      hash: sha256(text),
      tier: "insight",
      id: stableId("insight", insight.title),
      title: insight.title,
      excerpt: rawExcerpt.length > 300 ? rawExcerpt.slice(0, 300) + "..." : rawExcerpt,
      fusionKey: fusionSeed.length > 300 ? fusionSeed.slice(0, 300) + "..." : fusionSeed,
      docKey: `insight/${insight.title}`,
      severity: insight.severity,
      projects: insight.projects,
    });
  }
  return out;
}

export interface ChunkProjectOpts {
  /** palace: restrict to one room (mirrors QueryMemoryInput.palace.room). */
  room?: string;
  /** journal: include rollup archive (default true — matches
   *  scoreJournalTier's own default). Raw archive is NEVER included: it is
   *  not a competing tier (see queryArchiveFallback's contract). */
  includeRollupArchive?: boolean;
  /** Skip the global insights tier (indexer passes insights separately so
   *  they are not re-chunked once per project). */
  skipInsights?: boolean;
}

/**
 * Chunk one project's retrievable, TRUST-FILTERED texts.
 *
 * Reads through `readTierCandidates` in its SAFE-BY-DEFAULT posture (no
 * `includeUntrusted` opt-in — that escape hatch is sanctioned, and
 * harness-enforced by identity-trust-completeness.test.mjs, for
 * queryMemory()'s own mandatory trust-filter stage ONLY), so every
 * untrusted candidate is dropped by the reader itself via the canonical
 * `filterTrusted`. The explicit `filterTrusted` wrap below is defense in
 * depth (idempotent) and documents that this boundary is load-bearing for
 * the semantic leg's security model (see this file's header).
 *
 * Deliberately NOT covered (documented scope, fix7): the legacy journal
 * root (`~/.claude/projects/...` — query-memory.ts-private reader, rare
 * surface) and the raw hook-archive tier (never a competing source). Both
 * remain lexically reachable exactly as before.
 */
export function chunkProject(project: string, opts: ChunkProjectOpts = {}): EmbeddingChunk[] {
  const out: EmbeddingChunk[] = [];
  out.push(
    ...chunkCorrections(
      filterTrusted(readTierCandidates("corrections", project, {})),
    ),
  );
  out.push(
    ...chunkPalace(
      filterTrusted(readTierCandidates("palace-room", project, { room: opts.room })),
    ),
  );
  out.push(
    ...chunkJournal(
      filterTrusted(readTierCandidates("journal", project, {
        includeRollupArchive: opts.includeRollupArchive ?? true,
      })),
    ),
  );
  if (!opts.skipInsights) out.push(...chunkInsights());
  return out;
}

/** Chunk ONLY the global insights index (indexer helper). */
export function chunkGlobalInsights(): EmbeddingChunk[] {
  return chunkInsights();
}
