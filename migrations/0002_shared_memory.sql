-- migrations/0002_shared_memory.sql
--
-- Shared-memory cloud schema (ADR-001 rev2 + rev2.1). Authoritative store for
-- StorageMode="cloud" (packages/core/src/repository/contract.ts, FROZEN).
--
-- Idempotent: every DDL statement is safe to re-run (CREATE ... IF NOT
-- EXISTS / CREATE OR REPLACE FUNCTION / DROP POLICY IF EXISTS + CREATE
-- POLICY). Versioned via ar2_schema_version; the final INSERT is a no-op on
-- replay.
--
-- Assumes a real Supabase project already provides: roles anon /
-- authenticated / service_role, schema `auth` with auth.uid()/auth.jwt().
-- This file NEVER creates or redefines those — see
-- packages/core/test/fixtures/supabase-auth-stub.sql for the TEST-ONLY stand
-- -in used by the pglite harness (never applied to real Supabase).
--
-- PG15/17 (hosted Supabase) vs PG18 (PGlite test engine) compatibility notes
-- are called out inline with "PG15/17:" comments wherever a construct's
-- availability was verified against grounding rather than assumed.
--
-- Identity: auth.uid() = the calling principal's Supabase Auth user id.
-- Owner-trust (fix round 1, B1): auth.uid() = owner_id — agents are ALWAYS
-- separate Supabase Auth users bound via ar2_grants (R2.1/R2.8), so this is
-- sufficient on its own and requires no custom JWT claim. A real Supabase
-- project issues no `ar_role` claim without a Custom Access Token Auth Hook,
-- which this repo does not ship — gating on `auth.jwt()->>'ar_role'='owner'`
-- (rev2/2.1's original design) would either always be NULL/false in
-- production (locking the real owner out) or, worse, silently accidentally
-- pass owners through via SQL's three-valued NULL logic depending on which
-- downstream pattern reads it (see ar2_owner_trusted below and
-- reviews/WP-P2-report.md "Fix round 1" for the exact mechanism). Defense in
-- depth: ar2_owner_trusted() additionally REFUSES owner-trust if the JWT
-- explicitly claims ar_role='agent' anywhere (top-level, user_metadata,
-- app_metadata) — this guards a future custom-hook misconfiguration, it is
-- never the primary mechanism. See "Runbook: agent credentials" below.
-- Client-reported owner_id/principal_id fields in RPC payloads are NEVER
-- trusted; every RPC below derives identity from auth.uid() exclusively.
--
-- RUNBOOK — agent credentials (B1, no code enforces this, operational only):
-- Agent processes (MCP server, CLI running unattended, background workers)
-- MUST authenticate as their own dedicated Supabase Auth user (one per
-- agent credential, R2.8) and MUST NEVER hold, load, cache, or be handed the
-- owner's own Supabase session/JWT. Owner-gated actions (grant/revoke/alias/
-- confirm/exception/release_dependency/supersede/protected-constraint
-- retract) are authorized SOLELY by `auth.uid() = owner_id` — if an agent
-- process is ever given the owner's real session, it inherits full owner
-- trust with no further gate. `ar login --owner` (CLI-only) is the only
-- supported way to obtain an owner session; it is interactive, short-lived,
-- and never persists a refresh token (R2.8) specifically so agent runtimes
-- have no path to acquire one. If a future Custom Access Token Auth Hook is
-- added to mint `ar_role`, it must be sourced from a trusted server-side
-- table (e.g. which Supabase Auth user created the account / has an owner
-- row), never from client-supplied `user_metadata` (Supabase Auth allows
-- users to write their own `user_metadata` at signup/update — trusting it
-- here would let anyone self-issue ar_role='owner'). This migration does
-- not depend on any such hook existing; ar2_owner_trusted()'s ar_role check
-- is purely a defense-in-depth negative (ar_role='agent' => refuse), never
-- a positive requirement.

-- ---------------------------------------------------------------------------
-- 0. Schema version
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ar2_schema_version (
  version     integer PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 1. Extensions
-- ---------------------------------------------------------------------------

-- gen_random_uuid() is core (not pgcrypto) since PG13 — no extension needed.
-- pg_trgm powers the CJK-safe ILIKE/similarity fallback (N14) since a
-- language-specific tsvector config under-tokenizes CJK text.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- 2. Core tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ar2_workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Membership roster (distinct from ar2_grants' fine-grained capabilities):
-- who has ANY relationship to a workspace. Populated by ar2_admin_workspace
-- (owner, kind='user') and ar2_admin_grant (grantee, kind='agent'). Not part
-- of the RLS read-path (ar2_grants is authoritative for capabilities) — this
-- is an admin roster/index only.
CREATE TABLE IF NOT EXISTS ar2_members (
  workspace_id  uuid NOT NULL REFERENCES ar2_workspaces(id) ON DELETE CASCADE,
  principal_id  uuid NOT NULL,
  owner_id      uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('user', 'agent')),
  agent_label   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, principal_id)
);

CREATE TABLE IF NOT EXISTS ar2_grants (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id               uuid NOT NULL,
  workspace_id           uuid NOT NULL REFERENCES ar2_workspaces(id) ON DELETE CASCADE,
  grantee_principal_id   uuid NOT NULL,
  project_ids            uuid[],                 -- NULL = all projects in workspace
  can_read               boolean NOT NULL DEFAULT true,
  can_write              boolean NOT NULL DEFAULT false,
  can_approve            boolean NOT NULL DEFAULT false,
  personal               boolean NOT NULL DEFAULT false,
  revoked_at             timestamptz,
  expires_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ar2_grants_lookup_idx
  ON ar2_grants (owner_id, workspace_id, grantee_principal_id)
  WHERE revoked_at IS NULL;

-- Owner-global (not workspace-scoped): AdminRepository.setProjectAlias(alias,
-- projectId, ctx) in the FROZEN contract.ts carries no workspace_id, so the
-- alias->project mapping is keyed by (owner_id, alias) only.
CREATE TABLE IF NOT EXISTS ar2_project_aliases (
  owner_id      uuid NOT NULL,
  alias         text NOT NULL,
  project_id    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, alias)
);

CREATE TABLE IF NOT EXISTS ar2_records (
  owner_id             uuid NOT NULL,
  id                   uuid NOT NULL,
  workspace_id         uuid NOT NULL,
  project_id           uuid,
  kind                 text NOT NULL CHECK (kind IN ('fact', 'decision', 'preference', 'constraint', 'experience', 'handoff')),
  visibility           text NOT NULL CHECK (visibility IN ('private', 'project', 'workspace', 'owner_shared')), -- local_only never leaves the machine (rejected client-side; DB-level defense in depth via this CHECK)
  applicability        jsonb NOT NULL DEFAULT '{}'::jsonb,
  content              text NOT NULL,
  content_hash         text NOT NULL,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  authority            text NOT NULL CHECK (authority IN ('explicit_user', 'verified_observation', 'agent_inference', 'imported_untrusted', 'legacy', 'external_edit')),
  status               text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'active', 'superseded', 'retracted', 'quarantined')),
  revision             integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  source               jsonb NOT NULL,
  source_principal_id  uuid GENERATED ALWAYS AS ((source ->> 'principal_id')::uuid) STORED,
  evidence_refs        text[] NOT NULL DEFAULT '{}',
  derived_from         jsonb NOT NULL DEFAULT '[]'::jsonb,
  derived_closure      jsonb NOT NULL DEFAULT '[]'::jsonb,
  dependency_release   jsonb,
  exceptions           jsonb NOT NULL DEFAULT '[]'::jsonb,
  proposal_of          jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz,
  supersedes           jsonb,
  retracted_at         timestamptz,
  retraction_reason    text,
  -- CJK-safe full text: 'simple' config (no language-specific stemming/stop
  -- words that would mangle CJK) + trigram GIN as an ILIKE-speed fallback
  -- (N14: "ILIKE plus a bigram column" — trigram is the closest bundled
  -- equivalent; see report for the substitution rationale).
  content_tsv          tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  PRIMARY KEY (owner_id, id)
);
CREATE INDEX IF NOT EXISTS ar2_records_scope_idx ON ar2_records (owner_id, workspace_id, project_id);
CREATE INDEX IF NOT EXISTS ar2_records_status_idx ON ar2_records (owner_id, status);
CREATE INDEX IF NOT EXISTS ar2_records_tsv_idx ON ar2_records USING gin (content_tsv);
CREATE INDEX IF NOT EXISTS ar2_records_trgm_idx ON ar2_records USING gin (content gin_trgm_ops);

CREATE TABLE IF NOT EXISTS ar2_record_revisions (
  owner_id     uuid NOT NULL,
  id           uuid NOT NULL,
  revision     integer NOT NULL,
  snapshot     jsonb NOT NULL,
  changed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, id, revision)
);

