/**
 * site-pages.ts — the HTML (and markdown) of the hosted website: /, /connect, /local,
 * /connect.md, /local.md, /llms.txt. Plain strings, no template engine, no framework.
 *
 * Every interpolated value goes through esc(). The pages load NOTHING from elsewhere:
 * system fonts, inline SVG, one inline stylesheet and one tiny inline script, each
 * allowed by a CSP sha256 hash (see siteHeaders). Nothing here sets a cookie or phones
 * a third party (PRIVACY.md promises none).
 *
 * Design: "index cards". AgentRecall hands every agent the same few cards at
 * session_start, so the site is made of cards: white paper on a pale blue-grey desk,
 * navy ink, one yellow highlighter line and one red pin, the same palette as the README
 * art. Headlines are a system serif, commands are mono, everything else is system sans.
 */
import { createHash } from "node:crypto";
import { esc } from "./oauth-pages.js";

export const REPO_URL = "https://github.com/Goldentrii/AgentRecall-X";
export const TELEGRAM_URL = "https://t.me/+ywZwoHrg3AM0NDVi";
export const DEFAULT_PRIVACY_URL = `${REPO_URL}/blob/main/PRIVACY.md`;

export interface SiteCtx {
  /** Origin of this server, e.g. https://recall.aiakada.com (no trailing slash). */
  base: string;
  privacyUrl: string;
  /** Is hosted sign-in configured (OAuth on)? */
  hosted: boolean;
  /** The base URL was taken from the request's Host header (no configured public URL): pages must not be cached. */
  baseFromHost?: boolean;
}

// ---- assets ---------------------------------------------------------------

