/**
 * film.ts — the home page film: "Intelligent Distance" in five scroll-driven beats.
 *
 * The page keeps the site's CSP shape: one inline style and one inline script, each
 * allowed by its sha256 hash, and nothing from another origin. The only extra
 * requests are five same-origin JPEG plates under /film/ (img-src 'self').
 *
 * The assets live beside this file in ./film/ (copied into dist by the build). If
 * they are missing or unreadable, FILM is null and the site serves the classic
 * home page instead: a broken build must never take the front door down.
 *
 * Without script the page is a plain stacked document with the same copy and the
 * same links, so agents, crawlers and no-script browsers read the whole story.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { REPO_URL, TELEGRAM_URL, type SiteCtx } from "./site-pages.js";

/** The plates the film script loads, in the order the shader binds them. */
export const FILM_PLATES = ["human", "m0", "wrong", "m2", "m3"] as const;
/** Largest plate accepted at load; a bigger file means the wrong asset was shipped. */
const MAX_PLATE_BYTES = 400 * 1024;

export interface Film {
  css: string;
  script: string;
  styleHash: string;
  scriptHash: string;
  plates: ReadonlyMap<string, Buffer>;
}

const sha = (s: string): string => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;

export function loadFilm(dir: string): Film | null {
  try {
    // The HTML parser turns CRLF into LF before a CSP hash is checked (Windows checkouts), so hash the LF form.
    const css = fs.readFileSync(`${dir}/film.css`, "utf8").replace(/\r?\n/g, "\n");
    const script = fs.readFileSync(`${dir}/film.js`, "utf8").replace(/\r?\n/g, "\n");
    // Both are inlined: neither may be able to close its own element.
    if (/<\/style/i.test(css) || /<\/script/i.test(script)) return null;
    const plates = new Map<string, Buffer>();
    for (const name of FILM_PLATES) {
      const buf = fs.readFileSync(`${dir}/${name}.jpg`);
      const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
      if (!isJpeg || buf.length > MAX_PLATE_BYTES) return null;
      plates.set(`/film/${name}.jpg`, buf);
    }
    return { css, script, styleHash: sha(css), scriptHash: sha(script), plates };
  } catch {
    return null;
  }
}

export const FILM: Film | null = loadFilm(fileURLToPath(new URL("./film", import.meta.url)));
// A build without the assets still serves a home page, but the operator must be able to see why it is the old one.
if (!FILM) process.stderr.write("[site] home page film assets missing or invalid in dist/http/film; serving the classic home page\n");

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Headers for one plate. The bytes never depend on the request, so a shared cache may keep them. */
export function plateHeaders(length: number): Record<string, string> {
  return {
    "content-type": "image/jpeg",
    "content-length": String(length),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "public, max-age=86400",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "cross-origin-resource-policy": "same-origin",
  };
}

interface Beat { from: string; to: string; kicker?: string; h: string; p?: string; first?: boolean }
const BEATS: readonly Beat[] = [
  { from: "-1", to: "0.13", kicker: "Session 1", h: "Two kinds of intelligence.", first: true,
    p: "You think in intuition and fragments. Your agent thinks in tokens and logic. Intelligent Distance is the gap between what you mean and what it builds." },
  { from: "0.15", to: "0.27", kicker: "A misunderstanding", h: "It built it well. It was not what you meant.",
    p: "The gap is not a fault in either side. A correction made in one chat is gone by the next session, or the next agent." },
  { from: "0.29", to: "0.355", kicker: "You correct it", h: "One correction crosses the gap.",
    p: "A correction you approve becomes a rule, with its reason and where it applies." },
  { from: "0.40", to: "0.58", kicker: "Session 2", h: "It is remembered. By every connected agent.",
    p: "Claude Code, Codex, Cursor, claude.ai: each one starts from what you taught the last one." },
  { from: "0.66", to: "0.80", kicker: "Session 50", h: "Each time it matters, it is measured.",
    p: "Heeded, or repeated. A rule that keeps failing gets rewritten. Each outcome narrows the distance." },
];

