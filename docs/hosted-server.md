# Hosted AgentRecall server

One server, many users, any MCP agent. Each user gets a **token**. Any MCP client configured with the server URL + that token sees the same memory: the same owner card, HARD RULES, state card, corrections and recall. Users don't need a local install or hooks.

> Status: v1 plus optional OAuth 2.1. By default a static token is the only credential. If you configure OAuth (see [Connect with OAuth](#connect-with-oauth)), users can also sign in with GitHub or Google. Storage is the normal AgentRecall file store, one folder per user, on the server's disk.

## How it works

```
agent ──HTTPS──▶ TLS proxy ──▶ agent-recall-server :8787   POST /mcp   (Authorization: Bearer ar_…)
                                   token → uid → DATA/tenants/<uid>/   (fresh MCP server per request)
```

- **Isolation:**
  - Every request runs inside a tenant scope (`withTenant`).
  - Strict tenant mode makes any code path that loses that scope throw instead of touching another store.
  - Inside a tenant, AgentRecall switches off everything that belongs to the server's OS user or process:
    - the `~/.claude/projects` legacy scan
    - Supabase and cloud embeddings (process-wide singletons and env overrides)
    - cwd-based project detection
    - the process session id
  - Responses never show the server's filesystem. Store paths appear as `hosted:/projects/<slug>/…`, and every tool, resource and prompt result, including error messages, has the tenant root scrubbed before it leaves the server.
- **Lifecycle:** remote clients have no AgentRecall hooks. The server always sends the agent-driven (Tier B) instructions, so the agent calls `session_start` first and `session_end` before stopping.
- **Projects:** a tool called with `project: "auto"` (the default) uses the user's `main` project. Agents can pass an explicit project slug to keep separate projects.
- **Stateless:** each MCP message is an independent `POST /mcp` with a JSON response. `GET` / `DELETE /mcp` return 405.

## Run it

### One-command deploy on a fresh Ubuntu 24.04 box (recommended)

`deploy/hosted/` contains a Compose stack: the server, plus Caddy for automatic HTTPS. `setup.sh` installs Docker from Ubuntu's own repositories, adds swap, clones this repo, and starts the stack.

1. Create the box (for example AWS Lightsail: Ubuntu 24.04, dual-stack, 1 GB RAM), attach a static IP, and open TCP 80 and 443.
2. Point your domain's DNS `A` record at the static IP.
3. On the box (for example in Lightsail's browser SSH), pin the full commit SHA you reviewed, and read the script before running it:
   ```bash
   SHA=<full commit sha>
   curl -fsSL "https://raw.githubusercontent.com/Goldentrii/AgentRecall-X/$SHA/deploy/hosted/setup.sh" -o setup.sh
   less setup.sh
   AR_DOMAIN=recall.example.com AR_REF=$SHA bash setup.sh
   ```
   The script refuses to start if the domain's DNS doesn't point at this box yet. That way it never burns Let's Encrypt's rate limit; `AR_FORCE=1` overrides the check. On a brand-new box it first waits for the boot-time package updater to finish.
4. Create a token per user:
   ```bash
   cd /opt/agent-recall/deploy/hosted && sudo docker compose exec server agent-recall-server token create --uid alice --label "alice laptop"
   ```

To update, re-run `setup.sh` with a newer `AR_REF`. **Never run `docker compose down -v`**: `-v` deletes every user's memory and the TLS certificates. Optional settings go in `deploy/hosted/.env`: `AR_SERVER_QUOTA_MB` and `AR_SERVER_RATE_PER_MIN`. Data lives in the `agent-recall_ar-data` Docker volume; back it up, or turn on the host's automatic snapshots.

### Restricted deploy key (let an agent deploy, nothing else)

`deploy/hosted/remote.sh` is a forced command for one SSH key. Whoever holds that key, for example a coding agent on your laptop, can run exactly four requests and gets no shell:

| Request | Does |
|---|---|
| `deploy <40-hex commit>` | `setup.sh` at that commit. The commit must be one of the last 30 commits of `main` (checked with GitHub's compare API; fails closed if GitHub is unreachable), so nothing unmerged reaches the server and nobody can roll it back to an old version. One deploy at a time; a second is refused while one runs. |
| `status` | Deployed commit, container status, `/healthz` |
| `logs [N]` | Last N server log lines (default 50, max 500) |
| `usage` | Storage per user |

Anything else (a login shell, `scp`, other commands, shell syntax) is refused.

Set it up once:

1. On the machine that will deploy, create a dedicated key: `ssh-keygen -t ed25519 -f ~/.ssh/agent_recall_deploy -N "" -C agent-recall-deploy`.
2. On the server, install the script and bind the key's **public** half to it:
   ```bash
   SHA=<commit on main>
   curl -fsSL "https://raw.githubusercontent.com/Goldentrii/AgentRecall-X/$SHA/deploy/hosted/remote.sh" -o remote.sh
   sudo install -m 755 remote.sh /usr/local/bin/agent-recall-remote
   printf '\nrestrict,command="/usr/local/bin/agent-recall-remote" %s\n' "<contents of agent_recall_deploy.pub>" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
   ```
3. Use it: `ssh -i ~/.ssh/agent_recall_deploy ubuntu@<server> status` (or `deploy <sha>`, `logs 100`, `usage`).

The key has no passphrase so an agent can use it unattended; what it can do is limited to the four requests above. Since `deploy` runs the repo's own `setup.sh` with sudo, the real gate is that only reviewed code reaches `main` (protect the branch). To revoke, delete that line from `~/.ssh/authorized_keys`. The script's tests: `bash deploy/hosted/remote.test.sh` (Linux, needs `flock`). Re-run step 2's `install` line with a newer commit to update the script.

### Change the domain, keep the old one working

```bash
sudo bash /opt/agent-recall/deploy/hosted/domain-switch.sh new.example.com old.example.com www.new.example.com
```

The first name becomes the primary (`AR_DOMAIN`, and `AR_PUBLIC_URL` when sign-in is on). The others (at most 4) are aliases, stored as `AR_DOMAIN_ALIAS`: on an alias, `/mcp` and `/healthz` are proxied, so agents configured with the old address and a static token keep working, and every other path redirects to the primary. `/mcp` is proxied on purpose: a client may drop its `Authorization` header when it follows a redirect to another host.

The script checks that every name's DNS A record points at the box, shows what will change, asks you to type the new domain, keeps the previous settings in `.env.before-domain-switch.<UTC time>` (mode 600, one file per run, never overwritten), restarts the stack and checks the primary and each alias. It prints the rollback command.

What changes for users:

- Static tokens keep working on the primary and on every alias.
- Everyone who signed in with GitHub or Google signs in once more, at the new address. Grants are bound to the address they were issued for, and a refresh does not move them.
- Sign-in does not work through an alias. Change the address in the agent's config to the primary.
- A GitHub OAuth app has one callback URL: change it to `https://<new domain>/authorize/callback/github` at the same moment. The script prints the exact URL before it asks you to confirm.

Keep the old name's DNS record pointing at the box for as long as it is an alias: Caddy needs it to renew that name's certificate. Run the script again without the old name to drop it. The restricted deploy key cannot run this script or change these settings. Deploying a commit from before alias support existed drops the aliases without an error (its Caddyfile ignores `AR_DOMAIN_ALIAS`), so do not roll back past that commit while an alias is in use.

Tests: `bash deploy/hosted/domain-switch.test.sh` (stubs, no server) and `bash deploy/hosted/caddy.test.sh` (real Caddy in Docker).

### After a deploy

Run the smoke check from any machine with Node 18+ (no install, no dependencies). It only reads, plus one unauthenticated `POST /mcp` that must be refused:

```bash
node deploy/hosted/smoke.mjs --base https://agentrecallx.com --expect-version 3.5.3
node deploy/hosted/smoke.mjs --base https://agentrecallx.com --alias https://recall.aiakada.com   # also checks the alias
```

One `PASS` or `FAIL` line per check, with the evidence; exit 1 on any `FAIL`. It checks `/healthz` (and the version, with `--expect-version`), every public page and film plate (status and content type), that `/connect` answers without a session, that the CSP of `/` allows exactly the sha256 of the page's one inline style and one inline script, the security headers (HSTS, `nosniff`, `frame-ancestors`), that `POST /mcp` without credentials is a 401 pointing at the OAuth metadata, the two `/.well-known/oauth-*` documents, and with `--alias` that `/healthz` and `/mcp` are proxied while every other path 308-redirects to the primary. `node --test deploy/hosted/smoke.test.mjs` proves each check against a fake server; CI runs it in the `deploy-kit` job.

A change to `deploy/hosted/Caddyfile` restarts Caddy during the deploy, for about a second. The Caddyfile is a single-file bind mount that compose never notices changing, so `setup.sh` (and `domain-switch.sh`) export its sha256 as `AR_CADDYFILE_SHA`, which `compose.yaml` puts in a label on the `caddy` service: the label changes exactly when the file does, and compose then recreates Caddy; with the file unchanged Caddy keeps running. Certificates persist in the `caddy-data` volume, so nothing is re-issued. Run `docker compose up` by hand only through `setup.sh` or `sudo env AR_CADDYFILE_SHA=$(sha256sum Caddyfile | cut -d" " -f1) docker compose up -d`, otherwise the label falls back to `unset` and Caddy restarts once. `bash deploy/hosted/compose-label.test.sh` proves the label (CI: `deploy-kit`).

### Docker (single container, bring your own proxy)

```bash
docker build -f Dockerfile.server -t agent-recall-server .
docker run -d --name agent-recall -p 127.0.0.1:8787:8787 -v ar-data:/data --restart unless-stopped agent-recall-server
```

### Without Docker

```bash
npm ci && npm run build
AR_SERVER_DATA=/srv/agent-recall node packages/mcp-server/dist/http/cli.js serve --port 8787
```

The server binds `127.0.0.1` by default. Override this with `--host` or `AR_SERVER_HOST`; the Docker image sets `0.0.0.0` inside the container.

### TLS (required for anything but localhost)

The token travels in a header, so never expose plain HTTP. Example with Caddy:

```
mcp.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

## Issue tokens

```bash
agent-recall-server token create --uid alice --label "alice laptop"   # prints the token ONCE
agent-recall-server token list
agent-recall-server token revoke <id>                                 # takes effect on the next request
agent-recall-server usage                                             # storage per user vs quota
```

In Docker, prefix each command with `docker exec agent-recall`.

- `uid`: lowercase letters, digits and dashes, 3–40 chars. It names the user's folder (`DATA/tenants/<uid>`). Several tokens can share a uid, for example one per device or agent; revoking one doesn't affect the others.
- Only SHA-256 hashes of tokens are stored (`DATA/_server/tokens.json`, mode 0600).

## Connect an agent

Use `https://mcp.example.com/mcp` and the user's token.

**Claude Code**
```bash
claude mcp add --transport http agent-recall https://mcp.example.com/mcp --header "Authorization: Bearer ar_…"
```

**Cursor** (`~/.cursor/mcp.json`)
```json
{ "mcpServers": { "agent-recall": { "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer ar_…" } } } }
```

**Any client with only stdio support** (Claude Desktop config, older clients). Bridge through `mcp-remote`:
```json
{ "mcpServers": { "agent-recall": { "command": "npx", "args": ["-y", "mcp-remote", "https://mcp.example.com/mcp", "--header", "Authorization: Bearer ${AR_TOKEN}"], "env": { "AR_TOKEN": "ar_…" } } } }
```

**Codex and other clients:** use their Streamable-HTTP MCP setting with the URL above and an `Authorization: Bearer` header. Check the client's docs for the exact key names.

claude.ai custom connectors need OAuth: see the next section. Without OAuth configured, use one of the options above.

## Connect with OAuth

Optional. AgentRecall has its **own accounts**, tied to a **GitHub** or **Google** sign-in. **Sign-up is invite-only by default**: only accounts the operator has invited with `identity link` can sign in. An OAuth-capable MCP client (Claude Code, claude.ai custom connectors, Cursor, Codex) connects with just the URL: it opens a browser, the user picks "Continue with GitHub" or "Continue with Google", and the client receives tokens bound to that user's tenant. The server is its own OAuth authorization server. AgentRecall never sees or stores a password; GitHub and Google only tell it a stable numeric account id. Static `ar_` tokens keep working unchanged.

### Turn it on

OAuth is **off** unless a public URL and at least one provider are configured; otherwise the server behaves exactly as without OAuth. A half-configuration (a lone client id or secret, a public URL without a provider, a provider without a public URL) stops the server from starting.

| Setting | Meaning |
|---|---|
| `AR_PUBLIC_URL` / `--public-url` | Public origin of this server, e.g. `https://recall.example.com`. This is the OAuth issuer. Must be https (http only for localhost), origin only. |
| `AR_OAUTH_GITHUB_CLIENT_ID`, `AR_OAUTH_GITHUB_CLIENT_SECRET` | A GitHub OAuth app. Authorization callback URL: `<AR_PUBLIC_URL>/authorize/callback/github`. No scopes are needed. |
| `AR_OAUTH_GOOGLE_CLIENT_ID`, `AR_OAUTH_GOOGLE_CLIENT_SECRET` | A Google OAuth client (type "Web application"). Authorized redirect URI: `<AR_PUBLIC_URL>/authorize/callback/google`. Only the `openid` scope is used. |
| `AR_OAUTH_SIGNUP` | `invite` (default; empty also means invite) or `open`. Invite: an account that is not linked gets a "not invited" page showing its provider id, nothing is created, and the server logs the id and the `identity link` command to invite it. Open: anyone with a GitHub/Google account gets a tenant with the default quota. Any other value stops the server from starting. |
| `AR_PRIVACY_URL` | Optional. An https link to your privacy policy, shown under the sign-in buttons. Required in practice before you open sign-up to the public (GDPR Art. 13). `PRIVACY.md` in this repo is the policy of the reference deployment at agentrecallx.com; adapt it for your own server. An invalid value stops the server from starting. |
| `AR_OAUTH_REDIRECT_ALLOW` | Optional. Extra allowed client redirect URI prefixes, comma-separated (for example `https://vscode.dev/redirect`). Matched at a URL boundary. |
| `AR_TRUST_PROXY=1` | `1`/`true`/`yes`/`on` or `0`/`false`/`no`/`off` (empty = off; anything else stops the server from starting). Trust one proxy hop for the client IP. Set it behind Caddy (the deploy kit does); otherwise all users share one IP for rate limits (the server logs one warning when it sees `X-Forwarded-For` without it). Only set it behind a proxy that **overwrites** `X-Forwarded-For` (Caddy does) and never with the server port reachable directly: a client could then forge the header and dodge every per-IP limit. |

Client secrets are read from the environment only (never from command-line flags) and are never logged or sent to the browser. With the deploy kit, put these variables in `deploy/hosted/.env` and restart the stack.

With the deploy kit, `sudo bash /opt/agent-recall/deploy/hosted/oauth-setup.sh` does this for GitHub: it asks for the Client ID and the client secret (hidden input, terminal paste markers stripped), writes them and `AR_PUBLIC_URL` to `.env` (mode 600, other settings kept), restarts the stack and checks OAuth discovery. Then invite your own account: `sudo docker compose exec server agent-recall-server identity link --github-id <id> --uid <uid>`.

### Connect

```bash
claude mcp add --transport http agent-recall https://recall.example.com/mcp
# then run /mcp inside Claude Code and choose "Authenticate"
```

claude.ai: add a custom connector with the URL `https://recall.example.com/mcp`. Other clients: use their Streamable-HTTP MCP setting with the URL and no header; they discover OAuth from the `WWW-Authenticate: ... resource_metadata=` header on the 401.

### How it works

- Client endpoints: `/.well-known/oauth-protected-resource[/mcp]`, `/.well-known/oauth-authorization-server`, `POST /register` (dynamic client registration), `/authorize`, `POST /token`, `POST /revoke`. Browser endpoints: `POST /authorize/start`, `GET /authorize/callback/{github,google}`.
- Sign-in: `/authorize` shows the app name, where it returns to, and one button per configured provider, and sets a short-lived `HttpOnly` cookie per sign-in (`ar_oauth_<12 hex>`, `SameSite=Lax`, scoped to `/authorize`, so parallel sign-ins in one browser do not clash) that ties the whole sign-in to that browser. The button posts to `/authorize/start`, which redirects to the provider with a one-time `state` and PKCE (plus a nonce for Google). The callback only proceeds if the `state` is ours and unused, belongs to that provider, and the cookie matches. If the user declines, the client gets `error=access_denied` with its own `state`.
- PKCE (S256) is required toward clients. Access tokens (`aro_…`) last 1 hour; refresh tokens (`arr_…`) last 30 days and rotate on every use. A grant also ends 90 days after sign-in however often it is refreshed; the user then signs in again.
- Reusing a rotated refresh token revokes the whole grant. The one exception: the same client may present its just-rotated refresh token once more within 10 seconds (it lost the response) and gets fresh tokens instead of being signed out.
- Each user keeps at most 20 grants (one per signed-in app or device); a new sign-in beyond that ends the oldest one (by sign-in time, not last use). Every token change is written to disk before it takes effect, so a failed write never signs anyone out.
- Provider accounts are only checked at sign-in. To cut off a user immediately, run `agent-recall-server oauth revoke --uid <uid>`; otherwise their grants live until the 90-day limit.
- Only SHA-256 hashes of tokens are stored (`DATA/_server/oauth-grants.json`, mode 0600). Provider tokens are used once to read the account id and then discarded.
- Redirects are limited to loopback (`http://127.0.0.1|localhost|[::1]:*`), `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`, Cursor's `cursor://anysphere.cursor-retrieval/…`, and `AR_OAUTH_REDIRECT_ALLOW` prefixes. Anything else is refused at registration and again at `/authorize`. Prefixes are matched against the normalized URL, and URIs containing `%2e`, `%2f`, `%5c` or `.`/`..` path segments are refused.
- A client may register at most 3 redirect URIs (each up to 1024 chars); its name is capped at 100 chars and stripped of control and bidi characters. `/register` allows 20 per hour per IP.
- One client address (IPv4, or IPv6 /64) may have at most 30 sign-ins open at once; beyond that `/authorize` answers 429. `/authorize/start` and the callback are each limited to 10 hits per 10 minutes per client IP (IPv6 counted per /64) and 300 overall; only requests carrying a live request id or state spend the overall budget.
- Provider calls have a 10 s timeout and never follow redirects. If a provider is down or answers something unexpected, the user sees a generic message and can try again; static tokens are unaffected.

### Accounts and tenants

Invite an account with `identity link`. Without `--uid` it gets its own tenant, `gh-<github id>` or `gg-<google sub>`; with `--uid` it signs into an existing tenant (for example one that already has a static token). You find a GitHub id at `https://api.github.com/users/<login>`; for any account, the "not invited" page and the server log show the id after one sign-in attempt.

```bash
agent-recall-server identity link --github-id 42                  # invite: tenant gh-42
agent-recall-server identity link --github-id 42 --uid alice      # or: sign into the existing tenant alice
agent-recall-server identity link --google-sub 1100000000000000000 --uid alice
agent-recall-server identity unlink --github-id 42                # un-invite (then: oauth revoke --uid <uid> to end its sign-ins now)
agent-recall-server identity list
```

A link takes effect on the next sign-in. Sign-ins made before a re-link keep their old tenant until they end; run `oauth revoke --uid <old uid>` to move them now.

The `gh-`/`gg-` prefixes are reserved: `token create --uid gh-…` is refused, `identity link` onto another account's `gh-`/`gg-` uid is refused, and OAuth refuses to start while an active static token uses such a uid (revoke it and issue one for a plain uid).

### Operate

```bash
agent-recall-server oauth list                    # grants: id, uid, client, state, expiry
agent-recall-server oauth revoke <grant-id>       # one grant
agent-recall-server oauth revoke --uid alice      # every grant of that uid created so far; new sign-ins still work
```

Revocation takes effect on the next request. The server logs `oauth login github=<id> uid=<uid>` the first time an account signs in (no tokens, no email).

- A restart aborts sign-ins in progress (they live in memory); clients just retry. Issued tokens survive restarts.

## Corrections need the owner

On the hosted server an agent can **propose** a correction but cannot **activate** one.

Why: a correction is loaded by every agent of that user at `session_start`, and a P0 shows up under "HARD RULES (always follow, no exceptions)". Whoever holds a user's token, or steers an agent that does (for example through text the agent read), could otherwise plant a rule for all of that user's agents.

- Every `human_correction` sent through `check` is staged, including the structured `{rule, why, applies_when}` form and `pending_id`. The tool answers `status: "staged"` and tells the agent it is waiting for the owner.
- Staged text is not loaded anywhere: not in HARD RULES, `watch_for` or recall. `session_start` only shows a count ("N proposed corrections await the owner's confirmation").
- Only the owner activates one: the user themselves on the [review page](#the-review-page-owners-approve-their-own) (when OAuth is on), or the operator with the CLI:

```bash
agent-recall-server corrections list                            # counts per user: ready / incomplete
agent-recall-server corrections list --uid alice [--limit 20]   # that user's proposals in full: rule, why, applies_when (as JSON)
agent-recall-server corrections approve <id> --uid alice        # active from the next session_start
agent-recall-server corrections reject  <id> --uid alice
```

  Add `--project <slug>` for a project other than `main`. In Docker, prefix each command with `docker exec agent-recall` (deploy kit: `sudo docker compose exec server`).
- `list` marks each row `ready` (complete structured form, can be approved) or `incomplete` (a plain-string capture; ask the agent to re-submit it in the structured form, or reject it). Read the rule before approving: approval is the only check.
- **An id always means exactly the text `list` shows.** A `ready` row is printed in full (rule, why, applies_when) and never changes: re-submitting the same rule with any difference, even one symbol, creates a separate row with its own id. The id ends in a 128-bit digest of that content, a staged row is never overwritten, and `approve` refuses a row whose id or stored digest does not match its content. `approve` activates what that id showed, at the severity it showed.
- Without `--uid`, `list` prints one line of counts per user and no rule text, so one user's proposals cannot bury another's. With `--uid` it prints up to `--limit` rows (default 20, max 200), ready proposals first, and says how many it left out.
- Insights an agent saves through `session_end` are memory, not rules: they are shown only in the full-mode "Insights" list and never under HARD RULES, behaviour policies or `watch_for`. They are not gated.
- Proposal text is reduced to visible characters before it is stored: control characters, newlines, zero-width and bidi characters and Unicode tag characters become a space. A rule over 200 characters, a why over 600, or an `applies_when` with more than 8 entries or an entry over 60 characters is refused, not truncated (a staged row over these caps is shown as `incomplete` and cannot be approved). `list` prints anything unexpected as an escape such as `\u{200b}`.
- `check`'s `delta` is not recorded on the hosted server, so it cannot feed `watch_for` or auto-promoted insights.
- An agent can discard a partial capture (`resolution: "reject"`), logged in `corrections/_pending/_rejected.jsonl`. It cannot discard or replace a `ready` proposal; only the owner can (review page or `corrections reject`).
- A staged row expires 14 days after it was last submitted. At most 200 rows are kept per project; beyond that the oldest are dropped and logged.
- Local (stdio) installs are unchanged: there the structured form activates directly.

**What this does not cover.** The state card (`Goal`, `Next`, `Blockers`, `Pointers`) is written by agents through `session_end` and is loaded at every `session_start`. It is shown as state, not as a rule, but it is agent-written text every agent of that user reads. Treat a hosted user's token as able to write that card.

### The review page (owners approve their own)

With OAuth on, each user approves or rejects their own proposals at `<AR_PUBLIC_URL>/review`, so the operator does not have to read anyone's memory. It is off when OAuth is not configured (the routes do not exist; the CLI keeps working either way).

- **Sign-in:** "Continue with GitHub / Google", the same apps and the same callback URL as the MCP sign-in (`/authorize/callback/<provider>`), so there is nothing new to register. The account maps to its memory exactly as for MCP (operator link, else `gh-<id>` / `gg-<sub>`); with `AR_OAUTH_SIGNUP=invite` an account the operator has not linked gets no session. Static-token users without a linked GitHub/Google account keep using the CLI.
- **Agents cannot use it.** An `ar_` or `aro_` token never opens it: the page only trusts its own browser session, created by a GitHub/Google sign-in, and refuses any request with an `Authorization` header. That is the point of the owner gate. Re-authentication is not forced (GitHub skips its prompt for an app the user already authorized), so a program that can drive the user's signed-in browser, including a browser-using agent on their machine, can approve, as the user could.
- **What it shows:** only the signed-in account's `ready` proposals across all its projects, oldest first by when each was first proposed, so a re-submission cannot jump the queue (up to 100 at a time; the page says how many more are waiting), each in full: rule, why, applies_when, severity, project and id. Approving activates exactly that text: the id ends in the digest of it, and a row whose text or digest changed is not offered and cannot be approved. `incomplete` captures are only counted; they cannot be approved and expire after 14 days.
- **Session:** cookie `ar_review` (`HttpOnly; SameSite=Lax; Path=/review`, `Secure` on https), 30 minutes, in memory (a restart signs everyone out). The account is re-checked on every request, so `identity unlink` ends a session at once. "Sign out" ends it immediately. The result of an approve or reject is shown once on the next page load (it is not in the URL, so a link cannot fake "Approved"). If the proposals cannot be read, the page says so (503) instead of "nothing is waiting".
- **Protections:** every approve / reject / sign-out form carries a per-session CSRF token; a post whose `Sec-Fetch-Site` is not `same-origin`, or whose `Origin` is another site, is refused. `Origin: null` is accepted: with `Referrer-Policy: no-referrer` browsers send `null` on same-origin form posts, and the CSRF token still gates every change. Sign-in state is single use, expires after 10 minutes and is bound to the browser that started it (PKCE, and a nonce for Google). Pages have the same strict headers as the sign-in page (CSP `default-src 'none'`, no framing, no referrer, `no-store`) and every value on them is HTML-escaped. Sign-in starts are limited per IP like MCP sign-ins (10 per 10 minutes by default), and review sign-ins have their own per-IP and global buckets, so they cannot use up the budget MCP sign-ins need; approve/reject is capped at 120 per session per 10 minutes.
- **Shared parent domains:** the cookie is scoped to `Path=/review`, so it cannot use the `__Host-` prefix. Serve the server on a host whose sibling subdomains you trust, as for any cookie-based login.
- **Logs:** `[review] signed in github=<id> uid=<uid>` and `[review] approve|reject uid=<uid> project=<p> result=<approved|merged|rejected|gone|failed|unavailable>`. Proposal text is never logged.

## Website

The same process serves a small website at `<AR_PUBLIC_URL>/`, so a person who opens the domain sees something other than JSON. Design is system fonts and inline SVG only, light and dark, no third-party requests (the privacy policy promises none).

| Route | Needs a session | What |
|---|---|---|
| `/` | no | Home: a scroll-driven film about Intelligent Distance (the gap between you and your agents, narrowed by each correction), then the two doors, "Connect an agent" and "Run it locally" |
| `/film/<plate>.jpg` | no | The film's five image plates (same origin, cacheable for a day) |
| `/local` | no | Install prompt to paste to an agent, manual commands, what local means |
| `/connect` | yes (sign-in when signed out) | Dashboard: your ID (`gh-<id>` / `gg-<sub>`), copyable connect commands for Claude Code, Codex, Cursor, claude.ai and other clients, a "paste this to your agent" prompt, "Your agents" (every agent that used this memory, however it signed in, with last activity; OAuth sign-ins have Disconnect, tokens are read only), storage vs quota, pending corrections count (links to `/review`), "Download my memory", "Import memory" (pack command for PowerShell and bash, a prompt for your agent, the upload form), Sign out |
| `/privacy` | no | The privacy policy: `PRIVACY.md` at the repo root rendered by a small safe markdown subset (`markdown-lite.ts`, everything escaped, links only to http(s) and mailto). The build copies the file to `dist/http/legal/` (it fails if the file is missing, and both Dockerfiles `COPY` it); the server renders that copy at start. If the copy is missing at start, `/privacy` answers 503 rather than showing partial text |
| `/support` | no | Contact page: the address `PRIVACY.md` names (read from its "contact: **...**" line, so the two cannot differ), the GitHub issues link, the Telegram community, and an honest best-effort response time |
| `/connect.md`, `/local.md`, `/llms.txt`, `/favicon.svg` | no | Plain text for agents (same instructions), the llms.txt index, the icon |

- **Home page film:** `src/http/film.ts` plus `src/http/film/` (stylesheet, script, five JPEG plates; the build copies them to `dist/http/film/`). The page keeps the site's CSP: the style and the script are inline and allowed by their sha256 hashes, nothing loads from another origin, and the script uses WebGL2 with no library. Without script, or to an agent or crawler, it is a plain document with the same copy and links. Without WebGL the captions run over a gradient. If the assets are missing at start, the classic home page is served.
- **Footer:** every site page links Privacy (`/privacy`) and Support (`/support`) next to GitHub and Telegram, the home film included. There is deliberately no `/terms` route yet: a draft for the owner to sign off is in `docs/legal/TERMS-draft.md`.
- **OAuth off:** `/`, `/local`, `/privacy`, `/support`, `/connect.md`, `/local.md`, `/llms.txt` still work. `/connect` explains that hosted sign-in is not configured, and `/review` and the other signed-in routes do not exist. With OAuth off there is no configured public URL, so the commands use the request's `Host` header (shape-checked), and those pages are sent `Cache-Control: no-store` and `Vary: Host` so a shared cache never serves one host's URLs to another. With OAuth on, the pages use `AR_PUBLIC_URL` and are cacheable for 5 minutes.
- **Sign-in:** the same as `/review` (one shared module, `web-session.ts`): GitHub/Google through the callback `/authorize/callback/<provider>`, so nothing new to register. `AR_OAUTH_SIGNUP=invite` is honoured: an account the operator has not linked gets the "not invited, send this id" page and no session. One sign-in opens both `/connect` and `/review`; sign-out on either ends both.
- **Session:** cookies `ar_site` (`Path=/connect`) and `ar_review` (`Path=/review`) carry the same value; `HttpOnly; SameSite=Lax`, `Secure` on https, 30 minutes, in memory. Neither is ever sent to `/mcp` or the OAuth routes.
- **Agents cannot use it:** any `/connect*` request with an `Authorization` header (`ar_` or `aro_`) gets 403, whatever else it carries. `/connect.md` and the other text files are public.
- **Posts** (Disconnect, Download, Import, Sign out): session + per-session CSRF token + `Sec-Fetch-Site: same-origin` / `Origin` check, capped at 120 per session per 10 minutes; sign-in starts are limited per IP like `/review`.
- **Your agents:** one list of every live credential of the account: OAuth grants and operator tokens, each with the self-reported client name, how it signs in, connected date, last activity and last tool name, plus an "N agents share this memory" count. The server records, on each authenticated `POST /mcp`: the client name (from the `initialize` message's `clientInfo.name` when that request carries it; control, bidi and zero-width characters stripped, 60 characters max), last seen, the tool name of a `tools/call` (registered names only), and a call count. Entries are keyed by credential (`grant:<id>` / `token:<id>`), at most 50 per user. They live in `_server/activity/<uid>.json`, **outside** `tenants/<uid>/`: not counted against the quota, not in the download, and to be deleted together with the user. Writes are buffered in memory and flushed at most once per 60 s and when the server shuts down on SIGTERM/SIGINT (a hard kill can lose up to a minute); a failed write is logged once and never fails a request. A disconnected grant or revoked token is no longer listed. No request content is stored.
- **Disconnect** revokes one grant of the signed-in account (its access and refresh tokens stop working at once). A grant id that is not the account's own, or does not exist, changes nothing. Names shown are what each app reported about itself and are labelled so.
- **Download my memory:** `POST /connect/download` streams a ustar `.tar` of the account's tenant directory without buffering it. Only regular files are included; symlinks, devices and other special entries are skipped, and names that cannot be represented safely are skipped. Before entering a directory the exporter re-checks that it is still a real directory whose real path is inside the tenant root, files are opened with `O_NOFOLLOW` and their real path is re-checked after opening, so a directory swapped for a link while the export runs is not followed. This guarantee relies on `O_NOFOLLOW`, which is a Linux/POSIX feature and is what production runs; on Windows it is best-effort (and no path-based check can close a swap in the instant between a check and the next system call, which is why the tenant tree is written only by this server). One download at a time per account. A client that disconnects, errors or stops reading for 60 seconds ends the export: the file handle is closed and the account lock is released. The log line carries only the uid and counts.
- **Import memory:** `POST /connect/import` takes a local AgentRecall store (a ustar `.tar`) into the signed-in account, the mirror of the download. It is for the owner's browser session only: an `Authorization` header (an agent token) is a 403, because imported corrections become always-loaded rules. The form is a plain multipart upload (`csrf`, `mode`, `confirm`, then the `archive` file last; no script), parsed as a stream by a small built-in reader (`multipart.ts`, no dependency). Session, same-origin and the CSRF token are checked when the file part starts, before anything is written; a file that arrives before its token is refused. Modes: **add** (default: a file is placed only if it does not exist, hard-linked or copied with an exclusive flag, never overwritten, every parent re-checked with `lstat`/`realpath`) and **replace** (needs the word `REPLACE`; the current tenant directory is renamed to `_server/trash/<uid>-<UTC timestamp>/` and the staged tree renamed into place; trash older than 7 days is deleted at server start and at each import; only the most recent replaced memory per account is kept). `DATA` must be one filesystem, because both steps are renames.
  - The tar reader (`tar-import.ts`) accepts POSIX ustar only (what the download writes, plus the long-name `prefix` field). pax/GNU extension entries, other magic, base-256 sizes and unknown type flags abort the import; symlinks, hard links, devices and fifos are skipped and counted. Every checksum is verified, a name must be UTF-8, a declared size is never trusted beyond the bytes that arrive, and an archive without its end marker (cut off) imports nothing.
  - **Allowlist:** `projects/<slug>/**` (slug `[a-z0-9][a-z0-9_-]{0,63}`) with extensions `.md .json .jsonl .txt`, plus the root files `identity-card.md awareness.md awareness-state.json awareness-archive.json insights-index.json feedback-log.json MANIFEST.md`. Never imported: `projects/<slug>/digest/**` (digest ids are joined into file paths when read). Everything else (`config.json`, `telemetry/`, `tmp/`, `working-memory/`, `_unclaimed/`, logs, locks, vector indexes, any dotfile) is skipped and counted. An optional single top directory `agentrecall-<id>/` (as the download has) is stripped. Path rules: relative, forward slashes only, no empty/`.`/`..` segments, no control characters, backslash, colon or other Windows-illegal characters, no Windows-reserved names, no trailing dot or space, segment <= 255 bytes, total <= 512, depth <= 16; duplicates and case-fold collisions are refused.
  - **Always-follow rules are opt-in.** The form has a checkbox `rules` (off by default; a hidden `rules_seen` field proves the form was complete). Unless ticked, every file an agent loads as a standing instruction is skipped and counted: `projects/<slug>/corrections/**` (active corrections and `_pending`), `projects/<slug>/palace/behavior-policies.json`, `projects/<slug>/personal/**` (the corrections-derived profile) and the root `identity-card.md`. The result page says how many were left out and how many always-follow corrections are active. `mode`, `confirm` and `rules_seen` must all arrive before the file: a missing one is a 400, nothing is defaulted.
- **Limits:** 8 MiB per file, 50,000 entries, a file or new folder costs at least one 4 KiB block, at most 2,000 new folders, and the import must fit the quota (add: current usage + import <= quota, counted in 4 KiB disk blocks like the quota scan; replace: import <= quota; at most 1 GiB with no quota), enforced while streaming (the stream is aborted as soon as it is exceeded); 30 s idle, 15 min total, and once the archive has started it must average 16 KiB/s over every 10 s window (a trickle is dropped); one import at a time per account (409) and per network address (`ipKey`, 409), and 4 at once server-wide (503 with `Retry-After` and its own message; a slot is taken only when the archive part starts, after the CSRF check); 5 imports per hour per account (429).
  - **Interrupted replace:** a crash between the two renames leaves the tenant missing (or re-created empty by an agent request) with its data in trash. At server start, and before an import for that account, the newest trash entry younger than one hour is moved back and logged (an older entry is a deliberate replace and is never restored). The trash copy is not counted against the quota, and only the latest replaced memory per account is kept, for 7 days.
- **Staging:** every file goes to `_server/import-staging/<uid>-<random>/` first (opened `O_EXCL|O_NOFOLLOW`, parent and real path re-checked) and reaches the tenant only after the whole archive was read and its end marker seen. Any error, abort or disconnect removes the staging directory (`finally`); leftovers of a crashed process older than an hour are removed at start. The cached usage figure (dashboard and MCP quota check) is dropped after a commit. The result page and the log line carry counts only (imported, already present, refused by reason, projects, always-follow corrections now active), never content.
- **Headers on every page:** CSP `default-src 'none'; img-src 'self' data:; style-src 'sha256-…'; script-src 'sha256-…'; base-uri 'none'; form-action 'self'` (plus the provider origins on the sign-in form only) `; frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and `Cache-Control: no-store` on signed-in and sign-in pages. The one inline script (the Copy buttons) and the one inline stylesheet are allowed by hash only; without JavaScript the commands stay selectable text.

## Operations

- **Health:** `GET /healthz` returns `{ ok, version }`. The Docker image has a `HEALTHCHECK`.
- **Logs:** one line per request (method, path, uid, status, ms) on stderr. Tokens and bodies are never logged.
- **Backups:** back up the whole data volume. A user's memory is plain files under `tenants/<uid>/`.
- **Deleting a user:** revoke their tokens, then delete `tenants/<uid>/` and `_server/activity/<uid>.json`.
- **Per-user limits (on by default):**

  | Limit | Default | Set with | When exceeded |
  |---|---|---|---|
  | Storage | 100 MB per user | `--quota-mb` / `AR_SERVER_QUOTA_MB` (decimals allowed, `0` = off) | Write tools (`remember`, `session_end`, `check`) return an MCP tool error telling the agent the memory was not saved. Reads (`recall`, `session_start`) keep working, so users are never locked out of their memory. |
  | Requests | 120 per minute per user (bursts up to 120) | `--rate-per-min` / `AR_SERVER_RATE_PER_MIN` (`0` = off) | HTTP `429` with `retry-after` and an `agent_instruction`. |

  - The storage figure is re-measured at most every 15 s per user, and accepted writes count immediately, so a burst can overshoot only slightly. Reads may write small bookkeeping files, so treat the quota as a soft cap.
  - Storage counts allocated disk blocks where the OS reports them, so many tiny files can't dodge the quota.
  - The rate counts every POST, including the `initialize` handshake a client sends when it connects.
  - An empty variable (`AR_SERVER_QUOTA_MB=` in a `.env` file) means "use the default", never "off". An invalid value stops the server from starting rather than disabling the limit.
  - `agent-recall-server usage [--quota-mb N]` lists each user's storage and share of the quota.
  - Limits are the same for every user in v1; per-user plans come with pricing.
- **Server-wide limits:**
  - Request bodies are capped at 4 MiB, with a delivered `413`.
  - At most 64 concurrent in-flight MCP requests across all users; beyond that the server returns `503` with `retry-after`.
- **Shutdown:** SIGTERM/SIGINT drains in-flight requests (up to 8 s) before exiting.
- **Token store:** if `tokens.json` is unreadable, requests get `503 auth_unavailable` rather than being let through; the server recovers as soon as the file is valid again.

## Not in v1

- A website for self-serve tokens, Client ID Metadata Documents, and a web page to list or revoke OAuth grants (CLI only)
- Per-tenant Supabase or encryption at rest
- Per-user plans (different quotas or rates per user)
- Stateful MCP sessions (each `session_end` currently records its own session card)
