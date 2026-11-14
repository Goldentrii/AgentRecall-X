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

import { SITE_TOKENS } from "./site-theme.js";

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

const STYLE = SITE_TOKENS + `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 var(--sans)}
a{color:var(--cyan);text-underline-offset:3px}
:focus-visible{outline:3px solid var(--cyan);outline-offset:3px;border-radius:6px}
.page{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:28px 16px}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;letter-spacing:.02em}
.mark{width:10px;height:10px;border-radius:50%;background:var(--gold);box-shadow:0 0 14px var(--gold)}
main{background:var(--card);border:1px solid var(--line);border-top:3px solid var(--gold);border-radius:16px;padding:30px 28px;max-width:440px;width:100%}
h1{font:500 clamp(26px,5vw,32px)/1.12 var(--serif);letter-spacing:-.01em;margin:0 0 8px}
p{margin:10px 0;color:var(--muted)}
strong{color:var(--ink)}
.dest{font-size:17px;margin:14px 0 6px;color:var(--muted)}.dest strong{color:var(--cyan);font:600 16px var(--mono);overflow-wrap:anywhere}
.who{background:var(--sunk);border:1px solid var(--line);border-radius:10px;padding:12px 14px;font-size:14.5px;color:var(--muted);margin:12px 0}.who em{color:var(--dim)}
.note{font-size:14px;color:var(--dim)}
.warn{background:var(--warn-bg);border:1px solid var(--warn-line);border-left-width:4px;border-radius:10px;padding:10px 14px;font-size:14.5px;color:var(--warn-ink)}
.err{background:var(--err-bg);border:1px solid var(--err-line);border-left-width:4px;color:var(--err-ink);border-radius:10px;padding:10px 14px;font-size:14.5px;margin:14px 0}
button{display:block;margin-top:12px;width:100%;padding:14px 22px;border:1px solid var(--gold);border-radius:999px;background:var(--gold);color:var(--bg);font:600 16px/1 var(--sans);cursor:pointer}
button:hover{filter:brightness(1.08)}
button.secondary,button.reject{background:transparent;color:var(--ink);border-color:rgba(255,255,255,.4)}
button.secondary:hover,button.reject:hover{border-color:var(--ink);filter:none}
@media (max-width:520px){main{padding:24px 20px}}
`;

/** A whole page. `body` must already be escaped; `extraStyle` is a constant stylesheet, never user data. */
export function shell(title: string, body: string, extraStyle = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}${extraStyle}</style></head><body><div class="page"><div class="brand"><span class="mark"></span>AgentRecall</div><main>${body}</main></div></body></html>`;
}

export interface SignInView {
  requestId: string;
  clientName: string;
  redirectHost: string;
  destination: "loopback" | "claude" | "other";
  /** Configured providers only: [{name:"github", label:"GitHub"}]. */
  providers: Array<{ name: string; label: string }>;
  error?: string;
  /** Operator's privacy policy (validated https URL from AR_PRIVACY_URL); omitted = no link. */
  privacyUrl?: string;
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
    `</form>` +
    (v.privacyUrl
      ? `<p class="note">Your memory is stored on this server. <a href="${esc(v.privacyUrl)}" rel="noopener noreferrer" target="_blank">Privacy policy</a></p>`
      : ""));
}

export function errorPage(message: string): string {
  return shell("AgentRecall sign-in", `<h1>Sign-in problem</h1><div class="err" role="alert">${esc(message)}</div><p>You can close this tab and start again from your app.</p>`);
}
