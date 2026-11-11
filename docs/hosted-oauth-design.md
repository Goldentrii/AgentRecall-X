# Hosted AgentRecall — OAuth 2.1 design (v3, federated identity)

Status: 2026-11-07. Owner decision: AgentRecall has its **own accounts**, fully decoupled from Akada/Sub2API. Sign-in is federated: the user proves who they are to **GitHub** or **Google**; AgentRecall never sees or stores a password. (v2 authenticated against Akada accounts through Sub2API with email + password + TOTP; that path was removed.)

## Goal

A user connects any OAuth-capable MCP client (Claude Code, claude.ai custom connectors, Cursor, Codex) to `https://recall.example.com/mcp` **without an operator-issued token**: the client discovers OAuth, opens a browser, the user clicks "Continue with GitHub" or "Continue with Google", and the client receives tokens bound to that user's tenant. Static `ar_` tokens issued by `agent-recall-server token create` keep working unchanged.

## Roles

| Role | Who |
|---|---|
| Resource server (RS) | `agent-recall-server`, `POST /mcp` |
| Authorization server (AS) | the same process (OAuth routes) |
| Identity provider (upstream) | GitHub (OAuth 2.0 + PKCE; read `GET /user` `id`) and Google (OpenID Connect + PKCE; read id_token `sub`) |

## Enabling

OAuth is **off** unless `AR_PUBLIC_URL` and at least one provider pair are set (server behaves exactly as v1 otherwise). Anything half-configured refuses to start.

- `AR_PUBLIC_URL` / `--public-url` — public origin (issuer; https except localhost)
- `AR_OAUTH_GITHUB_CLIENT_ID` + `AR_OAUTH_GITHUB_CLIENT_SECRET`; callback `<public>/authorize/callback/github`
- `AR_OAUTH_GOOGLE_CLIENT_ID` + `AR_OAUTH_GOOGLE_CLIENT_SECRET`; callback `<public>/authorize/callback/google`
- `AR_OAUTH_REDIRECT_ALLOW` — extra allowed client redirect URI prefixes, comma-separated
- `AR_TRUST_PROXY=1` — trust one proxy hop for the client IP

Provider base URLs can be overridden only through the test option object (`ServeOptions.oauthTesting.providerUrls`), never via env, and must be https (http only on localhost).

## Endpoints (MCP SDK `mcpAuthRouter` + our `OAuthServerProvider`, plus two browser routes)

- `GET /.well-known/oauth-protected-resource[/mcp]` (RFC 9728), `GET /.well-known/oauth-authorization-server` (RFC 8414)
- `POST /register` — RFC 7591 dynamic client registration (public clients)
- `GET|POST /authorize` — validates client/redirect/PKCE (S256 only), shows the sign-in page, sets the browser cookie
- `POST /authorize/start` — the "Continue with …" button; redirects to the provider
- `GET /authorize/callback/:provider` — where the provider sends the browser back
- `POST /token` — `authorization_code` (PKCE) and `refresh_token` grants; `POST /revoke` — RFC 7009
- `POST /mcp` 401 carries `WWW-Authenticate: Bearer realm="agent-recall", resource_metadata="<public>/.well-known/oauth-protected-resource/mcp"`

## Flow

1. Client hits `/mcp` → 401 with `resource_metadata` → discovers AS → `POST /register` → `GET /authorize?…&code_challenge=…&resource=<public>/mcp`.
2. `/authorize` stores a **pending request** (random 32-byte id, 10 min TTL, in memory) and a per-request cookie `ar_oauth_<12 hex of the request id hash>=<random 32 bytes>` (`HttpOnly; SameSite=Lax; Path=/authorize; Max-Age=600; Secure` when the public URL is https) whose hash is bound to it. The page shows the client name, the redirect host, and one button per configured provider.
3. `POST /authorize/start` (`request_id`, `provider`): the request must be live, the cookie must match, the provider must be configured. A fresh upstream `state` (32 bytes, single use, replaces any older one), a provider PKCE verifier (kept server-side) and, for Google, a nonce are created; 302 to the provider.
   - GitHub: `github.com/login/oauth/authorize?client_id&redirect_uri&state&code_challenge&code_challenge_method=S256` (no scopes).
   - Google: `accounts.google.com/o/oauth2/v2/auth?…&response_type=code&scope=openid&nonce&prompt=select_account`.
