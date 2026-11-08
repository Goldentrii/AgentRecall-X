/**
 * oauth-pages.ts — the HTML the sign-in flow shows. Plain strings, no template engine.
 *
 * EVERY interpolated value goes through esc(). There is no password or code field
 * anywhere: the page only offers "Continue with GitHub / Google" buttons that POST
 * to this server, which then redirects to the provider. Security headers (see
 * pageHeaders): no framing, no referrer, no caching, no scripts, and forms may only
 * post to this server plus the provider origins — browsers also apply form-action
 * to the redirect that follows the form POST.
 */

export function esc(v: unknown): string {
  return String(v ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;");
}

/** `formActionOrigins`: extra origins (the providers) the sign-in form may be redirected to. */
export function pageHeaders(formActionOrigins: readonly string[] = []): Record<string, string> {
  const extra = formActionOrigins.filter((o) => /^https?:\/\/[A-Za-z0-9.\-:[\]]+$/.test(o));
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy":
      `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'${extra.length ? " " + extra.join(" ") : ""}; frame-ancestors 'none'`,
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
}

const STYLE = `
body{font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:#f6f7f9;color:#14171a;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{background:#fff;border:1px solid #dde1e6;border-radius:12px;padding:28px;max-width:400px;width:calc(100% - 32px)}
h1{font-size:20px;margin:0 0 4px}p{margin:8px 0;color:#444}.who{background:#f0f2f5;border-radius:8px;padding:10px 12px;font-size:14px}
button{margin-top:14px;width:100%;padding:11px;border:0;border-radius:8px;background:#14171a;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.dest{font-size:17px;margin:12px 0 4px;color:#14171a}.warn{background:#fff6e0;border:1px solid #f0d28a;border-radius:8px;padding:8px 12px;font-size:14px;color:#6b4a00}.note{font-size:14px}
.err{background:#fdecec;border:1px solid #f3b7b7;color:#8a1c1c;border-radius:8px;padding:10px 12px;font-size:14px;margin:12px 0}
`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export interface SignInView {
  requestId: string;
  clientName: string;
  redirectHost: string;
  destination: "loopback" | "claude" | "other";
  /** Configured providers only: [{name:"github", label:"GitHub"}]. */
  providers: Array<{ name: string; label: string }>;
  error?: string;
}

export function signInPage(v: SignInView): string {
  return shell("Sign in to AgentRecall",
    `<h1>Sign in to AgentRecall</h1>` +
    `<p class="dest">Sign-in result goes to: <strong>${esc(v.redirectHost)}</strong></p>` +
    (v.destination === "loopback" ? `<p class="warn">This connects a program running on this computer. Only continue if you just started the connection yourself.</p>` : "") +
    (v.destination === "claude" ? `<p class="note">This connects Claude (claude.ai).</p>` : "") +
    `<div class="who">Requested by <strong>${esc(v.clientName)}</strong> <em>(self-reported name, not verified)</em>. ` +
    `It wants read and write access to your AgentRecall memory.</div>` +
    `<p>Choose an account to continue.</p>` +
    (v.error ? `<div class="err" role="alert">${esc(v.error)}</div>` : "") +
    `<form method="post" action="/authorize/start">` +
    `<input type="hidden" name="request_id" value="${esc(v.requestId)}">` +
    v.providers.map((p) => `<button type="submit" name="provider" value="${esc(p.name)}">Continue with ${esc(p.label)}</button>`).join("") +
    `</form>`);
}

export function errorPage(message: string): string {
  return shell("AgentRecall sign-in", `<h1>Sign-in problem</h1><div class="err" role="alert">${esc(message)}</div><p>You can close this tab and start again from your app.</p>`);
}