CREATE TABLE IF NOT EXISTS ar2_events (
  seq                  bigserial PRIMARY KEY,
  xid                  xid8 NOT NULL DEFAULT pg_current_xact_id(),
  event_id             text GENERATED ALWAYS AS (seq::text) STORED,
  owner_id             uuid NOT NULL,
  workspace_id         uuid NOT NULL,
  record_id            uuid NOT NULL,
  operation_id         uuid NOT NULL,
  op                   text NOT NULL,
  old_revision         integer,
  new_revision         integer NOT NULL,
  actor_principal_id   uuid NOT NULL,
  at                   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ar2_events_scope_idx ON ar2_events (owner_id, workspace_id, seq);
CREATE INDEX IF NOT EXISTS ar2_events_record_idx ON ar2_events (owner_id, record_id, seq);

CREATE TABLE IF NOT EXISTS ar2_operations (
  principal_id   uuid NOT NULL,
  operation_id   uuid NOT NULL,
  payload_hash   text NOT NULL,
  receipt        jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, operation_id)
);

CREATE TABLE IF NOT EXISTS ar2_outcomes (
  owner_id           uuid NOT NULL,
  memory_id          uuid NOT NULL,
  memory_revision    integer NOT NULL,
  source_event_id    text NOT NULL,
  task_id            text,
  session_id         text,
  injected           boolean,
  applicable         text,
  action_taken       text,
  result             text,
  evidence_refs      text[] NOT NULL DEFAULT '{}',
  judged_by          text,
  judge_version      text,
  operation_id       uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, memory_id, memory_revision, source_event_id)
);

CREATE TABLE IF NOT EXISTS ar2_access_epochs (
  owner_id      uuid NOT NULL,
  principal_id  uuid NOT NULL,
  epoch         bigint NOT NULL DEFAULT 1,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, principal_id)
);

-- ---------------------------------------------------------------------------
-- 3. Lock down direct table access (R2.4)
-- ---------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ar2_workspaces', 'ar2_members', 'ar2_grants', 'ar2_project_aliases',
    'ar2_records', 'ar2_record_revisions', 'ar2_events', 'ar2_operations',
    'ar2_outcomes', 'ar2_access_epochs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON %I TO authenticated', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Read helpers (SECURITY INVOKER; correct because a principal's OWN
--    grant/epoch rows are always visible to themselves under the RLS
--    policies defined below, so no privilege escalation is needed here).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ar2_visible(
  p_owner_id uuid, p_workspace_id uuid, p_project_id uuid, p_visibility text, p_source_principal_id uuid
) RETURNS boolean
  LANGUAGE sql STABLE
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN false
    WHEN p_owner_id = auth.uid() THEN true
    WHEN p_visibility = 'private' THEN p_source_principal_id = auth.uid()
    WHEN p_visibility = 'project' THEN EXISTS (
      SELECT 1 FROM ar2_grants g
      WHERE g.owner_id = p_owner_id AND g.workspace_id = p_workspace_id
        AND g.grantee_principal_id = auth.uid() AND g.can_read
        AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())
        AND (g.project_ids IS NULL OR p_project_id = ANY(g.project_ids))
    )
    WHEN p_visibility = 'workspace' THEN EXISTS (
      SELECT 1 FROM ar2_grants g
      WHERE g.owner_id = p_owner_id AND g.workspace_id = p_workspace_id
        AND g.grantee_principal_id = auth.uid() AND g.can_read
        AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())
        AND g.project_ids IS NULL
    )
    WHEN p_visibility = 'owner_shared' THEN EXISTS (
      SELECT 1 FROM ar2_grants g
      WHERE g.owner_id = p_owner_id AND g.workspace_id = p_workspace_id
        AND g.grantee_principal_id = auth.uid() AND g.can_read AND g.personal
        AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())
    )
    ELSE false
  END;
$$;
REVOKE ALL ON FUNCTION ar2_visible(uuid, uuid, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ar2_visible(uuid, uuid, uuid, text, uuid) TO authenticated;

-- Fix round 1, B1: defense-in-depth negative check only (see header comment
-- and RUNBOOK). Checked in three locations because a future Custom Access
-- Token Auth Hook, or a client-writable `user_metadata` field, could place
-- it in any of them; COALESCE(...,false) is load-bearing — see
-- ar2_owner_trusted below for why a NULL here must never propagate.
CREATE OR REPLACE FUNCTION ar2_jwt_claims_agent() RETURNS boolean
  LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    (auth.jwt() ->> 'ar_role') = 'agent'
    OR (auth.jwt() -> 'user_metadata' ->> 'ar_role') = 'agent'
    OR (auth.jwt() -> 'app_metadata' ->> 'ar_role') = 'agent',
    false
  );
$$;
REVOKE ALL ON FUNCTION ar2_jwt_claims_agent() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ar2_jwt_claims_agent() TO authenticated;

