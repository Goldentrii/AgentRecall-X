/**
 * redirect-policy.ts — which redirect_uri values a client may register/use.
 *
 * Open dynamic registration + arbitrary redirects would let anyone phish a
 * user's memory token, so only these are allowed:
 *   - loopback (RFC 8252): http://127.0.0.1:*, http://localhost:*, http://[::1]:*
 *   - https://claude.ai/api/mcp/auth_callback and https://claude.com/api/mcp/auth_callback
 *   - operator-listed prefixes (AR_OAUTH_REDIRECT_ALLOW)
 * Never allowed, whatever the allow-list says: fragments, userinfo, whitespace/
 * control chars/backslashes, javascript:/data:/file:/blob:/vbscript: schemes.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const FIXED = new Set([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
]);
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "file:", "blob:", "vbscript:", "about:"]);
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\s\u0000-\u001f\u007f\\]/;

/** Custom-scheme native apps that are allowed out of the box (PKCE protects the code). */
export const DEFAULT_REDIRECT_PREFIXES: readonly string[] = ["cursor://anysphere.cursor-retrieval/"];

/** Encoded dots/slashes/backslashes or dot segments could slip past a prefix check (…/cb/%2e%2e/admin). */
function hasPathTricks(raw: string): boolean {
  if (/%2e|%2f|%5c/i.test(raw)) return true;
  const afterAuthority = raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?]*/i, "");
  const pathOnly = afterAuthority.split("?")[0];
  return pathOnly.split("/").some((seg) => seg === "." || seg === "..");
}

/** A prefix matches only at a URL boundary, so https://a.com never matches https://a.com.evil.net. */
function prefixMatches(raw: string, prefix: string): boolean {
  if (!raw.startsWith(prefix)) return false;
  const rest = raw.slice(prefix.length);
  return rest === "" || prefix.endsWith("/") || /^[/?]/.test(rest);
}

function normalizedHref(s: string): string | null {
  try {
    return new URL(s).href;
  } catch {
    return null;
  }
}

export function isAllowedRedirect(uri: unknown, extraPrefixes: readonly string[] = []): boolean {
  if (typeof uri !== "string" || uri.length === 0 || uri.length > 2048) return false;
  if (BAD_CHARS.test(uri) || uri.includes("#")) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.username || u.password || u.hash) return false;
  if (FORBIDDEN_SCHEMES.has(u.protocol)) return false;

  if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return true;
  if (u.protocol === "https:" && u.search === "" && FIXED.has(`${u.origin}${u.pathname}`)) return true;
  // Prefixes are matched against the NORMALIZED URL, and encoded/dot-segment paths are refused outright.
  if (hasPathTricks(uri)) return false;
  return [...DEFAULT_REDIRECT_PREFIXES, ...extraPrefixes].some((p) => {
    const np = p.length > 0 ? normalizedHref(p) : null;
    return np !== null && prefixMatches(u.href, np);
  });
}
