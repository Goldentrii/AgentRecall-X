# Hosted AgentRecall server

One server, many users, any MCP agent. Each user gets a **token**. Any MCP client configured with the server URL + that token sees the same memory: the same owner card, HARD RULES, state card, corrections and recall. Users don't need a local install or hooks.

> Status: v1. The token is the only credential (no OAuth yet). Storage is the normal AgentRecall file store, one folder per user, on the server's disk.

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

claude.ai custom connectors need OAuth, which is planned for v2. Until then, use one of the options above.

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

- OAuth 2.1 / browser login, and a website for self-serve tokens
- Per-tenant Supabase or encryption at rest
- Per-user plans (different quotas or rates per user)
- Stateful MCP sessions (each `session_end` currently records its own session card)
