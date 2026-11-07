// packages/core/test/supabase-rls-static.test.mjs
//
// Static guard for the Supabase mirror's security model (2026-11-07).
//
// In Supabase, a table in `public` without Row Level Security is readable AND
// writable through the Data API by anyone holding the project URL + anon key,
// and that key is public by design. AgentRecall's model: every table has RLS
// enabled with NO policies, anon/authenticated hold no privileges, routines
// pin search_path, are SECURITY INVOKER and are not executable by PUBLIC, and
// the client uses the secret key (service_role). This test parses every
// shipped SQL file (plus the SQL embedded in docs/supabase.md) so a new
// table, view or RPC cannot regress.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UPGRADE = "migrations/2026-11-07-enable-rls.sql";
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".claude"]);

function findSqlFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) findSqlFiles(path.join(dir, ent.name), out);
    } else if (ent.name.endsWith(".sql")) {
      out.push(path.join(dir, ent.name));
    }
  }
  return out;
}

/** Drop `-- …` comments so commented-out examples never count as coverage. */
function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, "");
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every dollar-quoted body ($$…$$, $fn$…$fn$) as {start, end, text}, where
 * start/end span the delimiters. Single-quoted literals are skipped while scanning.
 */
function dollarBlocks(sql) {
  const blocks = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      const close = sql.indexOf("'", i + 1);
      i = close < 0 ? sql.length : close + 1;
      continue;
    }
    if (ch === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        const end = close < 0 ? sql.length : close + tag[0].length;
        blocks.push({ start: i, end, text: sql.slice(i + tag[0].length, close < 0 ? sql.length : close) });
        i = end;
        continue;
      }
    }
    i++;
  }
  return blocks;
}

/** The statement starting at `start`: up to the first `;` outside quotes/dollar bodies. */
function statementAt(sql, start, blocks) {
  let i = start;
  while (i < sql.length) {
    const b = blocks.find((blk) => blk.start === i);
    if (b) { i = b.end; continue; }
    if (sql[i] === "'") {
      const close = sql.indexOf("'", i + 1);
      i = close < 0 ? sql.length : close + 1;
      continue;
    }
    if (sql[i] === ";") return sql.slice(start, i + 1);
    i++;
  }
  return sql.slice(start);
}

/** Remove dollar bodies and string literals: what remains of a CREATE FUNCTION is its option list. */
function withoutBodies(stmt) {
  let out = stmt;
  for (const b of dollarBlocks(stmt).reverse()) out = out.slice(0, b.start) + " <body> " + out.slice(b.end);
  return out.replace(/'(?:[^']|'')*'/g, " <body> ");
}

const ROLE_ARRAY = /ARRAY\s*\[\s*'anon'\s*,\s*'authenticated'\s*\]/i;

/**
 * True when a REVOKE whose object list names `name` targets anon: either
 * literally (`FROM anon`) or via `%I` inside a DO block that loops over
 * ARRAY['anon','authenticated'] (checked per enclosing block, not file-wide).
 */
function revokedFromAnon(sql, blocks, kindRe, nameRe) {
  const re = new RegExp(`REVOKE\\s+(?:ALL|EXECUTE)(?:\\s+PRIVILEGES)?\\s+ON\\s+(?:${kindRe})\\s+([\\s\\S]+?)\\s+FROM\\s+([^;']+)`, "gi");
  for (const m of sql.matchAll(re)) {
    if (!nameRe.test(m[1])) continue;
    const target = m[2];
    if (/\banon\b/i.test(target) && /\bauthenticated\b/i.test(target)) return true;
    if (/%I/.test(target)) {
      const block = blocks.find((b) => b.start < m.index && m.index < b.end);
      if (block && ROLE_ARRAY.test(block.text)) return true;
    }
  }
  return false;
}

