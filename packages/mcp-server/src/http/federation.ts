/**
 * federation.ts — talks to GitHub / Google so users can sign in without AgentRecall
 * ever handling a password. Authorization-code flow with PKCE (S256) toward the
 * provider; we only learn a stable numeric subject:
 *
 *   github  → GET /user `id`
 *   google  → OIDC id_token `sub`
 *
 * Every upstream call: 10 s timeout, redirects refused, response size capped.
 * FederationError messages never contain codes, tokens, secrets or response bodies.
 *   kind "unavailable": network / timeout / 5xx / 429 / non-JSON  (user may retry)
 *   kind "rejected":    the provider or its answer did not check out (generic failure)
 */
import { createHash, randomBytes } from "node:crypto";
import { parseOrigin, type OAuthConfig, type ProviderName } from "./oauth-config.js";

export interface ProviderUrls {
  githubAuthorize: string;
  githubToken: string;
  githubApi: string;
  googleAuthorize: string;
  googleToken: string;
}

export const DEFAULT_PROVIDER_URLS: ProviderUrls = {
  githubAuthorize: "https://github.com/login/oauth/authorize",
  githubToken: "https://github.com/login/oauth/access_token",
  githubApi: "https://api.github.com/user",
  googleAuthorize: "https://accounts.google.com/o/oauth2/v2/auth",
  googleToken: "https://oauth2.googleapis.com/token",
};

export const PROVIDER_LABEL: Record<ProviderName, string> = { github: "GitHub", google: "Google" };

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 256 * 1024;
const SUBJECT_RE: Record<ProviderName, RegExp> = { github: /^[1-9]\d{0,15}$/, google: /^\d{1,30}$/ };
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

export class FederationError extends Error {
  constructor(public kind: "unavailable" | "rejected", public reason: string) {
    super(`federation ${kind}: ${reason}`);
  }
}

/** Test-only overrides must still be https (or http on localhost): same rule as AR_PUBLIC_URL, applied to the origin. */
export function validateProviderUrls(urls: ProviderUrls): ProviderUrls {
  for (const [k, v] of Object.entries(urls)) parseOrigin(`provider url ${k}`, new URL(v).origin + "/");
  return urls;
}

/** Origins the sign-in page must allow in `form-action` (browsers apply it to the redirect after the form POST). */
export function formActionOrigins(urls: ProviderUrls, providers: readonly ProviderName[]): string[] {
  const set = new Set<string>();
  for (const p of providers) set.add(new URL(p === "github" ? urls.githubAuthorize : urls.googleAuthorize).origin);
  return [...set];
}

