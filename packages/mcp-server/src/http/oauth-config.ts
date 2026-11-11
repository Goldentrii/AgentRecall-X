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
 *   AR_OAUTH_SIGNUP=invite|open         invite (default): only accounts linked with `identity link` may sign in
 *   AR_PRIVACY_URL                      optional https link to the privacy policy, shown on the sign-in page
 *   AR_TRUST_PROXY=1|true|yes|on        trust ONE proxy hop for the client IP (0|false|no|off or empty = no)
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
  /** invite: only operator-linked accounts may sign in (no tenant is created for anyone else). */
  signup: SignupMode;
  /** AR_PRIVACY_URL: the operator's privacy policy, linked from the sign-in page (https only). */
  privacyUrl?: URL;
}

function parsePrivacyUrl(raw: string | undefined): URL | undefined {
  const v = clean(raw);
  if (v === undefined) return undefined;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new OAuthConfigError("AR_PRIVACY_URL is not a valid URL");
  }
  if (u.username || u.password) throw new OAuthConfigError("AR_PRIVACY_URL must not contain credentials");
  if (u.protocol !== "https:") throw new OAuthConfigError("AR_PRIVACY_URL must be an https URL");
  return u;
}

export type SignupMode = "invite" | "open";

export interface OAuthConfigInput {
  publicUrl?: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function clean(v: string | undefined): string | undefined {
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

/** The value as it may appear in an error message: any userinfo (user:password@) masked. */
function shown(raw: string): string {
  return raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, "$1***@");
}

export function parseOrigin(name: string, raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new OAuthConfigError(`${name} is not a valid URL: "${shown(raw)}"`);
  }
  // Credentials first, so no later message ever echoes them.
  if (u.username || u.password) throw new OAuthConfigError(`${name} must not contain credentials`);
  const secure = u.protocol === "https:" || (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname));
  if (!secure) throw new OAuthConfigError(`${name} must be https (http only for localhost), got "${shown(raw)}"`);
  if (u.search || u.hash || u.pathname !== "/") {
    throw new OAuthConfigError(`${name} must be an origin only (no path, query or fragment), got "${shown(raw)}"`);
  }
  return u;
}

const TRUE_WORDS = new Set(["1", "true", "yes", "on"]);
const FALSE_WORDS = new Set(["", "0", "false", "no", "off"]);

/** A yes/no setting; an unrecognised value fails closed instead of silently meaning "no". */
function parseBool(name: string, raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  if (TRUE_WORDS.has(v)) return true;
  if (FALSE_WORDS.has(v)) return false;
  throw new OAuthConfigError(`${name} must be one of 1/true/yes/on or 0/false/no/off, got "${raw}"`);
}

function parseSignup(raw: string | undefined): SignupMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "invite") return "invite";
  if (v === "open") return "open";
  throw new OAuthConfigError(`AR_OAUTH_SIGNUP must be "invite" (default) or "open", got "${raw}"`);
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
  return {
    publicUrl,
    resourceUrl: new URL("/mcp", publicUrl),
    providers,
    redirectAllow,
    trustProxy: parseBool("AR_TRUST_PROXY", env.AR_TRUST_PROXY),
    signup: parseSignup(env.AR_OAUTH_SIGNUP),
    privacyUrl: parsePrivacyUrl(env.AR_PRIVACY_URL),
  };
}