-- Fix round 1, B1: the ONE owner-trust predicate, used everywhere. Both
-- operands are COALESCEd to a definite boolean — never NULL — because SQL's
-- three-valued logic silently swallows a NULL owner-trust value in TWO
-- OPPOSITE, dangerous directions depending on which caller pattern reads it:
-- `IF NOT (v_owner_trusted AND x) THEN reject` treats NULL as "don't
-- reject" (fails OPEN — this is what accidentally let a real owner through
-- under the old ar_role-dependent code, masking the bug); `CASE WHEN
-- v_owner_trusted THEN 'active' ELSE 'candidate' END` treats NULL as the
-- ELSE branch (fails CLOSED but silently wrong — this is what the B1 RED
-- test actually caught: a real owner's create landing as `candidate`).
-- Returning a guaranteed boolean here makes every downstream `IF NOT
-- ar2_owner_trusted(...)` and `CASE WHEN ar2_owner_trusted(...)` behave
-- identically and correctly, with no three-valued-logic footgun left.
CREATE OR REPLACE FUNCTION ar2_owner_trusted(p_owner_id uuid) RETURNS boolean
  LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(auth.uid() = p_owner_id, false) AND NOT ar2_jwt_claims_agent();
$$;
REVOKE ALL ON FUNCTION ar2_owner_trusted(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ar2_owner_trusted(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION ar2_active_grant(
  p_owner_id uuid, p_workspace_id uuid, p_principal_id uuid
) RETURNS ar2_grants
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT g.* FROM ar2_grants g
  WHERE g.owner_id = p_owner_id AND g.workspace_id = p_workspace_id
    AND g.grantee_principal_id = p_principal_id
    AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())
  ORDER BY g.created_at DESC LIMIT 1;
$$;
REVOKE ALL ON FUNCTION ar2_active_grant(uuid, uuid, uuid) FROM PUBLIC;
-- Internal helper only: called from other SECURITY DEFINER functions, never
-- granted directly to authenticated/anon.

CREATE OR REPLACE FUNCTION ar2_get_access_epoch(p_owner_id uuid, p_principal_id uuid) RETURNS bigint
  LANGUAGE sql STABLE
AS $$
  SELECT COALESCE((SELECT epoch FROM ar2_access_epochs WHERE owner_id = p_owner_id AND principal_id = p_principal_id), 1);
$$;
REVOKE ALL ON FUNCTION ar2_get_access_epoch(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ar2_get_access_epoch(uuid, uuid) TO authenticated;

-- R2.11: a derived record's closure is valid iff every entry is visible,
-- active, and at the recorded revision — except entries listed in
-- dependency_release.source_revisions (rev2.1 D4), which skip the check.
CREATE OR REPLACE FUNCTION ar2_derived_valid(
  p_owner_id uuid, p_derived_closure jsonb, p_dependency_release jsonb
) RETURNS boolean
  LANGUAGE plpgsql STABLE
AS $$
DECLARE
  entry jsonb;
  released jsonb;
  r ar2_records%rowtype;
  is_released boolean;
BEGIN
  IF p_derived_closure IS NULL OR jsonb_array_length(p_derived_closure) = 0 THEN
    RETURN true;
  END IF;
  released := COALESCE(p_dependency_release -> 'source_revisions', '[]'::jsonb);
  FOR entry IN SELECT * FROM jsonb_array_elements(p_derived_closure)
  LOOP
    is_released := EXISTS (
      SELECT 1 FROM jsonb_array_elements(released) rel
      WHERE (rel ->> 'id') = (entry ->> 'id') AND (rel ->> 'revision')::int = (entry ->> 'revision')::int
    );
    IF is_released THEN
      CONTINUE;
    END IF;
    SELECT * INTO r FROM ar2_records
      WHERE owner_id = p_owner_id AND id = (entry ->> 'id')::uuid;
    IF NOT FOUND
       OR r.status <> 'active'
       OR r.revision <> (entry ->> 'revision')::int
       OR NOT ar2_visible(r.owner_id, r.workspace_id, r.project_id, r.visibility, r.source_principal_id)
    THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION ar2_derived_valid(uuid, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ar2_derived_valid(uuid, jsonb, jsonb) TO authenticated;

-- Server-side mirror of contract.ts:stripReservedMetadata (R2.1). The
-- TypeScript driver already strips these before sending, but ar2_mutate is
-- SECURITY DEFINER and reachable by anyone holding a valid `authenticated`
-- JWT — not only through CloudRepository — so the DB is the real trust
-- boundary and must not rely on a cooperating client.
CREATE OR REPLACE FUNCTION ar2_strip_reserved_metadata(p_meta jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
  FROM jsonb_each(COALESCE(p_meta, '{}'::jsonb))
  WHERE key NOT LIKE '\_ar%' ESCAPE '\' AND key NOT LIKE 'dependency\_release%' ESCAPE '\';
$$;

-- ---------------------------------------------------------------------------
-- 5. RLS policies (R2.2 read matrix; writes are RPC-only)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS ar2_workspaces_select ON ar2_workspaces;
CREATE POLICY ar2_workspaces_select ON ar2_workspaces FOR SELECT TO authenticated
  USING (owner_id = auth.uid() OR EXISTS (
    SELECT 1 FROM ar2_members m WHERE m.workspace_id = ar2_workspaces.id AND m.principal_id = auth.uid()
  ));

DROP POLICY IF EXISTS ar2_members_select ON ar2_members;
CREATE POLICY ar2_members_select ON ar2_members FOR SELECT TO authenticated
  USING (owner_id = auth.uid() OR principal_id = auth.uid());

DROP POLICY IF EXISTS ar2_grants_select ON ar2_grants;
CREATE POLICY ar2_grants_select ON ar2_grants FOR SELECT TO authenticated
  USING (owner_id = auth.uid() OR grantee_principal_id = auth.uid());

DROP POLICY IF EXISTS ar2_project_aliases_select ON ar2_project_aliases;
CREATE POLICY ar2_project_aliases_select ON ar2_project_aliases FOR SELECT TO authenticated
  USING (owner_id = auth.uid() OR EXISTS (
    -- any active (non-revoked, non-expired) grant from this owner, in any
    -- workspace, is enough to resolve that owner's aliases — low-sensitivity
    -- uuid lookup, not itself a read of record content.
    SELECT 1 FROM ar2_grants g WHERE g.owner_id = ar2_project_aliases.owner_id
      AND g.grantee_principal_id = auth.uid() AND g.can_read
      AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())
  ));

DROP POLICY IF EXISTS ar2_records_select ON ar2_records;
CREATE POLICY ar2_records_select ON ar2_records FOR SELECT TO authenticated
  USING (
    status <> 'retracted'  -- A16: retracted content never returned by any read path
    AND ar2_visible(owner_id, workspace_id, project_id, visibility, source_principal_id)
  );

DROP POLICY IF EXISTS ar2_record_revisions_select ON ar2_record_revisions;
CREATE POLICY ar2_record_revisions_select ON ar2_record_revisions FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM ar2_records r
    WHERE r.owner_id = ar2_record_revisions.owner_id AND r.id = ar2_record_revisions.id
      AND ar2_visible(r.owner_id, r.workspace_id, r.project_id, r.visibility, r.source_principal_id)
  ));

DROP POLICY IF EXISTS ar2_events_select ON ar2_events;
CREATE POLICY ar2_events_select ON ar2_events FOR SELECT TO authenticated
  USING (
    owner_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM ar2_records r
      WHERE r.owner_id = ar2_events.owner_id AND r.id = ar2_events.record_id
        AND ar2_visible(r.owner_id, r.workspace_id, r.project_id, r.visibility, r.source_principal_id)
    )
  );

DROP POLICY IF EXISTS ar2_operations_select ON ar2_operations;
CREATE POLICY ar2_operations_select ON ar2_operations FOR SELECT TO authenticated
  USING (principal_id = auth.uid());  -- R2.4 explicit rule

DROP POLICY IF EXISTS ar2_outcomes_select ON ar2_outcomes;
CREATE POLICY ar2_outcomes_select ON ar2_outcomes FOR SELECT TO authenticated
  USING (
    owner_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM ar2_records r
      WHERE r.owner_id = ar2_outcomes.owner_id AND r.id = ar2_outcomes.memory_id
        AND ar2_visible(r.owner_id, r.workspace_id, r.project_id, r.visibility, r.source_principal_id)
    )
  );

