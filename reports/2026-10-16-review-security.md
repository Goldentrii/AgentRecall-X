# Security Review — fix/3.5.2-egress-gate + fix/3.5.2-scrub-pii

- **Date:** 2026-10-16
- **Reviewer:** security-reviewer (independent; authored none of the code under review)
- **Base:** main @ f8938dd
- **Branches:** fix/3.5.2-egress-gate @ 3e3835e (E:/tools/AR-wt-egress), fix/3.5.2-scrub-pii @ 24db6fe (E:/tools/AR-wt-scrub)
- **Method:** full-diff read, egress-surface grep across all 4 packages, behavioral probes against built dist (23 credential/PII samples + 17 adversarial ReDoS inputs + 4-point scaling check), full test suites under `AGENT_RECALL_HOME`/`AGENT_CRAFT_HOME` temp dirs (no touch of `~/.agent-recall`).

---

## Verdicts

| Branch | Verdict |
|---|---|
| fix/3.5.2-egress-gate | **APPROVE-WITH-CHANGES** (one MEDIUM: widen nonce to 64 bits — one-line fix) |
| fix/3.5.2-scrub-pii | **APPROVE-WITH-CHANGES** (one HIGH: URL-embedded credentials leak; two MEDIUM) |

Both branches are strict security improvements over main. Nothing found is a regression; all findings are residual gaps in the new hardening.

---

## Branch 1 — fix/3.5.2-egress-gate

### Egress audit result: gate holds, chokepoint is sound

Full inventory of network calls in `packages/*/src` (grep: `fetch(`, `https://`, `http.request`, `WebSocket`, `axios`, `undici`, `createClient`):

| Surface | File | Gate | Verdict |
|---|---|---|---|
| OpenAI cloud embeddings (ambient key seam) | `packages/core/src/vector/embedding.ts:56` | `cloudEmbeddingsEnabled()` checked INSIDE `embed()` — the chokepoint. Flag `AGENT_RECALL_CLOUD_EMBEDDINGS` ∈ {"1","true"} AND `OPENAI_API_KEY` both required. | PASS |
| Backend selection | `vector/local-vector-backend.ts:20` (`available()`), `tools-logic/recall-backend.ts:127`, `tools-logic/smart-remember.ts:308` | All route through `cloudEmbeddingsEnabled()`; belt-and-suspenders on top of the `embed()` chokepoint. | PASS |
| Supabase OpenAI/Voyage providers | `supabase/embedding.ts:33,44,66,77` | Constructor-injected key only (`createEmbeddingProvider(provider, apiKey)`); never reads `OPENAI_API_KEY`. Reachable only via `config.embedding_api_key` / `AGENT_RECALL_EMBEDDING_KEY` (`supabase/config.ts:60`), which itself requires explicit `supabase_url` + `supabase_anon_key` (`config.ts:71` returns null otherwise). | PASS |
| Supabase sync/recall/dashboard | `supabase/client.ts`, `palace/awareness.ts:43` | All behind `readSupabaseConfig()` null-gate (explicit opt-in). `fetchDashboardArchivedTitles` is a GET of titles, sends no memory content. | PASS |
| Local ONNX embeddings | `embeddings/runtime.ts` | `env.allowRemoteModels = false` — zero-network by construction. | PASS |

**Bypass check:** `embed()` enforces the gate internally, so no alternate import path (core export `cloudEmbeddingsEnabled`/`embed` via `index.ts`, CLI, MCP, SDK) can reach api.openai.com without the flag. No other reads of `OPENAI_API_KEY` exist outside `vector/embedding.ts` (grep-verified; remaining hits are comments). No telemetry egress found (`lifecycle-telemetry` is local-fs only).

**Test quality:** `packages/core/test/egress-cloud-embeddings-gate.test.mjs` stubs `globalThis.fetch` (no real network), covers the opt-in truth table, zero-egress assertions end-to-end through `smartRecall`/`smartRemember`, and the fetch-throws error path. Good.

### Findings

