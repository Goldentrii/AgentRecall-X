// The home page film: served under the same strict CSP as every other page, with
// five same-origin plates, a readable no-script document, and a fallback to the
// classic home page when the film assets are missing.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { renderStatic, isStaticPath } = await import("../dist/http/site.js");
const { FILM, FILM_PLATES, loadFilm, filmPage } = await import("../dist/http/film.js");

const ctx = { base: "https://recall.example.com", privacyUrl: "https://example.com/privacy", hosted: true };
const hash = (s) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;

describe("home page film", () => {
  it("the build ships the film assets", () => {
    assert.ok(FILM, "dist/http/film/ must hold film.css, film.js and the five plates");
    assert.equal(FILM.plates.size, FILM_PLATES.length);
  });

  it("/ is the film, under a CSP whose hashes match its one inline style and one inline script", () => {
    const r = renderStatic("/", ctx);
    assert.equal(r.status, 200);
    const csp = r.headers["content-security-policy"];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /img-src 'self' data:/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.ok(!/unsafe-inline|unsafe-eval|'self'[^;]*;?\s*script-src|script-src[^;]*'self'|script-src[^;]*https?:/.test(csp.replace(/img-src 'self' data:;/, "")), csp);
    const scripts = [...r.body.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    const styles = [...r.body.matchAll(/<style>([\s\S]*?)<\/style>/g)];
    assert.equal(scripts.length, 1);
    assert.equal(styles.length, 1);
    assert.ok(csp.includes(`script-src ${hash(scripts[0][1])}`), "script hash");
    assert.ok(csp.includes(`style-src ${hash(styles[0][1])}`), "style hash");
    assert.ok(!/<script[^>]+src=|<link[^>]+rel="stylesheet"|\sstyle="|\son[a-z]+="/i.test(r.body), "nothing the CSP would block");
    assert.equal(r.headers["x-frame-options"], "DENY");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
  });

  it("the page tells the Intelligent Distance story and keeps both doors, readable without script", () => {
    const html = renderStatic("/", ctx).body;
    assert.equal([...html.matchAll(/<h1>/g)].length, 1);
    assert.match(html, /<h1>Two kinds of intelligence\.<\/h1>/);
    assert.match(html, /One correction crosses the gap\./);
    assert.match(html, /The distance never closes\./);
    assert.match(html, /<a class="btn" href="\/connect">Connect an agent<\/a>/);
    assert.match(html, /href="\/local"/);
    assert.match(html, /href="\/connect\.md"/);
    assert.match(html, /href="\/local\.md"/);
    assert.match(html, /href="https:\/\/example\.com\/privacy"/);
    // The captions are only pinned and hidden under html.film, which the script adds.
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
    for (const rule of css.matchAll(/([^{}]+)\{[^{}]*(?:opacity:0|visibility:hidden|position:fixed)[^{}]*\}/g)) {
      assert.match(rule[1], /\.film|\.skip/, `rule hides or pins content without script: ${rule[1].trim()}`);
    }
  });

  it("no host other than the repo, the privacy link and Telegram appears", () => {
    const html = renderStatic("/", ctx).body;
    const hosts = new Set([...html.matchAll(/(?:href|src|action)="(https?:\/\/[^"/]+)/g)].map((m) => m[1]));
    assert.deepEqual([...hosts].sort(), ["https://example.com", "https://github.com", "https://t.me"]);
    assert.ok(!/https?:\/\//.test(/<script>([\s\S]*?)<\/script>/.exec(html)[1]), "the script names no URL");
  });

  it("every plate the script loads is served as a cacheable same-origin JPEG", () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(renderStatic("/", ctx).body)[1];
    const names = /const PLATES = \[([^\]]+)\]/.exec(script)[1].split(",").map((s) => s.trim().replace(/"/g, ""));
    assert.deepEqual(names, [...FILM_PLATES]);
    let total = 0;
    for (const n of names) {
      const p = `/film/${n}.jpg`;
      assert.ok(isStaticPath(p, true) && isStaticPath(p, false), p);
      const r = renderStatic(p, ctx);
      assert.equal(r.status, 200, p);
      assert.ok(Buffer.isBuffer(r.body));
      assert.deepEqual([...r.body.subarray(0, 3)], [0xff, 0xd8, 0xff]);
      assert.equal(r.headers["content-type"], "image/jpeg");
      assert.equal(r.headers["content-length"], String(r.body.length));
      assert.equal(r.headers["x-content-type-options"], "nosniff");
      assert.match(r.headers["cache-control"], /public, max-age=\d+/);
      total += r.body.length;
    }
    assert.ok(total < 600 * 1024, `plates total ${total} bytes`);
  });

  it("plates never depend on the Host header, even with OAuth off", () => {
    const r = renderStatic("/film/human.jpg", { ...ctx, hosted: false, baseFromHost: true });
    assert.match(r.headers["cache-control"], /public/);
    assert.equal(r.headers.vary, undefined);
  });

  it("only the five plates are served under /film/", () => {
    for (const p of ["/film", "/film/", "/film/film.js", "/film/film.css", "/film/other.jpg", "/film/../site.js", "/film/human.jpg/x", "/film/HUMAN.jpg", "/film/human.jpg%00"]) {
      assert.equal(renderStatic(p, ctx), null, p);
      assert.equal(isStaticPath(p, true), false, p);
    }
  });

  it("missing or wrong assets load as null, and the classic home page is served instead", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ar-film-"));
    try {
      assert.equal(loadFilm(tmp), null, "empty dir");
      const src = path.join(here, "..", "dist", "http", "film");
      for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(tmp, f));
      assert.ok(loadFilm(tmp), "a full copy loads");
      fs.writeFileSync(path.join(tmp, "m2.jpg"), "<html>not a jpeg</html>");
      assert.equal(loadFilm(tmp), null, "a plate that is not a JPEG");
      fs.copyFileSync(path.join(src, "m2.jpg"), path.join(tmp, "m2.jpg"));
      fs.appendFileSync(path.join(tmp, "film.js"), "\n// </script><script>alert(1)");
      assert.equal(loadFilm(tmp), null, "a script that could close its own element");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    const classic = renderStatic("/", ctx, null);
    assert.equal(classic.status, 200);
    assert.match(classic.body, /<a class="btn" href="\/connect">Connect an agent<\/a>/);
    assert.equal(renderStatic("/film/human.jpg", ctx, null), null);
  });

  it("filmPage escapes the privacy URL", () => {
    const html = filmPage(FILM, { ...ctx, privacyUrl: 'https://example.com/"><script>x</script>' });
    assert.equal([...html.matchAll(/<script>/g)].length, 1);
  });
});