4. `GET /authorize/callback/:provider`: `state` is looked up and consumed (single use) → pending request; the cookie must match; the provider must match.
   - `error` from the provider → redirect to the client's `redirect_uri` with `error=access_denied` and the client's own `state`.
   - GitHub: POST the token endpoint (code, secret, PKCE verifier) → `GET /user` → numeric `id`.
   - Google: POST the token endpoint → `id_token`. It comes straight from Google's token endpoint over TLS, so its signature need not be verified (OIDC Core 3.1.3.7); we check `iss` ∈ {accounts.google.com, https://accounts.google.com}, `aud` = our client id, `exp` in the future, `nonce` = ours, `sub` numeric.
   - Any upstream failure → the sign-in page again with a generic message (pending request survives; no secrets in pages or logs).
   - Success → uid resolved → authorization code (32 bytes, 60 s, single use, bound to client, redirect_uri, code_challenge, resource, uid) → `302 redirect_uri?code=…&state=…`, cookie cleared.
5. `POST /token` → access token `aro_…` (1 h) + refresh token `arr_…` (30 d, rotated on every use, grant ends 90 days after sign-in). Reuse of a rotated refresh token revokes the whole grant.
6. `/mcp` resolves `aro_` tokens (hash lookup, expiry, grant not revoked, audience = this RS) → uid → tenant, exactly like `ar_` tokens.

## Identity → tenant

- Identity key: `github:<numeric id>` or `google:<numeric sub>`.
- Default uid: `gh-<id>` / `gg-<sub>` (match `UID_RE`); the `gh-` and `gg-` prefixes are reserved (`token create --uid gh-…` is refused).
- Link an existing tenant: `agent-recall-server identity link --github-id <n> | --google-sub <s> --uid <uid>` → `_server/identities.json` (CLI-only writer, read per request with mtime cache).
- First sign-in of each account is logged once: `oauth login github=<id> uid=<uid>` (no tokens, no email).

## Storage (`<dataDir>/_server/`, dir 0700, files 0600, atomic rename)

| File | Writer | Content |
|---|---|---|
| `tokens.json` | CLI | unchanged (static `ar_`) |
| `identities.json` | CLI | `{version:1, links:{"github:<id>": "<uid>", "google:<sub>": "<uid>"}}` |
| `oauth-clients.json` | server | registered clients (cap 5 000; oldest unused pruned first) |
| `oauth-grants.json` | server | grants: only SHA-256 hashes of tokens |
| `oauth-revoked.json` | CLI | `{grants:{id:iso}, uids:{uid:iso}}` operator revocations |

Pending requests, upstream states and authorization codes are in memory only (a restart aborts in-flight sign-ins; clients just retry).

## Security rules