const CSS = `
:root{color-scheme:light dark;--paper:#F2F5FA;--card:#FFFFFF;--ink:#18233F;--slate:#566482;--line:#D3DBE8;--soft:#E7ECF4;--code:#EEF2F8;--red:#DD3B45;--yellow:#FFE45C;--btn:#18233F;--btnink:#FFFFFF;--focus:#2B5BD7;--okbg:#E6F5EC;--okink:#14532D;--errbg:#FDECEC;--errink:#8A1C1C;--serif:ui-serif,"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;--sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
@media (prefers-color-scheme:dark){:root{--paper:#0E141F;--card:#161E2C;--ink:#E8EEF8;--slate:#9FB0CC;--line:#2B374B;--soft:#1D2738;--code:#0B111A;--btn:#FFE45C;--btnink:#18233F;--focus:#8DB0FF;--okbg:#10301F;--okink:#A9E6C0;--errbg:#3A1618;--errink:#F5B5B8}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.6 var(--sans)}
a{color:inherit;text-underline-offset:3px;text-decoration-thickness:1px}
a:hover{text-decoration-thickness:2px}
:focus-visible{outline:3px solid var(--focus);outline-offset:3px;border-radius:4px}
.skip{position:absolute;left:-999px;top:8px;background:var(--btn);color:var(--btnink);padding:8px 14px;border-radius:8px;z-index:9}
.skip:focus{left:8px}
.wrap{max-width:1080px;margin:0 auto;padding:0 24px}
header.top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:20px 0}
.brand{display:flex;align-items:center;gap:10px;font:700 19px/1 var(--serif);text-decoration:none;letter-spacing:-.01em}
.brand svg{width:34px;height:34px}
nav.main{display:flex;gap:22px;flex-wrap:wrap;font-size:15px}
nav.main a{text-decoration:none;padding:6px 0;border-bottom:2px solid transparent}
nav.main a:hover,nav.main a[aria-current]{border-bottom-color:var(--red)}
h1,h2,h3{font-family:var(--serif);line-height:1.12;letter-spacing:-.015em;margin:0}
h1{font-size:clamp(2.35rem,6.4vw,4.1rem);font-weight:700}
h2{font-size:clamp(1.55rem,3.4vw,2.1rem);font-weight:700}
h3{font-size:1.2rem;font-weight:700}
p{margin:0 0 14px}
h1+.lede{margin-top:14px}
.panel h3{margin-top:18px}
.lede{font-size:clamp(1.05rem,2.2vw,1.25rem);color:var(--slate);max-width:34em}
.hero{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:40px;align-items:center;padding:28px 0 56px}
.hero h1{margin:0 0 18px}
.cta{display:flex;gap:12px;flex-wrap:wrap;margin:26px 0 18px}
.btn{display:inline-block;font:600 16px/1 var(--sans);padding:15px 22px;border-radius:10px;border:2px solid var(--btn);background:var(--btn);color:var(--btnink);text-decoration:none;cursor:pointer}
.btn:hover{filter:brightness(1.12)}
.btn.alt{background:transparent;color:var(--ink);border-color:var(--ink)}
.btn.small{padding:10px 14px;font-size:14px;border-radius:8px}
.btn.danger{background:transparent;color:var(--errink);border-color:var(--errink)}
.agentnote{font-size:14px;color:var(--slate)}
.agentnote a{font-family:var(--mono);font-size:13px}
.art{width:100%;height:auto;display:block}
.art .chip{fill:var(--card);stroke:var(--ink);stroke-width:2}
.art .wire{stroke:var(--slate);stroke-width:2;fill:none;stroke-dasharray:3 6;stroke-linecap:round}
.art .back{fill:var(--soft);stroke:var(--line);stroke-width:2}
.art .face{fill:var(--card);stroke:var(--ink);stroke-width:2.5}
.art text{font-family:var(--sans);fill:var(--ink);font-size:15px}
.art .mono{font-family:var(--mono);font-size:13px;fill:var(--slate)}
.art .head{font-family:var(--serif);font-weight:700;font-size:20px}
.art .hl{fill:var(--yellow)}
.art .hltext{fill:#18233F;font-weight:600;font-size:14px}
.art .dot{fill:var(--red)}
.art .rule{stroke:var(--line);stroke-width:2}
.doors{display:grid;grid-template-columns:1fr 1fr;gap:22px;padding:8px 0 24px}
.door{position:relative;background:var(--card);border:2px solid var(--ink);border-radius:16px;padding:30px 28px 28px;box-shadow:6px 6px 0 var(--soft)}
.door:before{content:"";position:absolute;top:-2px;left:28px;width:46px;height:8px;background:var(--red);border-radius:0 0 6px 6px}
.door.local:before{background:var(--yellow)}
.door h2{margin:6px 0 10px}
.door p{color:var(--slate)}
.door ul{margin:0 0 22px;padding-left:20px;color:var(--ink)}
.door li{margin:4px 0}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;padding:30px 0 20px;margin:0;list-style:none;counter-reset:s}
.steps li{counter-increment:s;border-top:2px solid var(--ink);padding-top:14px}
.steps li:before{content:counter(s);font:700 28px/1 var(--serif);display:block;margin-bottom:8px}
.steps strong{display:block;font-family:var(--serif);font-size:1.15rem;margin-bottom:4px}
.steps span{color:var(--slate);font-size:15.5px}
section.block{padding:34px 0}
footer.foot{border-top:1px solid var(--line);margin-top:48px;padding:26px 0 44px;display:flex;gap:22px;flex-wrap:wrap;justify-content:space-between;color:var(--slate);font-size:15px}
footer.foot nav{display:flex;gap:22px;flex-wrap:wrap}
.panel{background:var(--card);border:2px solid var(--ink);border-radius:16px;padding:26px 26px 24px;margin:0 0 22px;box-shadow:6px 6px 0 var(--soft)}
.panel>h2{font-size:1.5rem;margin-bottom:6px}
.panel>p.sub{color:var(--slate);margin-bottom:16px}
.who{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin:6px 0 26px}
.who p{margin:0;color:var(--slate);font-size:15px}
.who form{margin:0}
.idrow{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.idval{font:600 clamp(1.4rem,4vw,2rem)/1.2 var(--mono);background:var(--yellow);color:#18233F;padding:6px 14px;border-radius:8px;overflow-wrap:anywhere}
.cmd{position:relative;margin:10px 0 14px}
pre{margin:0;background:var(--code);border:1px solid var(--line);border-radius:10px;padding:14px 16px;font:14px/1.55 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink)}
.cmd pre{padding-right:84px}
.copy{display:none;position:absolute;top:8px;right:8px;font:600 13px/1 var(--sans);padding:8px 11px;border-radius:7px;border:1.5px solid var(--ink);background:var(--card);color:var(--ink);cursor:pointer}
.js .copy{display:block}
.copy:hover{background:var(--soft)}
.idrow .copy{position:static;display:none}
.js .idrow .copy{display:block}
.tabs{margin-top:6px}
.tabs>input{position:absolute;opacity:0;pointer-events:none}
.tablist{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
.tablist label{cursor:pointer;padding:9px 15px;border-radius:999px;border:1.5px solid var(--line);font-size:15px;font-weight:600;background:var(--card)}
.tablist label:hover{border-color:var(--ink)}
.tabs>input:focus-visible~.tablist label{outline:none}
.tabs .p{display:none}
#t1:checked~.panels #p1,#t2:checked~.panels #p2,#t3:checked~.panels #p3,#t4:checked~.panels #p4,#t5:checked~.panels #p5{display:block}
#t1:checked~.tablist [for=t1],#t2:checked~.tablist [for=t2],#t3:checked~.tablist [for=t3],#t4:checked~.tablist [for=t4],#t5:checked~.tablist [for=t5]{background:var(--btn);color:var(--btnink);border-color:var(--btn)}
#t1:focus-visible~.tablist [for=t1],#t2:focus-visible~.tablist [for=t2],#t3:focus-visible~.tablist [for=t3],#t4:focus-visible~.tablist [for=t4],#t5:focus-visible~.tablist [for=t5]{outline:3px solid var(--focus);outline-offset:3px}
.step-note{color:var(--slate);font-size:15.5px;margin:4px 0 0}
.agentprompt{margin-top:22px;padding-top:20px;border-top:1px dashed var(--line)}
.agentprompt h3{margin-bottom:4px}
.rows{list-style:none;margin:0;padding:0}
.rows li{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:14px 0;border-top:1px solid var(--line)}
.rows li:first-child{border-top:0}
.rows .name{font-weight:600}
.rows .meta{color:var(--slate);font-size:14px}
.rows form{margin:0}
.empty{color:var(--slate);margin:0}
.bar{height:12px;border-radius:99px;background:var(--soft);border:1px solid var(--line);overflow:hidden;margin:10px 0 8px}
.bar b{display:block;height:100%;background:var(--ink)}
.bar b.w20{width:20%}.bar b.w40{width:40%}.bar b.w60{width:60%}.bar b.w80{width:80%}.bar b.w100{width:100%}.bar b.w0{width:2%}.bar b.w5{width:5%}.bar b.w10{width:10%}
.bar b.full{background:var(--red)}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:22px}
.pair .panel{margin:0}
.notice{border-radius:10px;padding:12px 16px;margin:0 0 20px;font-size:15.5px}
.notice.ok{background:var(--okbg);color:var(--okink)}
.notice.err{background:var(--errbg);color:var(--errink)}
.signin{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);gap:34px;align-items:start;padding:20px 0 20px}
.signin ul{padding-left:20px;margin:0 0 14px}
.signin li{margin:6px 0}
.signin .panel form{margin:0 0 10px}
.signin .btn{width:100%;text-align:center;margin-bottom:10px}
code{font:.9em var(--mono);background:var(--code);padding:1px 6px;border-radius:5px}
.who h1{font-size:clamp(1.8rem,4vw,2.6rem);margin-bottom:6px}
.small{font-size:14px;color:var(--slate)}
.msg{max-width:560px;margin:40px auto}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (max-width:820px){.hero,.signin{grid-template-columns:1fr;gap:28px}.doors,.pair{grid-template-columns:1fr}.steps{grid-template-columns:1fr}}
@media (max-width:520px){body{font-size:16px}.wrap{padding:0 18px}.panel{padding:20px 18px}.door{padding:26px 20px 22px}.tablist label{padding:8px 12px;font-size:14px}.btn{width:100%;text-align:center}.cta{flex-direction:column}.cmd pre{padding:48px 14px 14px}.idrow .copy{position:static}.rows .btn,.who .btn{width:auto}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

const SCRIPT = `document.documentElement.className+=" js";document.addEventListener("click",function(e){var b=e.target.closest("[data-copy]");if(!b)return;var t=document.getElementById(b.getAttribute("data-copy"));if(!t)return;var o=b.textContent;function done(m){b.textContent=m;setTimeout(function(){b.textContent=o},1600)}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t.textContent).then(function(){done("Copied")},function(){done("Select and copy")})}else{done("Select and copy")}});`;

const sha = (s: string): string => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;
export const STYLE_HASH = sha(CSS);
export const SCRIPT_HASH = sha(SCRIPT);

/** Headers for every site page. `formOrigins`: provider origins, only for a page whose sign-in form redirects to them. */
export function siteHeaders(opts: { formOrigins?: readonly string[]; noStore?: boolean } = {}): Record<string, string> {
  const extra = (opts.formOrigins ?? []).filter((o) => /^https?:\/\/[A-Za-z0-9.\-:[\]]+$/.test(o));
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy":
      `default-src 'none'; img-src 'self' data:; style-src ${STYLE_HASH}; script-src ${SCRIPT_HASH}; base-uri 'none'; ` +
      `form-action 'self'${extra.length ? " " + extra.join(" ") : ""}; frame-ancestors 'none'`,
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cache-control": opts.noStore === false ? "public, max-age=300" : "no-store",
  };
}

export const TEXT_HEADERS: Record<string, string> = {
  "content-type": "text/plain; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "public, max-age=300",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

const MARK = `<svg viewBox="0 0 40 40" aria-hidden="true" focusable="false"><rect x="9" y="3" width="28" height="22" rx="5" fill="#E7ECF4" stroke="#18233F" stroke-width="2.4"/><rect x="5" y="9" width="28" height="22" rx="5" fill="#FFFFFF" stroke="#18233F" stroke-width="2.4"/><rect x="1.5" y="15" width="28" height="22" rx="5" fill="#FFE45C" stroke="#18233F" stroke-width="2.4"/><circle cx="23.5" cy="21.5" r="3" fill="#DD3B45"/></svg>`;

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">${MARK.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "")}</svg>`;

