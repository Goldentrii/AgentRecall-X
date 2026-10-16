/**
 * retrieval/lexical-index.ts — persistent, incremental lexical index for the
 * journal tier (perf/lexical-index, 2026-10-16; reports/2026-10-15-rigorous-
 * eval.md scale finding: 10k journal entries → recall p50 ~1.0-1.3 s, because
 * `scoreJournalTier` re-reads and re-tokenizes the WHOLE corpus on every
 * query — 10k `readFileSync`s + trust-tagging in the fetch stage alone
 * measured ~1.2 s warm on win32; the full-corpus IDF tokenization adds
 * another ~190 ms).
 *
 * WHAT IT STORES — per journal file, keyed by absolute path and validated by
 * (size, mtimeNs): the DERIVED, query-independent data the journal scorer
 * needs before it has to touch file content:
 *   - `u`  — the rescue-quarantine trust bit (isRescueSourcedContent), so the
 *            trust FILTER no longer requires reading every file per query;
 *   - `t`  — the file's unique stemmed token set (tokenizeWords + stem, the
 *            exact inputs `buildIdfModel`'s per-doc `tokenSet` is built from);
 *   - `r`  — the file's unique lowercase whitespace-run set. Because every
 *            query keyword/variant is whitespace-free (tokenizeWords output),
 *            `content.toLowerCase().includes(term)` ⟺ some run contains
 *            `term` as a substring — this makes BOTH the per-line
 *            `lineMatchesQuery` prefilter AND `buildIdfModel`'s
 *            `d.lower.includes(v)` DF predicate answerable from the index
 *            with zero false negatives (a false POSITIVE only costs one
 *            file read that then produces no hits).
 * Terms are stored once in a shared `vocab` table; docs reference vocab ids.
 *
 * WHAT IT NEVER STORES — file content, excerpts, scores, or anything
 * query-dependent. Line-level hit generation still reads the real file (only
 * for docs the prefilter says CAN match), so a stale/poisoned index can skew
 * ranking weights but cannot fabricate content. Contents ARE cached
 * IN-PROCESS (per (size, mtimeNs), pruned to the enumerated file set on each
 * drift) — a long-lived MCP server holds roughly one copy of the project's
 * journal text in RAM, the same order of memory the brute-force path already
 * allocated transiently on EVERY query.
 *
 * TRUST (security): the cached `u` bit is an OPTIMIZATION, not the trust
 * boundary. Every content read performed through this module re-runs
 * `isRescueSourcedContent` on the bytes actually read (`trustedContent`
 * below) and refuses to return rescue-tagged content — so a hand-poisoned
 * index file (or the accepted same-(size,mtime)-different-content staleness
 * window, same class the embedding index-store documents) can never SURFACE
 * quarantined content; at worst it perturbs IDF document-frequency counts
 * for files that are never read. An attacker who can write this index file
 * lives inside the AgentRecall root and could already edit the journal
 * files/frontmatter themselves — no new privilege is created (same residual
 * class as storage/corrections.ts's planted-file note).
 *
 * INVALIDATION — every snapshot load re-enumerates the journal directories
 * (listJournalFiles + the same archive readdir/filter the Wave-1 reader
 * uses) and re-stats every enumerated file (bigint mtimeNs + size). A file
 * created, deleted, or edited OUTSIDE the tool is therefore picked up on the
 * very next query — there is no write-path hook to forget, and no TTL
 * window. Stale/missing entries are re-read and re-derived inline (the
 * incremental update), and the refreshed index is persisted.
 *
 * WRITES follow the embeddings/index-store.ts conventions: full payload
 * built first, then written under `withLock("lexical-index-<project>")` via
 * tmp+rename (writeJsonAtomic) — lock-free readers never observe a torn
 * file; concurrent refreshes serialize. READS are lock-free and
 * corruption-TOLERANT: any structural problem (truncated JSON from a killed
 * writer's half-flushed tmp, garbage bytes, wrong version, malformed doc
 * rows) degrades to "entry missing" → re-derive from the real files →
 * rewrite. The recall path never throws from here (`loadJournalLexicalSnapshot`
 * returns null on any unexpected failure, and scoreJournalTier falls back to
 * the brute-force path).
 *
 * EQUIVALENCE — the consumer (query-memory.ts's scoreJournalTier) is built
 * so the indexed path produces IDENTICAL rankings to the brute-force path:
 * same candidate enumeration order (listJournalFiles live half; the same
 * archive filter + date-desc stable sort as candidates.ts's rollup half),
 * same trust filter, same line-scan code on the same content, and an IDF
 * model assembled from index-derived DF counts that match buildIdfModel's
 * predicate exactly (see the `r`/`t` notes above). Pinned by
 * test/lexical-index.test.mjs's brute-vs-indexed deep-equality suite. The
 * ONE documented divergence: a file deleted between this module's stat sweep
 * and a (failed) content read stays counted in the IDF corpus size for that
 * query, where brute force would have dropped it at fetch — a transient,
 * mid-query-mutation-only window.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { projectSubPath, journalDir } from "../storage/paths.js";
import { listJournalFiles } from "../helpers/journal-files.js";
import { isRescueSourcedContent } from "../helpers/journal-filter.js";
import { tokenizeWords } from "../helpers/tokenize.js";
import { stem } from "../helpers/normalize.js";
import { withLock } from "../storage/filelock.js";
import { writeJsonAtomic } from "../storage/fs-utils.js";

const INDEX_VERSION = 1;
const INDEX_FILENAME = "lexical-journal-v1.json";

/** Kill switch / test oracle toggle — default ON; "0"/"false"/"off" disables. */
export function lexicalIndexEnabled(): boolean {
  const v = (process.env.AGENT_RECALL_LEXICAL_INDEX ?? "").toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

/** The index file's on-disk location — built via projectSubPath so the
 *  sanitize + assertInsideRoot guards apply exactly once, like every other
 *  project-scoped path in this package. */
export function lexicalJournalIndexPath(project: string): string {
  return projectSubPath(project, "index", INDEX_FILENAME);
}

// ---------------------------------------------------------------------------
// Persisted format
// ---------------------------------------------------------------------------

interface PersistedDoc {
  /** Absolute source path (a root move ⇒ one-time full re-derive, by design). */
  k: string;
  /** Size in bytes (validation key, with `m`). */
  s: number;
  /** mtimeNs as a decimal string (bigint doesn't survive JSON). */
  m: string;
  /** 1 = rescue-quarantined (cached isRescueSourcedContent; see TRUST above). */
  u: 0 | 1;
  /** Unique lowercase whitespace-run vocab ids. */
  r: number[];
  /** Unique stemmed-token vocab ids. */
  t: number[];
}

interface PersistedIndex {
  version: number;
  builtAt: string;
  vocab: string[];
  docs: PersistedDoc[];
}

// ---------------------------------------------------------------------------
// In-process state (per index path — root/project scoped by construction)
// ---------------------------------------------------------------------------

interface DocEntry {
  s: number;
  m: bigint;
  u: boolean;
  runs: string[];
  stems: string[];
}

interface ScannedFile {
  path: string;
  file: string;
  date: string;
  s: number;
  m: bigint;
}

interface ProjectState {
  /** Derived per-file data, validated by (s, m) at every use. */
  entries: Map<string, DocEntry>;
  /** Lazily-read file contents, validated by (s, m) at every use. */
  contents: Map<string, { s: number; m: bigint; c: string }>;
  /** Last built snapshot + the exact (path,s,m) enumeration it was built from. */
  snap?: { includeRollupArchive: boolean; scanned: ScannedFile[]; snapshot: LexicalJournalSnapshot };
}

const states = new Map<string, ProjectState>();

/** Reset all in-process caches (tests — simulates a fresh process). */
export function resetLexicalIndexCaches(): void {
  states.clear();
}

// ---------------------------------------------------------------------------
// Snapshot — what the journal scorer consumes
// ---------------------------------------------------------------------------

export interface LexicalSnapshotDoc {
  /** Filename date prefix for live/archive docs; "" when undeterminable (same semantics as MemoryCandidate.date for the journal tier). */
  date: string;
  /** Basename. */
  file: string;
  /** Absolute path. */
  path: string;
  /** Cached rescue-quarantine bit (content reads re-verify; see module header). */
  untrusted: boolean;
}

export interface LexicalJournalSnapshot {
  /** Docs in the EXACT order the brute-force journal fetch would produce
   *  (live half via listJournalFiles' own date-desc order, then the rollup-
   *  archive half date-desc) — hit-generation order, and therefore stable-
   *  sort tie-breaks, match brute force by construction. */
  docs: ReadonlyArray<LexicalSnapshotDoc>;
  /** Indices of docs whose lowercase content contains `term` as a substring
   *  (term must be whitespace-free — every tokenizeWords/expandQuery output
   *  is). Includes untrusted docs; callers filter. Memoized per snapshot. */
  docsContaining(term: string): ReadonlySet<number>;
  /** Indices of docs whose stemmed token set contains `term` exactly. */
  docsWithStemToken(term: string): ReadonlySet<number>;
  /** The doc's content, re-verified through the rescue-quarantine choke at
   *  read time — returns null for unreadable files AND for content that is
   *  rescue-tagged on the actual bytes read (whatever the cached bit says). */
  trustedContent(i: number): string | null;
}

/** Derive the query-independent term data for one file's content.
 *  MUST stay byte-aligned with query-memory.ts's brute-force predicates:
 *  runs ⇒ `content.toLowerCase().includes(term)` for whitespace-free terms;
 *  stems ⇒ `new Set(tokenizeWords(content).map(stem))`. */
function deriveTerms(content: string): { runs: string[]; stems: string[] } {
  const runSet = new Set<string>();
  for (const r of content.toLowerCase().split(/\s+/)) {
    if (r.length > 0) runSet.add(r);
  }
  const stemSet = new Set<string>();
  for (const t of tokenizeWords(content)) stemSet.add(stem(t));
  return { runs: [...runSet], stems: [...stemSet] };
}

/** Parse + validate a persisted index into an entries map. Any structural
 *  problem (garbage, truncation, wrong version, malformed row) degrades to
 *  "fewer cached entries" — never throws, never trusts shape. */
function loadPersistedEntries(indexPath: string): Map<string, DocEntry> {
  const entries = new Map<string, DocEntry>();
  let raw: string;
  try {
    raw = fs.readFileSync(indexPath, "utf-8");
  } catch {
    return entries; // missing — first run
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return entries; // corrupt/truncated — rebuild from files
  }
  const idx = parsed as Partial<PersistedIndex>;
  if (!idx || idx.version !== INDEX_VERSION || !Array.isArray(idx.vocab) || !Array.isArray(idx.docs)) {
    return entries;
  }
  const vocab = idx.vocab;
  const term = (id: unknown): string | null =>
    typeof id === "number" && Number.isInteger(id) && id >= 0 && id < vocab.length && typeof vocab[id] === "string"
      ? vocab[id]
      : null;
  for (const d of idx.docs) {
    if (!d || typeof d.k !== "string" || typeof d.s !== "number" || !Number.isFinite(d.s)) continue;
    if (typeof d.m !== "string" || !/^\d+$/.test(d.m)) continue;
    if ((d.u !== 0 && d.u !== 1) || !Array.isArray(d.r) || !Array.isArray(d.t)) continue;
    const runs: string[] = [];
    const stems: string[] = [];
    let ok = true;
    for (const id of d.r) {
      const t = term(id);
      if (t === null) { ok = false; break; }
      runs.push(t);
    }
    if (!ok) continue;
    for (const id of d.t) {
      const t = term(id);
      if (t === null) { ok = false; break; }
      stems.push(t);
    }
    if (!ok) continue;
    entries.set(d.k, { s: d.s, m: BigInt(d.m), u: d.u === 1, runs, stems });
  }
  return entries;
}

/** Serialize entries (vocab-table form) and persist atomically under the
 *  project's own lock. Best-effort: the index is a cache — a failed persist
 *  must never fail the query that triggered it. */
async function persistEntries(project: string, indexPath: string, entries: Map<string, DocEntry>): Promise<void> {
  const vocab: string[] = [];
  const idByTerm = new Map<string, number>();
  const idOf = (t: string): number => {
    let id = idByTerm.get(t);
    if (id === undefined) {
      id = vocab.length;
      vocab.push(t);
      idByTerm.set(t, id);
    }
    return id;
  };
  const docs: PersistedDoc[] = [];
  for (const [k, e] of entries) {
    docs.push({
      k,
      s: e.s,
      m: e.m.toString(),
      u: e.u ? 1 : 0,
      r: e.runs.map(idOf),
      t: e.stems.map(idOf),
    });
  }
  const payload: PersistedIndex = { version: INDEX_VERSION, builtAt: new Date().toISOString(), vocab, docs };
  try {
    await withLock(`lexical-index-${project}`, () => {
      writeJsonAtomic(indexPath, payload);
    });
  } catch {
    // Lock contention / fs failure — skip; next drifted query retries.
  }
}

/** Same-enumeration check against the cached snapshot (cheap elementwise
 *  compare of the freshly-statted (path, size, mtimeNs) triples). */
function sameScan(a: ScannedFile[], b: ScannedFile[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].path !== b[i].path || a[i].s !== b[i].s || a[i].m !== b[i].m) return false;
  }
  return true;
}