describe("home page film — accessibility and motion", () => {
  const html = renderStatic("/", ctx).body;
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

  it("captions are never removed from the accessibility tree", () => {
    assert.ok(!/visibility:\s*hidden|display:\s*none[^}]*\}\s*\.film \.beat|\.beat[^{]*\{[^}]*display:\s*none/.test(css));
    assert.ok(!/\binert\b|aria-hidden/.test(script), "the script hides nothing from assistive technology");
    assert.match(script, /tabIndex = on \? 0 : -1/, "links in an off-screen caption leave the Tab order");
  });

  it("reduced motion removes the jump, and the flash never reaches full white", () => {
    assert.match(script, /prefers-reduced-motion: reduce/);
    assert.match(script, /\* \(1\.0 - calm\)/, "rush is zero when calm is set");
    assert.match(script, /uniform1f\(u\("calm"\), reduced \? 1 : 0\)/);
    assert.match(script, /0\.7 \* pow\(rush, 5\.0\)/, "flash capped below white");
  });

  it("nothing is drawn while hidden or covered, and no discrete GPU is requested", () => {
    assert.match(script, /!document\.hidden && !covered/);
    assert.ok(!/high-performance/.test(script));
  });
});

describe("home page film — calls to action and gold", () => {
  const html = renderStatic("/", ctx).body;
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const header = /<header class="top">([\s\S]*?)<\/header>/.exec(html)[1];

  it("the header carries two real buttons, GitHub stays a plain link", () => {
    assert.match(header, /<a class="btn sm" href="\/connect">Connect an agent<\/a>/);
    assert.match(header, /<a class="btn sm alt" href="\/local">Run it locally<\/a>/);
    assert.match(header, /<a href="https:\/\/github\.com[^"]*" rel="noopener">GitHub<\/a>/);
  });

  it("'Skip the film' is a plain anchor to #doors, and #doors exists", () => {
    assert.match(html, /<a class="skipfilm" href="#doors">Skip the film<\/a>/);
    assert.match(html, /id="doors"/);
  });

  it("the film track is 450vh, not 900vh", () => {
    assert.match(css, /\.film #track\{[^}]*height:450vh/);
    assert.ok(!/900vh/.test(css));
  });

  it("one gold token drives brand, kickers and primary buttons; the shader grades the human side gold", () => {
    assert.match(css, /--gold:#f5c451/i);
    assert.match(css, /\.btn\{[^}]*background:var\(--gold\)/);
    assert.match(css, /\.kicker\{[^}]*color:var\(--gold\)/);
    assert.match(css, /\.mark\{[^}]*background:var\(--gold\)/);
    assert.match(script, /const vec3 GOLD = vec3\(0\.961, 0\.769, 0\.318\)/);
    assert.match(script, /gold\(plate\(H, c, hc, s\)\)/);
  });

  it("captions only explain the distance and the fix, and never promise automatic hosted rules", () => {
    assert.match(html, /Intelligent Distance/);
    assert.ok(!/automatically (becomes|saved|applied)/i.test(html));
  });
});

describe("home page film — line endings", () => {
  it("a CRLF checkout hashes exactly the text it inlines (the browser hashes after newline normalisation)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ar-film-crlf-"));
    try {
      const src = path.join(here, "..", "dist", "http", "film");
      for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(tmp, f));
      for (const f of ["film.css", "film.js"]) {
        const lf = fs.readFileSync(path.join(tmp, f), "utf8").replace(/\r\n/g, "\n");
        fs.writeFileSync(path.join(tmp, f), lf.replace(/\n/g, "\r\n"));
      }
      const film = loadFilm(tmp);
      assert.ok(film);
      assert.ok(!film.css.includes("\r") && !film.script.includes("\r"), "inlined text carries no CR");
      assert.equal(film.styleHash, hash(film.css));
      assert.equal(film.scriptHash, hash(film.script));
      assert.equal(film.styleHash, FILM.styleHash, "same hash as the LF build");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
