/**
 * review-pages.ts — HTML for the owner's review page (/review). Plain strings, no
 * template engine, no scripts. EVERY interpolated value goes through esc(): proposal
 * text is agent-written, so it is untrusted however it was cleaned on the way in.
 * Headers come from oauth-pages.pageHeaders (strict CSP, no framing, no-store).
 */
import { esc, shell } from "./oauth-pages.js";

export interface ReviewItem {
  id: string;
  project: string;
  severity: string;
  seenCount: number;
  firstSeen: string;
  lastSeen: string;
  rule: string;
  why: string;
  appliesWhen: string[];
}

export interface ReviewListView {
  /** Who signed in, e.g. "GitHub account 101". */
  account: string;
  /** The memory (tenant) the account maps to. */
  uid: string;
  csrf: string;
  /** A key of NOTICES (the session's one-shot outcome of the last post); anything else is ignored, never echoed. */
  notice?: string;
  items: ReviewItem[];
  /** Captures that cannot be approved as they stand (not the structured form). */
  incomplete: number;
  /** Ready proposals not shown because of the display cap. */
  hidden: number;
}

export interface ReviewSignInView {
  providers: Array<{ name: string; label: string }>;
  error?: string;
  privacyUrl?: string;
}

const NOTICES: Record<string, string> = {
  approved: "Approved. It is active from the next session_start.",
  merged: "Approved. An active correction with the same rule already existed, so this one was merged into it and the existing wording is kept.",
  rejected: "Rejected. It will not become active.",
  gone: "That proposal is no longer waiting, or its text changed after it was shown. Nothing was activated.",
  failed: "That proposal could not be approved. Nothing was activated; if it is still waiting it is listed below.",
  unavailable: "Your proposals could not be read just now. Nothing was changed; please try again.",
};

export function noticeKey(v: unknown): string | undefined {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(NOTICES, v) ? v : undefined;
}

const REVIEW_STYLE = `
main{max-width:760px}
.p{border:1px solid #dde1e6;border-radius:10px;padding:14px 16px;margin:14px 0}
.meta{font-size:13px;color:#5b6570;margin:0 0 6px}
.rule{font-size:16px;font-weight:600;color:#14171a;white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0}
.why{white-space:pre-wrap;overflow-wrap:anywhere}
.when{font-size:14px}.when code{background:#f0f2f5;border-radius:4px;padding:1px 5px;margin-right:4px;white-space:pre-wrap;overflow-wrap:anywhere}
.id{font:12px ui-monospace,Consolas,monospace;color:#5b6570;overflow-wrap:anywhere}
.acts{display:flex;gap:10px}.acts form{flex:1}
button.reject,button.secondary{background:#fff;color:#14171a;border:1px solid #c4cad1}
.ok{background:#e9f7ef;border:1px solid #a6dcbc;color:#14532d;border-radius:8px;padding:10px 12px;font-size:14px;margin:12px 0}
.bar{display:flex;justify-content:space-between;align-items:center;gap:12px}.bar form{width:auto}.bar button{margin:0;width:auto;padding:7px 12px}
`;

const hidden = (name: string, value: string): string => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;

export function reviewSignInPage(v: ReviewSignInView): string {
  return shell("Review your AgentRecall corrections",
    `<h1>Review your corrections</h1>` +
    `<p>Your agents can only <strong>propose</strong> an always-follow rule. Nothing becomes active until you approve it here.</p>` +
    `<p class="note">Sign in with the account your hosted memory belongs to. Agent tokens are not accepted on this page, so an agent cannot approve its own proposals.</p>` +
    (v.error ? `<div class="err" role="alert">${esc(v.error)}</div>` : "") +
    `<form method="post" action="/review/start">` +
    v.providers.map((p) => `<button type="submit" name="provider" value="${esc(p.name)}">Continue with ${esc(p.label)}</button>`).join("") +
    `</form>` +
    (v.privacyUrl ? `<p class="note"><a href="${esc(v.privacyUrl)}" rel="noopener noreferrer" target="_blank">Privacy policy</a></p>` : ""),
    REVIEW_STYLE);
}

function item(it: ReviewItem, csrf: string): string {
  const fields = hidden("id", it.id) + hidden("project", it.project) + hidden("csrf", csrf);
  return `<section class="p">` +
    `<p class="meta">project <strong>${esc(it.project)}</strong> · ${esc(it.severity)} · proposed ${esc(it.seenCount)}× · first ${esc(it.firstSeen)} · last ${esc(it.lastSeen)}</p>` +
    `<p class="rule">${esc(it.rule)}</p>` +
    `<p class="why"><strong>Why:</strong> ${esc(it.why)}</p>` +
    `<p class="when"><strong>Applies when:</strong> ${it.appliesWhen.map((w) => `<code>${esc(w)}</code>`).join("")}</p>` +
    `<p class="id">${esc(it.id)}</p>` +
    `<div class="acts">` +
    `<form method="post" action="/review/approve">${fields}<button type="submit">Approve</button></form>` +
    `<form method="post" action="/review/reject">${fields}<button type="submit" class="reject">Reject</button></form>` +
    `</div></section>`;
}

export function reviewListPage(v: ReviewListView): string {
  const key = noticeKey(v.notice);
  const n = v.items.length;
  return shell("Review your AgentRecall corrections",
    `<div class="bar"><h1>Review your corrections</h1>` +
    `<form method="post" action="/review/logout">${hidden("csrf", v.csrf)}<button type="submit" class="secondary">Sign out</button></form></div>` +
    `<p class="note">Signed in with ${esc(v.account)} · memory <strong>${esc(v.uid)}</strong></p>` +
    (key ? `<div class="${key === "gone" || key === "failed" || key === "unavailable" ? "err" : "ok"}" role="status" data-notice="${esc(key)}">${esc(NOTICES[key])}</div>` : "") +
    (n === 0
      ? `<p>Nothing is waiting for your review.</p>`
      : `<p>${n} proposed correction${n === 1 ? " is" : "s are"} waiting, oldest first. An approved correction is loaded by every one of your agents at session_start; ` +
        `a p0 shows up under HARD RULES. Read it in full: what you see is exactly what approving activates.</p>` +
        v.items.map((it) => item(it, v.csrf)).join("")) +
    (v.hidden > 0 ? `<p class="note">${esc(v.hidden)} more waiting. Approve or reject these to see them.</p>` : "") +
    (v.incomplete > 0
      ? `<p class="note">${esc(v.incomplete)} other capture${v.incomplete === 1 ? "" : "s"} cannot be approved as ${v.incomplete === 1 ? "it stands" : "they stand"}: ` +
        `ask your agent to re-submit ${v.incomplete === 1 ? "it" : "them"} with a rule (at most 200 characters), a why (at most 600) and applies_when (at most 8 entries of at most 60 characters). They expire after 14 days.</p>`
      : ""),
    REVIEW_STYLE);
}

/** A standalone message (errors, expired sessions) with a way back to the start. */
export function reviewMessagePage(title: string, message: string): string {
  return shell("AgentRecall review",
    `<h1>${esc(title)}</h1><div class="err" role="alert">${esc(message)}</div><p><a href="/review">Back to the review page</a></p>`,
    REVIEW_STYLE);
}
