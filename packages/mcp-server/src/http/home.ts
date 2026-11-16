/**
 * home.ts — the home page at "/": the blueprint page (hero figure, two ways in, how it
 * works, one measured example, clients, values, a link to the film).
 *
 * The page keeps the site's CSP shape and is stricter than the film: ONE inline style
 * allowed by its sha256 hash, NO script at all (so script-src is 'none'), no image
 * element, nothing from another origin. The figures are inline SVG, drawn once and
 * checked here at load time, because they are the only large markup that is not ours
 * line by line.
 *
 * The assets live beside this file in ./home/ (copied into dist by the build): home.html
 * is a template with {{placeholders}}, home.css is the one stylesheet, and the five svg
 * files are the figures and the icon sprite. loadHome() assembles them and REFUSES the
 * result (returns null) if anything could break the CSP or the markup: a stray script,
 * style attribute, external URL, duplicate id or dangling <use>. When HOME is null the
 * site serves the classic home page instead: a broken build must never take the front
 * door down.
 *
 * The scroll film is served at /film (see film.ts); this page links to it.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { REPO_URL, TELEGRAM_URL, footerNav } from "./site-pages.js";

export interface Home {
  /** The whole document, ready to send. */
  html: string;
  /** CSP source for the one inline <style>: sha256 of its exact (LF) text. */
  styleHash: string;
}

/** The figure files (home/<name>.svg) and the template placeholders {{name}} they fill. */
export const HOME_FIGURES = ["fig1", "fig2-1", "fig2-2", "fig3"] as const;

/** Largest page accepted at load; a bigger one means the wrong asset was shipped. */
const MAX_HTML_BYTES = 512 * 1024;

const sha = (s: string): string => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;

/** The HTML parser turns CRLF into LF before a CSP hash is checked (Windows checkouts), so read the LF form. */
const lf = (s: string): string => s.replace(/\r\n?/g, "\n");

interface Attr { tag: string; name: string; value: string | null }

/**
 * Every attribute of every tag, read the way an HTML parser reads them: quotes are respected,
 * so a quoted value (title="one = 1", title=">") never looks like an attribute or ends a tag,
 * and "/" separates attributes (<svg/onload=...>). Text outside tags is skipped, so prose such
 * as "style = none" is never mistaken for one. Names are lower-cased.
 */
