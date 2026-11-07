# Target — Hosted AgentRecall: any agent, any machine, same memory

> Owner goal (2026-11-07): "Even with a single host server, as long as users connect to it and log in, they can access their own data without needing any specific agent." This is the success benchmark.

## 1. Success benchmark (testable)

1. A user gets a credential once.
2. They add **one MCP server entry** (URL + credential) to *any* MCP-capable agent: Claude Code, Claude Desktop, Cursor, Codex, Windsurf, a custom SDK agent.
3. That agent's first `session_start` returns **the same owner card, HARD RULES, state and corrections** as every other agent the user has used, with no local install and no hooks.
4. User A can never read or write user B's data, whatever A sends (token, path, project name, tool arguments).

Done = steps 1–4 pass in an automated end-to-end test against the real server binary, plus one manual run from two different real agents.

## 2. Architecture (v1: one server, files on one disk)

```
any MCP client ──HTTPS──▶ reverse proxy (TLS) ──▶ agent-recall-server (Node, one process)
   Authorization: Bearer ar_…                         │ 1. hash token → look up {uid}
                                                      │ 2. withRoot(DATA/tenants/<uid>, …)
                                                      │ 3. fresh McpServer + Streamable HTTP transport per request
                                                      ▼
                                       DATA/tenants/<uid>/   (exact same on-disk store as local AgentRecall)
                                       DATA/_server/tokens.json (sha256 hashes only)
```

- **Same code, same store format.** Tenant isolation reuses core's existing `withRoot()` (AsyncLocalStorage root scoping, `types.ts:30`). All tools, recall, corrections and cards work unchanged.
- **Stateless HTTP mode:** a new server + transport per request, so no MCP session state is shared between requests or users.
- **Identity:**
  - `uid` is a server-assigned id (`^[a-z0-9][a-z0-9-]{2,39}$`). It names the tenant folder and is never accepted from the client.
  - The **credential is a secret bearer token** (`ar_` + 32 random bytes). Only its SHA-256 is stored. A uid alone grants nothing.
- **Admin CLI (v1, until the website exists):** `agent-recall-server token create --uid <uid> [--label]` prints the token once. Also `token list` and `token revoke`.
- **Why a token first, not OAuth:**
  - Every MCP client accepts `Authorization` headers today (Claude Code `--header`, Cursor/Codex config).
  - OAuth 2.1, which the MCP spec defines for remote servers, is v2. It is needed for claude.ai custom connectors and for a "log in with browser" UX.
- **Hooks are optional.** A hosted client has no local hooks, so it relies on the MCP lifecycle instructions (call `session_start` first and `session_end` at exit). This is the existing no-hooks host tier.

## 3. Split of work

### Agent (me): code, tests, docs, all local; no deploy or push without the owner's yes

- [x] A1 Cross-tenant global-state audit, then fix every HIGH (caches keyed by root, process-global session ids, env-as-config).
- [x] A2 `createServer()` factory: the stdio entry and the HTTP entry both build the same server. Stdio behaviour is unchanged.
- [x] A3 `agent-recall-server` HTTP entry:
  - Streamable HTTP, stateless
  - bearer auth with a constant-time hash lookup
  - per-request `withRoot`
  - body-size limit, `/healthz`
  - structured JSON errors carrying `agent_instruction`
- [x] A4 Token store + admin CLI (create, list, revoke). Hashes only, file mode `0600`.
- [x] A5 Tests:
  - auth: missing, bad and revoked tokens → 401
  - **two-tenant isolation**: A writes, B's recall/session_start never sees it; hostile project names and paths stay inside the tenant root
  - concurrency: interleaved A/B requests
- [x] A6 End-to-end test with the real MCP SDK client over HTTP against the built binary (benchmark steps 1–4).
- [~] A7 Dockerfile for the server (persistent volume at `/data`), plus a deploy guide and client config snippets for Claude Code, Cursor, Codex and Claude Desktop. (written; image build NOT yet verified: Docker engine was not running)
- [x] A8 Independent code + security review; fix CRITICAL/HIGH.

### Owner (you): decisions, accounts, money, legal, approvals

- [ ] O1 **Pick a host + domain.** Any VM or container host with a persistent disk works (Hetzner/Fly/Railway/a VPS). Not Vercel functions, which have no persistent disk. Create the account, pay, and point DNS (e.g. `mcp.<yourdomain>`).
- [ ] O2 **Approve the deploy** (REDLINE), and set the server secrets on the host. I never enter credentials.
- [ ] O3 **Legal, because you now hold users' data:** a privacy policy + terms, GDPR basics (EU: data location, deletion on request, a DPA with the host), and a decision on backups and retention.
- [ ] O4 **Decide onboarding for v1:** you issue tokens by hand with the admin CLI (fine for the first users), or a signup website (later; OAuth v2).
- [ ] O5 **Decide pricing/limits,** even if v1 is free: per-tenant storage cap, rate limits.
- [ ] O6 Review and merge the PRs.

## 4. Later (not v1)

- OAuth 2.1 login (browser) + a small website: sign in, create/revoke tokens, copy config.
- Per-tenant storage backends: keep files on the server, **or** point a tenant at their own Supabase (the BYO plan, `2026-11-07-byo-supabase-shared-memory.md`, becomes the storage driver instead of a desktop-sync feature).
- Encryption at rest per tenant, usage metering, admin dashboard.
- Local desktop installs syncing with the hosted tenant, so hooks keep working offline.
