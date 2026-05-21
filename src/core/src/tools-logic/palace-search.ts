import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProject } from "../storage/project.js";
import { palaceDir } from "../storage/paths.js";
import { ensurePalaceInitialized, listRooms, recordAccess } from "../palace/rooms.js";
import { stem, expandQuery } from "../helpers/normalize.js";

export interface PalaceSearchInput {
  query: string;
  room?: string;
  project?: string;
  limit?: number;
}

export interface PalaceSearchResult {
  project: string;
  query: string;
  results: Array<{
    room: string;
    file: string;
    salience: number;
    excerpt: string;
    line: number;
    /** Keyword overlap ratio [0,1]. Added in v3.3.14 — used by smart-recall for RRF internal scoring. */
    keyword_score: number;
  }>;
  total_matches: number;
}

/**
 * Parse YAML frontmatter tags from markdown content.
 * Looks for `tags: [...]` line between `---` markers.
 */
function parseFrontmatterTags(content: string): string[] {
  // Find the YAML block between --- markers
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return [];

  const yamlBlock = match[1];
  const tagsLine = yamlBlock.split("\n").find((l) => l.trim().startsWith("tags:"));
  if (!tagsLine) return [];

  // Parse inline array: tags: ["foo", "bar"] or tags: [foo, bar]
  const arrayMatch = tagsLine.match(/tags:\s*\[([^\]]*)\]/);
  if (!arrayMatch) return [];

  return arrayMatch[1]
    .split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, ""))
    .filter((t) => t.length > 0);
}

