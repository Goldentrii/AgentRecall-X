#!/usr/bin/env node
/**
 * agent-recall-server — hosted AgentRecall (multi-tenant MCP over HTTP).
 *
 *   agent-recall-server serve        [--port 8787] [--host 127.0.0.1] [--data DIR] [--full]
 *                                    [--quota-mb 100] [--rate-per-min 120]
 *   agent-recall-server token create --uid <uid> [--label TEXT] [--data DIR]
 *   agent-recall-server token list   [--data DIR]
 *   agent-recall-server token revoke <id> [--data DIR]
 *   agent-recall-server usage        [--quota-mb 100] [--data DIR]
 *   agent-recall-server identity link --github-id <n> | --google-sub <s> --uid <uid> [--data DIR]
 *   agent-recall-server identity list [--data DIR]
 *   agent-recall-server oauth list   [--data DIR]
 *   agent-recall-server oauth revoke <grant-id> | --uid <uid> [--data DIR]
 *
 * OAuth (optional): serve [--public-url URL], plus GitHub and/or Google client env vars
 * AR_PUBLIC_URL + AR_OAUTH_{GITHUB,GOOGLE}_CLIENT_ID/_SECRET; see docs/hosted-server.md.
 *
 * DIR = --data or AR_SERVER_DATA (required; no implicit default, so a server
 * can never silently write tenants into the operator's home).
 */
import * as path from "node:path";
import { VERSION } from "agent-recall-core";
import * as fs from "node:fs";
import { startHttpServer, DEFAULT_QUOTA_BYTES, DEFAULT_RATE_PER_MIN, formatMb } from "./serve.js";
import { createToken, listTokens, revokeToken, UID_RE, TokenStoreUnavailableError } from "./tokens.js";
import { dirSize } from "./limits.js";
import { loadOAuthConfig, OAuthConfigError } from "./oauth-config.js";
import { linkIdentity, listIdentities } from "./identities.js";
import { operatorRevokeGrant, operatorRevokeUid, readGrantsFresh, readJsonFreshRevoked } from "./oauth-store.js";

const USAGE = `agent-recall-server v${VERSION}

Usage:
  agent-recall-server serve [--port 8787] [--host 127.0.0.1] [--data DIR] [--full]
                            [--quota-mb 100] [--rate-per-min 120]
  agent-recall-server token create --uid <uid> [--label TEXT] [--data DIR]
  agent-recall-server token list [--data DIR]
  agent-recall-server token revoke <id> [--data DIR]
  agent-recall-server usage [--quota-mb 100] [--data DIR]
  agent-recall-server identity link --github-id <n> --uid <uid> [--data DIR]
  agent-recall-server identity link --google-sub <s> --uid <uid> [--data DIR]
  agent-recall-server identity list [--data DIR]
  agent-recall-server oauth list [--data DIR]
  agent-recall-server oauth revoke <grant-id> [--data DIR]
  agent-recall-server oauth revoke --uid <uid> [--data DIR]

OAuth sign-in with GitHub / Google is on only when a public URL and at least one provider are set:
  --public-url / $AR_PUBLIC_URL            public https origin of this server (the OAuth issuer)
  $AR_OAUTH_GITHUB_CLIENT_ID + $AR_OAUTH_GITHUB_CLIENT_SECRET     callback <public>/authorize/callback/github
  $AR_OAUTH_GOOGLE_CLIENT_ID + $AR_OAUTH_GOOGLE_CLIENT_SECRET     callback <public>/authorize/callback/google
Optional env: AR_OAUTH_REDIRECT_ALLOW (extra redirect URI prefixes, comma-separated),
AR_TRUST_PROXY=1 (trust one proxy hop for client IPs; set it behind Caddy).

Per-user limits: --quota-mb ($AR_SERVER_QUOTA_MB, default 100) and
--rate-per-min ($AR_SERVER_RATE_PER_MIN, default 120); 0 = off.
DIR defaults to $AR_SERVER_DATA. The MCP endpoint is POST /mcp with
'Authorization: Bearer <token>'. Bind to 127.0.0.1 behind a TLS reverse proxy.`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) fail(`${name} needs a value`);
  return v;
}

