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