- PKCE S256 mandatory toward clients and toward providers. `state` echoed to the client.
- **Browser binding:** the per-request `ar_oauth_<…>` cookie ties start and callback to the browser that loaded the sign-in page (stops login CSRF and a victim finishing an attacker's flow). `state` is single use, provider-bound and unguessable.
- **Redirect policy** (at `/register` and `/authorize`): loopback `http://127.0.0.1:*`, `http://localhost:*`, `http://[::1]:*`; `https://claude.ai/api/mcp/auth_callback`; `https://claude.com/api/mcp/auth_callback`; `cursor://anysphere.cursor-retrieval/`; plus `AR_OAUTH_REDIRECT_ALLOW` prefixes (matched on the normalized URL; `%2e`, `%2f`, `%5c` and dot segments refused). Everything else → `invalid_redirect_uri`.
- `resource` (RFC 8707), when sent, must equal `<public>/mcp`.
- Pages: `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self' <provider origins>; frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. The provider origins (github.com, accounts.google.com) are in `form-action` because browsers also apply it to the redirect after the form POST. All interpolated values are HTML-escaped. There is no password or code field anywhere.
- Rate limits: `/authorize/start` and the callback each 10 hits / 10 min per client IP (IPv6 per /64, non-IP input in one "invalid" bucket) and 300 / 10 min overall; the overall budget is spent only by live request ids / states. `/register` 20 / hour per IP. `/token`, `/revoke` 600 and `/authorize` 300 per 15 min per IP.
- Provider calls: 10 s timeout, `redirect: "error"`, response size cap; failures → generic message. Client secrets come from env only and are never logged or sent to the browser.
- Operator revocation: `oauth list`, `oauth revoke <grant-id>`, `oauth revoke --uid <uid>` (grants created up to now; later sign-ins work).

## Implementation notes

- Only part of the config set (a lone id or secret, a URL without a provider, a provider without a URL) is a startup error (fail closed). Nothing set = off.
- Registration stores only a whitelist of client metadata (name capped at 100 chars, bidi/zero-width characters stripped, at most 3 redirect URIs of 1024 chars, `token_endpoint_auth_method: none`).
- Grants have a 90-day absolute lifetime; client `last_used_at` is persisted at most once per hour. `/register` rewrites the whole clients file synchronously (bounded: ~5 000 clients, 20 registrations per hour per IP); debouncing that would need a SIGTERM flush.
- A code that fails PKCE can be tried at most 5 times (the SDK checks the verifier outside the provider); a mismatching `redirect_uri`/client/resource burns the code. The token request may omit `redirect_uri`.
- The un-suffixed `/.well-known/oauth-protected-resource` serves the same document as the `/mcp`-suffixed one. The issuer is advertised with a trailing slash (`https://host/`) because the MCP SDK serializes it from a `URL`; not changed.
- One warning is logged when `X-Forwarded-For` is seen while `AR_TRUST_PROXY` is off.
- SDK per-IP defaults for `/token` and `/revoke` (50 per 15 min) are raised because claude.ai calls from a few shared egress IPs.
- Consent page: the primary line is where the result goes ("Sign-in result goes to: <host>"); the client name is labelled "self-reported name, not verified" (open DCR lets anyone pick any name). Loopback redirects add "This connects a program running on this computer…"; the fixed claude.ai/claude.com callbacks add "This connects Claude (claude.ai)."
- Each pending request may be sent to a provider at most 3 times; the 4th `/authorize/start` gets a 429 page and spends no global budget. Client `state` is capped at 512 chars (`invalid_request`).
- The pending table (10 000) evicts only expired entries; when it is full of live sign-ins `/authorize` answers 503 with `retry-after` instead of evicting anyone.
- The browser-binding cookie is per sign-in (`ar_oauth_<12 hex of the request id hash>`), so parallel sign-ins in one browser do not clobber each other; completion clears only its own cookie.
- Google id_token: an array `aud` must contain our client id and carry `azp` equal to it; any `azp` must equal our client id; `iat` may be at most 5 min in the future.
- Stored client redirect URIs are re-checked against the current policy on every lookup; a client left with none is treated as unknown (tightening `AR_OAUTH_REDIRECT_ALLOW` takes effect for existing clients).
- Not done: revoking the GitHub access token after `/user` (it is never stored or logged and carries no scopes); enforcing `redirect_uri` at `/token` when the client omits it (PKCE already binds the code to the client).
- Testing seams (`ServeOptions.oauthTesting`: clock, login limits, provider URLs, fetch, provider timeout) exist only for the test suite.

## Not in this change

- Client ID Metadata Documents (CIMD) — DCR only for now
- Consent memory ("always allow this client")
- A web page to list/revoke grants (CLI only)
- Account linking across providers (link two provider accounts to one tenant with `identity link` by hand)
- Email or password sign-in

## Review round 6 (2026-11-11)

- **Invite-only by default** (`AR_OAUTH_SIGNUP=invite`): an account that is not linked with `identity link` gets a 403 "not invited" page showing its provider id; no code, grant or tenant is created. `open` restores self-service sign-up. Reason: open sign-up gave every GitHub/Google account 100 MB of the server's disk before onboarding and the privacy policy were decided.
- **Grants capped at 20 per uid** (live and revoked); a new sign-in evicts that uid's oldest. Bounds `oauth-grants.json`, which is rewritten on every change.
- **Write first, then apply**: every grant/client change builds the next state, writes it, and only then swaps it into memory. A failed write (EPERM from an antivirus lock, ENOSPC) leaves memory as on disk, so a retry with the same refresh token is not mistaken for theft.
- **Refresh grace**: the just-rotated refresh token is accepted ONCE more from the same client within 10 s (lost `/token` response); a second replay, or any replay after 10 s, revokes the grant as before. One retry only, so a stolen old token cannot keep minting tokens.
- **Un-invite**: `identity unlink` removes a link; a stored link onto another account's reserved uid ends the sign-in with a terminal 403 instead of a retry page.
- **Reserved uids enforced everywhere**: `identity link` may target a `gh-`/`gg-` uid only if it is the account's own; a stored link onto someone else's reserved uid is refused at sign-in; OAuth refuses to start while an active static token uses a reserved uid.
- **Per-address pending cap**: 30 open sign-in requests per client address (IPv6 per /64), so one address cannot fill the 10 000-entry table.
- Small: `AR_TRUST_PROXY` accepts 1/true/yes/on and 0/false/no/off and refuses anything else; `AR_PUBLIC_URL` errors mask credentials; SDK minimum `^1.29.0`; a provider that never answers is covered by a timeout test.
