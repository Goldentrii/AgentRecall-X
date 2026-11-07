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

### Docker (recommended)

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
- **Limits:**
  - Request bodies are capped at 4 MiB, with a delivered `413`.
  - At most 64 concurrent in-flight MCP requests across all users; beyond that the server returns `503` with `retry-after`.
  - **There is no per-user storage quota or rate limit yet.** Any valid token can fill the shared disk. Before opening to untrusted users, rate-limit in the proxy and watch disk usage.
- **Shutdown:** SIGTERM/SIGINT drains in-flight requests (up to 8 s) before exiting.
- **Token store:** if `tokens.json` is unreadable, requests get `503 auth_unavailable` rather than being let through; the server recovers as soon as the file is valid again.

## Not in v1

- OAuth 2.1 / browser login, and a website for self-serve tokens
- Per-tenant Supabase or encryption at rest
- Quotas and rate limits
- Stateful MCP sessions (each `session_end` currently records its own session card)