DROP POLICY IF EXISTS ar2_access_epochs_select ON ar2_access_epochs;
CREATE POLICY ar2_access_epochs_select ON ar2_access_epochs FOR SELECT TO authenticated
  USING (owner_id = auth.uid() OR principal_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 6. Access-epoch bump triggers (R2.10, rev2.1 clarification: coarse bump —
--    owner + every currently-active grantee of the affected workspace)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ar2_bump_epochs(p_owner_id uuid, p_workspace_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO ar2_access_epochs (owner_id, principal_id, epoch, updated_at)
    VALUES (p_owner_id, p_owner_id, 2, now())
    ON CONFLICT (owner_id, principal_id) DO UPDATE SET epoch = ar2_access_epochs.epoch + 1, updated_at = now();
  INSERT INTO ar2_access_epochs (owner_id, principal_id, epoch, updated_at)
    SELECT p_owner_id, g.grantee_principal_id, 2, now()
    FROM ar2_grants g
    WHERE g.owner_id = p_owner_id AND g.workspace_id = p_workspace_id
      AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())
    ON CONFLICT (owner_id, principal_id) DO UPDATE SET epoch = ar2_access_epochs.epoch + 1, updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION ar2_trg_grants_epoch() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM ar2_bump_epochs(COALESCE(NEW.owner_id, OLD.owner_id), COALESCE(NEW.workspace_id, OLD.workspace_id));
  -- also bump the grantee directly in case they had no epoch row and the
  -- grant is being revoked (excluded from the active-grantee scan above)
  INSERT INTO ar2_access_epochs (owner_id, principal_id, epoch, updated_at)
    VALUES (COALESCE(NEW.owner_id, OLD.owner_id), COALESCE(NEW.grantee_principal_id, OLD.grantee_principal_id), 2, now())
    ON CONFLICT (owner_id, principal_id) DO UPDATE SET epoch = ar2_access_epochs.epoch + 1, updated_at = now();
  RETURN COALESCE(NEW, OLD);
END;
$$;
DROP TRIGGER IF EXISTS ar2_grants_epoch_trg ON ar2_grants;
CREATE TRIGGER ar2_grants_epoch_trg AFTER INSERT OR UPDATE OR DELETE ON ar2_grants
  FOR EACH ROW EXECUTE FUNCTION ar2_trg_grants_epoch();

CREATE OR REPLACE FUNCTION ar2_trg_records_epoch() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (TG_OP = 'UPDATE') AND (NEW.visibility IS DISTINCT FROM OLD.visibility OR NEW.project_id IS DISTINCT FROM OLD.project_id) THEN
    PERFORM ar2_bump_epochs(NEW.owner_id, NEW.workspace_id);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS ar2_records_epoch_trg ON ar2_records;
CREATE TRIGGER ar2_records_epoch_trg AFTER UPDATE ON ar2_records
  FOR EACH ROW EXECUTE FUNCTION ar2_trg_records_epoch();

-- ---------------------------------------------------------------------------
-- 7. idle_in_transaction_session_timeout (N3) + feed-lag metric (N3)
-- ---------------------------------------------------------------------------

ALTER ROLE authenticated SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE anon SET idle_in_transaction_session_timeout = '30s';

CREATE OR REPLACE FUNCTION ar2_feed_lag_seconds() RETURNS double precision
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXTRACT(EPOCH FROM (now() - COALESCE((SELECT at FROM ar2_events ORDER BY seq DESC LIMIT 1), now())));
$$;
REVOKE ALL ON FUNCTION ar2_feed_lag_seconds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ar2_feed_lag_seconds() TO authenticated;

-- ---------------------------------------------------------------------------
-- 8. RPCs — SECURITY INVOKER reads (RLS fully applies; auth.uid() resolves
--    identically regardless of invoker/definer, only privileges differ)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ar2_get(p_owner_id uuid, p_id uuid) RETURNS jsonb
  LANGUAGE sql STABLE
AS $$
  SELECT to_jsonb(r) FROM ar2_records r WHERE r.owner_id = p_owner_id AND r.id = p_id;
$$;
REVOKE ALL ON FUNCTION ar2_get(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ar2_get(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION ar2_query(
  p_owner_id uuid,
  p_workspace_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL,
  p_text text DEFAULT NULL,
  p_kinds text[] DEFAULT NULL,
  p_ids uuid[] DEFAULT NULL,
  p_limit integer DEFAULT 200,
  p_snapshot_only_active boolean DEFAULT false,
  p_include_non_active boolean DEFAULT false,
  -- keyset pagination for list(): strictly-after (updated_at DESC, id DESC)
  p_after_updated_at timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL
) RETURNS jsonb
  LANGUAGE plpgsql STABLE
AS $$
DECLARE
  items jsonb;
  withheld integer := 0;
BEGIN
  WITH scoped AS (
    SELECT r.* FROM ar2_records r
    WHERE r.owner_id = p_owner_id
      AND (p_workspace_id IS NULL OR r.workspace_id = p_workspace_id)
      AND (p_project_id IS NULL OR r.project_id = p_project_id)
      AND (p_kinds IS NULL OR r.kind = ANY(p_kinds))
      AND (p_ids IS NULL OR r.id = ANY(p_ids))
      AND (NOT p_snapshot_only_active OR r.status = 'active')
      AND (p_include_non_active OR r.status <> 'retracted')
      AND (
        p_text IS NULL
        OR r.content_tsv @@ plainto_tsquery('simple', p_text)
        OR r.content ILIKE ('%' || p_text || '%')
      )
      AND (
        p_after_updated_at IS NULL
        OR (r.updated_at, r.id) < (p_after_updated_at, COALESCE(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid))
      )
    ORDER BY r.updated_at DESC, r.id DESC
    LIMIT GREATEST(p_limit, 0)
  ),
  filtered AS (
    SELECT s.*, ar2_derived_valid(s.owner_id, s.derived_closure, s.dependency_release) AS valid
    FROM scoped s
  )
  SELECT
    COALESCE(jsonb_agg(to_jsonb(f) - 'valid' ORDER BY f.updated_at DESC, f.id DESC) FILTER (WHERE f.valid), '[]'::jsonb),
    COUNT(*) FILTER (WHERE NOT f.valid)
  INTO items, withheld
  FROM filtered f;

  RETURN jsonb_build_object('items', items, 'withheld_derived', withheld);
END;
$$;
REVOKE ALL ON FUNCTION ar2_query(uuid, uuid, uuid, text, text[], uuid[], integer, boolean, boolean, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ar2_query(uuid, uuid, uuid, text, text[], uuid[], integer, boolean, boolean, timestamptz, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION ar2_history(p_owner_id uuid, p_id uuid) RETURNS jsonb
  LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(jsonb_agg(rr.snapshot ORDER BY rr.revision ASC), '[]'::jsonb)
  FROM ar2_record_revisions rr
  WHERE rr.owner_id = p_owner_id AND rr.id = p_id;
$$;
REVOKE ALL ON FUNCTION ar2_history(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ar2_history(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION ar2_latest_handoff(p_owner_id uuid, p_project_id uuid, p_task_key text) RETURNS jsonb
  LANGUAGE sql STABLE
AS $$
  SELECT to_jsonb(r) FROM ar2_records r
  WHERE r.owner_id = p_owner_id
    AND r.kind = 'handoff'
    AND r.status = 'active'
    AND (p_project_id IS NULL OR r.project_id = p_project_id)
    AND (r.content::jsonb ->> 'task_key') = p_task_key
  ORDER BY r.updated_at DESC
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION ar2_latest_handoff(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ar2_latest_handoff(uuid, uuid, text) TO authenticated;

-- xmin change-cursor rule (rev1 §6): cursor = 'xid:seq'; never skip an
-- in-flight transaction — only return events whose xid precedes the xmin of
-- the CURRENT snapshot (i.e. is guaranteed fully committed/visible).
CREATE OR REPLACE FUNCTION ar2_read_changes(p_owner_id uuid, p_cursor text, p_limit integer DEFAULT 200) RETURNS jsonb
  LANGUAGE plpgsql STABLE
AS $$
DECLARE
  cur_xid xid8 := '0';
  cur_seq bigint := 0;
  v_xmin xid8 := pg_snapshot_xmin(pg_current_snapshot());
  rows jsonb;
  last_xid xid8;
  last_seq bigint;
BEGIN
  IF p_cursor IS NOT NULL AND p_cursor <> '' THEN
    cur_xid := split_part(p_cursor, ':', 1)::xid8;
    cur_seq := split_part(p_cursor, ':', 2)::bigint;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.xid, e.seq), '[]'::jsonb),
         MAX(e.xid), MAX(e.seq)
    INTO rows, last_xid, last_seq
  FROM (
    SELECT e.* FROM ar2_events e
    WHERE (e.owner_id = p_owner_id OR EXISTS (
            SELECT 1 FROM ar2_records r WHERE r.owner_id = e.owner_id AND r.id = e.record_id
              AND ar2_visible(r.owner_id, r.workspace_id, r.project_id, r.visibility, r.source_principal_id)
          ))
      AND e.xid < v_xmin
      AND (e.xid, e.seq) > (cur_xid, cur_seq)
    ORDER BY e.xid, e.seq
    LIMIT GREATEST(p_limit, 0)
  ) e;

  RETURN jsonb_build_object(
    'events', rows,
    'next_cursor', COALESCE(last_xid::text || ':' || last_seq::text, p_cursor),
    'has_more', jsonb_array_length(rows) = p_limit
  );
END;
$$;
REVOKE ALL ON FUNCTION ar2_read_changes(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ar2_read_changes(uuid, text, integer) TO authenticated;

CREATE OR REPLACE FUNCTION ar2_get_operation(p_operation_id uuid) RETURNS jsonb
  LANGUAGE sql STABLE
AS $$
  SELECT to_jsonb(o) FROM ar2_operations o WHERE o.principal_id = auth.uid() AND o.operation_id = p_operation_id;
$$;
REVOKE ALL ON FUNCTION ar2_get_operation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ar2_get_operation(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION ar2_resolve_project(p_owner_id uuid, p_alias text) RETURNS uuid
  LANGUAGE sql STABLE
AS $$
  SELECT project_id FROM ar2_project_aliases WHERE owner_id = p_owner_id AND alias = p_alias;
$$;
REVOKE ALL ON FUNCTION ar2_resolve_project(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ar2_resolve_project(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 9. RPCs — SECURITY DEFINER writes (R2.4: pinned search_path, explicit
--    auth.uid() checks; RLS is BYPASSED inside these bodies by definition of
--    SECURITY DEFINER, so every authorization decision below is hand-coded)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ar2_admin_workspace(p_name text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_owner uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('status', 'rejected', 'reason', 'unauthenticated', 'message', 'no auth.uid()');
  END IF;
  INSERT INTO ar2_workspaces (owner_id, name) VALUES (v_owner, p_name) RETURNING id INTO v_id;
  INSERT INTO ar2_members (workspace_id, principal_id, owner_id, kind)
    VALUES (v_id, v_owner, v_owner, 'user');
  RETURN jsonb_build_object('workspace_id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION ar2_admin_workspace(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ar2_admin_workspace(text) TO authenticated;

CREATE OR REPLACE FUNCTION ar2_admin_grant(
  p_operation_id uuid, p_workspace_id uuid, p_grantee_principal_id uuid,
  p_project_ids uuid[], p_can_read boolean, p_can_write boolean, p_can_approve boolean, p_personal boolean,
  p_expires_at timestamptz
) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_owner uuid;
  v_owner_trusted boolean;
BEGIN
  SELECT owner_id INTO v_owner FROM ar2_workspaces WHERE id = p_workspace_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'reason', 'not_found', 'message', 'workspace not found');
  END IF;
  v_owner_trusted := ar2_owner_trusted(v_owner);
  IF NOT v_owner_trusted THEN
    RETURN jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'reason', 'forbidden', 'message', 'grant requires owner trust');
  END IF;
  INSERT INTO ar2_grants (owner_id, workspace_id, grantee_principal_id, project_ids, can_read, can_write, can_approve, personal, expires_at)
    VALUES (v_owner, p_workspace_id, p_grantee_principal_id, p_project_ids, p_can_read, p_can_write, p_can_approve, p_personal, p_expires_at);
  INSERT INTO ar2_members (workspace_id, principal_id, owner_id, kind)
    VALUES (p_workspace_id, p_grantee_principal_id, v_owner, 'agent')
    ON CONFLICT (workspace_id, principal_id) DO NOTHING;
  RETURN jsonb_build_object('status', 'committed', 'operation_id', p_operation_id, 'id', p_grantee_principal_id::text, 'revision', 1,
    'commit_cursor', '', 'replayed', false, 'effective', true, 'effective_authority', 'explicit_user', 'effective_status', 'active');
END;
$$;
REVOKE ALL ON FUNCTION ar2_admin_grant(uuid, uuid, uuid, uuid[], boolean, boolean, boolean, boolean, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ar2_admin_grant(uuid, uuid, uuid, uuid[], boolean, boolean, boolean, boolean, timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION ar2_admin_revoke(p_operation_id uuid, p_workspace_id uuid, p_grantee_principal_id uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_owner uuid;
  v_owner_trusted boolean;
BEGIN
  SELECT owner_id INTO v_owner FROM ar2_workspaces WHERE id = p_workspace_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'reason', 'not_found', 'message', 'workspace not found');
  END IF;
  v_owner_trusted := ar2_owner_trusted(v_owner);
  IF NOT v_owner_trusted THEN
    RETURN jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'reason', 'forbidden', 'message', 'revoke requires owner trust');
  END IF;
  UPDATE ar2_grants SET revoked_at = now()
  WHERE owner_id = v_owner AND workspace_id = p_workspace_id AND grantee_principal_id = p_grantee_principal_id
    AND revoked_at IS NULL;
  RETURN jsonb_build_object('status', 'committed', 'operation_id', p_operation_id, 'id', p_grantee_principal_id::text, 'revision', 1,
    'commit_cursor', '', 'replayed', false, 'effective', true, 'effective_authority', 'explicit_user', 'effective_status', 'active');
END;
$$;
REVOKE ALL ON FUNCTION ar2_admin_revoke(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ar2_admin_revoke(uuid, uuid, uuid) TO authenticated;

-- Owner-global (no workspace_id — see ar2_project_aliases): the caller IS
-- the owner (auth.uid()), no workspace lookup needed to find one.
CREATE OR REPLACE FUNCTION ar2_admin_alias(p_operation_id uuid, p_alias text, p_project_id uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_owner_trusted boolean;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'reason', 'unauthenticated', 'message', 'no auth.uid()');
  END IF;
  v_owner_trusted := ar2_owner_trusted(v_caller);
  IF NOT v_owner_trusted THEN
    RETURN jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'reason', 'forbidden', 'message', 'alias requires owner trust');
  END IF;
  INSERT INTO ar2_project_aliases (owner_id, alias, project_id)
    VALUES (v_caller, p_alias, p_project_id)
    ON CONFLICT (owner_id, alias) DO UPDATE SET project_id = EXCLUDED.project_id;
  RETURN jsonb_build_object('status', 'committed', 'operation_id', p_operation_id, 'id', p_project_id::text, 'revision', 1,
    'commit_cursor', '', 'replayed', false, 'effective', true, 'effective_authority', 'explicit_user', 'effective_status', 'active');
END;
$$;
REVOKE ALL ON FUNCTION ar2_admin_alias(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ar2_admin_alias(uuid, text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION ar2_record_outcome(p_owner_id uuid, p_operation_id uuid, p_payload_hash text, p_outcome jsonb) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_existing ar2_operations%rowtype;
  v_memory_id uuid := (p_outcome -> 'memory' ->> 'id')::uuid;
  v_memory_revision integer := (p_outcome -> 'memory' ->> 'revision')::integer;
  v_source_event_id text := p_outcome ->> 'source_event_id';
  v_receipt jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'id', COALESCE(v_memory_id::text, ''), 'reason', 'unauthenticated', 'message', 'no auth.uid()');
  END IF;

  SELECT * INTO v_existing FROM ar2_operations WHERE principal_id = v_caller AND operation_id = p_operation_id;
  IF FOUND THEN
    IF v_existing.payload_hash = p_payload_hash THEN
      RETURN jsonb_set(v_existing.receipt, '{replayed}', 'true'::jsonb);
    ELSE
      v_receipt := jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'id', COALESCE(v_memory_id::text, ''), 'reason', 'idempotency_mismatch', 'message', 'operation_id reused with a different payload');
      RETURN v_receipt;
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM ar2_events e WHERE e.owner_id = p_owner_id AND e.event_id = v_source_event_id) THEN
    v_receipt := jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'id', COALESCE(v_memory_id::text, ''), 'reason', 'schema', 'message', 'source_event_id does not reference an existing event');
    INSERT INTO ar2_operations (principal_id, operation_id, payload_hash, receipt) VALUES (v_caller, p_operation_id, p_payload_hash, v_receipt);
    RETURN v_receipt;
  END IF;

  BEGIN
    INSERT INTO ar2_outcomes (owner_id, memory_id, memory_revision, source_event_id, task_id, session_id, injected, applicable, action_taken, result, evidence_refs, judged_by, judge_version, operation_id)
    VALUES (
      p_owner_id, v_memory_id, v_memory_revision, v_source_event_id,
      p_outcome ->> 'task_id', p_outcome ->> 'session_id',
      (p_outcome ->> 'injected')::boolean,
      p_outcome ->> 'applicable',
      p_outcome ->> 'action_taken',
      p_outcome ->> 'result',
      COALESCE((SELECT array_agg(x) FROM jsonb_array_elements_text(COALESCE(p_outcome -> 'evidence_refs', '[]'::jsonb)) x), '{}'),
      p_outcome ->> 'judged_by', p_outcome ->> 'judge_version', p_operation_id
    );
    v_receipt := jsonb_build_object('status', 'committed', 'operation_id', p_operation_id, 'id', v_memory_id::text, 'revision', v_memory_revision,
      'commit_cursor', '', 'replayed', false, 'effective', true, 'effective_authority', 'verified_observation', 'effective_status', 'active');
  EXCEPTION WHEN unique_violation THEN
    -- duplicate (owner_id, memory_id, memory_revision, source_event_id): original receipt, no second effect (R2.12)
    SELECT receipt INTO v_receipt FROM ar2_operations WHERE principal_id = v_caller
      ORDER BY created_at DESC LIMIT 1; -- best-effort fallback; the ON CONFLICT path below is the normal case
    v_receipt := jsonb_build_object('status', 'committed', 'operation_id', p_operation_id, 'id', v_memory_id::text, 'revision', v_memory_revision,
      'commit_cursor', '', 'replayed', true, 'effective', false, 'effective_authority', 'verified_observation', 'effective_status', 'active');
  END;

  INSERT INTO ar2_operations (principal_id, operation_id, payload_hash, receipt) VALUES (v_caller, p_operation_id, p_payload_hash, v_receipt);
  RETURN v_receipt;
END;
$$;
REVOKE ALL ON FUNCTION ar2_record_outcome(uuid, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ar2_record_outcome(uuid, uuid, text, jsonb) TO authenticated;

-- ar2_mutate: CAS + idempotency + record + event + operation in one
-- transaction (R2.5). Order: authenticate -> operation lookup -> validate
-- (shape already checked client-side by contract.ts; schema errors here are
-- defense-in-depth) -> authorize (R2.1) -> CAS -> commit.
CREATE OR REPLACE FUNCTION ar2_mutate(
  -- The runtime binds exactly one owner (R2.2) — CloudRepository always
  -- knows ctx.principal.owner_id without a network round trip, unlike a
  -- workspace_id for non-create ops (which may be unreadable/unknown ahead
  -- of time). Trusting p_owner_id as anything more than a SCOPE SELECTOR
  -- would be unsafe, but it isn't: every check below still re-verifies the
  -- caller's real relationship (owner-trust or an active grant) to this
  -- exact owner_id, so a false claim only ever produces a rejection/
  -- not_found, never elevated access (same pattern as ar2_get/ar2_query,
  -- which already take p_owner_id as a plain argument).
  p_owner_id uuid,
  p_cmd jsonb,
  p_expected_revision integer,
  p_operation_id uuid,
  p_payload_hash text,
  -- Precomputed by the driver via contract.ts:proposalId(principal_id,
  -- operation_id) (rev2.1 D2: "drivers share helper proposalId() in
  -- contract.ts") — NOT recomputed here so there is exactly one
  -- implementation of the UUIDv5-style derivation, in TypeScript.
  p_proposal_id uuid DEFAULT NULL
) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_owner uuid;
  v_owner_trusted boolean;
  v_op text := p_cmd ->> 'op';
  v_id uuid := (p_cmd ->> 'id')::uuid;
  v_existing_op ar2_operations%rowtype;
  v_target ar2_records%rowtype;
  v_grant ar2_grants%rowtype;
  v_can_write boolean;
  v_can_approve boolean;
  v_is_author boolean;
  v_protected boolean;
  v_effective_authority text;
  v_effective_status text;
  v_receipt jsonb;
  v_new_revision integer;
  v_seq bigint;
  v_evtxid xid8;
  v_widening boolean;
  v_new_id uuid;
  v_proposal_id uuid;
  v_source jsonb;
  v_workspace_id uuid;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'id', COALESCE(v_id::text, ''), 'reason', 'unauthenticated', 'message', 'no auth.uid()');
  END IF;
  IF p_owner_id IS NULL THEN
    RETURN jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'id', COALESCE(v_id::text, ''), 'reason', 'schema', 'message', 'owner_id is required');
  END IF;
  v_owner := p_owner_id;
  v_owner_trusted := ar2_owner_trusted(v_owner);

  -- ---- idempotency (R2.5): operation lookup BEFORE validate/authorize ----
  SELECT * INTO v_existing_op FROM ar2_operations WHERE principal_id = v_caller AND operation_id = p_operation_id;
  IF FOUND THEN
    IF v_existing_op.payload_hash = p_payload_hash THEN
      RETURN jsonb_set(v_existing_op.receipt, '{replayed}', 'true'::jsonb);
    ELSE
      RETURN jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'id', COALESCE(v_id::text, ''), 'reason', 'idempotency_mismatch', 'message', 'operation_id reused with a different payload');
    END IF;
  END IF;

  -- =====================================================================
  -- CREATE (id is client-generated; a retried create is idempotent via the
  -- operation-id path above, so a pre-existing id here is a genuine new
  -- record collision attempt against a DIFFERENT operation)
  -- =====================================================================
  IF v_op = 'create' THEN
    v_workspace_id := (p_cmd ->> 'workspace_id')::uuid;
    IF NOT EXISTS (SELECT 1 FROM ar2_workspaces WHERE id = v_workspace_id AND owner_id = v_owner) THEN
      v_receipt := jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'id', COALESCE(v_id::text, ''), 'reason', 'not_found', 'message', 'workspace not found');
      INSERT INTO ar2_operations (principal_id, operation_id, payload_hash, receipt) VALUES (v_caller, p_operation_id, p_payload_hash, v_receipt);
      RETURN v_receipt;
    END IF;

    -- resolve caller's grant on this workspace (owner implicitly has all capabilities)
    IF v_caller = v_owner THEN
      v_can_write := true; v_can_approve := v_owner_trusted;
    ELSE
      SELECT * INTO v_grant FROM ar2_active_grant(v_owner, v_workspace_id, v_caller);
      v_can_write := COALESCE(v_grant.can_write, false);
      v_can_approve := COALESCE(v_grant.can_approve, false);
      IF NOT FOUND OR v_grant.grantee_principal_id IS NULL THEN
        v_can_write := false; v_can_approve := false;
      END IF;
    END IF;

    IF NOT v_can_write THEN
      v_receipt := jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'id', v_id::text, 'reason', 'forbidden', 'message', 'no can_write grant on this workspace');
      INSERT INTO ar2_operations (principal_id, operation_id, payload_hash, receipt) VALUES (v_caller, p_operation_id, p_payload_hash, v_receipt);
      RETURN v_receipt;
    END IF;
    IF EXISTS (SELECT 1 FROM ar2_records WHERE owner_id = v_owner AND id = v_id) THEN
      v_receipt := jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'id', v_id::text, 'reason', 'schema', 'message', 'id already exists');
      INSERT INTO ar2_operations (principal_id, operation_id, payload_hash, receipt) VALUES (v_caller, p_operation_id, p_payload_hash, v_receipt);
      RETURN v_receipt;
    END IF;

    -- R2.1 row 3: authority recompute (explicit_user/legacy only survive with owner trust)
    v_effective_authority := p_cmd ->> 'authority';
    IF v_effective_authority IN ('explicit_user', 'legacy') AND NOT v_owner_trusted THEN
      v_effective_authority := 'agent_inference';
    END IF;

    -- R2.1 rows 1/2: constraint kind, workspace/owner_shared visibility, or no
    -- resolved project -> candidate unless owner_trusted; else straight to active
    IF (p_cmd ->> 'kind') = 'constraint'
       OR (p_cmd ->> 'visibility') IN ('workspace', 'owner_shared')
       OR (p_cmd ->> 'project_id') IS NULL
    THEN
      v_effective_status := CASE WHEN v_owner_trusted THEN 'active' ELSE 'candidate' END;
    ELSE
      v_effective_status := 'active';
    END IF;

    v_source := jsonb_build_object(
      'principal_id', v_caller, 'captured_at', now(), 'channel', COALESCE(p_cmd -> 'source' ->> 'channel', 'sdk'),
      'session_id', p_cmd -> 'source' ->> 'session_id', 'agent_id', p_cmd -> 'source' ->> 'agent_id'
    );

    INSERT INTO ar2_records (
      owner_id, id, workspace_id, project_id, kind, visibility, applicability, content, content_hash,
      metadata, authority, status, revision, source, evidence_refs, derived_from, derived_closure, expires_at
    ) VALUES (
      v_owner, v_id, v_workspace_id, NULLIF(p_cmd ->> 'project_id', '')::uuid, p_cmd ->> 'kind', p_cmd ->> 'visibility',
      COALESCE(p_cmd -> 'applicability', '{}'::jsonb), p_cmd ->> 'content', encode(sha256(normalize(p_cmd ->> 'content', NFC)::bytea), 'hex'),
      ar2_strip_reserved_metadata(p_cmd -> 'metadata'), v_effective_authority, v_effective_status, 1, v_source,
      COALESCE((SELECT array_agg(x) FROM jsonb_array_elements_text(COALESCE(p_cmd -> 'evidence_refs', '[]'::jsonb)) x), '{}'),
      COALESCE(p_cmd -> 'derived_from', '[]'::jsonb), COALESCE(p_cmd -> 'derived_from', '[]'::jsonb),
      NULLIF(p_cmd ->> 'expires_at', '')::timestamptz
    );

    INSERT INTO ar2_record_revisions (owner_id, id, revision, snapshot)
      SELECT owner_id, id, revision, to_jsonb(r) FROM ar2_records r WHERE r.owner_id = v_owner AND r.id = v_id;

    INSERT INTO ar2_events (owner_id, workspace_id, record_id, operation_id, op, old_revision, new_revision, actor_principal_id)
      VALUES (v_owner, v_workspace_id, v_id, p_operation_id, 'create', NULL, 1, v_caller)
      RETURNING seq, xid INTO v_seq, v_evtxid;

    v_receipt := jsonb_build_object('status', 'committed', 'operation_id', p_operation_id, 'id', v_id::text, 'revision', 1,
      'commit_cursor', v_evtxid::text || ':' || v_seq::text, 'replayed', false, 'effective', v_effective_status = 'active',
      'effective_authority', v_effective_authority, 'effective_status', v_effective_status);
    INSERT INTO ar2_operations (principal_id, operation_id, payload_hash, receipt) VALUES (v_caller, p_operation_id, p_payload_hash, v_receipt);
    RETURN v_receipt;
  END IF;

  -- =====================================================================
  -- All non-create ops: resolve target under CAS (existence hiding, R2.3 —
  -- an unreadable/nonexistent id looks identical: not_found)
  -- =====================================================================
  SELECT * INTO v_target FROM ar2_records WHERE owner_id = v_owner AND id = v_id;
  IF NOT FOUND OR NOT ar2_visible(v_target.owner_id, v_target.workspace_id, v_target.project_id, v_target.visibility, v_target.source_principal_id) THEN
    v_receipt := jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'id', v_id::text, 'reason', 'not_found', 'message', 'no such record');
    INSERT INTO ar2_operations (principal_id, operation_id, payload_hash, receipt) VALUES (v_caller, p_operation_id, p_payload_hash, v_receipt);
    RETURN v_receipt;
  END IF;

  -- resolve caller's grant on the TARGET's actual workspace (owner implicitly has all capabilities)
  IF v_caller = v_owner THEN
    v_can_write := true; v_can_approve := v_owner_trusted;
  ELSE
    SELECT * INTO v_grant FROM ar2_active_grant(v_owner, v_target.workspace_id, v_caller);
    v_can_write := COALESCE(v_grant.can_write, false);
    v_can_approve := COALESCE(v_grant.can_approve, false);
    IF NOT FOUND OR v_grant.grantee_principal_id IS NULL THEN
      v_can_write := false; v_can_approve := false;
    END IF;
  END IF;

  IF p_expected_revision IS NOT NULL AND v_target.revision <> p_expected_revision THEN
    v_receipt := jsonb_build_object('status', 'conflict', 'operation_id', p_operation_id, 'id', v_id::text, 'expected_revision', p_expected_revision,
      'current', jsonb_build_object('revision', v_target.revision, 'status', v_target.status, 'updated_at', v_target.updated_at));
    INSERT INTO ar2_operations (principal_id, operation_id, payload_hash, receipt) VALUES (v_caller, p_operation_id, p_payload_hash, v_receipt);
    RETURN v_receipt;
  END IF;

  -- COALESCEd defensively: a NULL here (e.g. a corrupted source jsonb with
  -- no principal_id) must fail closed (not-author), never silently swallow
  -- into the "OR v_caller = v_owner" allow branch below via NULL-with-OR.
  v_is_author := COALESCE(v_target.source_principal_id = v_caller, false);
  v_protected := (v_target.kind = 'constraint') AND (v_target.authority IN ('explicit_user', 'legacy'));
  v_new_revision := v_target.revision + 1;

  IF v_op = 'retract' OR v_op = 'quarantine' THEN
    IF v_protected THEN
      IF NOT (v_owner_trusted AND v_can_approve) THEN
        v_receipt := jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'id', v_id::text, 'reason', 'requires_owner_approval', 'message', v_op || ' on a protected constraint requires owner approval');
        INSERT INTO ar2_operations (principal_id, operation_id, payload_hash, receipt) VALUES (v_caller, p_operation_id, p_payload_hash, v_receipt);
        RETURN v_receipt;
      END IF;
    ELSIF NOT (v_can_write AND (v_is_author OR v_caller = v_owner)) THEN
      v_receipt := jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'id', v_id::text, 'reason', 'forbidden', 'message', v_op || ' requires can_write and (author or owner)');
      INSERT INTO ar2_operations (principal_id, operation_id, payload_hash, receipt) VALUES (v_caller, p_operation_id, p_payload_hash, v_receipt);
      RETURN v_receipt;
    END IF;

    UPDATE ar2_records SET
      status = CASE WHEN v_op = 'retract' THEN 'retracted' ELSE 'quarantined' END,
      revision = v_new_revision, updated_at = now(),
      retracted_at = CASE WHEN v_op = 'retract' THEN now() ELSE retracted_at END,
      retraction_reason = COALESCE(p_cmd ->> 'reason', retraction_reason)
    WHERE owner_id = v_owner AND id = v_id;

  ELSIF v_op = 'confirm' THEN
    IF v_target.status <> 'candidate' THEN
      v_receipt := jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'id', v_id::text, 'reason', 'untrusted_confirm', 'message', 'target is not a candidate');
      INSERT INTO ar2_operations (principal_id, operation_id, payload_hash, receipt) VALUES (v_caller, p_operation_id, p_payload_hash, v_receipt);
      RETURN v_receipt;
    END IF;
    IF NOT (v_owner_trusted AND v_can_approve) THEN
      v_receipt := jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'id', v_id::text, 'reason', 'untrusted_confirm', 'message', 'confirm requires owner_trusted + can_approve');
      INSERT INTO ar2_operations (principal_id, operation_id, payload_hash, receipt) VALUES (v_caller, p_operation_id, p_payload_hash, v_receipt);
      RETURN v_receipt;
    END IF;

    IF v_target.proposal_of IS NOT NULL THEN
      -- rev2.1 D2: confirming a proposal applies its content/applicability
      -- patch to the referenced target, CAS'd on proposal_of.revision.
      DECLARE
        v_ref_id uuid := (v_target.proposal_of ->> 'id')::uuid;
        v_ref_rev integer := (v_target.proposal_of ->> 'revision')::integer;
        v_ref ar2_records%rowtype;
      BEGIN
        SELECT * INTO v_ref FROM ar2_records WHERE owner_id = v_owner AND id = v_ref_id;
        IF NOT FOUND OR v_ref.revision <> v_ref_rev THEN
          v_receipt := jsonb_build_object('status', 'conflict', 'operation_id', p_operation_id, 'id', v_id::text, 'expected_revision', v_ref_rev,
            'current', CASE WHEN FOUND THEN jsonb_build_object('revision', v_ref.revision, 'status', v_ref.status, 'updated_at', v_ref.updated_at) ELSE NULL END);
          INSERT INTO ar2_operations (principal_id, operation_id, payload_hash, receipt) VALUES (v_caller, p_operation_id, p_payload_hash, v_receipt);
          RETURN v_receipt;
        END IF;
        UPDATE ar2_records SET
          content = v_target.content, content_hash = v_target.content_hash,
          applicability = v_target.applicability, revision = v_ref.revision + 1, updated_at = now()
        WHERE owner_id = v_owner AND id = v_ref_id;
        UPDATE ar2_records SET status = 'superseded', revision = v_new_revision, updated_at = now()
        WHERE owner_id = v_owner AND id = v_id;

        INSERT INTO ar2_record_revisions (owner_id, id, revision, snapshot)
          SELECT owner_id, id, revision, to_jsonb(r) FROM ar2_records r WHERE r.owner_id = v_owner AND r.id = v_ref_id;
        INSERT INTO ar2_events (owner_id, workspace_id, record_id, operation_id, op, old_revision, new_revision, actor_principal_id)
          VALUES (v_owner, v_target.workspace_id, v_ref_id, p_operation_id, 'confirm', v_ref_rev, v_ref.revision + 1, v_caller);
      END;
    ELSE
      UPDATE ar2_records SET status = 'active', authority = 'explicit_user', revision = v_new_revision, updated_at = now()
      WHERE owner_id = v_owner AND id = v_id;
    END IF;

  ELSIF v_op = 'exception' THEN
    IF NOT (v_owner_trusted AND v_can_approve) THEN
      v_receipt := jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'id', v_id::text, 'reason', 'requires_owner_approval', 'message', 'exception requires owner_trusted + can_approve');
      INSERT INTO ar2_operations (principal_id, operation_id, payload_hash, receipt) VALUES (v_caller, p_operation_id, p_payload_hash, v_receipt);
      RETURN v_receipt;
    END IF;
    UPDATE ar2_records SET
      exceptions = v_target.exceptions || jsonb_build_array(jsonb_build_object(
        'exception_id', p_cmd ->> 'exception_id', 'target_revision', v_new_revision,
        'applicability', p_cmd -> 'applicability', 'valid_until', p_cmd ->> 'valid_until',
        'approved_by', v_caller, 'approved_at', now(), 'reason', p_cmd ->> 'reason'
      )),
      revision = v_new_revision, updated_at = now()
    WHERE owner_id = v_owner AND id = v_id;

  ELSIF v_op = 'release_dependency' THEN
    IF NOT (v_owner_trusted AND v_can_approve) THEN
      v_receipt := jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'id', v_id::text, 'reason', 'requires_owner_approval', 'message', 'release_dependency requires owner_trusted + can_approve');
      INSERT INTO ar2_operations (principal_id, operation_id, payload_hash, receipt) VALUES (v_caller, p_operation_id, p_payload_hash, v_receipt);
      RETURN v_receipt;
    END IF;
    UPDATE ar2_records SET
      dependency_release = jsonb_build_object(
        'approved_by', v_caller, 'approved_at', now(),
        'redaction_report_ref', p_cmd ->> 'redaction_report_ref', 'source_revisions', v_target.derived_closure
      ),
      revision = v_new_revision, updated_at = now()
    WHERE owner_id = v_owner AND id = v_id;

  ELSIF v_op = 'supersede' THEN
    IF NOT (v_owner_trusted AND v_can_approve) THEN
      v_receipt := jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'id', v_id::text, 'reason', 'requires_owner_approval', 'message', 'supersede requires owner_trusted + can_approve');
      INSERT INTO ar2_operations (principal_id, operation_id, payload_hash, receipt) VALUES (v_caller, p_operation_id, p_payload_hash, v_receipt);
      RETURN v_receipt;
    END IF;
    v_new_id := (p_cmd -> 'replacement' ->> 'id')::uuid;
    v_effective_authority := p_cmd -> 'replacement' ->> 'authority';
    IF v_effective_authority IN ('explicit_user', 'legacy') AND NOT v_owner_trusted THEN
      v_effective_authority := 'agent_inference';
    END IF;
    v_source := jsonb_build_object('principal_id', v_caller, 'captured_at', now(), 'channel', COALESCE(p_cmd -> 'replacement' -> 'source' ->> 'channel', 'sdk'));

    INSERT INTO ar2_records (
      owner_id, id, workspace_id, project_id, kind, visibility, applicability, content, content_hash,
      metadata, authority, status, revision, source, evidence_refs, derived_from, derived_closure, expires_at, supersedes
    ) VALUES (
      v_owner, v_new_id, v_target.workspace_id, NULLIF(p_cmd -> 'replacement' ->> 'project_id', '')::uuid,
      p_cmd -> 'replacement' ->> 'kind', p_cmd -> 'replacement' ->> 'visibility',
      COALESCE(p_cmd -> 'replacement' -> 'applicability', '{}'::jsonb), p_cmd -> 'replacement' ->> 'content',
      encode(sha256(normalize(p_cmd -> 'replacement' ->> 'content', NFC)::bytea), 'hex'),
      ar2_strip_reserved_metadata(p_cmd -> 'replacement' -> 'metadata'), v_effective_authority, 'active', 1, v_source,
      COALESCE((SELECT array_agg(x) FROM jsonb_array_elements_text(COALESCE(p_cmd -> 'replacement' -> 'evidence_refs', '[]'::jsonb)) x), '{}'),
      COALESCE(p_cmd -> 'replacement' -> 'derived_from', '[]'::jsonb), COALESCE(p_cmd -> 'replacement' -> 'derived_from', '[]'::jsonb),
      NULLIF(p_cmd -> 'replacement' ->> 'expires_at', '')::timestamptz,
      jsonb_build_object('id', v_id, 'revision', v_target.revision)
    );
    UPDATE ar2_records SET status = 'superseded', revision = v_new_revision, updated_at = now()
    WHERE owner_id = v_owner AND id = v_id;

    INSERT INTO ar2_record_revisions (owner_id, id, revision, snapshot)
      SELECT owner_id, id, revision, to_jsonb(r) FROM ar2_records r WHERE r.owner_id = v_owner AND r.id = v_new_id;
    INSERT INTO ar2_events (owner_id, workspace_id, record_id, operation_id, op, old_revision, new_revision, actor_principal_id)
      VALUES (v_owner, v_target.workspace_id, v_new_id, p_operation_id, 'supersede', NULL, 1, v_caller);

  ELSIF v_op = 'update' THEN
    v_widening := (p_cmd -> 'patch' ? 'visibility')
      AND ARRAY_POSITION(ARRAY['private', 'project', 'workspace', 'owner_shared'], p_cmd -> 'patch' ->> 'visibility')
        > ARRAY_POSITION(ARRAY['private', 'project', 'workspace', 'owner_shared'], v_target.visibility);
    IF v_target.kind = 'constraint' AND (p_cmd -> 'patch' ? 'applicability' OR p_cmd -> 'patch' ? 'expires_at') THEN
      v_widening := true;
    END IF;

    IF v_protected OR v_widening THEN
      IF v_owner_trusted AND v_can_approve THEN
        UPDATE ar2_records SET
          content = COALESCE(p_cmd -> 'patch' ->> 'content', content),
          content_hash = CASE WHEN p_cmd -> 'patch' ? 'content' THEN encode(sha256(normalize(p_cmd -> 'patch' ->> 'content', NFC)::bytea), 'hex') ELSE content_hash END,
          metadata = CASE WHEN p_cmd -> 'patch' ? 'metadata' THEN ar2_strip_reserved_metadata(p_cmd -> 'patch' -> 'metadata') ELSE metadata END,
          applicability = COALESCE(p_cmd -> 'patch' -> 'applicability', applicability),
          visibility = COALESCE(p_cmd -> 'patch' ->> 'visibility', visibility),
          evidence_refs = COALESCE((SELECT array_agg(x) FROM jsonb_array_elements_text(p_cmd -> 'patch' -> 'evidence_refs') x), evidence_refs),
          expires_at = COALESCE(NULLIF(p_cmd -> 'patch' ->> 'expires_at', '')::timestamptz, expires_at),
          revision = v_new_revision, updated_at = now()
        WHERE owner_id = v_owner AND id = v_id;
      ELSE
        -- rev2.1 D2: store as a proposal revision, target unchanged
        IF p_proposal_id IS NULL THEN
          v_receipt := jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'id', v_id::text, 'reason', 'schema', 'message', 'proposal update requires p_proposal_id (contract.ts:proposalId)');
          INSERT INTO ar2_operations (principal_id, operation_id, payload_hash, receipt) VALUES (v_caller, p_operation_id, p_payload_hash, v_receipt);
          RETURN v_receipt;
        END IF;
        v_proposal_id := p_proposal_id;
        INSERT INTO ar2_records (
          owner_id, id, workspace_id, project_id, kind, visibility, applicability, content, content_hash,
          metadata, authority, status, revision, source, evidence_refs, derived_from, derived_closure, proposal_of
        ) VALUES (
          v_owner, v_proposal_id, v_target.workspace_id, v_target.project_id, v_target.kind, v_target.visibility,
          COALESCE(p_cmd -> 'patch' -> 'applicability', v_target.applicability),
          COALESCE(p_cmd -> 'patch' ->> 'content', v_target.content),
          encode(sha256(normalize(COALESCE(p_cmd -> 'patch' ->> 'content', v_target.content), NFC)::bytea), 'hex'),
          v_target.metadata, 'agent_inference', 'candidate', 1,
          jsonb_build_object('principal_id', v_caller, 'captured_at', now(), 'channel', 'sdk'),
          v_target.evidence_refs, v_target.derived_from, v_target.derived_closure,
          jsonb_build_object('id', v_id, 'revision', v_target.revision)
        )
        ON CONFLICT (owner_id, id) DO NOTHING;

        v_receipt := jsonb_build_object('status', 'committed', 'operation_id', p_operation_id, 'id', v_proposal_id::text, 'revision', 1,
          'commit_cursor', '', 'replayed', false, 'effective', false, 'effective_authority', 'agent_inference', 'effective_status', 'candidate');
        INSERT INTO ar2_operations (principal_id, operation_id, payload_hash, receipt) VALUES (v_caller, p_operation_id, p_payload_hash, v_receipt);
        RETURN v_receipt;
      END IF;
    ELSIF v_can_write AND (v_is_author OR v_caller = v_owner) THEN
      UPDATE ar2_records SET
        content = COALESCE(p_cmd -> 'patch' ->> 'content', content),
        content_hash = CASE WHEN p_cmd -> 'patch' ? 'content' THEN encode(sha256(normalize(p_cmd -> 'patch' ->> 'content', NFC)::bytea), 'hex') ELSE content_hash END,
        metadata = CASE WHEN p_cmd -> 'patch' ? 'metadata' THEN ar2_strip_reserved_metadata(p_cmd -> 'patch' -> 'metadata') ELSE metadata END,
        evidence_refs = COALESCE((SELECT array_agg(x) FROM jsonb_array_elements_text(p_cmd -> 'patch' -> 'evidence_refs') x), evidence_refs),
        expires_at = COALESCE(NULLIF(p_cmd -> 'patch' ->> 'expires_at', '')::timestamptz, expires_at),
        revision = v_new_revision, updated_at = now()
      WHERE owner_id = v_owner AND id = v_id;
    ELSE
      v_receipt := jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'id', v_id::text, 'reason', 'forbidden', 'message', 'update requires can_write and (author or owner)');
      INSERT INTO ar2_operations (principal_id, operation_id, payload_hash, receipt) VALUES (v_caller, p_operation_id, p_payload_hash, v_receipt);
      RETURN v_receipt;
    END IF;

  ELSE
    v_receipt := jsonb_build_object('status', 'rejected', 'operation_id', p_operation_id, 'id', v_id::text, 'reason', 'schema', 'message', 'unknown op ' || v_op);
    INSERT INTO ar2_operations (principal_id, operation_id, payload_hash, receipt) VALUES (v_caller, p_operation_id, p_payload_hash, v_receipt);
    RETURN v_receipt;
  END IF;

  IF v_op NOT IN ('create', 'supersede') THEN
    INSERT INTO ar2_record_revisions (owner_id, id, revision, snapshot)
      SELECT owner_id, id, revision, to_jsonb(r) FROM ar2_records r WHERE r.owner_id = v_owner AND r.id = v_id;
    INSERT INTO ar2_events (owner_id, workspace_id, record_id, operation_id, op, old_revision, new_revision, actor_principal_id)
      VALUES (v_owner, v_target.workspace_id, v_id, p_operation_id, v_op, v_target.revision, v_new_revision, v_caller)
      RETURNING seq, xid INTO v_seq, v_evtxid;
  END IF;

  SELECT * INTO v_target FROM ar2_records WHERE owner_id = v_owner AND id = v_id;
  v_receipt := jsonb_build_object('status', 'committed', 'operation_id', p_operation_id, 'id', v_id::text, 'revision', v_target.revision,
    'commit_cursor', COALESCE(v_evtxid::text || ':' || v_seq::text, ''), 'replayed', false, 'effective', true,
    'effective_authority', v_target.authority, 'effective_status', v_target.status);
  INSERT INTO ar2_operations (principal_id, operation_id, payload_hash, receipt) VALUES (v_caller, p_operation_id, p_payload_hash, v_receipt);
  RETURN v_receipt;
END;
$$;
REVOKE ALL ON FUNCTION ar2_mutate(uuid, jsonb, integer, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ar2_mutate(uuid, jsonb, integer, uuid, text, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 10. Mark migration applied
-- ---------------------------------------------------------------------------

INSERT INTO ar2_schema_version (version) VALUES (2) ON CONFLICT (version) DO NOTHING;