/** Return human-readable violations, plus the objects found, for one SQL text. */
function auditSql(rawSql) {
  const sql = stripComments(rawSql);
  const blocks = dollarBlocks(sql);
  const insideBlock = (idx) => blocks.some((b) => b.start < idx && idx < b.end);
  const violations = [];

  const rels = [...sql.matchAll(
    /CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?(TABLE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?/gi,
  )].filter((m) => !insideBlock(m.index));
  const tables = [];
  for (const m of rels) {
    const kind = m[1].toUpperCase().replace(/\s+/g, " ");
    const name = m[2];
    const nameInList = new RegExp(`(?:^|[\\s,.("'])${esc(name)}(?:$|[\\s,)"'])`, "i");
    if (kind === "MATERIALIZED VIEW") {
      violations.push(`materialized view ${name}: not allowed (RLS cannot apply to it)`);
      continue;
    }
    if (kind === "VIEW") {
      const stmt = statementAt(sql, m.index, blocks);
      if (!/security_invoker\s*=\s*(?:true|on)/i.test(stmt)) {
        violations.push(`view ${name}: must be WITH (security_invoker = true), or it bypasses RLS on its base tables`);
      }
    } else {
      tables.push(name);
      const rls = new RegExp(`ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(?:public\\.)?"?${esc(name)}"?\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, "i");
      if (!rls.test(sql.slice(m.index))) violations.push(`table ${name}: no ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY after its CREATE TABLE`);
    }
    if (!revokedFromAnon(sql, blocks, "TABLE", nameInList)) {
      violations.push(`${kind.toLowerCase()} ${name}: privileges are never revoked from anon and authenticated`);
    }
  }

  const routines = [...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\s+(?:public\.)?"?(\w+)"?\s*\(/gi)]
    .filter((m) => !insideBlock(m.index));
  const functions = [];
  for (const m of routines) {
    const kind = m[1].toLowerCase();
    const name = m[2];
    functions.push(name);
    const options = withoutBodies(statementAt(sql, m.index, blocks));
    if (!/\bSET\s+search_path\b/i.test(options)) violations.push(`${kind} ${name}: search_path is not pinned`);
    if (/\bSECURITY\s+DEFINER\b/i.test(options)) violations.push(`${kind} ${name}: SECURITY DEFINER is not allowed (it bypasses RLS for its caller)`);
    const sig = new RegExp(`(?:^|[\\s,.("'])${esc(name)}\\s*\\(`, "i");
    const revokePublic = new RegExp(`REVOKE\\s+(?:ALL|EXECUTE)(?:\\s+PRIVILEGES)?\\s+ON\\s+(?:FUNCTION|PROCEDURE|ROUTINE)\\s+[^;]*?${esc(name)}\\s*\\([^;]*?\\bFROM\\s+PUBLIC\\b`, "i");
    if (!revokePublic.test(sql)) violations.push(`${kind} ${name}: EXECUTE is never revoked from PUBLIC`);
    if (!revokedFromAnon(sql, blocks, "FUNCTION|PROCEDURE|ROUTINE", sig)) {
      violations.push(`${kind} ${name}: EXECUTE is never revoked from anon and authenticated`);
    }
  }
  return { violations, tables, functions };
}

function docsSqlBlocks() {
  const md = fs.readFileSync(path.join(REPO, "docs/supabase.md"), "utf-8").replace(/\r\n/g, "\n");
  return [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
}

function sqlArrayLiteral(sql, varName) {
  const m = new RegExp(`${varName}\\s+text\\[\\]\\s*:=\\s*ARRAY\\[([^\\]]*)\\]`, "i").exec(sql);
  assert.ok(m, `${varName} array not found in ${UPGRADE}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe("Supabase SQL security (static)", () => {
  const files = findSqlFiles(REPO);
  const rel = (f) => path.relative(REPO, f).replace(/\\/g, "/");

  it("finds the shipped SQL files", () => {
    const names = files.map(rel);
    for (const expected of ["migration.sql", UPGRADE, "meta/scripts/dashboard-migration.sql"]) {
      assert.ok(names.includes(expected), `expected to scan ${expected}; scanned: ${names.join(", ")}`);
    }
  });

  for (const file of files) {
    it(`${rel(file)}: tables have RLS + no anon grants; routines pinned, invoker, not PUBLIC-executable`, () => {
      assert.deepEqual(auditSql(fs.readFileSync(file, "utf-8")).violations, []);
    });
  }

  it("migration.sql covers the tables and RPCs the client uses", () => {
    const { tables, functions } = auditSql(fs.readFileSync(path.join(REPO, "migration.sql"), "utf-8"));
    for (const t of ["ar_entries", "ar_insights", "ar_sync_state"]) assert.ok(tables.includes(t), t);
    for (const f of ["ar_semantic_search", "ar_insight_search", "ar_cross_project_search"]) assert.ok(functions.includes(f), f);
  });

  it("docs/supabase.md embeds migration.sql verbatim (no drift between the two install paths)", () => {
    const mig = fs.readFileSync(path.join(REPO, "migration.sql"), "utf-8").replace(/\r\n/g, "\n").trim();
    const blocks = docsSqlBlocks().map((b) => b.trim());
    assert.ok(blocks.includes(mig), "the ```sql block in docs/supabase.md Step 2 must equal migration.sql");
    for (const b of blocks) assert.deepEqual(auditSql(b).violations, [], "every SQL block in docs/supabase.md must pass the audit");
  });

  it("upgrade migration's allowlist covers every table and function any shipped SQL creates", () => {
    const up = stripComments(fs.readFileSync(path.join(REPO, UPGRADE), "utf-8"));
    const knownTables = sqlArrayLiteral(up, "known_tables");
    const knownFunctions = sqlArrayLiteral(up, "known_functions");
    const sources = [...files.map((f) => fs.readFileSync(f, "utf-8")), ...docsSqlBlocks()];
    for (const src of sources) {
      const { tables, functions } = auditSql(src);
      for (const t of tables) assert.ok(knownTables.includes(t), `${t} is created somewhere but missing from known_tables in ${UPGRADE}`);
      for (const f of functions) assert.ok(knownFunctions.includes(f), `${f} is created somewhere but missing from known_functions in ${UPGRADE}`);
    }
  });

  it("upgrade migration locks down the allowlisted objects and reports other ar_* objects", () => {
    const sql = stripComments(fs.readFileSync(path.join(REPO, UPGRADE), "utf-8"));
    assert.match(sql, /ALTER TABLE public\.%I ENABLE ROW LEVEL SECURITY/);
    assert.match(sql, /REVOKE ALL ON TABLE public\.%I FROM %I/);
    assert.match(sql, ROLE_ARRAY);
    assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.%I TO service_role/);
    assert.match(sql, /ALTER FUNCTION %s SET search_path = public, extensions, pg_temp/);
    assert.match(sql, /REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC/);
    assert.match(sql, /RAISE NOTICE 'not secured by this migration/);
    assert.doesNotMatch(sql, /tablename\s+LIKE\s+'ar/i, "no wildcard table sweep: it could hit another app's ar_* tables");
  });

  it("no shipped SQL creates a policy (RLS stays deny-all for anon/authenticated)", () => {
    for (const file of files) {
      assert.doesNotMatch(stripComments(fs.readFileSync(file, "utf-8")), /CREATE\s+POLICY/i, rel(file));
    }
  });

  // Self-tests: the auditor must catch the regressions it guards against.
  it("auditor flags a table without RLS, a SECURITY DEFINER RPC and an unpinned search_path", () => {
    const bad = `
      CREATE TABLE IF NOT EXISTS ar_new (id uuid);
      -- ALTER TABLE ar_new ENABLE ROW LEVEL SECURITY;  (commented out must not count)
      CREATE OR REPLACE FUNCTION ar_leak() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
    `;
    const v = auditSql(bad).violations.join("\n");
    assert.match(v, /table ar_new: no ALTER TABLE ar_new ENABLE ROW LEVEL SECURITY/);
    assert.match(v, /table ar_new: privileges are never revoked/);
    assert.match(v, /function ar_leak: SECURITY DEFINER/);
    assert.match(v, /function ar_leak: search_path is not pinned/);
    assert.match(v, /function ar_leak: EXECUTE is never revoked from PUBLIC/);
  });

  it("auditor sees views, materialized views, unlogged tables, procedures and options after the body", () => {
    const bad = `
      CREATE VIEW ar_v AS SELECT * FROM ar_entries;
      CREATE MATERIALIZED VIEW ar_mv AS SELECT 1;
      CREATE UNLOGGED TABLE ar_u (id int);
      CREATE PROCEDURE ar_p() LANGUAGE sql AS $p$ SELECT 1 $p$;
      CREATE FUNCTION ar_after() RETURNS int AS $fn$ SELECT 1 $fn$ LANGUAGE sql SECURITY DEFINER;
    `;
    const v = auditSql(bad).violations.join("\n");
    assert.match(v, /view ar_v: must be WITH \(security_invoker = true\)/);
    assert.match(v, /materialized view ar_mv: not allowed/);
    assert.match(v, /table ar_u: no ALTER TABLE ar_u ENABLE ROW LEVEL SECURITY/);
    assert.match(v, /procedure ar_p: search_path is not pinned/);
    assert.match(v, /function ar_after: SECURITY DEFINER/);
  });

  it("auditor accepts options after the body and checks revokes per object, not file-wide", () => {
    const good = `
      CREATE FUNCTION ar_ok() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql SET search_path = public;
      REVOKE EXECUTE ON FUNCTION ar_ok() FROM PUBLIC;
      CREATE TABLE ar_a (id int);
      ALTER TABLE ar_a ENABLE ROW LEVEL SECURITY;
      CREATE TABLE ar_b (id int);
      ALTER TABLE ar_b ENABLE ROW LEVEL SECURITY;
      DO $$ DECLARE r text; BEGIN
        FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
          EXECUTE format('REVOKE ALL ON TABLE ar_a FROM %I', r);
          EXECUTE format('REVOKE EXECUTE ON FUNCTION ar_ok() FROM %I', r);
        END LOOP;
      END $$;
    `;
    const v = auditSql(good).violations;
    assert.deepEqual(v, ["table ar_b: privileges are never revoked from anon and authenticated"]);
  });
});
