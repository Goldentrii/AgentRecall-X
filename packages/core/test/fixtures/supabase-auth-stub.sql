-- test/fixtures/supabase-auth-stub.sql
--
-- Stub of the parts of a real Supabase project that ar2_* migrations and RLS
-- policies depend on: the anon/authenticated/service_role roles, the `auth`
-- schema, and auth.uid()/auth.jwt(). This file is TEST-ONLY scaffolding for
-- the pglite-harness (PostgreSQL 18 WASM via @electric-sql/pglite) — it must
-- NEVER be applied to a real Supabase project (Supabase already provides all
-- of this; re-defining auth.uid()/auth.jwt() there would fail/should never
-- be attempted).
--
-- Identity model used by the stub + migrations/0002_shared_memory.sql:
--   - `SET ROLE authenticated;` switches the pglite session into the
--     unprivileged role that all ar2_* grants/RLS are written against.
--   - `select set_config('request.jwt.claims', '{"sub":"<uuid>","ar_role":"owner|agent"}', false);`
--     stands in for the JWT claims PostgREST would normally inject via
--     `request.jwt.claims`. auth.uid() reads claims.sub; owner-trust checks
--     read claims.ar_role.
--   - Reset with `RESET ROLE;` (or a fresh PGlite session) between principals
--     so identities never leak across calls (harness responsibility).
--
-- Applied once by a superuser session, before migrations/0002_shared_memory.sql.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END $$;

GRANT anon TO CURRENT_USER;
GRANT authenticated TO CURRENT_USER;
GRANT service_role TO CURRENT_USER;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

-- auth.uid(): NULL for anon / unauthenticated sessions, else the `sub` claim.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE
AS $$
  SELECT (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
$$;

-- auth.jwt(): full claims object, '{}' when unset.
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
  LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
  LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.role', true), '');
$$;

GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.jwt() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