/**
 * Load (building/refreshing as needed) the lexical snapshot for a project's
 * journal tier. Returns null when the index is disabled or anything
 * unexpected fails — the caller falls back to the brute-force path.
 *
 * Per-call work when nothing changed: one readdir pass per journal dir +
 * one statSync per enumerated file (the external-edit detection the module
 * header documents — ~115 ms for 10k files on win32, measured) + an
 * elementwise fingerprint compare. Derivation/persist run only for drifted
 * files.
 */
export async function loadJournalLexicalSnapshot(
  project: string,
  opts: { includeRollupArchive: boolean },
): Promise<LexicalJournalSnapshot | null> {
  if (!lexicalIndexEnabled()) return null;
  try {
    const indexPath = lexicalJournalIndexPath(project);
    let state = states.get(indexPath);
    if (!state) {
      state = { entries: loadPersistedEntries(indexPath), contents: new Map() };
      states.set(indexPath, state);
    }

    // ---- enumerate (must mirror candidates.ts's readJournalCandidates) ----
    // Live half: listJournalFiles(project, false) — the SAME shared reader the
    // brute-force fetch's live half delegates to, so ordering and inclusion
    // rules are inherited, not re-implemented.
    const live = listJournalFiles(project, false);
    const archiveDir = path.join(journalDir(project), "archive");
    let archiveNames: string[] = [];
    if (opts.includeRollupArchive) {
      try {
        // Same filter as candidates.ts's rollup-archive half (index.md + the
        // `_`-reserved namespace excluded by name).
        archiveNames = fs.readdirSync(archiveDir).filter((f) => f.endsWith(".md") && f !== "index.md" && !f.startsWith("_"));
      } catch {
        archiveNames = [];
      }
    }

    // ---- stat sweep (bigint mtimeNs — external-edit detection) ----
    const scanned: ScannedFile[] = [];
    for (const entry of live) {
      const p = path.join(entry.dir, entry.file);
      const st = fs.statSync(p, { bigint: true, throwIfNoEntry: false });
      if (!st) continue;
      scanned.push({ path: p, file: entry.file, date: entry.date, s: Number(st.size), m: st.mtimeNs });
    }
    const archiveScanned: ScannedFile[] = [];
    for (const file of archiveNames) {
      const p = path.join(archiveDir, file);
      const st = fs.statSync(p, { bigint: true, throwIfNoEntry: false });
      if (!st) continue;
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      archiveScanned.push({ path: p, file, date: dateMatch ? dateMatch[1] : "", s: Number(st.size), m: st.mtimeNs });
    }
    // Stable date-desc sort — same comparator (and same tie behavior: stable
    // sort over readdir enumeration order) as the brute half's
    // archiveCandidates.sort((a, b) => b.date.localeCompare(a.date)).
    archiveScanned.sort((a, b) => b.date.localeCompare(a.date));
    scanned.push(...archiveScanned);

    // ---- unchanged? serve the cached snapshot (postings + memos intact) ----
    if (state.snap && state.snap.includeRollupArchive === opts.includeRollupArchive && sameScan(state.snap.scanned, scanned)) {
      return state.snap.snapshot;
    }

    // ---- incremental refresh: (re-)derive stale/missing entries ----
    let dirty = false;
    const docs: LexicalSnapshotDoc[] = [];
    const docEntries: DocEntry[] = [];
    for (const sc of scanned) {
      let e = state.entries.get(sc.path);
      if (!e || e.s !== sc.s || e.m !== sc.m) {
        let content: string;
        try {
          content = fs.readFileSync(sc.path, "utf-8");
        } catch {
          state.entries.delete(sc.path);
          dirty = true;
          continue; // vanished/unreadable between stat and read — skip, like brute force's safeReadFile
        }
        const terms = deriveTerms(content);
        // THE trust choke, applied at derive time on the bytes just read —
        // the same isRescueSourcedContent every sibling journal reader calls.
        e = { s: sc.s, m: sc.m, u: isRescueSourcedContent(content), runs: terms.runs, stems: terms.stems };
        state.entries.set(sc.path, e);
        state.contents.set(sc.path, { s: sc.s, m: sc.m, c: content });
        dirty = true;
      }
      docs.push({ date: sc.date, file: sc.file, path: sc.path, untrusted: e.u });
      docEntries.push(e);
    }

    // ---- prune deleted files + persist when anything drifted ----
    // Kept set = everything enumerated this scan, PLUS (when the archive was
    // NOT enumerated this call) previously-known archive-scope entries — so a
    // rare includeRollupArchive:false query never clobbers the archive half.
    const keep = new Map<string, DocEntry>();
    for (let i = 0; i < docs.length; i++) keep.set(docs[i].path, docEntries[i]);
    if (!opts.includeRollupArchive) {
      const archivePrefix = archiveDir + path.sep;
      for (const [k, e] of state.entries) {
        if (k.startsWith(archivePrefix) && !keep.has(k)) keep.set(k, e);
      }
    }
    if (keep.size !== state.entries.size) dirty = true;
    state.entries = keep;
    for (const k of [...state.contents.keys()]) {
      if (!keep.has(k)) state.contents.delete(k);
    }
    if (dirty) await persistEntries(project, indexPath, keep);

    // ---- build snapshot structures (postings + memoized lookups) ----
    const runPostings = new Map<string, number[]>();
    const stemPostings = new Map<string, number[]>();
    for (let i = 0; i < docEntries.length; i++) {
      for (const t of docEntries[i].runs) {
        let arr = runPostings.get(t);
        if (!arr) { arr = []; runPostings.set(t, arr); }
        arr.push(i);
      }
      for (const t of docEntries[i].stems) {
        let arr = stemPostings.get(t);
        if (!arr) { arr = []; stemPostings.set(t, arr); }
        arr.push(i);
      }
    }
    const substringMemo = new Map<string, Set<number>>();
    const stemMemo = new Map<string, Set<number>>();
    const st = state; // narrow for the closures below

    const snapshot: LexicalJournalSnapshot = {
      docs,
      docsContaining(term: string): ReadonlySet<number> {
        let got = substringMemo.get(term);
        if (!got) {
          got = new Set<number>();
          for (const [t, posting] of runPostings) {
            if (t.includes(term)) {
              for (const i of posting) got.add(i);
            }
          }
          substringMemo.set(term, got);
        }
        return got;
      },
      docsWithStemToken(term: string): ReadonlySet<number> {
        let got = stemMemo.get(term);
        if (!got) {
          const posting = stemPostings.get(term);
          got = posting ? new Set(posting) : new Set<number>();
          stemMemo.set(term, got);
        }
        return got;
      },
      trustedContent(i: number): string | null {
        const d = docs[i];
        let rec = st.contents.get(d.path);
        if (!rec || rec.s !== docEntries[i].s || rec.m !== docEntries[i].m) {
          try {
            rec = { s: docEntries[i].s, m: docEntries[i].m, c: fs.readFileSync(d.path, "utf-8") };
          } catch {
            return null;
          }
          st.contents.set(d.path, rec);
        }
        // Read-time re-verification through the SAME choke — a poisoned/stale
        // cached trust bit can never surface quarantined content (see TRUST
        // in the module header).
        if (isRescueSourcedContent(rec.c)) return null;
        return rec.c;
      },
    };

    state.snap = { includeRollupArchive: opts.includeRollupArchive, scanned, snapshot };
    return snapshot;
  } catch {
    return null; // any unexpected failure → caller takes the brute-force path
  }
}
