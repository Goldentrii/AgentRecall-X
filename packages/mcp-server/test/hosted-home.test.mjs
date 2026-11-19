// The home page at "/": the blueprint page. One inline style (hash in the CSP), no script,
// inline SVG figures, nothing from another origin, readable without CSS tricks, and a
// loader that refuses any asset set that could break that.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { renderStatic, isStaticPath } = await import("../dist/http/site.js");
const { HOME, HOME_FIGURES, HOME_PARTS, loadHome, loadHomeWithReason } = await import("../dist/http/home.js");
const { footerNav, REPO_URL } = await import("../dist/http/site-pages.js");

const ctx = { base: "https://recall.example.com", privacyUrl: "https://example.com/privacy", hosted: true };
const hash = (s) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;
const srcDir = path.join(here, "..", "dist", "http", "home");
const SHIPPED = ["home.css", "home.html", "icons.svg", ...HOME_FIGURES.map((f) => `${f}.svg`), ...HOME_PARTS.map((f) => `${f}.svg`)];

const res = renderStatic("/", ctx);
const html = res.body;
const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];

/** A temp copy of the shipped assets, with `change(name, text)` applied to each file. */
function withCopy(change, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ar-home-"));
  try {
    for (const f of SHIPPED) {
      const text = fs.readFileSync(path.join(srcDir, f), "utf8").replace(/\r\n/g, "\n");
      fs.writeFileSync(path.join(tmp, f), change ? change(f, text) : text);
    }
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("home page at /", () => {
  it("the build ships the home assets, and / is the new home page", () => {
    assert.ok(HOME, "dist/http/home/ must hold home.html, home.css, icons.svg and the four figures");
    assert.equal(res.status, 200);
    assert.equal([...html.matchAll(/<h1[\s>]/g)].length, 1);
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)[1].replace(/<[^>]+>/g, "");
    assert.match(h1, /distance between you and your agents/i);
    assert.match(h1, /measured/i);
    assert.ok(!/Two kinds of intelligence/.test(html), "the film is no longer the home page");
  });

  it("CSP: one inline style matching style-src, no script, script-src 'none', nothing blocked", () => {
    const csp = res.headers["content-security-policy"];
    assert.equal([...html.matchAll(/<style[\s>]/g)].length, 1);
    assert.equal([...html.matchAll(/<script/gi)].length, 0);
    assert.ok(csp.includes(`style-src ${hash(css)};`), "style hash");
    assert.match(csp, /(^|; )script-src 'none'(;|$)/);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.ok(!/unsafe-/.test(csp), csp);
    assert.ok(!/\sstyle\s*=|\son[a-z]+\s*=|<link[^>]+rel="?stylesheet|<img[\s>]|<iframe|javascript:/i.test(html), "nothing the CSP would block");
    assert.ok(!/<[^>]+\ssrc\s*=/i.test(html), "no external src of any kind");
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
  });

  it("only the repo and Telegram hosts appear in href, src and action", () => {
    const hosts = new Set([...html.matchAll(/(?:href|src|action)="(https?:\/\/[^"/]+)/g)].map((m) => m[1]));
    assert.deepEqual([...hosts].sort(), ["https://github.com", "https://t.me"]);
  });

  it("links to the doors, the film, the agent files, the legal pages and the page's own sections", () => {
    for (const href of ["/connect", "/local", "/film", "/connect.md", "/local.md", "/privacy", "/support", "#how", "#clients", "#main"]) {
      assert.ok(html.includes(`href="${href}"`), `missing link ${href}`);
    }
    for (const id of ["how", "clients", "main"]) assert.ok(html.includes(` id="${id}"`), `missing target #${id}`);
    assert.match(html, /<a class="skip" href="#main">/);
  });

  it("the footer is exactly footerNav('home'); the header has both doors", () => {
    assert.ok(html.includes(footerNav("home")));
    const header = /<header class="top">([\s\S]*?)<\/header>/.exec(html)[1];
    assert.match(header, /<a class="btn[^"]*" href="\/connect">[\s\S]*Connect an agent[\s\S]*<\/a>/);
    assert.match(header, /<a class="btn[^"]*" href="\/local">Run it locally<\/a>/);
  });

  it("copy: names Intelligent Distance, never calls itself a memory store, labels the measured block an example", () => {
    assert.match(html, /Intelligent Distance/);
    assert.ok(!/\bmemory (storage|layer|database)\b/i.test(html));
    const measured = /<section class="sec" id="measured"[\s\S]*?<\/section>/.exec(html)[0];
    assert.match(measured, /example/i);
    assert.match(measured, /example rule/i);
  });

  it("no duplicate ids, every <use> resolves, figures are decorative with a caption", () => {
    const ids = [...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(ids.filter((x, i) => ids.indexOf(x) !== i), []);
    const uses = [...html.matchAll(/<use[^>]*\shref="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(uses.length > 0);
    for (const u of uses) assert.ok(u.startsWith("#") && ids.includes(u.slice(1)), `dangling <use> ${u}`);
    const figures = [...html.matchAll(/<figure[\s\S]*?<\/figure>/g)].map((m) => m[0]);
    // The four figures, plus the cabinet: a <figure> whose art is the parts (cabinet + drawer fronts), not one class="art" svg.
    assert.equal(figures.length, HOME_FIGURES.length + 1);
    const art = figures.filter((f) => /<svg class="art"/.test(f));
    assert.equal(art.length, HOME_FIGURES.length, "every figure but the cabinet is a class=art svg");
    for (const f of art) {
      assert.match(f, /<svg class="art"[^>]*aria-hidden="true"/);
      assert.match(f, /<figcaption/);
    }
    const cabinet = figures.find((f) => !/<svg class="art"/.test(f));
    assert.match(cabinet, /<figcaption/);
  });

  it("content is readable without any of the CSS: only listed selectors may hide anything", () => {
    // Why each is allowed: .sr/.skip are screen-reader-only and off-screen until focused; .nav/.top__* swap long and short
    // labels or drop the second nav on a phone (same links remain in the page); .cap--br/.lbl-sec are drawing captions
    // (aria-hidden decoration); .fig--cut::after is a decorative corner turned off in forced-colors mode.
    // The interactive panels (each revealed by a control, see the next test): .tc-scn/.tc-p/.tc-r are the scenario, step and
    // reading panels shown by a checked radio; .pr-on/.pr-d--on/.pr-off/.pr-d--off are the two sides of the checkbox switch;
    // .cr/.cr0-.cr2 are the cabinet counter, one value shown per number of open drawers; .tc-in/.pr-in are the real inputs,
    // kept (focusable, in the page) but invisible because their labels are drawn; ::-webkit-details-marker is the browser's
    // own disclosure triangle (the drawer front is the marker); the drawer tray fades in when its <details> opens; "from" is
    // a keyframe start state of an entrance animation that ends visible.
    const allowed = [".sr", ".skip", ".sprite", ".nav", ".top__short", ".top__long", ".top__local", ".cap--br", ".lbl-sec", ".fig--cut::after",
      ".tc-in", ".pr-in", ".tc-scn", ".tc-p", ".tc-r", ".pr-on", ".pr-d--on", ".pers:has(#pr-on:checked) .pr-off", ".pers:has(#pr-on:checked) .pr-d--off",
      ".cr", ".cab-fig:has(details[open]) .cr0", ".cab-fig:has(details[open] ~ details[open]) .cr1",
      ".cab-fig:has(details[open] ~ details[open] ~ details[open]) .cr2",
      ".drawer > summary::-webkit-details-marker", '.drawer [id$="-tray"]', "from"];
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/opacity:\s*0(?![.\d])|visibility:\s*hidden|display:\s*none/.test(rule[2])) continue;
      for (const sel of rule[1].split(",").map((s) => s.trim())) {
        assert.ok(allowed.includes(sel), `rule hides content without a reason: ${sel}`);
      }
    }
  });

  it("every panel that starts hidden is revealed by a control that exists in the page", () => {
    // [panel class, the control id that shows it]
    const reveals = [
      ["tc-scn--1", "tc-s1"], ["tc-scn--2", "tc-s2"], ["tc-scn--3", "tc-s3"],
      ["tc-p--1", "tc-p1"], ["tc-p--2", "tc-p2"], ["tc-p--3", "tc-p3"], ["tc-p--4", "tc-p4"],
      ["tc-r--1", "tc-p1"], ["tc-r--2", "tc-p2"], ["tc-r--3", "tc-p3"], ["tc-r--4", "tc-p4"],
      ["pr-on", "pr-on"],
    ];
    for (const [panel, control] of reveals) {
      assert.ok(new RegExp(`class="[^"]*\\b${panel}\\b`).test(html), `no element with class ${panel}`);
      assert.ok(html.includes(` id="${control}"`), `control #${control} is not in the page`);
      assert.ok(css.includes(`#${control}:checked`) && new RegExp(`#${control}:checked\\)[^{,]*\\.${panel}\\b`).test(css), `no rule shows .${panel} when #${control} is checked`);
    }
    for (const id of ["tc-s1", "tc-s2", "tc-s3"]) assert.match(html, new RegExp(`<input[^>]*type="radio"[^>]*name="tc-scn"[^>]*id="${id}"`));
    for (const id of ["tc-p1", "tc-p2", "tc-p3", "tc-p4"]) assert.match(html, new RegExp(`<input[^>]*type="radio"[^>]*name="tc-step"[^>]*id="${id}"`));
    assert.match(html, /<input[^>]*type="checkbox"[^>]*id="pr-on"/);
    for (const name of ["rules", "you", "project"]) {
      const id = "dr-" + name;
      const d = new RegExp(`<details id="${id}" class="drawer drawer--${name}"[^>]*>\\s*<summary>[\\s\\S]*?</details>`).exec(html);
      assert.ok(d, `<details id="${id}" class="drawer drawer--${name}"> with a <summary>`);
      assert.ok(d[0].includes(`id="${id}-tray"`), `the tray #${id}-tray sits inside #${id}`);
      // Trays start hidden by [id$="-tray"], and an open-drawer rule shows them; the per-drawer rule moves that drawer's front.
      assert.ok(css.includes('.drawer [id$="-tray"]{opacity:0'), "trays start hidden");
      assert.ok(css.includes('.drawer[open] [id$="-tray"]{opacity:1}'), "an open drawer shows its tray");
      assert.ok(new RegExp(`\\.drawer--${name}\\[open\\]`).test(css), `no open rule for .drawer--${name}`);
    }
    // The cabinet counter: one value per number of open drawers (0..3), each shown by an open-drawer rule.
    for (const n of [0, 1, 2, 3]) assert.ok(new RegExp(`\\.cr${n}\\{display:inline\\}`).test(css), `no rule shows .cr${n}`);
  });

  it("the interactive controls: defaults, labels, fieldsets, accessible names", () => {
    const checked = (id) => new RegExp(`<input[^>]*\\bid="${id}"[^>]*\\bchecked\\b|<input[^>]*\\bchecked\\b[^>]*\\bid="${id}"`).test(html);
    assert.ok(checked("tc-s1") && !checked("tc-s2") && !checked("tc-s3"), "tc-s1 is the only checked scenario");
    assert.ok(checked("tc-p1") && !checked("tc-p2") && !checked("tc-p3") && !checked("tc-p4"), "tc-p1 is the only checked step");
    assert.ok(!checked("pr-on"), "pr-on starts unchecked");
    assert.ok(!/<details[^>]*\sopen[\s>=]/.test(html), "no drawer starts open");
    const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(inputs.length >= 8);
    for (const i of inputs) {
      const id = /\sid="([^"]+)"/.exec(i)?.[1];
      assert.ok(id, `input without id: ${i}`);
      assert.ok(new RegExp(`<label[^>]*\\sfor="${id}"`).test(html), `no <label for="${id}">`);
    }
    for (const name of ["tc-scn", "tc-step"]) {
      const fs_ = [...html.matchAll(/<fieldset[\s\S]*?<\/fieldset>/g)].map((m) => m[0]).find((f) => f.includes(`name="${name}"`));
      assert.ok(fs_, `radios ${name} must sit in a <fieldset>`);
      assert.match(fs_, /<legend[\s>]/);
    }
    const summaries = [...html.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map((m) => m[1]);
    assert.equal(summaries.length, 3);
    for (const s of summaries) assert.match(s, /<span class="sr">[^<]+<\/span>/, "a summary needs a text name; its svg is decoration");
  });

  it("still no script, no form, and script-src 'none'", () => {
    assert.ok(!/<script/i.test(html));
    assert.ok(!/<form/i.test(html));
    assert.match(res.headers["content-security-policy"], /(^|; )script-src 'none'(;|$)/);
  });

  it("the copy agents and crawlers need is in the HTML, not only behind a control", () => {
    for (const s of ["Never deploy without asking me first.", "Reply in the language I write in.", "Lead with the answer.",
      "Your owner card", "The project state card", "Without AgentRecall", "With AgentRecall", "illustrative"]) {
      assert.ok(html.includes(s), `missing copy: ${s}`);
    }
  });

  it("prefers-reduced-motion turns transitions and animations off", () => {
    const blocks = [...css.matchAll(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g)].map((x) => x[1]).join("\n");
    assert.ok(blocks, "the media block");
    assert.match(blocks, /transition:\s*none/);
    assert.match(blocks, /animation:\s*none/);
    // The second block turns off the drawer and .dd transitions specifically.
    assert.match(blocks, /\.drawer \[id\$="-tray"\],\.dd[^{]*\{transition:none/);
  });

  it("the drawer parts are inlined as they are (no class=art); the figures still get it", () => {
    for (const name of HOME_PARTS) {
      const svg = fs.readFileSync(path.join(srcDir, `${name}.svg`), "utf8").replace(/\r\n/g, "\n").replace(/<\?xml[^>]*\?>/g, "").replace(/\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, "").trim();
      assert.ok(html.includes(svg), `${name}.svg is inlined verbatim`);
      assert.ok(!/^<svg[^>]*\bclass="art"/.test(svg));
    }
    assert.equal([...html.matchAll(/<svg class="art"/g)].length, HOME_FIGURES.length);
  });

  it("what the small-screen rules hide is still reachable: the door links also sit outside the header nav", () => {
    const header = /<header class="top">[\s\S]*?<\/header>/.exec(html)[0];
    const rest = html.replace(header, "");
    for (const href of ["/connect", "/local", "/film"]) {
      assert.ok(rest.includes('href="' + href + '"'), href + " must be linked outside the header");
    }
  });

  it("honours prefers-reduced-motion", () => {
    assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
  });

  it("/ is a static path with or without OAuth", () => {
    assert.ok(isStaticPath("/", true) && isStaticPath("/", false));
  });
});

describe("home page — headers and cache", () => {
  it("is cacheable for five minutes when the base URL is configured", () => {
    assert.equal(res.headers["cache-control"], "public, max-age=300");
    assert.equal(res.headers.vary, undefined);
  });

  it("is never stored by a shared cache when the base URL came from the Host header", () => {
    const r = renderStatic("/", { ...ctx, hosted: false, baseFromHost: true });
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers.vary, "Host");
    assert.equal(r.status, 200);
  });

  it("with no loaded home the classic home page is served, with its footer links", () => {
    const classic = renderStatic("/", ctx, null, undefined, null);
    assert.equal(classic.status, 200);
    assert.ok(!/Measured, and shortened/.test(classic.body));
    assert.match(classic.body, /<a href="\/privacy">Privacy<\/a><a href="\/support">Support<\/a>/);
    assert.ok(classic.headers["content-security-policy"].includes("script-src 'sha256-"), "the classic page keeps its own script hash");
  });
});

describe("home page — loader", () => {
  it("a full copy of the assets loads and gives the same page as the build", () => {
    withCopy(null, (dir) => {
      const h = loadHome(dir);
      assert.ok(h);
      assert.equal(h.html, HOME.html);
      assert.equal(h.styleHash, HOME.styleHash);
    });
  });

  it("a CRLF checkout hashes exactly the text it inlines", () => {
    withCopy((f, text) => text.replace(/\n/g, "\r\n"), (dir) => {
      const h = loadHome(dir);
      assert.ok(h);
      assert.ok(!h.html.includes("\r"), "no CR reaches the page");
      const inlined = /<style>([\s\S]*?)<\/style>/.exec(h.html)[1];
      assert.equal(h.styleHash, hash(inlined));
      assert.equal(h.styleHash, HOME.styleHash, "same hash as the LF build");
    });
  });

  it("an empty or missing directory loads as null", () => {
    assert.equal(loadHome(path.join(os.tmpdir(), "ar-home-does-not-exist")), null);
    withCopy(null, (dir) => {
      fs.rmSync(path.join(dir, "home.html"));
      assert.equal(loadHome(dir), null, "no template");
    });
  });

  // [name, change(file, text) -> new text | null (omit file), expected reason]. Each case targets ONE check.
  const on = (file, from, to) => (f, t) => (f === file ? t.replace(from, to) : t);
  const refusals = [
    ["a missing figure", (f) => (f === "fig3.svg" ? null : undefined), /unreadable: .*fig3\.svg/],
    ["a missing part", (f) => (f === "drawer-you.svg" ? null : undefined), /unreadable: .*drawer-you\.svg/],
    ["a part svg with <script>", on("cabinet.svg", "</svg>", "<script>1</script></svg>"), /cabinet\.svg: svg contains <script/],
    ["a part that starts with <svgx", (f) => (f === "drawer-rules.svg" ? "<svgx></svgx>" : undefined), /drawer-rules\.svg does not start with <svg/],
    ["a part that does not start with <svg", (f) => (f === "drawer-rules.svg" ? "<div>x</div>" : undefined), /drawer-rules\.svg does not start with <svg/],
    ["css that could close its own style", on("home.css", /$/, "\n/* </style><b> */"), /home\.css could close/],
    ["an svg with <script>", on("fig1.svg", "</svg>", "<script>1</script></svg>"), /fig1\.svg: svg contains <script/],
    ["an svg with <style>", on("fig2-1.svg", "</svg>", "<style>a{}</style></svg>"), /fig2-1\.svg: svg contains <style/],
    ["an svg with <foreignObject>", on("fig2-2.svg", "</svg>", "<foreignObject/></svg>"), /fig2-2\.svg: svg contains <foreignObject/],
    ["an svg with <image>", on("fig3.svg", "</svg>", "<image/></svg>"), /fig3\.svg: svg contains <image/],
    ["an svg with an on*= attribute", on("fig1.svg", "<g ", '<g onload="x" '), /fig1\.svg: svg contains an on\*= attribute/],
    ["an svg with a slash-separated on*= attribute", on("fig1.svg", "</svg>", '<g/onload="x"/></svg>'), /fig1\.svg: svg contains an on\*= attribute/],
    ["an svg with style=", on("fig1.svg", "<g ", '<g style="fill:red" '), /fig1\.svg: svg contains a style= attribute/],
    ["an svg with <set>", on("fig1.svg", "</svg>", '<set attributeName="href" to="x"/></svg>'), /fig1\.svg: svg contains <set, <animate or <a/],
    ["an svg with <animate>", on("fig1.svg", "</svg>", '<animate attributeName="href"/></svg>'), /fig1\.svg: svg contains <set, <animate or <a/],
    ["an svg with an <a>", on("fig3.svg", "</svg>", '<a href="/x">x</a></svg>'), /fig3\.svg: svg contains <set, <animate or <a/],
    ["an svg with an absolute href", on("fig3.svg", "</svg>", '<use href="https://evil.example/"/></svg>'), /fig3\.svg: svg contains an absolute href/],
    ["an svg with xlink:href", on("fig3.svg", "</svg>", '<use xlink:href="#x"/></svg>'), /fig3\.svg: svg contains xlink:href/],
    ["a figure that does not start with <svg", (f) => (f === "fig1.svg" ? "<div>x</div>" : undefined), /fig1\.svg does not start with <svg/],
    ["icons.svg with <script>", on("icons.svg", /<\/svg>\s*$/, "<script>1</script></svg>"), /icons\.svg: svg contains <script/],
    ["icons.svg with an on*= attribute", on("icons.svg", "<symbol ", '<symbol onload="x" '), /icons\.svg: svg contains an on\*= attribute/],
    ["icons.svg with no <symbol>", (f) => (f === "icons.svg" ? "<svg></svg>" : undefined), /icons\.svg holds no <symbol>/],
    ["a duplicate id", on("fig2-1.svg", "</svg>", '<g id="f1-title"/></svg>'), /duplicate id "f1-title"/],
    ["a duplicate single-quoted id", on("fig2-1.svg", "</svg>", "<g id='f1-title'/></svg>"), /duplicate id "f1-title"/],
    ["a leftover placeholder", on("home.html", "<main", "{{nope}}<main"), /placeholder left in the page: \{\{nope\}\}/],
    ["an external URL", on("home.html", 'href="/film"', 'href="https://evil.example/film"'), /external URL https:\/\/evil\.example\/film/],
    ["a scheme-relative URL", on("home.html", 'href="/film"', 'href="//evil.example/film"'), /external URL \/\/evil\.example\/film/],
    ["a single-quoted external URL", on("home.html", 'href="/film"', "href='https://evil.example/film'"), /external URL https:\/\/evil\.example\/film/],
    ["an unquoted external URL", on("home.html", 'href="/film"', "href=//evil.example/film"), /external URL \/\/evil\.example\/film/],
    ["an external URL behind whitespace", on("home.html", 'href="/film"', 'href=" https://evil.example/film"'), /external URL https:\/\/evil\.example\/film/],
    ["an external URL split by a tab", on("home.html", 'href="/film"', 'href="ht\ttps://evil.example/film"'), /external URL https:\/\/evil\.example\/film/],
    ["a dangling <use href=\"#nope\">", on("home.html", '<use href="#i-film"/>', '<use href="#nope"/>'), /<use> points at a missing id \(#nope\)/],
    ["a <script> in the template", on("home.html", "</body>", "<script>1</script></body>"), /no <script/],
    ["a style= attribute in the template", on("home.html", '<main id="main">', '<main id="main" style="x:y">'), /style= attribute is present/],
    ["an on*= attribute in the template", on("home.html", '<main id="main">', '<main id="main" onclick="x">'), /on\*= attribute is present/],
    ["a javascript: URL", on("home.html", "</main>", "<p>javascript:1</p></main>"), /javascript: URL is present/],
    ["a <link rel=stylesheet> in the template", on("home.html", "</head>", '<link rel="stylesheet" href="/x.css"></head>'), /<link rel=stylesheet> is present/],
    ["an <img> in the template", on("home.html", "</main>", '<img src="/x"></main>'), /<img> is present/],
    ["an <iframe> in the template", on("home.html", "</main>", '<iframe src="/x"></iframe></main>'), /<iframe> is present/],
    ["a second <style>", on("home.html", "</head>", "<style>a{}</style></head>"), /exactly one <style>/],
    ["a <style> that is not the single css block", on("home.html", "<style>{{css}}</style>", '<style media="all">{{css}}</style>'), /<style> is not the single css block/],
    ["a page over 512 KB", on("home.html", "</main>", "<p>" + "x".repeat(520 * 1024) + "</p></main>"), /page larger than 512 KB/],
    ["an on*= attribute after a quoted '>'", on("home.html", '<main id="main">', '<main id="main" title=">" onclick="x">'), /on\*= attribute is present/],
    ["a style= attribute after a quoted '>'", on("fig1.svg", "<g ", '<g title=">" style="x" '), /fig1\.svg: svg contains a style= attribute/],
    ["css with @import", on("home.css", /$/, '\n@import "/x.css";'), /home\.css contains @import/],
    ["css with an absolute url()", on("home.css", /$/, "\na{background:url( 'https://evil.example/x.png')}"), /home\.css loads an absolute url\(\)/],
    ["a <meta http-equiv> refresh", on("home.html", "</head>", '<meta http-equiv="refresh" content="0;url=https://evil.example/"></head>'), /<meta http-equiv> is present/],
    ["a <base>", on("home.html", "</head>", '<base href="/x/"></head>'), /a <base> is present/],
    ["a <form>", on("home.html", "</main>", '<form action="/x"></form></main>'), /a <form> is present/],
    ["an <object>", on("home.html", "</main>", '<object data="/x"></object></main>'), /an? <object> is present/],
    ["an <embed>", on("home.html", "</main>", '<embed src="/x"></main>'), /an? <embed> is present/],
    ["a dangling <use/href> without a space", on("home.html", '<use href="#i-film"/>', '<use/href="#nope"/>'), /<use> points at a missing id \(#nope\)/],
    ["a dangling unquoted <use href>", on("home.html", '<use href="#i-film"/>', "<use href=#nope />"), /<use> points at a missing id \(#nope\)/],
    ["a URL that only starts like the repo", on("home.html", 'href="/film"', 'href="https://github.com/Goldentrii/AgentRecall-Xevil"'), /external URL https:\/\/github\.com\/Goldentrii\/AgentRecall-Xevil/],
    ["a character reference in a URL", on("home.html", 'href="/film"', 'href="&#106;avascript:alert(1)"'), /character reference in a URL/],
    ["a backslash-backslash URL (read as //)", on("home.html", 'href="/film"', 'href="\\\\evil.example/x"'), /external URL \\\\evil\.example\/x/],
    ["a slash-backslash URL (read as //)", on("home.html", 'href="/film"', 'href="/\\evil.example/x"'), /external URL \/\\evil\.example\/x/],
    ["a handler hidden behind a quote opened in a comment", on("home.html", "</main>", '<!-- <p a=" --><b onclick="x">x</b></main>'), /on\*= attribute is present/],
    ["a comment rebuilt from what one strip pass leaves", on("home.html", "</main>", '<!<!---->-- a > <p a=" --><b onclick="x">x</b></main>'), /<! construct is left in the page/],
    ["a CDATA section", on("home.html", "</main>", "<![CDATA[x]]></main>"), /<! construct is left in the page/],
    ["a processing instruction", on("home.html", "</main>", "<?x y?></main>"), /<\? processing instruction/],
    ["an end tag with an attribute", on("home.html", "</main>", '</p a="x"></main>'), /end tag that is not a bare <\/name>/],
    ["a <title> holding markup", on("home.html", "<title>", "<title><b>x</b>"), /<title> holds markup/],
    ["a <textarea>", on("home.html", "</main>", "<textarea>x</textarea></main>"), /a <textarea> is present/],
    ["a <noscript>", on("home.html", "</main>", "<noscript>x</noscript></main>"), /a <noscript> is present/],
    ["css with '<'", on("home.css", /$/, "\na::after{content:'<'}"), /home\.css contains '<'/],
    ["css with an escaped @import", on("home.css", /$/, '\n@\\69mport "https://evil.example/x.css";'), /home\.css contains a backslash escape/],
    ["css with image-set()", on("home.css", /$/, "\na{background:image-set('https://evil.example/x.png' 1x)}"), /home\.css contains image-set\(\)/],
    // U+00A0 is not HTML whitespace: the browser reads one tag "a\u00A0b=\"" ending at the first ">", so the <b onclick> after it is live.
    ["a tag split by U+00A0 that hides a handler", on("home.html", "<main", '<a\u00A0b="><b onclick=x>x</b>"><main'), /on\*= attribute is present/],
    ["a second style opened as <style/>", on("home.html", "<main", '<style/>x <p a="</style><b onclick=x>x</b>"><main'), /exactly one <style>/],
    ["an <iframe/> with no space", on("home.html", "<main", '<iframe/>x</iframe><main'), /an <iframe> is present/],
    ["a <link rel=preload>", on("home.html", "</head>", '<link rel="preload" href="/x"></head>'), /<link rel=preload> is present/],
    ["a ping= attribute on a link", on("home.html", 'href="/film"', 'href="/film" ping="https://evil.example/p"'), /a ping= attribute is present/],
    ["an svg with srcset=", on("fig1.svg", "<g ", '<g srcset="https://evil.example/x 1x" '), /fig1\.svg: svg contains a srcset= attribute/],
  ];
  for (const [name, change, reason] of refusals) {
    it("refuses " + name, () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ar-home-bad-"));
      try {
        let changed = false;
        for (const f of SHIPPED) {
          const text = fs.readFileSync(path.join(srcDir, f), "utf8").replace(/\r\n/g, "\n");
          const out = change(f, text);
          if (out === null) { changed = true; continue; }
          const final = out === undefined ? text : out;
          if (final !== text) changed = true;
          fs.writeFileSync(path.join(tmp, f), final);
        }
        assert.ok(changed, "the fixture edit did not match the shipped assets (stale snippet): " + name);
        assert.equal(loadHome(tmp), null);
        const r = loadHomeWithReason(tmp);
        assert.ok("reason" in r, "expected a refusal");
        assert.match(r.reason, reason);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  it("attribute values that only look like attributes are not mistaken for them", () => {
    withCopy((f, t) => (f === "home.html" ? t.replace('<main id="main">', '<main id="main" title="rule one = 1" aria-label="in style = x, onset = 2">') : t), (dir) => {
      assert.ok(loadHome(dir), "a quoted value must not trip the on*= or style= guards");
    });
  });

  it("a byte-order mark or a leading blank line in the template is not refused", () => {
    withCopy((f, t) => (f === "home.html" ? "\uFEFF\n\n" + t : f === "home.css" ? "\uFEFF" + t : t), (dir) => {
      const h = loadHome(dir);
      assert.ok(h, "an editor save must not take the page down");
      assert.match(h.html, /^<!doctype html>/i, "the page still starts with its doctype");
      assert.equal(h.styleHash, HOME.styleHash, "the BOM is not part of the hashed style");
    });
  });

  it("a commented-out link is not served and is not refused", () => {
    withCopy((f, t) => (f === "home.html" ? t.replace("</main>", '<!-- <a href="https://evil.example/">old</a> --></main>') : t), (dir) => {
      const h = loadHome(dir);
      assert.ok(h, "a comment is inert in the browser, so it must not take the page down");
      assert.ok(!h.html.includes("evil.example"), "comments are stripped before the page is checked and served");
      assert.ok(!h.html.includes("<!--"), "no comment reaches the page");
    });
  });

  it("the repo and Telegram links are allowed with a path, query or fragment under them", () => {
    withCopy((f, t) => (f === "home.html" ? t.replace('href="/film"', 'href="{{repo}}/issues?q=x#top"') : t), (dir) => {
      assert.ok(loadHome(dir), "a path under the repo URL is the repo");
    });
  });

  it("prose such as 'one = 1' and ' only = ' is not mistaken for an attribute", () => {
    withCopy((f, t) => (f === "home.html" ? t.replace("</main>", "<p>one = 1 and only = 2, style = none</p></main>") : t), (dir) => {
      assert.ok(loadHome(dir), "text outside a tag must not trip the attribute guards");
    });
  });

  it("the refusal logs one stderr line naming the reason and the page falls back (module load, fresh process)", async () => {
    const { spawnSync } = await import("node:child_process");
    const tmp = fs.mkdtempSync(path.join(here, "..", "ar-home-proc-"));
    try {
      // A copy of dist inside the package (so node_modules still resolves) with one asset broken; the loader reads ./home beside home.js.
      const dist = path.join(here, "..", "dist");
      fs.cpSync(dist, path.join(tmp, "dist"), { recursive: true });
      fs.rmSync(path.join(tmp, "dist", "http", "home", "fig3.svg"));
      const code = `const m = await import("./dist/http/site.js"); const r = m.renderStatic("/", { base: "https://x", privacyUrl: "https://x/p", hosted: true }); process.stdout.write(String(r.status) + " " + /Measured, and shortened/.test(r.body));`;
      const p = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: tmp, encoding: "utf8" });
      const lines = p.stderr.split("\n").filter((l) => l.includes("[site] home page"));
      assert.equal(lines.length, 1, p.stderr);
      assert.match(lines[0], /^\[site\] home page assets missing or invalid in dist\/http\/home \(unreadable: .*fig3\.svg.*\); serving the classic home page$/);
      assert.equal(p.stdout, "200 false", "classic home page served");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("REPO_URL is the only place the repo address comes from", () => {
    assert.ok(HOME.html.includes(`href="${REPO_URL}"`));
    assert.ok(!fs.readFileSync(path.join(srcDir, "home.html"), "utf8").includes("github.com"), "the template uses {{repo}}");
  });
});
