/**
 * store-lib.mjs — synthetic AgentRecall store builder for the 2026-10-15
 * adversarial eval. Mirrors the on-disk layout of scripts/eval/fixtures/
 * golden-v1 (projects/<slug>/{journal,corrections,palace/rooms/<room>}).
 *
 * Isolation: callers create stores ONLY under fresh mkdtemp dirs and point
 * AGENT_RECALL_ROOT at them. Never touches ~/.agent-recall.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export function scrubEnv() {
  for (const k of [
    "AGENT_RECALL_SUPABASE_KEY",
    "AGENT_RECALL_EMBEDDING_KEY",
    "OPENAI_API_KEY",
    "VOYAGE_API_KEY",
  ]) delete process.env[k];
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "adv-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
}

export function makeStore(name = "adv-store") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  fs.writeFileSync(path.join(root, "awareness.md"), "# Awareness\n");
  fs.writeFileSync(
    path.join(root, "insights-index.json"),
    JSON.stringify({ version: "1", updated: "2026-10-01", insights: [] }, null, 2),
  );
  return root;
}

export function projectDir(root, slug) {
  const p = path.join(root, "projects", slug);
  fs.mkdirSync(path.join(p, "journal"), { recursive: true });
  fs.mkdirSync(path.join(p, "corrections"), { recursive: true });
  fs.mkdirSync(path.join(p, "palace", "rooms"), { recursive: true });
  return p;
}

export function writeJournal(root, slug, date, fileSlug, body) {
  const p = projectDir(root, slug);
  const lines = body.split("\n").length;
  const f = path.join(p, "journal", `${date}--manual--${String(lines).padStart(2, "0")}L--${fileSlug}.md`);
  fs.writeFileSync(f, body);
  return f;
}

export function writePalace(root, slug, room, file, body, meta = {}) {
  const p = projectDir(root, slug);
  const roomDir = path.join(p, "palace", "rooms", room);
  fs.mkdirSync(roomDir, { recursive: true });
  const roomMeta = path.join(roomDir, "_room.json");
  if (!fs.existsSync(roomMeta)) {
    fs.writeFileSync(
      roomMeta,
      JSON.stringify(
        {
          slug: room,
          name: room,
          description: `${room} for ${slug}`,
          created: "2026-06-01",
          updated: "2026-09-01",
          salience: 0.7,
          access_count: 5,
          last_accessed: "2026-10-01",
          tags: [room],
          connections: [],
          ...meta,
        },
        null,
        2,
      ),
    );
  }
  const f = path.join(roomDir, `${file}.md`);
  fs.writeFileSync(f, body);
  return f;
}

export function writeCorrection(root, slug, date, id, rule, context, tags = [], severity = "p1") {
  const p = projectDir(root, slug);
  const f = path.join(p, "corrections", `${date}-${id}.json`);
  fs.writeFileSync(
    f,
    JSON.stringify(
      {
        id: `${date}-${id}`,
        date,
        severity,
        project: slug,
        rule,
        context,
        tags,
        kind: "correction",
        active: true,
        retrieved_count: 0,
        heeded_count: 0,
        recurrence_count: 0,
      },
      null,
      2,
    ),
  );
  return f;
}

/** Deterministic PRNG (mulberry32) for reproducible synthetic corpora. */
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pct(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}
