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
| `AR_OAUTH_REDIRECT_ALLOW` | Optional. Extra allowed client redirect URI prefixes, comma-separated (for example `https://vscode.dev/redirect`). Matched at a URL boundary. |
| `AR_TRUST_PROXY=1` | `1`/`true`/`yes`/`on` or `0`/`false`/`no`/`off` (empty = off; anything else stops the server from starting). Trust one proxy hop for the client IP. Set it behind Caddy (the deploy kit does); otherwise all users share one IP for rate limits (the server logs one warning when it sees `X-Forwarded-For` without it). Only set it behind a proxy that **overwrites** `X-Forwarded-For` (Caddy does) and never with the server port reachable directly: a client could then forge the header and dodge every per-IP limit. |

Client secrets are read from the environment only (never from command-line flags) and are never logged or sent to the browser. With the deploy kit, put these variables in `deploy/hosted/.env` and restart the stack.

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

## Operations

- **Health:** `GET /healthz` returns `{ ok, version }`. The Docker image has a `HEALTHCHECK`.
- **Logs:** one line per request (method, path, uid, status, ms) on stderr. Tokens and bodies are never logged.
- **Backups:** back up the whole data volume. A user's memory is plain files under `tenants/<uid>/`.
- **Deleting a user:** revoke their tokens, then delete `tenants/<uid>/`.
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