/** Arguments that are neither a --flag nor a flag's value, so `--data DIR <id>` and `<id> --data DIR` both work. */
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      if (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) i++;
    } else out.push(args[i]);
  }
  return out;
}

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n\n${USAGE}\n`);
  process.exit(2);
}

/** A flag value, else a NON-EMPTY env var (an empty `VAR=` in .env/compose means unset, never "off"). */
function setting(args: string[], name: string, envName: string): string | undefined {
  const v = flag(args, name);
  if (v !== undefined) return v;
  const e = process.env[envName];
  return e === undefined || e.trim() === "" ? undefined : e;
}

/** --quota-mb / AR_SERVER_QUOTA_MB in bytes (decimals allowed; 0 = off). Fails closed on junk. */
function quotaBytes(args: string[]): number {
  const v = setting(args, "--quota-mb", "AR_SERVER_QUOTA_MB");
  if (v === undefined) return DEFAULT_QUOTA_BYTES;
  if (!/^\d+(\.\d+)?$/.test(v.trim())) fail(`--quota-mb must be a number >= 0 (0 = no quota), got "${v}"`);
  const mb = Number(v);
  const bytes = Math.round(mb * 1024 * 1024);
  if (!Number.isFinite(bytes) || (mb > 0 && bytes === 0)) fail(`--quota-mb ${v} is out of range`);
  return bytes;
}

/** --rate-per-min / AR_SERVER_RATE_PER_MIN (integer; 0 = off). Fails closed on junk. */
function ratePerMinute(args: string[]): number {
  const v = setting(args, "--rate-per-min", "AR_SERVER_RATE_PER_MIN");
  if (v === undefined) return DEFAULT_RATE_PER_MIN;
  if (!/^\d{1,9}$/.test(v.trim())) fail(`--rate-per-min must be an integer >= 0 (0 = no rate limit), got "${v}"`);
  return Number(v);
}

function dataDir(args: string[]): string {
  const d = flag(args, "--data") ?? process.env.AR_SERVER_DATA;
  if (!d) fail("no data directory: pass --data DIR or set AR_SERVER_DATA");
  return path.resolve(d);
}

async function main(argv: string[]): Promise<void> {
  const [cmd, sub, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE + "\n");
    return;
  }

  if (cmd === "serve") {
    const args = argv.slice(1);
    const port = Number(flag(args, "--port") ?? process.env.PORT ?? 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail("--port must be 1-65535");
    const host = flag(args, "--host") ?? process.env.AR_SERVER_HOST ?? "127.0.0.1";
    const dir = dataDir(args);
    const quota = quotaBytes(args);
    const rate = ratePerMinute(args);
    let oauth;
    try {
      oauth = loadOAuthConfig({ publicUrl: flag(args, "--public-url") });
    } catch (err) {
      if (err instanceof OAuthConfigError) fail(err.message);
      throw err;
    }
    const server = await startHttpServer({ dataDir: dir, port, host, full: args.includes("--full"), quotaBytes: quota, ratePerMinute: rate, oauth });
    process.stderr.write(
      `agent-recall-server v${VERSION} listening on http://${host}:${port}/mcp (data: ${dir}; ` +
      `quota ${quota > 0 ? formatMb(quota) + "/user" : "off"}; rate ${rate > 0 ? `${rate} req/min/user` : "off"}; ` +
      `oauth ${oauth ? `on, issuer ${oauth.publicUrl.origin}, login: ${Object.keys(oauth.providers).join("+")}` : "off"})\n`,
    );

    // Graceful drain: stop accepting, let in-flight memory writes finish, then
    // exit. Matters in Docker, where node is PID 1 and `docker stop` sends SIGTERM.
    let stopping = false;
    const shutdown = (signal: string): void => {
      if (stopping) return;
      stopping = true;
      process.stderr.write(`agent-recall-server: ${signal} received, draining\n`);
      const force = setTimeout(() => {
        process.stderr.write("agent-recall-server: drain timeout, exiting\n");
        process.exit(1);
      }, 8_000);
      force.unref();
      server.close(() => process.exit(0));
      server.closeIdleConnections();
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    return;
  }

  if (cmd === "token") {
    const args = [sub, ...rest].filter((a): a is string => a !== undefined);
    const dir = dataDir(args);
    if (sub === "create") {
      const uid = flag(args, "--uid");
      if (!uid) fail("token create needs --uid");
      const { token, record } = createToken(dir, uid, flag(args, "--label") ?? "");
      process.stdout.write(
        `Created token ${record.id} for uid "${record.uid}".\n` +
        `Shown ONCE — store it in the agent's MCP config; it cannot be recovered:\n\n  ${token}\n`,
      );
      return;
    }
    if (sub === "list") {
      const rows = listTokens(dir);
      if (rows.length === 0) process.stdout.write("no tokens\n");
      for (const r of rows) {
        process.stdout.write(`${r.id}  uid=${r.uid}  ${r.revoked_at ? "REVOKED " + r.revoked_at : "active"}  created=${r.created_at}  ${r.label}\n`);
      }
      return;
    }
    if (sub === "revoke") {
      const id = rest[0];
      if (!id || id.startsWith("--")) fail("token revoke needs <id> (see token list)");
      if (!revokeToken(dir, id)) fail(`no active token with id ${id}`);
      process.stdout.write(`revoked ${id}\n`);
      return;
    }
    fail(`unknown token subcommand: ${sub ?? "(none)"}`);
  }

  if (cmd === "identity") {
    const args = [sub, ...rest].filter((a): a is string => a !== undefined);
    const dir = dataDir(args);
    if (sub === "link") {
      const gh = flag(args, "--github-id");
      const gg = flag(args, "--google-sub");
      const uid = flag(args, "--uid");
      if (!uid || (gh === undefined) === (gg === undefined)) fail("identity link needs --uid <uid> and exactly one of --github-id <n> or --google-sub <s>");
      const provider = gh !== undefined ? "github" : "google";
      const subject = (gh ?? gg) as string;
      try {
        linkIdentity(dir, provider, subject, uid as string);
      } catch (err) {
        if (err instanceof TokenStoreUnavailableError) throw err;
        fail((err as Error).message);
      }
      process.stdout.write(`linked ${provider} ${subject} -> uid "${uid}"\n`);
      return;
    }
    if (sub === "list") {
      const rows = listIdentities(dir);
      if (rows.length === 0) process.stdout.write("no identity links (default uid is gh-<id> / gg-<sub>)\n");
      for (const r of rows) process.stdout.write(`${r.provider}=${r.subject}  uid=${r.uid}\n`);
      return;
    }
    fail(`unknown identity subcommand: ${sub ?? "(none)"}`);
  }

  if (cmd === "oauth") {
    const args = [sub, ...rest].filter((a): a is string => a !== undefined);
    const dir = dataDir(args);
    if (sub === "list") {
      const grants = readGrantsFresh(dir);
      const revoked = readJsonFreshRevoked(dir);
      if (grants.length === 0) process.stdout.write("no oauth grants\n");
      for (const g of grants) {
        const op = revoked.grants[g.id] ?? (revoked.uids[g.uid] && Date.parse(g.created_at) <= Date.parse(revoked.uids[g.uid]) ? revoked.uids[g.uid] : undefined);
        const state = g.revoked_at ? `REVOKED ${g.revoked_at}` : op ? `REVOKED(operator) ${op}` : "active";
        process.stdout.write(`${g.id}  uid=${g.uid}  client=${g.client_id}  ${state}  created=${g.created_at}  refresh-expires=${new Date(g.refresh.exp).toISOString()}\n`);
      }
      return;
    }
    if (sub === "revoke") {
      const uid = flag(args, "--uid");
      if (uid) {
        try {
          operatorRevokeUid(dir, uid);
        } catch (err) {
          if (err instanceof TokenStoreUnavailableError) throw err;
          fail((err as Error).message);
        }
        process.stdout.write(`revoked every oauth grant of uid "${uid}" created so far; takes effect on the next request\n`);
        return;
      }
      const id = positionals(rest)[0];
      if (!id) fail("oauth revoke needs <grant-id> (see oauth list) or --uid <uid>");
      if (!operatorRevokeGrant(dir, id)) fail(`no oauth grant with id ${id}`);
      process.stdout.write(`revoked grant ${id}; takes effect on the next request\n`);
      return;
    }
    fail(`unknown oauth subcommand: ${sub ?? "(none)"}`);
  }

  if (cmd === "usage") {
    const args = argv.slice(1);
    const dir = dataDir(args);
    const quota = quotaBytes(args);
    const tenantsDir = path.join(dir, "tenants");
    const uids = fs.existsSync(tenantsDir)
      ? fs.readdirSync(tenantsDir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && UID_RE.test(e.name))
          .map((e) => e.name)
          .sort()
      : [];
    if (uids.length === 0) process.stdout.write("no tenants\n");
    const width = Math.max(0, ...uids.map((u) => u.length));
    for (const uid of uids) {
      const bytes = await dirSize(path.join(tenantsDir, uid));
      const share = quota > 0 ? `${Math.round((bytes / quota) * 100)}% of ${formatMb(quota)}` : "no quota";
      process.stdout.write(`${uid.padEnd(width)}  ${bytes} bytes  ${share}\n`);
    }
    return;
  }

  fail(`unknown command: ${cmd}`);
}

main(process.argv.slice(2)).catch((err) => {
  if (err instanceof TokenStoreUnavailableError) {
    process.stderr.write(`error: ${err.message}\nThe file is corrupt or not valid JSON: fix it or remove it (restore from backup if you have one), then retry.\n`);
    process.exit(1);
  }
  process.stderr.write(`fatal: ${(err as Error)?.message ?? String(err)}\n`);
  process.exit(1);
});
