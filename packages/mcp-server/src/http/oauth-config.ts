/**
 * oauth-config.ts — OAuth is OFF unless a public URL AND at least one federated
 * login provider are configured; then the server is its own OAuth authorization
 * server and users sign in with GitHub and/or Google. AgentRecall never sees or
 * stores a password.
 *
 *   AR_PUBLIC_URL / --public-url        public origin = OAuth issuer (https, except localhost)
 *   AR_OAUTH_GITHUB_CLIENT_ID / _SECRET GitHub OAuth app (callback: <public>/authorize/callback/github)
 *   AR_OAUTH_GOOGLE_CLIENT_ID / _SECRET Google OAuth client (callback: <public>/authorize/callback/google)
 *   AR_OAUTH_REDIRECT_ALLOW             extra allowed client redirect URI prefixes, comma-separated
 *   AR_TRUST_PROXY=1                    trust ONE proxy hop for the client IP
 *
 * Nothing configured → null (server == v1). Anything half-configured (a lone
 * id or secret, a public URL without a provider, a provider without a public
 * URL) throws: fail closed instead of silently running without OAuth.
 */

export class OAuthConfigError extends Error {}

export type ProviderName = "github" | "google";
export const PROVIDER_NAMES: readonly ProviderName[] = ["github", "google"];

export interface ProviderCreds {
  clientId: string;
  clientSecret: string;
}

export interface OAuthConfig {
  /** Issuer / public origin, e.g. https://recall.aiakada.com */
  publicUrl: URL;
  /** Protected resource: <public>/mcp. Tokens are audience-bound to it. */
  resourceUrl: URL;
  providers: Partial<Record<ProviderName, ProviderCreds>>;
  redirectAllow: string[];
  trustProxy: boolean;
}

export interface OAuthConfigInput {
  publicUrl?: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function clean(v: string | undefined): string | undefined {
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

export function parseOrigin(name: string, raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new OAuthConfigError(`${name} is not a valid URL: "${raw}"`);
  }
  const secure = u.protocol === "https:" || (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname));
  if (!secure) throw new OAuthConfigError(`${name} must be https (http only for localhost), got "${raw}"`);
  if (u.username || u.password) throw new OAuthConfigError(`${name} must not contain credentials`);
  if (u.search || u.hash || u.pathname !== "/") {
    throw new OAuthConfigError(`${name} must be an origin only (no path, query or fragment), got "${raw}"`);
  }
  return u;
}

export function loadOAuthConfig(flags: OAuthConfigInput = {}, env: NodeJS.ProcessEnv = process.env): OAuthConfig | null {
  const pub = clean(flags.publicUrl) ?? clean(env.AR_PUBLIC_URL);
  const providers: Partial<Record<ProviderName, ProviderCreds>> = {};
  for (const name of PROVIDER_NAMES) {
    const up = name.toUpperCase();
    const id = clean(env[`AR_OAUTH_${up}_CLIENT_ID`]);
    const secret = clean(env[`AR_OAUTH_${up}_CLIENT_SECRET`]);
    if (id === undefined && secret === undefined) continue;
    if (id === undefined || secret === undefined) {
      throw new OAuthConfigError(`OAuth ${name} login needs both AR_OAUTH_${up}_CLIENT_ID and AR_OAUTH_${up}_CLIENT_SECRET`);
    }
    providers[name] = { clientId: id, clientSecret: secret };
  }
  const anyProvider = Object.keys(providers).length > 0;
  if (pub === undefined && !anyProvider) return null;
  if (pub === undefined) throw new OAuthConfigError("OAuth needs AR_PUBLIC_URL (--public-url) as well as the provider credentials");
  if (!anyProvider) {
    throw new OAuthConfigError("OAuth needs at least one provider: set AR_OAUTH_GITHUB_CLIENT_ID/_SECRET and/or AR_OAUTH_GOOGLE_CLIENT_ID/_SECRET");
  }
  const publicUrl = parseOrigin("AR_PUBLIC_URL", pub);
  const redirectAllow = (clean(env.AR_OAUTH_REDIRECT_ALLOW) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const tp = (clean(env.AR_TRUST_PROXY) ?? "").toLowerCase();
  return {
    publicUrl,
    resourceUrl: new URL("/mcp", publicUrl),
    providers,
    redirectAllow,
    trustProxy: tp === "1" || tp === "true",
  };
}