**MEDIUM-1 — 4-hex nonce (16 bits) undersized for its own threat model.**
`packages/core/src/storage/content-guard.ts:271-277` (`fenceNonce()` → `randomBytes(2)`).
The nonce defends the layer where exact-byte forgery is already dead (bracket neutralization at `content-guard.ts:287` rewrites every stored `⟦`/`⟧` → `[`/`]` BEFORE wrapping — verified still applied unconditionally, and tested at `p1-fence-boundary.test.mjs:124-137`). What remains is a reader that checks the nonce but tolerates homoglyph brackets. Against that reader, 16 bits is guessable by volume: stored content embedding ~100 lookalike closes with distinct nonce guesses matches the live nonce with p ≈ 100/65536 ≈ 0.15% per render; a memory recalled across ~300 sessions reaches ~37% cumulative. The code's "fixed-length for handoff probe" constraint holds equally at 16 hex chars.
*Fix (one line):* `randomBytes(2)` → `randomBytes(8)` (64 bits, 16 hex chars, still fixed-length); update the fallback pad to 16.
*Repro:* probability argument above; no code defect to demonstrate.

**LOW-1 — `Math.random` fallback is not a CSPRNG** (`content-guard.ts:275`). Only reachable if `node:crypto` is absent (practically never in Node ≥ 14; the never-throws contract motivates it, and the comment is honest). Acceptable as documented; consider `globalThis.crypto.getRandomValues` as intermediate fallback.

**LOW-2 — flag parsing is lowercase-only.** `cloudEmbeddingsEnabled()` (`vector/embedding.ts:42-46`) rejects `TRUE`/`yes`/`on`. Fails in the safe direction (no egress), but a user who sets `AGENT_RECALL_CLOUD_EMBEDDINGS=TRUE` gets silent null embeddings. Doc or normalize with `.toLowerCase()`.

**Tests:** full suite green — core 1915/1916 (1 skipped), mcp 76, sdk 41, cli 293, 0 fail.

---

## Branch 2 — fix/3.5.2-scrub-pii

### Verified sound

- **Fail-closed really closed.** `scrubForExport` (`content-guard.ts:577-611`) has no try/catch; throwing cores (`applySecretScrub`/`applyPiiScrub`) called directly. `doSync` (`supabase/sync.ts:239`) scrubs BEFORE any client write; a throw lands in its catch (`sync.ts:293`) → `logSyncError` → return — nothing uploaded (verified: no upsert precedes line 239, embedding input is parsed-from-scrubbed at `sync.ts:278`). `backfill` (`sync.ts:413`) computes the hash inside the per-file try → `failed++`, raw content only ever reaches the net through `doSync`'s own scrub. The thrown `SecretScanError` carries only the pattern LABEL, never content — no secret leakage into `sync-errors.log`.
- **Fixpoint loop converges.** Placeholders can't re-match (`[`-prefix filtered by `isSecretLikeValue`; `[REDACTED:*]` tokens carry no digits / break the entropy charset at `:`); the boundary-unblocking case (`a@b.io4111…`) that motivated the loop is real and handled; MAX_ROUNDS=5 + final clean-detection pass is a correct fail-closed postcondition.
- **ReDoS: PASS, measured.** Built dist, 17 adversarial inputs (keyword spam, unclosed quotes after KV, 100 KB digit/dash runs vs the PAN lookarounds, IBAN group floods, email local-part/domain-dot floods, entropy-charset floods): all ≤ 20 ms at 100 KB; scaling 100→800 KB is ~7x time for 8x input (linear). Bounded quantifiers claims check out.
- **PII egress-only decision: correct.** PII scrub lives only in `scrubForExport` (sync chokepoint + corrections export); `scrubForCloud` (local writes) untouched by PII. Rationale documented at `content-guard.ts:21-26` and `338-346`. Allowlists (RFC-2606 domains, noreply@, IBAN mod-97, PAN IIN+Luhn) behaved correctly in probes: `noreply@github.com`, checksum-failing IBAN, Luhn-failing PAN, 13-digit timestamps, git SHAs all preserved; real email/IBAN/Visa PAN all redacted.
- **House rule (string → path.join/RegExp/fs):** no new dynamic `RegExp`, no user content reaching `path.join`/`fs` in either diff. PASS.

### Findings