// ---- layout ---------------------------------------------------------------

type Nav = "home" | "connect" | "local" | "none";

function layout(title: string, body: string, ctx: SiteCtx, nav: Nav, description = "One memory shared by every AI agent you use."): string {
  const cur = (n: Nav) => (nav === n ? ' aria-current="page"' : "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)}</title><meta name="description" content="${esc(description)}">` +
    `<meta name="color-scheme" content="light dark"><meta name="robots" content="${nav === "home" || nav === "local" ? "index,follow" : "noindex"}">` +
    `<link rel="icon" href="/favicon.svg" type="image/svg+xml">` +
    `<link rel="alternate" type="text/markdown" href="/connect.md" title="Connect an agent (for agents)">` +
    `<link rel="alternate" type="text/markdown" href="/local.md" title="Run locally (for agents)">` +
    `<style>${CSS}</style></head><body>` +
    `<a class="skip" href="#main">Skip to content</a>` +
    `<div class="wrap"><header class="top"><a class="brand" href="/" aria-label="AgentRecall home">${MARK}AgentRecall</a>` +
    `<nav class="main" aria-label="Main"><a href="/connect"${cur("connect")}>Connect an agent</a><a href="/local"${cur("local")}>Run it locally</a>` +
    `<a href="${REPO_URL}" rel="noopener">GitHub</a></nav></header>` +
    `<main id="main">${body}</main>` +
    `<footer class="foot"><span>AgentRecall is open source (MIT). Memory you host here is private to your account.</span>` +
    `<nav aria-label="Footer"><a href="${REPO_URL}" rel="noopener">GitHub</a><a href="${esc(ctx.privacyUrl)}" rel="noopener">Privacy</a><a href="${TELEGRAM_URL}" rel="noopener">Telegram</a></nav></footer>` +
    `</div><script>${SCRIPT}</script></body></html>`;
}

/** A copyable block. `id` must be unique on the page. */
function cmd(id: string, text: string): string {
  return `<div class="cmd"><pre id="${esc(id)}" tabindex="0">${esc(text)}</pre><button type="button" class="copy" data-copy="${esc(id)}">Copy</button></div>`;
}

// ---- the instructions (shared by the pages and the .md files) -------------------

const GITHUB_SKILL = "https://raw.githubusercontent.com/Goldentrii/AgentRecall-X/main/SKILL.md";
const HOOKS_URL = `${REPO_URL}#hooks-claude-code-runs-the-loop-for-you`;

const claudeCode = (b: string) => `claude mcp add --scope user --transport http agent-recall ${b}/mcp`;
const codex = (b: string) => `codex mcp add agent-recall --url ${b}/mcp`;
const cursorJson = (b: string) => `{ "mcpServers": { "agent-recall": { "url": "${b}/mcp" } } }`;

export function hostedAgentPrompt(b: string): string {
  return [
    `Connect yourself to my AgentRecall memory (one memory shared by all my agents). The MCP server is ${b}/mcp (Streamable HTTP, sign-in with OAuth).`,
    ``,
    `- If you are Claude Code, run: ${claudeCode(b)}`,
    `  Then tell me to type /mcp, pick agent-recall and choose Authenticate, so I can sign in with GitHub in my browser.`,
    `- If you are Codex, run: ${codex(b)}`,
    `  Then run: codex mcp login agent-recall  (I sign in in the browser).`,
    `- If you are Cursor, add this to ~/.cursor/mcp.json and tell me to sign in when Cursor prompts: ${cursorJson(b)}`,
    `- Any other MCP client: add ${b}/mcp as a Streamable HTTP server and let it start the OAuth sign-in.`,
    ``,
    `Do not ask for my password or any token: the sign-in happens in my browser. When it is connected, call session_start (project "auto") and tell me what it returned. Full instructions: ${b}/connect.md`,
  ].join("\n");
}

export function localAgentPrompt(): string {
  return [
    `Install AgentRecall locally for me (fully offline; memory is plain markdown in ~/.agent-recall/).`,
    ``,
    `1. Add the MCP server for the client you are running in:`,
    `   - Claude Code: claude mcp add --scope user agent-recall -- npx -y agent-recall-mcp`,
    `   - Codex: codex mcp add agent-recall -- npx -y agent-recall-mcp`,
    `   - Cursor / Windsurf: add { "mcpServers": { "agent-recall": { "command": "npx", "args": ["-y", "agent-recall-mcp"] } } } to the client's MCP config.`,
    `2. If you are Claude Code, also install the skill: mkdir -p ~/.claude/skills/agent-recall && curl -o ~/.claude/skills/agent-recall/SKILL.md ${GITHUB_SKILL}`,
    `3. Optional, only after I say yes: npm i -g agent-recall-cli, then wire the hooks from ${HOOKS_URL} into ~/.claude/settings.json. Show me the exact change first; do not overwrite my existing hooks.`,
    `4. Verify: restart if needed, call session_start (project "auto") and tell me what it returned.`,
    ``,
    `Full instructions: ${REPO_URL}#local-install`,
  ].join("\n");
}

export function connectMarkdown(b: string, hosted: boolean): string {
  return [
    `# Connect an agent to AgentRecall (hosted)`,
    ``,
    hosted
      ? `AgentRecall is one memory shared by every AI agent a person uses. This server is ${b}. MCP endpoint: ${b}/mcp (Streamable HTTP, OAuth 2.1 sign-in with GitHub). Sign-up is free.`
      : `Hosted sign-in is not configured on this server (${b}). Use a local install instead: ${b}/local.md`,
    ``,
    `You (the agent) cannot sign in for the human. The human signs in with their own browser. Do not ask for passwords or tokens.`,
    ``,
    `## Steps`,
    ``,
    `1. Add the server to your MCP client.`,
    `   - Claude Code: \`${claudeCode(b)}\` then tell the human to type /mcp, pick agent-recall, choose Authenticate.`,
    `   - Codex: \`${codex(b)}\` then \`codex mcp login agent-recall\`.`,
    `   - Cursor: add to ~/.cursor/mcp.json: \`${cursorJson(b)}\``,
    `   - claude.ai: Settings, Connectors, Add custom connector, URL ${b}/mcp`,
    `   - Any other client that supports Streamable HTTP with OAuth: give it ${b}/mcp and nothing else.`,
    `2. The human signs in with GitHub in the browser window that opens. Their AgentRecall ID is created on first sign-in (for example gh-123456); no email is collected.`,
    `3. Call \`session_start\` with \`project: "auto"\` and report what it returned.`,
    ``,
    `## After connecting`,
    ``,
    `- Dashboard (human, browser): ${b}/connect shows the ID, connected agents (disconnect any), storage used, and "Download my memory".`,
    `- Corrections you propose with \`check\` wait for the human to approve them at ${b}/review. Tell them it is waiting.`,
    `- Loop: session_start first; remember for facts; check for corrections and before risky actions; session_end when done. Saying "noted" is not saving: only a tool call saves.`,
    ``,
    `Local install instead: ${b}/local.md`,
    ``,
  ].join("\n");
}

export function localMarkdown(b: string): string {
  return [
    `# Run AgentRecall locally`,
    ``,
    `Fully offline. Memory is plain markdown in ~/.agent-recall/. By default nothing leaves the machine (the Supabase mirror, Telegram reports and cloud embeddings are all opt-in).`,
    ``,
    `## Install (run these for the human)`,
    ``,
    `- Claude Code: \`claude mcp add --scope user agent-recall -- npx -y agent-recall-mcp\``,
    `- Codex: \`codex mcp add agent-recall -- npx -y agent-recall-mcp\``,
    `- Cursor / Windsurf: \`{ "mcpServers": { "agent-recall": { "command": "npx", "args": ["-y", "agent-recall-mcp"] } } }\``,
    `- VS Code (.vscode/mcp.json): \`{ "servers": { "agent-recall": { "command": "npx", "args": ["-y", "agent-recall-mcp"] } } }\``,
    ``,
    `## Claude Code extras (optional)`,
    ``,
    `- Skill: \`mkdir -p ~/.claude/skills/agent-recall && curl -o ~/.claude/skills/agent-recall/SKILL.md ${GITHUB_SKILL}\``,
    `- Hooks that run the memory loop without agent discipline: \`npm i -g agent-recall-cli\`, then add the hooks from ${HOOKS_URL} to ~/.claude/settings.json. Show the human the exact change and get a yes first; never overwrite existing hooks.`,
    ``,
    `## Verify`,
    ``,
    `Call \`session_start\` with \`project: "auto"\` and report what it returned.`,
    ``,
    `Prefer a hosted memory shared across devices? ${b}/connect.md`,
    `Source and docs: ${REPO_URL}`,
    ``,
  ].join("\n");
}

export function llmsTxt(b: string): string {
  return [
    `# AgentRecall`,
    ``,
    `> One memory shared by every AI agent you use. Rules, corrections and project state follow the user from Claude Code to Codex to Cursor and any MCP client. Hosted (${b}/mcp, free, sign in with GitHub) or local and fully offline (npx -y agent-recall-mcp).`,
    ``,
    `## Set up (for agents)`,
    ``,
    `- [Connect to the hosted server](${b}/connect.md): add ${b}/mcp to your MCP client; the human signs in with GitHub`,
    `- [Install locally](${b}/local.md): npx -y agent-recall-mcp, plain markdown in ~/.agent-recall/`,
    ``,
    `## For humans`,
    ``,
    `- [Website](${b}/): connect an agent or run it locally`,
    `- [Dashboard](${b}/connect): your ID, connected agents, storage, download your memory`,
    `- [Review corrections](${b}/review): approve or reject what your agents propose`,
    ``,
    `## Docs`,
    ``,
    `- [README](${REPO_URL}/blob/main/README.md)`,
    `- [Hosted server](${REPO_URL}/blob/main/docs/hosted-server.md)`,
    `- [Privacy policy](${REPO_URL}/blob/main/PRIVACY.md)`,
    `- [AGENTS.md](${REPO_URL}/blob/main/AGENTS.md): lifecycle doctrine`,
    ``,
  ].join("\n");
}

// ---- hero art -------------------------------------------------------------

const HERO_ART = `<svg class="art" viewBox="0 0 460 380" role="img" aria-labelledby="hero-t hero-d">` +
  `<title id="hero-t">One memory, every agent</title>` +
  `<desc id="hero-d">Claude Code, Codex, Cursor and claude.ai all connect to one memory card. At session_start every agent gets the same card: the hard rules, such as ask before a version bump, and the project state.</desc>` +
  `<path class="wire" d="M150 62C190 62 190 150 226 150"/><path class="wire" d="M150 138C190 138 200 168 226 168"/><path class="wire" d="M150 214C190 214 200 190 226 190"/><path class="wire" d="M150 290C190 290 190 210 226 210"/>` +
  `<g><rect class="chip" x="8" y="40" width="142" height="44" rx="12"/><text x="24" y="68">Claude Code</text>` +
  `<rect class="chip" x="8" y="116" width="142" height="44" rx="12"/><text x="24" y="144">Codex</text>` +
  `<rect class="chip" x="8" y="192" width="142" height="44" rx="12"/><text x="24" y="220">Cursor</text>` +
  `<rect class="chip" x="8" y="268" width="142" height="44" rx="12"/><text x="24" y="296">claude.ai</text></g>` +
  `<rect class="back" x="250" y="40" width="214" height="296" rx="16" transform="rotate(5 352 188)"/>` +
  `<rect class="back" x="244" y="34" width="214" height="296" rx="16" transform="rotate(2.5 346 182)"/>` +
  `<rect class="face" x="232" y="26" width="216" height="304" rx="16"/>` +
  `<circle class="dot" cx="422" cy="52" r="8"/>` +
  `<text class="mono" x="252" y="58">session_start</text>` +
  `<text class="head" x="252" y="96">Hard rules</text>` +
  `<rect class="hl" x="246" y="112" width="190" height="30" rx="5"/><text class="hltext" x="258" y="133">Ask before a version bump</text>` +
  `<circle class="dot" cx="260" cy="168" r="4"/><text x="274" y="173">Never push to main</text>` +
  `<circle class="dot" cx="260" cy="198" r="4"/><text x="274" y="203">Use pnpm, not npm</text>` +
  `<line class="rule" x1="252" y1="226" x2="428" y2="226"/>` +
  `<text class="head" x="252" y="256">Project state</text>` +
  `<text class="mono" x="252" y="282">goal  ship the hosted site</text>` +
  `<text class="mono" x="252" y="304">next  review the PR</text>` +
  `</svg>`;

// ---- pages ----------------------------------------------------------------

export function homePage(ctx: SiteCtx): string {
  return layout("AgentRecall: one memory for every AI agent",
    `<section class="hero"><div>` +
    `<h1>Teach one agent. Every agent remembers.</h1>` +
    `<p class="lede">AgentRecall is one memory shared by Claude Code, Codex, Cursor, claude.ai and any MCP client. Your rules, corrections and project state follow you from tool to tool.</p>` +
    `<div class="cta"><a class="btn" href="/connect">Connect an agent</a><a class="btn alt" href="/local">Run it locally</a></div>` +
    `<p class="agentnote">Are you an AI agent? Read <a href="/connect.md">/connect.md</a> or <a href="/local.md">/local.md</a>.</p>` +
    `</div>${HERO_ART}</section>` +
    `<section class="doors" aria-label="Choose how to use AgentRecall">` +
    `<article class="door"><h2>Connect an agent</h2><p>We host the memory. Sign in with GitHub, get your ID, add one URL to your agent.</p>` +
    `<ul><li>Ready in about a minute</li><li>Free, stored in Frankfurt (EU)</li><li>One memory across devices and agents</li></ul>` +
    `<a class="btn" href="/connect">Connect an agent</a></article>` +
    `<article class="door local"><h2>Run it locally</h2><p>Everything stays on your machine, as plain markdown files you can read.</p>` +
    `<ul><li>Works fully offline</li><li>One npx command, or let your agent install it</li><li>Optional hooks run the loop for you</li></ul>` +
    `<a class="btn alt" href="/local">Install locally</a></article></section>` +
    `<section class="block"><h2>How the hosted memory works</h2><ol class="steps">` +
    `<li><strong>Sign in with GitHub</strong><span>Your AgentRecall ID is created on first sign-in. No email is collected.</span></li>` +
    `<li><strong>Add the server URL</strong><span>One command for Claude Code, Codex or Cursor. Agents sign in through your browser.</span></li>` +
    `<li><strong>Every agent remembers</strong><span>At the start of each session your agents load the same rules and project state.</span></li></ol></section>`,
    ctx, "home", "AgentRecall is one memory shared by every AI agent you use: Claude Code, Codex, Cursor, claude.ai and any MCP client. Hosted or fully local.");
}

export interface SignInPageView {
  providers: Array<{ name: string; label: string }>;
  error?: string;
  privacyUrl?: string;
}

export function connectSignInPage(ctx: SiteCtx, v: SignInPageView): string {
  return layout("Connect an agent: AgentRecall",
    `<section class="signin"><div>` +
    `<h1>Connect an agent</h1><p class="lede">Sign in once. You get your own private memory and the exact commands to connect your agents.</p>` +
    `<ul><li>Your AgentRecall ID, created on first sign-in. No email is collected.</li>` +
    `<li>One command each for Claude Code, Codex, Cursor and claude.ai.</li>` +
    `<li>See every connected agent and disconnect any of them.</li>` +
    `<li>Download all of your memory whenever you like.</li></ul>` +
    `<p class="small">Prefer to keep everything on your own machine? <a href="/local">Run it locally</a>.</p></div>` +
    `<div class="panel"><h2>Sign in</h2><p class="sub">Free. The only cookie is the one that keeps you signed in for 30 minutes.</p>` +
    (v.error ? `<div class="notice err" role="alert">${esc(v.error)}</div>` : "") +
    `<form method="post" action="/connect/start">` +
    v.providers.map((p, i) => `<button type="submit" class="btn${i === 0 ? "" : " alt"}" name="provider" value="${esc(p.name)}">Sign in with ${esc(p.label)}</button>`).join("") +
    `</form><p class="small">Agents cannot use this page: it refuses API tokens.</p></div></section>`,
    ctx, "connect");
}

export function connectUnavailablePage(ctx: SiteCtx): string {
  return layout("Connect an agent: AgentRecall",
    `<section class="msg"><h1>Hosted sign-in is not set up here</h1>` +
    `<p class="lede">This server has no GitHub or Google sign-in configured, so it cannot create hosted accounts. You can still run AgentRecall on your own machine.</p>` +
    `<div class="cta"><a class="btn" href="/local">Run it locally</a><a class="btn alt" href="/">Back to the home page</a></div></section>`,
    ctx, "connect");
}

export function messagePage(ctx: SiteCtx, title: string, message: string, back: { href: string; label: string }): string {
  return layout(`${title}: AgentRecall`,
    `<section class="msg"><h1>${esc(title)}</h1><div class="notice err" role="alert">${esc(message)}</div>` +
    `<p><a class="btn alt" href="${esc(back.href)}">${esc(back.label)}</a></p></section>`, ctx, "none");
}

export interface GrantView { id: string; clientName: string; createdAt: string; lastUsedAt?: string }
export interface TokenView { id: string; label: string; createdAt: string }

export interface DashboardView {
  account: string;
  uid: string;
  csrf: string;
  notice?: { kind: "ok" | "err"; text: string };
  grants: GrantView[];
  tokens: TokenView[];
  usedBytes: number;
  /** 0 = no quota. */
  quotaBytes: number;
  pending: number;
}

const day = (iso: string): string => `<time datetime="${esc(iso)}">${esc(iso.slice(0, 10))}</time>`;
const hidden = (name: string, value: string): string => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
const mb = (n: number): string => `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;

export function dashboardPage(ctx: SiteCtx, v: DashboardView): string {
  const b = ctx.base;
  const pct = v.quotaBytes > 0 ? Math.min(100, (v.usedBytes / v.quotaBytes) * 100) : 0;
  const width = pct <= 0 ? "w0" : pct <= 5 ? "w5" : pct <= 10 ? "w10" : pct <= 20 ? "w20" : pct <= 40 ? "w40" : pct <= 60 ? "w60" : pct <= 80 ? "w80" : "w100";
  const tabs: Array<[string, string, string]> = [
    ["Claude Code", cmd("c1", claudeCode(b)), `<p class="step-note">Then type <code>/mcp</code> inside Claude Code, pick <strong>agent-recall</strong> and choose <strong>Authenticate</strong>. Sign in with the same GitHub account.</p>`],
    ["Codex", cmd("c2", codex(b)), `<p class="step-note">Codex opens the sign-in page itself. If you closed it, run <code>codex mcp login agent-recall</code>.</p>`],
    ["Cursor", cmd("c3", `{\n  "mcpServers": {\n    "agent-recall": { "url": "${b}/mcp" }\n  }\n}`), `<p class="step-note">Add this to <code>~/.cursor/mcp.json</code>, then sign in when Cursor prompts you.</p>`],
    ["claude.ai", cmd("c4", `${b}/mcp`), `<p class="step-note">Settings, Connectors, <strong>Add custom connector</strong>, paste this URL (on plans where custom connectors are available).</p>`],
    ["Other clients", cmd("c5", `${b}/mcp`), `<p class="step-note">Any MCP client that supports Streamable HTTP with OAuth: give it this URL and nothing else. It finds the sign-in from the server&rsquo;s response.</p>`],
  ];
  return layout("Your AgentRecall: connect an agent",
    `<div class="who"><div><h1>Your AgentRecall</h1><p>Signed in with ${esc(v.account)}</p></div>` +
    `<form method="post" action="/connect/logout">${hidden("csrf", v.csrf)}<button type="submit" class="btn alt small">Sign out</button></form></div>` +
    (v.notice ? `<div class="notice ${v.notice.kind}" role="status">${esc(v.notice.text)}</div>` : "") +

    `<section class="panel" aria-labelledby="h-id"><h2 id="h-id">Your AgentRecall ID</h2>` +
    `<p class="sub">It names your private memory on this server. It was created when you first signed in; no email is collected. You never type it into an agent: signing in connects an agent to it.</p>` +
    `<div class="idrow"><span class="idval" id="uid">${esc(v.uid)}</span><button type="button" class="copy" data-copy="uid">Copy</button></div></section>` +

    `<section class="panel" aria-labelledby="h-connect"><h2 id="h-connect">Connect an agent</h2>` +
    `<p class="sub">Pick your client and paste. Each agent signs in with your GitHub account in the browser, then shares this one memory.</p>` +
    `<div class="tabs">` +
    tabs.map((_, i) => `<input type="radio" name="client" id="t${i + 1}"${i === 0 ? " checked" : ""} aria-label="${esc(tabs[i][0])}">`).join("") +
    `<div class="tablist" aria-hidden="true">${tabs.map((t, i) => `<label for="t${i + 1}">${esc(t[0])}</label>`).join("")}</div>` +
    `<div class="panels">${tabs.map((t, i) => `<div class="p" id="p${i + 1}">${t[1]}${t[2]}</div>`).join("")}</div></div>` +
    `<div class="agentprompt"><h3>Or let your agent do it</h3><p class="step-note">Paste this into any agent. It runs the right command for itself and asks you to sign in.</p>` +
    cmd("prompt", hostedAgentPrompt(b)) + `</div></section>` +

    `<section class="panel" aria-labelledby="h-agents"><h2 id="h-agents">Connected agents</h2>` +
    `<p class="sub">Names are what each app calls itself; AgentRecall cannot verify them. Disconnect ends that sign-in at once.</p>` +
    (v.grants.length === 0
      ? `<p class="empty">No agent is connected yet. Add one above; it appears here after you sign in from it.</p>`
      : `<ul class="rows">${v.grants.map((g) =>
        `<li><div><div class="name">${esc(g.clientName)} <span class="meta">(self-reported name)</span></div>` +
        `<div class="meta">Connected ${day(g.createdAt)}${g.lastUsedAt ? `, last used ${day(g.lastUsedAt)}` : ""}</div></div>` +
        `<form method="post" action="/connect/disconnect">${hidden("grant", g.id)}${hidden("csrf", v.csrf)}` +
        `<button type="submit" class="btn danger small" aria-label="Disconnect ${esc(g.clientName)}">Disconnect</button></form></li>`).join("")}</ul>`) +
    (v.tokens.length > 0
      ? `<h3>Tokens issued by the operator</h3><p class="step-note">Read only. To revoke one, ask the server operator.</p><ul class="rows">${v.tokens.map((t) =>
        `<li><div><div class="name">${esc(t.label || "unlabelled token")}</div><div class="meta">id ${esc(t.id)}, created ${day(t.createdAt)}</div></div></li>`).join("")}</ul>`
      : "") + `</section>` +

    `<div class="pair"><section class="panel" aria-labelledby="h-store"><h2 id="h-store">Your memory</h2>` +
    `<p class="sub">Storage used${v.quotaBytes > 0 ? ` of ${esc(mb(v.quotaBytes))}` : ""}.</p>` +
    `<div class="bar" role="img" aria-label="${esc(mb(v.usedBytes))} used"><b class="${width}${pct >= 100 ? " full" : ""}"></b></div>` +
    `<p>${esc(mb(v.usedBytes))} used${v.quotaBytes > 0 && pct >= 100 ? ". Full: reading still works, new memories are refused." : ""}</p>` +
    `<form method="post" action="/connect/download">${hidden("csrf", v.csrf)}<button type="submit" class="btn alt small">Download my memory (.tar)</button></form>` +
    `<p class="small">All your files as plain markdown and JSON, yours to keep.</p></section>` +
    `<section class="panel" aria-labelledby="h-rev"><h2 id="h-rev">Corrections</h2>` +
    `<p class="sub">Your agents can only propose an always-follow rule. Nothing becomes active until you approve it.</p>` +
    `<p>${v.pending === 0 ? "Nothing is waiting for your review." : `<strong>${esc(v.pending)}</strong> ${v.pending === 1 ? "correction is" : "corrections are"} waiting for your review.`}</p>` +
    `<a class="btn${v.pending > 0 ? "" : " alt"} small" href="/review">Review corrections</a></section></div>`,
    ctx, "connect");
}

export function localPage(ctx: SiteCtx): string {
  return layout("Run AgentRecall locally",
    `<section class="block"><h1>Run it locally</h1>` +
    `<p class="lede">Fully offline. Your memory is plain markdown in <code>~/.agent-recall/</code>. By default nothing leaves your machine.</p></section>` +
    `<section class="panel" aria-labelledby="h-ai"><h2 id="h-ai">Let your agent install it</h2>` +
    `<p class="sub">Paste this into Claude Code, Codex or Cursor. The agent installs the server, the skill and (if you say yes) the hooks.</p>` +
    cmd("lprompt", localAgentPrompt()) + `</section>` +
    `<section class="panel" aria-labelledby="h-man"><h2 id="h-man">Or do it yourself</h2>` +
    `<h3>Claude Code</h3>${cmd("l1", "claude mcp add --scope user agent-recall -- npx -y agent-recall-mcp")}` +
    `<h3>Codex</h3>${cmd("l2", "codex mcp add agent-recall -- npx -y agent-recall-mcp")}` +
    `<h3>Cursor, Windsurf</h3>${cmd("l3", `{ "mcpServers": { "agent-recall": { "command": "npx", "args": ["-y", "agent-recall-mcp"] } } }`)}` +
    `<h3>Claude Code skill</h3>${cmd("l4", `mkdir -p ~/.claude/skills/agent-recall\ncurl -o ~/.claude/skills/agent-recall/SKILL.md ${GITHUB_SKILL}`)}` +
    `<p class="step-note">Optional hooks make Claude Code run the memory loop for you: install <code>npm i -g agent-recall-cli</code> and add the hooks listed in the <a href="${esc(HOOKS_URL)}" rel="noopener">README</a>.</p></section>` +
    `<section class="panel" aria-labelledby="h-what"><h2 id="h-what">What &ldquo;local&rdquo; means</h2>` +
    `<ul><li>Works with no network. Memory lives in <code>~/.agent-recall/</code> as markdown you can read, edit and back up.</li>` +
    `<li>Nothing is sent anywhere by default. The Supabase mirror, Telegram reports and cloud embeddings are all opt-in.</li>` +
    `<li>Want one memory across devices instead? <a href="/connect">Connect an agent</a> to the hosted server.</li></ul></section>`,
    ctx, "local", "Install AgentRecall locally: one npx command, plain markdown memory on your own machine, fully offline.");
}
