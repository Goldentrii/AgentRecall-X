# AgentRecall — Supabase Setup

> **Supabase is optional.** AgentRecall works fully without it — journals, palace rooms, corrections, recall, all hooks. Supabase adds semantic search (meaning-based, not keyword) and `/arstatus` cross-project intelligence. Set it up when keyword search hits its ceiling.

---

## What You Get

| Without Supabase | With Supabase |
|-----------------|--------------|
| Keyword recall (stemming + synonyms) | + Semantic recall via pgvector cosine similarity |
| `/arstatus` filesystem scan | + `[score]` relevance badges + `★` recommended project + cross-project insight alerts |
| hook-start loads palace context | + Pre-loaded semantic context from last session |
| `ar_insights` empty | + 22+ cross-project patterns searchable by meaning |

Graceful degradation is built in — if Supabase is unreachable or unconfigured, every AR feature works as before. Zero errors, zero behavior change.

---

## Step 1 — Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) → **New project**. Use a project dedicated to AgentRecall rather than one that also hosts an app: the secret key below unlocks the whole project.
2. Note your **Project URL** and create a **secret key** (Settings → API Keys → *Secret keys*; starts with `sb_secret_`). A legacy `service_role` key also works. **Do not use the anon / publishable key** — see [Security model](#security-model).
3. You'll also need an **OpenAI API key** for embeddings (`text-embedding-3-small`)

---

## Step 2 — Apply the Migration

Open your Supabase project → **SQL Editor** → **New query** → paste the migration below → **Run**:

```sql
-- migration.sql — AgentRecall Supabase schema (fresh install)
-- Run once in the Supabase SQL editor (see docs/supabase.md). Idempotent.
--
-- SECURITY MODEL: every ar_* table has Row Level Security ENABLED with NO
-- policies, and the anon / authenticated roles have no privileges on tables or
-- functions. Only the server-side SECRET key (role service_role, BYPASSRLS) can
-- read or write. Configure AgentRecall with your secret key (sb_secret_…), never
-- the anon/publishable key — that key is public by design.
--
-- Upgrading an existing install that predates RLS? Run
-- migrations/2026-11-07-enable-rls.sql instead (it secures tables in place).
-- Adding a table or function? Give it the same ENABLE ROW LEVEL SECURITY /
-- REVOKE / GRANT treatment — packages/core/test/supabase-rls-static.test.mjs
-- fails the build otherwise.

-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Core content table
CREATE TABLE IF NOT EXISTS ar_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project     text NOT NULL,
  store       text NOT NULL,
  room        text,
  slug        text NOT NULL,
  title       text,
  body        text NOT NULL,
  tags        text[] DEFAULT '{}',
  metadata    jsonb DEFAULT '{}',
  file_path   text,
  file_hash   text,
  embedding   vector(1536),
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  UNIQUE(project, store, slug)
);
ALTER TABLE ar_entries ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_ar_entries_project ON ar_entries(project);
CREATE INDEX IF NOT EXISTS idx_ar_entries_store ON ar_entries(project, store);
CREATE INDEX IF NOT EXISTS idx_ar_entries_tags ON ar_entries USING gin(tags);
CREATE INDEX IF NOT EXISTS idx_ar_entries_fts ON ar_entries
  USING gin(to_tsvector('english', coalesce(title, '') || ' ' || body));

-- Awareness insights
CREATE TABLE IF NOT EXISTS ar_insights (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL UNIQUE,
  severity    text DEFAULT 'important',
  confirmed   int DEFAULT 1,
  projects    text[] DEFAULT '{}',
  tags        text[] DEFAULT '{}',
  embedding   vector(1536),
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);
ALTER TABLE ar_insights ENABLE ROW LEVEL SECURITY;

-- Sync state
CREATE TABLE IF NOT EXISTS ar_sync_state (
  file_path    text PRIMARY KEY,
  file_hash    text NOT NULL,
  entry_id     uuid REFERENCES ar_entries(id) ON DELETE SET NULL,
  status       text DEFAULT 'synced',
  error        text,
  synced_at    timestamptz DEFAULT now()
);
ALTER TABLE ar_sync_state ENABLE ROW LEVEL SECURITY;

-- Vector indexes (created after initial data load for better performance)
-- Run these AFTER backfill completes:
-- CREATE INDEX idx_ar_entries_embedding ON ar_entries
--   USING ivfflat(embedding vector_cosine_ops) WITH (lists = 100);
-- CREATE INDEX idx_ar_insights_embedding ON ar_insights
--   USING ivfflat(embedding vector_cosine_ops) WITH (lists = 50);

-- RPC function for semantic search
CREATE OR REPLACE FUNCTION ar_semantic_search(
  query_embedding vector(1536),
  match_project text,
  match_limit int DEFAULT 20
)
RETURNS TABLE (
  id uuid,
  project text,
  store text,
  room text,
  slug text,
  title text,
  body text,
  tags text[],
  metadata jsonb,
  similarity float
)
LANGUAGE sql STABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT
    e.id, e.project, e.store, e.room, e.slug, e.title, e.body, e.tags, e.metadata,
    1 - (e.embedding <=> query_embedding) AS similarity
  FROM ar_entries e
  WHERE e.project = match_project
    AND e.embedding IS NOT NULL
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_limit;
$$;

-- Cross-project semantic search (for insights)
CREATE OR REPLACE FUNCTION ar_insight_search(
  query_embedding vector(1536),
  match_limit int DEFAULT 10
)
RETURNS TABLE (
  id uuid,
  title text,
  severity text,
  confirmed int,
  projects text[],
  similarity float
)
LANGUAGE sql STABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT
    i.id, i.title, i.severity, i.confirmed, i.projects,
    1 - (i.embedding <=> query_embedding) AS similarity
  FROM ar_insights i
  WHERE i.embedding IS NOT NULL
  ORDER BY i.embedding <=> query_embedding
  LIMIT match_limit;
$$;

-- Cross-project ranking for /arstatus (best match per project)
CREATE OR REPLACE FUNCTION ar_cross_project_search(
  query_embedding vector(1536),
  match_limit integer DEFAULT 30
)
RETURNS TABLE (project text, best_slug text, best_title text, similarity float)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT ON (e.project)
    e.project, e.slug AS best_slug, e.title AS best_title,
    1 - (e.embedding <=> query_embedding) AS similarity
  FROM ar_entries e
  WHERE e.embedding IS NOT NULL
  ORDER BY e.project, e.embedding <=> query_embedding
  LIMIT match_limit;
END;
$$;

-- Lock down privileges: anon / authenticated get nothing, service_role (the
-- secret key) gets what AgentRecall needs. Role checks keep this runnable on
-- plain Postgres, where the Supabase roles do not exist.
REVOKE EXECUTE ON FUNCTION ar_semantic_search(vector, text, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ar_insight_search(vector, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ar_cross_project_search(vector, integer) FROM PUBLIC;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE ar_entries, ar_insights, ar_sync_state FROM %I', r);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION ar_semantic_search(vector, text, int), '
                     'ar_insight_search(vector, int), ar_cross_project_search(vector, integer) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ar_entries, ar_insights, ar_sync_state TO service_role;
    GRANT EXECUTE ON FUNCTION ar_semantic_search(vector, text, int),
                              ar_insight_search(vector, int),
                              ar_cross_project_search(vector, integer) TO service_role;
  END IF;
END
$$;
```

Or use the raw file: [`migration.sql`](../migration.sql) (the block above is that file verbatim; a test keeps them identical).

### Upgrading an install created before 2026-11-07

Earlier versions of this migration created the tables **without Row Level Security**, which leaves them readable and writable by anyone holding your project URL and anon key. Run [`migrations/2026-11-07-enable-rls.sql`](../migrations/2026-11-07-enable-rls.sql) once in the SQL editor (idempotent — safe to re-run). It enables RLS on every AgentRecall table that exists (`ar_entries`, `ar_insights`, `ar_sync_state`, plus the dashboard's `ar_awareness`, `ar_corrections`, `ar_palace_rooms`, `ar_sessions`, `_backups`), revokes all `anon` / `authenticated` privileges, pins `search_path` on the `ar_*` RPCs and limits `EXECUTE` to `service_role`. Other `ar_*`-named objects are left alone (they may belong to another app) and listed as NOTICEs in the SQL editor output for you to review. Then switch AgentRecall to your secret key (Step 3). If you ever pasted the anon key somewhere public, rotate it anyway.

---

## Step 3 — Configure AR

```bash
ar setup supabase
```

The wizard prompts for:
- Supabase Project URL (e.g. `https://abcdef.supabase.co`)
- Supabase **secret** key (`sb_secret_…`) — the wizard refuses an anon/publishable key
- OpenAI API key (for `text-embedding-3-small` embeddings)

Writes `supabase_secret_key` to `~/.agent-recall/config.json` (owner-only permissions on macOS/Linux) — never commit it. `AGENT_RECALL_SUPABASE_KEY` overrides the file and must also hold the secret key; prefer the file, since an exported env var ends up in shell history and every child process's environment. `supabase_url` must be `https://` (plain `http://` only for `localhost` / `127.0.0.1` / `[::1]`); otherwise sync is disabled so the secret key is never sent in clear text.

**Existing configs:** the old field name `supabase_anon_key` is still read, with a one-time deprecation notice — rename it to `supabase_secret_key`. If the configured key is recognisably public (`sb_publishable_…` or an `anon` JWT), AgentRecall prints a warning on stderr: it keeps syncing until you apply the RLS migration, and after that a public key cannot read or write anything. Key values are never logged.

---

## Security model

AgentRecall talks to Supabase only from your own machine (CLI, MCP server, hooks) — never from a browser — so it uses the simplest safe pattern for a single-owner server-side client:

| Layer | Setting |
|-------|---------|
| Tables (`ar_*`) | Row Level Security **enabled, no policies** — the anon / authenticated roles match zero rows |
| Grants | `anon` and `authenticated` have **no** table or function privileges; `service_role` has `SELECT/INSERT/UPDATE/DELETE` + `EXECUTE` on the `ar_*` RPCs |
| RPCs | `SECURITY INVOKER`, `search_path` pinned |
| Client key | The project **secret key** (`sb_secret_…`, role `service_role`, `BYPASSRLS`), stored only in your local `config.json` / env |

The anon / publishable key is public by design (Supabase expects it to ship in browser bundles), so it must never be what protects your memory. The secret key is backend-only: Supabase rejects it from browsers, and you can create one secret key per machine and revoke it individually. If it leaks, rotate it in the dashboard.

**Blast radius:** the secret key bypasses RLS on *every* table in the project, not only `ar_*`, and grants Auth admin access. That is why Step 1 recommends a project used only for AgentRecall. On Windows, `config.json` gets no special file permissions, so anyone who can read your user profile can read the key.

Adding a table or RPC? Give it the same treatment — `packages/core/test/supabase-rls-static.test.mjs` fails the build if any `CREATE TABLE` / `CREATE FUNCTION` in the shipped SQL lacks it.

---

## Step 4 — Backfill

```bash
ar setup supabase --backfill
```

Syncs all local `~/.agent-recall/` files (journals, palace rooms, awareness) to Supabase. Hash-based — skips files already in sync. Safe to re-run anytime.

Expected output:
```
Backfilling my-project (42 files)...
  synced: 38, skipped: 4, failed: 0
...
Backfill complete — synced: 140, skipped: 380, failed: 0
```

---

## Step 5 — Seed Cross-Project Insights

```bash
python3 ~/.claude/scripts/ar-populate-insights.py
```

Parses `~/.agent-recall/awareness.md` and palace alignment rooms → embeds each insight → upserts to `ar_insights`. Safe to re-run (idempotent via `UNIQUE(title)`). Like every client of these tables, the script needs the **secret** key — with RLS enabled an anon key gets nothing back.

---

## How It Works

```
remember() / session_end()
  → writes to local ~/.agent-recall/  ← source of truth, always
  → async: syncs to ar_entries (hash-dedup via ar_sync_state)
      → text-embedding-3-small (1536 dims)
      → pgvector stores embedding

recall(query)
  → Supabase configured?
      YES → 3-way parallel RRF:
              1. ar_semantic_search   (pgvector cosine on ar_entries)
              2. ar_insight_search    (pgvector on ar_insights, cross-project)
              3. FTS on ar_entries    (PostgreSQL keyword backup)
            → Reciprocal Rank Fusion → ranked results
      NO  → local keyword search (unchanged behavior)

/arstatus (at session end, async)
  → embeds last session summary
  → ar_cross_project_search → ranks all projects by relevance
  → fetches top ar_insights by confirmation count
  → writes ~/.agent-recall/arstatus-cache.json
  → next /arstatus render: [score] badges + ★ recommendation + insight alerts
```

---

## Storage Layout (Supabase)

| Table | Purpose | Rows grow when |
|-------|---------|----------------|
| `ar_entries` | All palace/journal/awareness content with embeddings | Every `remember()` / `session_end()` |
| `ar_insights` | Cross-project patterns from awareness.md | Run `ar-populate-insights.py` |
| `ar_sync_state` | Hash-based dedup tracker | Every sync |

---

## Rebuild / Reset

```bash
# Re-embed everything (after changing embedding model or corrupted rows)
ar setup supabase --backfill

# Re-embed only missing embeddings
python3 ~/.claude/scripts/ar-embed.py --upsert

# Re-seed insights after awareness.md changes
python3 ~/.claude/scripts/ar-populate-insights.py

# Regenerate /arstatus cache manually
echo "my recent work context" > ~/.agent-recall/.last-session-summary.txt
python3 ~/.claude/scripts/ar-arstatus-cache.py
```

---

## Notes

- **pgvector ivfflat indexes** require `maintenance_work_mem ≥ 64MB` — not available on Supabase free tier. AR works without them (sequential scan, fast up to ~10K rows).
- **Embedding provider:** OpenAI `text-embedding-3-small` (1536 dims). Voyage `voyage-3-lite` also supported (512 dims, zero-padded to 1536).
- **Local files are always the source of truth.** Supabase is a derived read index — delete and rebuild anytime with `--backfill`.