**HIGH-1 — URL-embedded credentials leak.** `content-guard.ts:160-167` (`isSecretLikeValue` exempts `^https?://`) + no connection-string pattern anywhere.
*Repro (probed against built dist):*
```
https://root:T0pSecr3t@10.20.30.40/admin        → LEAKED verbatim
https://svc:Pa55word@host:8443/x                → LEAKED verbatim
redis://default:MyRedisPw1@127.0.0.1:6379       → LEAKED verbatim
mongodb+srv://svc:P4ssw0rd!x@cluster0…          → "P4ssw0rd!" leaked ('!' splits the email match)
API_TOKEN=https://user:pass@…                   → KV rule explicitly exempts it
```
Domain-shaped hosts get the password redacted only by COINCIDENCE (the email rule matches `pass@host.tld`); IP hosts, host:port, and passwords with email-illegal chars leak outright. Connection strings are among the most common real-world secrets in dev notes — exactly what this product stores.
*Fix:* add to `SECRET_VALUE_PATTERNS`:
```ts
{
  re: /\b([a-z][a-z0-9+.-]{1,30}:\/\/[^/\s:@]{1,64}:)([^@\s/]{1,128})@/gi,
  label: "URL-embedded credential",
  decide: (_m, groups) => `${groups[0] ?? ""}[REDACTED:secret-value]@`,
}
```
(bounded quantifiers — linear; run it BEFORE the email rule so the password is labeled as a credential, not an email).

**MEDIUM-2 — `Authorization: Bearer <token>` has no context rule.** "bearer"/"authorization" absent from the KV keyword list (`content-guard.ts:170`), so opaque bearer tokens < 32 chars or hex-only rely on nothing: `Authorization: Bearer d4f8a2b9c1e3` → LEAKED (probed). JWTs are caught today only via the entropy rule (payload+signature redacted, constant `eyJ…` header survives — acceptable).
*Fix:* add a `bearer[ \t]+(\S{8,})` context pattern (same `isSecretLikeValue` filter).

**MEDIUM-3 — Slack webhook URLs leak.** `https://hooks.slack.com/services/T00000000/B00000000/XXXX…` → LEAKED (probed): it's a URL (KV-exempt) and `/` is excluded from the entropy charset, splitting the path. Webhook URLs are bearer credentials.
*Fix:* explicit pattern `/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g` → redact path.

**MEDIUM-4 (design, document-or-change) — entropy/KV scrub now mutates LOCAL writes.** The new layers live in `scrubSecretContent`, which `scrubForCloud` → journal/palace LOCAL writes run (`content-guard.ts:465-473`). A legit ≥32-char base64 identifier with ≥2 digits (API response IDs, vectra doc ids, data-URI fragments) is destroyed at rest, irreversibly, in the user's own journal — the same class of data the PII boundary comment argues the user "chose to record". Hex (git SHAs, digests) is safe; the ~4%-FP policy is documented for EGRESS but the local blast radius isn't acknowledged.
*Fix option:* move `applyEntropyScrub` (and optionally the KV rule) egress-side only (`scrubForExport`), keeping prefix rules local — mirrors the PII rationale exactly. At minimum, document the local behavior change.

**LOW-3 — `logSyncError` can throw inside the catch.** `sync.ts:108-122`: unguarded `mkdirSync/appendFileSync/readFileSync/writeFileSync/renameSync`. `scrubForExport` throwing is now an EXPECTED path into `doSync`'s catch; if the log write fails (root deleted mid-flight, disk full, read-only), the throw escapes the catch of fire-and-forget `void doSync(...)` (`sync.ts:202`) → unhandled rejection → process crash on Node ≥ 15. Pre-existing class, but this branch raises the catch-path frequency. *Fix:* wrap `logSyncError`'s body in try/catch (best-effort logging).

**LOW-4 — `glpat-` (GitLab PAT) leaks** (probed: `glpat-<20 chars>` — 26 chars, under the 32-char entropy floor, no prefix entry). Cheap prefix-table addition; same for `xoxs-`/`xoxa-` Slack variants (my `xoxs-` sample was only caught by entropy luck).

**LOW-5 — perf-budget test flake (observed).** Full suite: 1960/1962 pass, 1 skipped, **1 fail**: `content-guard-hardening.test.mjs:280` "email local-part bait (98 KB) scrubs in < 50 ms" measured 50.1 ms (best of 3) under full-suite load on this machine; standalone the same input runs ~16 ms. Not a security issue — raise the budget (e.g. 150 ms) or warm up before timing, or it will flake in CI.

**INFO** — `file_path`/slug are uploaded unscrubbed by `doSync` (pre-existing, out of scope): a memory file named after a person/email egresses its name. — Both branches edit `content-guard.ts`; whichever merges second must reconcile (nonce fence + scrub layers touch adjacent regions).

---

## Test runs (temp homes, `~/.agent-recall` untouched)

| Branch | Result |
|---|---|
| egress-gate | build clean; 1915+76+41+293 pass, 0 fail, 1 skipped |
| scrub-pii | build clean; 1960/1962 pass, 1 fail (LOW-5 timing flake only), 1 skipped |