export const b64url = (b: Buffer): string => b.toString("base64url");

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export class Federation {
  readonly urls: ProviderUrls;

  constructor(
    private readonly config: OAuthConfig,
    urls: ProviderUrls = DEFAULT_PROVIDER_URLS,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs: number = TIMEOUT_MS,
  ) {
    this.urls = validateProviderUrls(urls);
  }

  enabledProviders(): ProviderName[] {
    return (["github", "google"] as const).filter((p) => this.config.providers[p] !== undefined);
  }

  redirectUri(provider: ProviderName): string {
    return new URL(`/authorize/callback/${provider}`, this.config.publicUrl).href;
  }

  authorizeUrl(provider: ProviderName, p: { state: string; challenge: string; nonce: string }): string {
    const creds = this.config.providers[provider];
    if (!creds) throw new FederationError("rejected", "provider not configured");
    const u = new URL(provider === "github" ? this.urls.githubAuthorize : this.urls.googleAuthorize);
    u.searchParams.set("client_id", creds.clientId);
    u.searchParams.set("redirect_uri", this.redirectUri(provider));
    u.searchParams.set("state", p.state);
    u.searchParams.set("code_challenge", p.challenge);
    u.searchParams.set("code_challenge_method", "S256");
    if (provider === "google") {
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", "openid");
      u.searchParams.set("nonce", p.nonce);
      u.searchParams.set("prompt", "select_account");
    }
    return u.href;
  }

  private async call(url: string, init: RequestInit): Promise<{ status: number; json: any }> {
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) });
      text = await res.text();
    } catch (err) {
      const name = (err as Error)?.name;
      throw new FederationError("unavailable", name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
    }
    if (res.status >= 500 || res.status === 429) throw new FederationError("unavailable", `http ${res.status}`);
    if (text.length > MAX_RESPONSE_CHARS) throw new FederationError("unavailable", "response too large");
    try {
      return { status: res.status, json: JSON.parse(text) };
    } catch {
      throw new FederationError("unavailable", "non-json response");
    }
  }

  /** Trade the provider's code for a verified subject id. */
  async identify(provider: ProviderName, code: string, verifier: string, nonce: string): Promise<string> {
    const creds = this.config.providers[provider];
    if (!creds) throw new FederationError("rejected", "provider not configured");
    const body = new URLSearchParams({
      client_id: creds.clientId, client_secret: creds.clientSecret, code,
      redirect_uri: this.redirectUri(provider), code_verifier: verifier,
    });
    if (provider === "github") return this.identifyGithub(body);
    body.set("grant_type", "authorization_code");
    return this.identifyGoogle(body, creds.clientId, nonce);
  }

  private async identifyGithub(body: URLSearchParams): Promise<string> {
    const tok = await this.call(this.urls.githubToken, {
      method: "POST", body: body.toString(),
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "agent-recall-server" },
    });
    const accessToken = tok.json?.access_token;
    if (tok.status !== 200 || typeof accessToken !== "string" || accessToken.length === 0) throw new FederationError("rejected", "github token exchange");
    const user = await this.call(this.urls.githubApi, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "User-Agent": "agent-recall-server" },
    });
    const id = user.json?.id;
    if (user.status !== 200 || typeof id !== "number" || !Number.isSafeInteger(id) || !SUBJECT_RE.github.test(String(id))) {
      throw new FederationError("rejected", "github user id");
    }
    return String(id);
  }

  private async identifyGoogle(body: URLSearchParams, clientId: string, nonce: string): Promise<string> {
    const tok = await this.call(this.urls.googleToken, {
      method: "POST", body: body.toString(),
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    });
    const idToken = tok.json?.id_token;
    if (tok.status !== 200 || typeof idToken !== "string") throw new FederationError("rejected", "google token exchange");
    // The id_token comes straight from Google's token endpoint over TLS, so its signature need not be
    // verified (OpenID Connect Core 3.1.3.7, step 6); we still check every claim that binds it to this request.
    const parts = idToken.split(".");
    let claims: any;
    try {
      claims = parts.length === 3 ? JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) : null;
    } catch {
      claims = null;
    }
    if (claims === null || typeof claims !== "object") throw new FederationError("rejected", "google id_token format");
    // aud: our client id; an array form additionally needs azp === our client id (OIDC Core 3.1.3.7 steps 3-5).
    const audOk = claims.aud === clientId || (Array.isArray(claims.aud) && claims.aud.includes(clientId) && claims.azp === clientId);
    if (claims.azp !== undefined && claims.azp !== clientId) throw new FederationError("rejected", "google azp");
    if (typeof claims.iat !== "number" || claims.iat * 1000 > this.now() + 5 * 60 * 1000) throw new FederationError("rejected", "google iat");
    if (!GOOGLE_ISSUERS.has(claims.iss)) throw new FederationError("rejected", "google iss");
    if (!audOk) throw new FederationError("rejected", "google aud");
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= this.now()) throw new FederationError("rejected", "google exp");
    if (typeof claims.nonce !== "string" || claims.nonce !== nonce) throw new FederationError("rejected", "google nonce");
    if (typeof claims.sub !== "string" || !SUBJECT_RE.google.test(claims.sub)) throw new FederationError("rejected", "google sub");
    return claims.sub;
  }
}