export async function palaceSearch(input: PalaceSearchInput): Promise<PalaceSearchResult> {
  const slug = await resolveProject(input.project);
  ensurePalaceInitialized(slug);

  const rooms = listRooms(slug);
  const pd = palaceDir(slug);
  // v3.3.14: use keyword overlap instead of exact substring match.
  // Old approach: lines[i].toLowerCase().includes(fullQuery) required the entire
  // query to appear as one continuous substring — too strict, missed relevant entries.
  // New approach: count matched keywords, compute overlap ratio for scoring.
  // v3.3.21: use stemming + synonym expansion for query words
  const rawQueryWords = input.query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);

  // Fix RC1: project-scope keyword inflation.
  // When searching within a project, every file contains the project name —
  // it adds zero discriminating signal. Strip the project slug and its
  // normalized variants (lowercase, no hyphens/spaces) from query words so
  // they don't boost files that merely mention the project name.
  const projectVariants = new Set<string>();
  if (input.project) {
    const base = input.project.toLowerCase();
    projectVariants.add(base);                        // "agentrecall"
    projectVariants.add(base.replace(/[-_\s]+/g, "")); // "agentrecall" (remove separators)
    projectVariants.add(stem(base));                  // stemmed form
    for (const part of base.split(/[-_\s]+/)) {
      if (part.length > 2) {
        projectVariants.add(part);
        projectVariants.add(stem(part));
      }
    }
  }

  const filteredRawQueryWords = rawQueryWords.filter((w) => !projectVariants.has(w) && !projectVariants.has(stem(w)));
  const queryWords = expandQuery(filteredRawQueryWords);
  const results: PalaceSearchResult["results"] = [];

  const targetRooms = input.room ? rooms.filter((r) => r.slug === input.room) : rooms;

  for (const roomMeta of targetRooms) {
    const roomPath = path.join(pd, "rooms", roomMeta.slug);
    if (!fs.existsSync(roomPath)) continue;

    const files = fs.readdirSync(roomPath).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const filePath = path.join(roomPath, file);
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      // Parse YAML frontmatter tags for bonus scoring
      const fileTags = parseFrontmatterTags(content);

      // Check if any query words match file-level tags.
      // Reduced from 0.3 to 0.10: a flat +0.3 tag bonus bypassed IDF entirely and
      // caused files whose only match was a generic tag (e.g. "deployment") to rank
      // above files with genuine content matches. 0.10 preserves the signal without
      // overriding IDF-based content scoring.
      const tagBonus = queryWords.some((w) =>
        fileTags.some((t) => t.toLowerCase().includes(w) || w.includes(t.toLowerCase()))
      ) ? 0.10 : 0;

      for (let i = 0; i < lines.length; i++) {
        const lineLower = lines[i].toLowerCase();
        if (queryWords.length === 0) continue;
        // Skip pure markdown headings (## Memories, # Room, etc.) — structural, not content
        if (/^#{1,6}\s/.test(lines[i])) continue;

        // Stem each line word for matching
        const lineWords = lineLower.split(/\s+/).filter(w => w.length > 2).map(w => stem(w));
        const lineWordSet = new Set(lineWords);

        // Count how many query keywords match (stemmed OR substring)
        const matchedWords = queryWords.filter((w) => lineWordSet.has(w) || lineLower.includes(w));
        if (matchedWords.length === 0) continue;

        const rawKeywordScore = matchedWords.length / queryWords.length;
        const keywordScore = Math.min(1.0, rawKeywordScore + tagBonus);

        // Build excerpt anchored on first keyword match
        const firstKw = matchedWords[0];
        const matchIdx = lineLower.indexOf(firstKw);
        const start = Math.max(0, matchIdx - 40);
        const end = Math.min(lines[i].length, matchIdx + firstKw.length + 80);
        let excerpt = lines[i].slice(start, end).trim();
        if (start > 0) excerpt = "..." + excerpt;
        if (end < lines[i].length) excerpt = excerpt + "...";

        results.push({
          room: roomMeta.slug,
          file: file.replace(".md", ""),
          salience: roomMeta.salience,
          excerpt,
          line: i + 1,
          keyword_score: keywordScore,
        });
      }
    }

    if (results.some((r) => r.room === roomMeta.slug)) {
      recordAccess(slug, roomMeta.slug);
    }
  }

  // Fix RC3: IDF (inverse document frequency) re-scoring.
  // Pure TF (keyword overlap ratio) treats "agentrecall" the same as "rrf-scoring"
  // even though the former appears in every file. IDF penalises keywords that appear
  // in many documents so rare, specific terms drive ranking.
  //
  // We use a lightweight file-level doc-frequency map built from the results we
  // already collected (no second filesystem pass needed).
  //
  // IDF formula: log(1 + totalDocs / (docFreq + 1))  — smoothed log-IDF.
  // A keyword in all docs → IDF ≈ log(1) = 0 (no contribution).
  // A keyword in 1 of 100 docs → IDF ≈ log(101) ≈ 4.6 (strong signal).
  // We then normalise the IDF weights so they scale between 0 and 1.
  if (results.length > 0) {
    // Count distinct files each queryWord appears in
    const totalDocs = new Set(results.map((r) => `${r.room}/${r.file}`)).size;
    const docFreq = new Map<string, Set<string>>();

    for (const r of results) {
      const docId = `${r.room}/${r.file}`;
      const combined = (r.excerpt + " " + r.room + " " + r.file).toLowerCase();
      for (const w of queryWords) {
        if (combined.includes(w)) {
          if (!docFreq.has(w)) docFreq.set(w, new Set());
          docFreq.get(w)!.add(docId);
        }
      }
    }

    // Compute IDF per keyword, normalise to [0,1]
    const idfRaw = new Map<string, number>();
    for (const w of queryWords) {
      const df = docFreq.get(w)?.size ?? 0;
      idfRaw.set(w, Math.log(1 + totalDocs / (df + 1)));
    }
    const maxIdf = Math.max(1, ...Array.from(idfRaw.values()));
    const idf = new Map<string, number>();
    for (const [w, v] of idfRaw) idf.set(w, v / maxIdf);

    // Re-score: replace raw keyword_score with IDF-weighted version.
    // keyword_score already contains tagBonus; we blend 70% IDF-weighted + 30% raw
    // so files with many matching rare terms beat files with one ubiquitous term.
    for (const r of results) {
      const combined = (r.excerpt + " " + r.room + " " + r.file).toLowerCase();
      const matchedIdfWords = queryWords.filter((w) => combined.includes(w));
      if (matchedIdfWords.length === 0) continue;

      const idfWeightedScore = matchedIdfWords.reduce((sum, w) => sum + (idf.get(w) ?? 0), 0)
        / queryWords.length;

      // Blend: 70% IDF-weighted, 30% original ratio (preserves tagBonus signal)
      r.keyword_score = Math.min(1.0, idfWeightedScore * 0.70 + r.keyword_score * 0.30);
    }
  }

  // Sort by keyword_score × salience so most relevant + important rooms surface first
  results.sort((a, b) => (b.keyword_score * b.salience) - (a.keyword_score * a.salience) || a.line - b.line);
  const limited = results.slice(0, input.limit ?? 20);

  return { project: slug, query: input.query, results: limited, total_matches: results.length };
}