function attrs(html: string): Attr[] {
  const out: Attr[] = [];
  const n = html.length;
  let i = 0;
  while ((i = html.indexOf("<", i)) !== -1) {
    i++;
    // A doctype or bogus comment ("<!...>", "<?...>") runs to the first ">", as in the browser (real comments are already stripped).
    if (html[i] === "!" || html[i] === "?") {
      const end = html.indexOf(">", i);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (!/[A-Za-z]/.test(html[i] ?? "")) continue;
    // Whitespace is HTML's (tab, LF, FF, CR, space), not JS \s: U+00A0 or U+FEFF is part of a name to the browser.
    const t0 = i;
    while (i < n && !/[\t\n\f\r />]/.test(html[i])) i++;
    const tag = html.slice(t0, i).toLowerCase();
    for (;;) {
      while (i < n && /[\t\n\f\r /]/.test(html[i])) i++;
      if (i >= n || html[i] === ">") break;
      const a0 = i;
      // As in the HTML spec, a leading "=" is part of the name (so the name is never empty and "<p =x>" ends at its ">").
      if (html[i] === "=") i++;
      while (i < n && !/[\t\n\f\r />=]/.test(html[i])) i++;
      const name = html.slice(a0, i).toLowerCase();
      while (i < n && /[\t\n\f\r ]/.test(html[i])) i++;
      let value: string | null = null;
      if (html[i] === "=") {
        i++;
        while (i < n && /[\t\n\f\r ]/.test(html[i])) i++;
        const q = html[i];
        if (q === '"' || q === "'") {
          const end = html.indexOf(q, i + 1);
          value = html.slice(i + 1, end === -1 ? n : end);
          i = end === -1 ? n : end + 1;
        } else {
          const v0 = i;
          while (i < n && !/[\t\n\f\r >]/.test(html[i])) i++;
          value = html.slice(v0, i);
        }
      }
      out.push({ tag, name, value });
    }
  }
  return out;
}

/** Attributes whose value a browser follows as a URL. */
const URL_ATTR = /^(?:href|src|action|xlink:href|formaction)$/;
/** Browsers drop leading/trailing whitespace and any tab or newline inside a URL, so judge the value they would follow. */
const urlOf = (v: string): string => v.replace(/[\u0000- ]/g, "");
/** A URL that leaves this origin: any scheme, or two leading slashes, where a browser reads "\" as "/" ("\\evil", "/\evil"). */
const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i;
/** HTML comments as the parser ends them: "-->", "--!>", the empty "<!-->" / "<!--->", or the end of the input. */
const stripComments = (s: string): string => s.replace(/<!--(?:>|->|[\s\S]*?(?:--!?>|$))/g, "");
/** Only the repo and the Telegram community, each as itself or a path, query or fragment under it (never "…AgentRecall-Xevil"). */
const allowedExternal = (u: string): boolean =>
  [REPO_URL, TELEGRAM_URL].some((base) => u === base || (u.startsWith(base) && /^[/?#]/.test(u.slice(base.length))));

function attrProblem(list: readonly Attr[]): string | null {
  if (list.some((a) => a.name.startsWith("on"))) return "an on*= attribute";
  if (list.some((a) => a.name === "style")) return "a style= attribute";
  // ping posts to its URLs on a click and srcset lists several; neither is needed, so neither is judged as a URL, just refused.
  const fetching = list.find((a) => a.name === "ping" || a.name === "srcset");
  if (fetching) return `a ${fetching.name}= attribute`;
  return null;
}

/** An svg is inlined into the page, so it may not carry anything the CSP would block or that reaches out. */
function svgProblem(svg: string): string | null {
  if (/<script/i.test(svg)) return "svg contains <script";
  if (/<style/i.test(svg)) return "svg contains <style";
  if (/<foreignObject/i.test(svg)) return "svg contains <foreignObject";
  if (/<image/i.test(svg)) return "svg contains <image";
  if (/<(?:set|animate|a)[\s/>]/i.test(svg)) return "svg contains <set, <animate or <a";
  const list = attrs(svg);
  const bad = attrProblem(list);
  if (bad) return `svg contains ${bad}`;
  if (list.some((a) => a.name === "href" && a.value !== null && ABSOLUTE_URL.test(urlOf(a.value)))) return "svg contains an absolute href";
  if (list.some((a) => a.name === "xlink:href")) return "svg contains xlink:href";
  return null;
}

/** Drop what is only valid in a standalone file: the XML prolog, comments, and the namespace (HTML5 does not need it). */
const cleanSvg = (s: string): string =>
  stripComments(s.replace(/<\?xml[^>]*\?>/g, "")).replace(/\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, "").trim();

/** The icons are drawn thin for a standalone sheet; on the page they are a touch bolder and lighter in colour so they read at 1px. */
const boldIcons = (s: string): string =>
  s.replace(/stroke="#9aaec3"/g, 'stroke="#c9d3df"').replace(/stroke-width="1"/g, 'stroke-width="1.3"').replace(/stroke-opacity="0\.45"/g, 'stroke-opacity="0.6"');

export type Loaded = { home: Home } | { reason: string };

function assemble(dir: string): Loaded {
  // A byte-order mark from an editor save is not content; dropping it keeps a harmless save from failing the checks.
  const rd = (name: string): string => lf(fs.readFileSync(`${dir}/${name}`, "utf8")).replace(/^\uFEFF/, "");
  const css = rd("home.css").trim();
  if (/<\/style/i.test(css)) return { reason: "home.css could close its own <style>" };
  // The CSP would block these anyway; refusing them keeps "nothing from another origin" true of the asset itself.
  // No "<" at all: then the style body reads the same whether it is parsed as raw text or as markup.
  if (css.includes("<")) return { reason: "home.css contains '<'" };
  // A CSS escape can spell anything ("@\69mport"), and image-set() fetches like url(); the stylesheet needs neither.
  if (css.includes("\\")) return { reason: "home.css contains a backslash escape" };
  if (/image-set\(/i.test(css)) return { reason: "home.css contains image-set()" };
  if (/@import/i.test(css)) return { reason: "home.css contains @import" };
  if (/url\(\s*["']?\s*(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i.test(css)) return { reason: "home.css loads an absolute url()" };

  const figures = new Map<string, string>();
  for (const name of HOME_FIGURES) {
    const svg = cleanSvg(rd(`${name}.svg`));
    const bad = svgProblem(svg);
    if (bad) return { reason: `${name}.svg: ${bad}` };
    if (!svg.startsWith("<svg ")) return { reason: `${name}.svg does not start with <svg` };
    figures.set(name, svg.replace("<svg ", '<svg class="art" '));
  }
  const iconsRaw = cleanSvg(rd("icons.svg"));
  const iconsBad = svgProblem(iconsRaw);
  if (iconsBad) return { reason: `icons.svg: ${iconsBad}` };
  const symbols = (iconsRaw.match(/<symbol[\s\S]*?<\/symbol>/g) ?? []).join("");
  if (!symbols) return { reason: "icons.svg holds no <symbol>" };
  const sprite = `<svg width="0" height="0" aria-hidden="true" focusable="false" class="sprite">${boldIcons(symbols)}</svg>`;

  const fills: Record<string, string> = { css, icons: sprite, footer: footerNav("home"), repo: REPO_URL };
  for (const [k, v] of figures) fills[k] = v;
  // Comments go before anything is checked, so the page that is checked is byte for byte the page that is served.
  let html = stripComments(rd("home.html")).trimStart();
  // split/join, not replace(): the values contain "$" sequences that replace() would interpret.
  for (const [k, v] of Object.entries(fills)) html = html.split(`{{${k}}}`).join(v);

  const left = html.match(/\{\{[^}]*\}\}/);
  if (left) return { reason: `placeholder left in the page: ${left[0]}` };
  const count = (re: RegExp): number => (html.match(re) ?? []).length;
  // Element checks match the name as a prefix: a browser also opens "<style/>" or "<iframe/>", so no terminator is required.
  if (count(/<style/gi) !== 1) return { reason: "the page must hold exactly one <style>" };
  if (!html.includes(`<style>${css}</style>`)) return { reason: "the <style> is not the single css block" };
  if (count(/<script/gi)) return { reason: "the page must hold no <script" };
  // attrs() reads tags the way a browser does only where the two cannot disagree on where markup starts and
  // ends. Comments, CDATA, processing instructions, end tags with attributes and raw-text elements are such
  // places, and the page needs none of them, so the served bytes may not contain them at all.
  if (/<!/.test(html.replace(/^<!doctype html>/i, ""))) return { reason: "a comment, CDATA or other <! construct is left in the page" };
  if (html.includes("<?")) return { reason: "a <? processing instruction is present" };
  if (/<\/(?![a-zA-Z][a-zA-Z0-9-]*>)/.test(html)) return { reason: "an end tag that is not a bare </name> is present" };
  if ([...html.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)].some((m) => m[1].includes("<"))) return { reason: "a <title> holds markup" };
  const raw = /<(textarea|xmp|noscript|noembed|noframes|plaintext)/i.exec(html);
  if (raw) return { reason: `a <${raw[1].toLowerCase()}> is present` };
  const list = attrs(html);
  const bad = attrProblem(list);
  if (bad) return { reason: `${bad} is present` };
  if (count(/javascript:/gi)) return { reason: "a javascript: URL is present" };
  // The head links only the icon and the two markdown alternates; any other rel (stylesheet, preload, ...) would fetch.
  const rel = list.find((a) => a.tag === "link" && a.name === "rel" && !/^(?:icon|alternate)$/i.test((a.value ?? "").trim()));
  if (rel) return { reason: `a <link rel=${(rel.value ?? "").trim()}> is present` };
  if (count(/<img/gi)) return { reason: "an <img> is present" };
  if (count(/<iframe/gi)) return { reason: "an <iframe> is present" };
  // Elements that navigate, submit, re-base or embed: none belongs on this page (the CSP does not stop a meta refresh).
  if (list.some((a) => a.tag === "meta" && a.name === "http-equiv")) return { reason: "a <meta http-equiv> is present" };
  const embed = /<(base|form|object|embed)/i.exec(html);
  if (embed) return { reason: `a <${embed[1].toLowerCase()}> is present` };

  const ids = list.filter((a) => a.name === "id" && a.value !== null).map((a) => a.value as string);
  const dup = ids.find((x, i) => ids.indexOf(x) !== i);
  if (dup !== undefined) return { reason: `duplicate id "${dup}"` };
  for (const a of list) {
    if (a.value === null) continue;
    if (a.tag === "use" && a.name === "href" && (!a.value.startsWith("#") || !ids.includes(a.value.slice(1)))) {
      return { reason: `<use> points at a missing id (${a.value})` };
    }
    if (!URL_ATTR.test(a.name)) continue;
    const u = urlOf(a.value);
    // A character reference in a URL could spell a scheme the checks below never see ("&#106;avascript:").
    if (u.includes("&")) return { reason: `character reference in a URL (${u})` };
    if (ABSOLUTE_URL.test(u) && !allowedExternal(u)) return { reason: `external URL ${u}` };
  }
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) return { reason: "page larger than 512 KB" };
  return { home: { html, styleHash: sha(css) } };
}

/** Assemble the home page from `dir`, or say why not. Never throws. */
export function loadHomeWithReason(dir: string): Loaded {
  try {
    return assemble(dir);
  } catch (e) {
    return { reason: `unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function loadHome(dir: string): Home | null {
  const r = loadHomeWithReason(dir);
  return "home" in r ? r.home : null;
}

const loaded = loadHomeWithReason(fileURLToPath(new URL("./home", import.meta.url)));
export const HOME: Home | null = "home" in loaded ? loaded.home : null;
// A build without valid assets still serves a home page, but the operator must be able to see why it is the old one.
if ("reason" in loaded) process.stderr.write(`[site] home page assets missing or invalid in dist/http/home (${loaded.reason}); serving the classic home page\n`);
