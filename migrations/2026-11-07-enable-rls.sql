-- migrations/2026-11-07-enable-rls.sql — AgentRecall Supabase hardening (upgrade path)
--
-- WHY: the original migration.sql created the ar_* tables without Row Level
-- Security. In Supabase, a table without RLS in the `public` schema is fully
-- readable AND writable through the Data API (PostgREST) by anyone holding the
-- project URL + the anon/publishable key — and that key is designed to be
-- public. This migration locks every AgentRecall table down to the
-- server-side secret key (`service_role`, which has BYPASSRLS).
--
-- WHAT IT DOES (every step is idempotent — safe to run any number of times):
--   1. ENABLE ROW LEVEL SECURITY on each AgentRecall table that exists (the
--      explicit list below — nothing else is touched) and adds NO policies, so
--      the anon / authenticated roles can never see a row.
--   2. REVOKE ALL table privileges from anon and authenticated (grants are
--      checked before policies; revoking them also neutralises any permissive
--      policy someone added by hand).
--   3. GRANT SELECT/INSERT/UPDATE/DELETE to service_role explicitly (projects
--      created with "don't auto-expose new tables" have no default grant).
--   4. For each AgentRecall function that exists: pin search_path, REVOKE
--      EXECUTE from PUBLIC / anon / authenticated, GRANT EXECUTE to service_role.
--   5. RAISE NOTICE for any OTHER public ar_* table, view or routine, so you can
--      review it yourself. Those are left untouched on purpose: a name like
--      ar_invoices may belong to a different app in the same project.
--
-- AFTER RUNNING IT: AgentRecall must be configured with your project's SECRET
-- key (sb_secret_… — or the legacy service_role JWT), not the anon /
-- publishable key. See docs/supabase.md → "Step 3".
--
-- Run in: Supabase dashboard → SQL Editor → New query → paste → Run.
-- Role checks make it a no-op (rather than an error) on plain Postgres where
-- the Supabase roles do not exist.

DO $$
DECLARE
  -- Every table any AgentRecall SQL file has ever created.
  --   migration.sql:                         ar_entries, ar_insights, ar_sync_state
  --   meta/scripts/dashboard-migration.sql:  ar_awareness, ar_corrections, ar_palace_rooms, ar_sessions, _backups
  known_tables text[] := ARRAY['ar_entries', 'ar_insights', 'ar_sync_state',
                               'ar_awareness', 'ar_corrections', 'ar_palace_rooms', 'ar_sessions', '_backups'];
  -- Every function any AgentRecall SQL file (or docs/supabase.md) has ever created.
  known_functions text[] := ARRAY['ar_semantic_search', 'ar_insight_search', 'ar_cross_project_search'];
  t text;
  f record;
  r text;
BEGIN
  -- 1–3. Tables ----------------------------------------------------------------
  FOREACH t IN ARRAY known_tables LOOP
    CONTINUE WHEN to_regclass(format('public.%I', t)) IS NULL;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role', t);
    END IF;
  END LOOP;

  -- 4. Functions (RPCs) ---------------------------------------------------------
  -- The shipped functions are SECURITY INVOKER, so RLS already applies to the
  -- caller; revoking EXECUTE is defence in depth. Every overload is covered.
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY (known_functions)
      AND p.prokind = 'f'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, extensions, pg_temp', f.sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f.sig);

    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %I', f.sig, r);
      END IF;
    END LOOP;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
    END IF;
  END LOOP;

  -- 5. Report anything ar_*-named this migration did NOT secure ------------------
  FOR f IN
    SELECT c.relname AS name, c.relkind AS kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND c.relname LIKE 'ar\_%' ESCAPE '\'
      AND c.relname <> ALL (known_tables)
  LOOP
    RAISE NOTICE 'not secured by this migration (review it yourself): relation public.% (relkind %)', f.name, f.kind;
  END LOOP;
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname LIKE 'ar\_%' ESCAPE '\'
      AND p.proname <> ALL (known_functions)
  LOOP
    RAISE NOTICE 'not secured by this migration (review it yourself): routine %', f.sig;
  END LOOP;
END
$$;

-- Verify (optional): every row should show rls_enabled = true and anon_select = false.
-- SELECT c.relname AS table_name,
--        c.relrowsecurity AS rls_enabled,
--        has_table_privilege('anon', c.oid, 'SELECT') AS anon_select
-- FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
-- WHERE n.nspname = 'public' AND c.relkind = 'r'
--   AND (c.relname LIKE 'ar\_%' ESCAPE '\' OR c.relname = '_backups');