export function filmPage(film: Film, ctx: SiteCtx): string {
  const beats = BEATS.map((b) =>
    `<section class="beat" data-from="${b.from}" data-to="${b.to}">` +
    (b.kicker ? `<p class="kicker">${esc(b.kicker)}</p>` : "") +
    `<${b.first ? "h1" : "h2"}>${esc(b.h)}</${b.first ? "h1" : "h2"}>` +
    (b.p ? `<p>${esc(b.p)}</p>` : "") +
    `</section>`).join("");
  const description = "AgentRecall narrows the distance between you and your AI agents: every correction you make is remembered by Claude Code, Codex, Cursor and any MCP client, and measured each time it matters. Hosted or fully local.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>AgentRecall: the distance between you and your agents, measured and shortened</title>` +
    `<meta name="description" content="${esc(description)}">` +
    `<meta name="color-scheme" content="dark"><meta name="robots" content="index,follow">` +
    `<link rel="icon" href="/favicon.svg" type="image/svg+xml">` +
    `<link rel="alternate" type="text/markdown" href="/connect.md" title="Connect an agent (for agents)">` +
    `<link rel="alternate" type="text/markdown" href="/local.md" title="Run locally (for agents)">` +
    `<style>${film.css}</style></head><body>` +
    `<a class="skip" href="#doors">Skip to content</a>` +
    `<canvas id="stage" aria-hidden="true"></canvas>` +
    `<header class="top"><a class="brand" href="/" aria-label="AgentRecall home"><span class="mark"></span>AgentRecall</a>` +
    `<nav aria-label="Main"><a class="btn sm" href="/connect">Connect an agent</a><a class="btn sm alt" href="/local">Run it locally</a><a href="${REPO_URL}" rel="noopener">GitHub</a></nav></header>` +
    `<div class="meter" aria-hidden="true"><span id="session">SESSION 01</span><span id="dist">DISTANCE 1.00</span></div>` +
    `<div class="hint" aria-hidden="true">Scroll</div><a class="skipfilm" href="#doors">Skip the film</a>` +
    `<main id="track">${beats}` +
    `<section class="beat end" data-from="0.86" data-to="2">` +
    `<h2>The distance never closes.<br>It gets measured, and it gets shorter.</h2>` +
    `<p class="cta"><a class="btn" href="/connect">Connect an agent</a><a class="btn alt" href="/local">Run it locally</a></p>` +
    `<p class="agentnote">Are you an AI agent? Read <a href="/connect.md">/connect.md</a> or <a href="/local.md">/local.md</a>.</p>` +
    `</section></main>` +
    `<div class="after"><div class="inner">` +
    `<section class="doors" id="doors" aria-label="Choose how to use AgentRecall">` +
    `<article class="door human"><h2>Connect an agent</h2><p>We host the memory. Sign in with GitHub, get your ID, add one URL to your agent.</p>` +
    `<ul><li>Ready in about a minute</li><li>Free, stored in Frankfurt (EU)</li><li>One memory across devices and agents</li></ul>` +
    `<a class="btn" href="/connect">Connect an agent</a></article>` +
    `<article class="door machine"><h2>Run it locally</h2><p>Everything stays on your machine, as plain markdown files you can read.</p>` +
    `<ul><li>Works fully offline</li><li>One npx command, or let your agent install it</li><li>Optional hooks run the loop for you</li></ul>` +
    `<a class="btn alt" href="/local">Install locally</a></article></section>` +
    `<section class="how"><h2>How the distance gets shorter</h2><ol class="steps">` +
    `<li><strong>You correct an agent</strong><span>The correction becomes a rule with its reason and where it applies. On the hosted server you approve it first.</span></li>` +
    `<li><strong>Every agent loads it</strong><span>At the start of each session your agents receive the same rules and the state of your project.</span></li>` +
    `<li><strong>Each outcome is recorded</strong><span>When the situation comes back, the rule is marked heeded or repeated. Rules that keep failing get rewritten.</span></li></ol></section>` +
    `<footer class="foot"><span>AgentRecall is open source (MIT). Memory you host here is private to your account.</span>` +
    `<nav aria-label="Footer"><a href="${REPO_URL}" rel="noopener">GitHub</a><a href="${esc(ctx.privacyUrl)}" rel="noopener">Privacy</a><a href="${TELEGRAM_URL}" rel="noopener">Telegram</a></nav></footer>` +
    `</div></div><script>${film.script}</script></body></html>`;
}
