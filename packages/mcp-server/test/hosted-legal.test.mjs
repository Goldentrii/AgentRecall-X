// /privacy and /support: PRIVACY.md rendered on our own domain (single source, shipped in dist),
// a support page that names only the address PRIVACY.md names, the footer links on every page,
// and the small markdown renderer that must never let source text become markup.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { renderStatic, isStaticPath } = await import("../dist/http/site.js");
const { LEGAL, parseLegal, loadLegal } = await import("../dist/http/legal.js");
const { renderMarkdown } = await import("../dist/http/markdown-lite.js");
const { llmsTxt } = await import("../dist/http/site-pages.js");

const REPO_POLICY = path.join(here, "..", "..", "..", "PRIVACY.md");
const policy = fs.readFileSync(REPO_POLICY, "utf8").replace(/\r\n/g, "\n");
const ctx = { base: "https://recall.example.com", privacyUrl: "https://example.com/privacy", hosted: true };
const hash = (s) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;
const CONTACT = /contact:\s*\*\*([^*\s]+)\*\*/.exec(policy)[1];

describe("PRIVACY.md is the single source", () => {
  it("the build ships a byte-identical copy in dist/http/legal", () => {
    const shipped = fs.readFileSync(path.join(here, "..", "dist", "http", "legal", "PRIVACY.md"), "utf8").replace(/\r\n/g, "\n");
    assert.equal(shipped, policy);
    assert.ok(LEGAL, "the server loaded it");
  });

  it("the contact address is read from the policy text", () => {
    assert.match(CONTACT, /^[^@\s]+@[^@\s]+\.[a-z]+$/i);
    assert.equal(LEGAL.contact, CONTACT);
  });

  it("parseLegal: no contact, or an invalid one, yields null", () => {
    assert.equal(parseLegal("# t\n\nno one here").contact, null);
    assert.equal(parseLegal("contact: **not an email**").contact, null);
    assert.equal(parseLegal("contact: **a@b.example**").contact, "a@b.example");
    assert.equal(loadLegal(path.join(here, "does-not-exist.md")), null);
  });

  it("the package ships dist, so the copy travels with it", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
    assert.ok(pkg.files.includes("dist"));
  });
});

describe("GET /privacy", () => {
  const r = renderStatic("/privacy", ctx);

  it("is an HTML page under the site CSP whose hashes match its one inline style and script", () => {
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "text/html; charset=utf-8");
    const csp = r.headers["content-security-policy"];
    const style = [...r.body.matchAll(/<style>([\s\S]*?)<\/style>/g)];
    const script = [...r.body.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.equal(style.length, 1);
    assert.equal(script.length, 1);
    assert.ok(csp.includes(`style-src ${hash(style[0][1])}`));
    assert.ok(csp.includes(`script-src ${hash(script[0][1])}`));
    assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
    assert.ok(!/\sstyle="|\son[a-z]+="|<script[^>]+src=|<link[^>]+rel="stylesheet"/i.test(r.body));
    assert.equal(r.headers["x-frame-options"], "DENY");
  });

  it("renders the policy text: headings, the table, the contact, the data location", () => {
    assert.match(r.body, /<h1>Privacy policy: hosted AgentRecall at agentrecallx\.com<\/h1>/);
    assert.match(r.body, /<h2>Who is responsible<\/h2>/);
    assert.match(r.body, /<h2>Your rights<\/h2>/);
    assert.match(r.body, /<table>[\s\S]*<th scope="col">Data<\/th>/);
    assert.ok(r.body.includes(`<strong>${CONTACT}</strong>`));
    assert.match(r.body, /Frankfurt, Germany/);
    assert.match(r.body, /<code>ar_review_login_&lt;id&gt;<\/code>/, "code spans are escaped");
    // Every paragraph of the source shows up (words, not markup).
    const words = (h) => h.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/g, " ").replace(/[`*|#\-]/g, " ").replace(/\s+/g, " ");
    const text = words(r.body);
    for (const line of policy.split("\n").filter((l) => /^[A-Za-z]/.test(l))) {
      const head = words(line).trim().slice(0, 60);
      assert.ok(text.includes(head), `missing: ${head}`);
    }
  });

  it("is indexable, cacheable and linked to nothing outside the policy's own links", () => {
    assert.match(r.body, /<meta name="robots" content="index,follow">/);
    assert.match(r.headers["cache-control"], /public/);
    const hosts = new Set([...r.body.matchAll(/(?:href|src|action)="(https?:\/\/[^"/]+)/g)].map((m) => m[1]));
    assert.deepEqual([...hosts].sort(), ["https://github.com", "https://t.me"]);
  });

  it("works with a trailing slash, hosted or not, and a host-derived base is never cached", () => {
    assert.equal(renderStatic("/privacy/", ctx).status, 200);
    assert.ok(isStaticPath("/privacy", true) && isStaticPath("/privacy", false));
    const local = renderStatic("/privacy", { ...ctx, hosted: false, baseFromHost: true });
    assert.equal(local.headers["cache-control"], "no-store");
  });

  it("answers 503 and shows no policy text when the shipped copy is missing", () => {
    const gone = renderStatic("/privacy", ctx, null, null);
    assert.equal(gone.status, 503);
    assert.equal(gone.headers["retry-after"], "300");
    assert.equal(gone.headers["cache-control"], "no-store");
    assert.match(gone.body, /unavailable/);
    assert.ok(!gone.body.includes("Data controller"));
    assert.match(gone.body, /<meta name="robots" content="noindex/, "a fallback page is never indexed");
  });

  it("support promises no response time the owner has not confirmed", () => {
    const s = renderStatic("/support", ctx).body;
    assert.match(s, /no guaranteed response time/);
    assert.ok(!/within about a week/.test(s));
  });
});

describe("GET /support", () => {
  const r = renderStatic("/support", ctx);

  it("is an HTML page under the site CSP", () => {
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "text/html; charset=utf-8");
    const style = /<style>([\s\S]*?)<\/style>/.exec(r.body)[1];
    const script = /<script>([\s\S]*?)<\/script>/.exec(r.body)[1];
    assert.ok(r.headers["content-security-policy"].includes(hash(style)));
    assert.ok(r.headers["content-security-policy"].includes(hash(script)));
  });

  it("names the address PRIVACY.md names, and no other", () => {
    assert.ok(r.body.includes(`href="mailto:${CONTACT}"`));
    const addresses = new Set([...r.body.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0]));
    assert.deepEqual([...addresses], [CONTACT]);
    assert.equal([...r.body.matchAll(/mailto:/g)].length, 1);
  });

  it("links GitHub issues, says support is best effort by one person, promises no SLA", () => {
    assert.match(r.body, /href="https:\/\/github\.com\/Goldentrii\/AgentRecall-X\/issues"/);
    assert.match(r.body, /run by one person/);
    assert.match(r.body, /best effort/);
    assert.match(r.body, /no guaranteed response time/);
    assert.match(r.body, /<a href="\/privacy">privacy policy<\/a>/);
  });

  it("without a contact in the policy it shows no mailto link at all", () => {
    const none = renderStatic("/support", ctx, null, { html: "", contact: null });
    assert.ok(!/mailto:/.test(none.body));
    assert.match(none.body, /issues/);
  });
});

describe("links on every site page", () => {
  const pages = ["/", "/local", "/privacy", "/support"];
  const connectOff = renderStatic("/connect", { ...ctx, hosted: false });

  it("Privacy and Support are in the footer of the home film, /local, /privacy, /support and the sign-in-off page", () => {
    for (const [p, body] of [...pages.map((p) => [p, renderStatic(p, ctx).body]), ["/connect", connectOff.body]]) {
      assert.match(body, /<nav aria-label="Footer">[^]*<a href="\/privacy"[^>]*>Privacy<\/a><a href="\/support"[^>]*>Support<\/a>/, p);
    }
  });

  it("the classic home page has them too", () => {
    assert.match(renderStatic("/", ctx, null).body, /<a href="\/privacy">Privacy<\/a><a href="\/support">Support<\/a>/);
  });

  it("the current page is marked in the footer", () => {
    assert.match(renderStatic("/privacy", ctx).body, /<a href="\/privacy" aria-current="page">Privacy<\/a>/);
    assert.match(renderStatic("/support", ctx).body, /<a href="\/support" aria-current="page">Support<\/a>/);
  });

  it("there is no /terms route (a draft lives in docs/legal for the owner)", () => {
    assert.equal(renderStatic("/terms", ctx), null);
    assert.ok(!isStaticPath("/terms", true));
  });

  it("llms.txt points at the site's own pages", () => {
    const t = llmsTxt("https://recall.example.com");
    assert.match(t, /\[Privacy policy\]\(https:\/\/recall\.example\.com\/privacy\)/);
    assert.match(t, /\[Support\]\(https:\/\/recall\.example\.com\/support\)/);
  });
});

describe("markdown-lite never turns source text into markup", () => {
  it("raw HTML is shown as text", () => {
    const h = renderMarkdown('# <script>alert(1)</script>\n\n<img src=x onerror=alert(1)> and <b>x</b>\n\n- <iframe src="//e"></iframe>\n\n| <i>a</i> | b |\n|---|---|\n| <u>c</u> | d |');
    assert.ok(!/<(script|img|iframe|b|i|u)\b/.test(h.replace(/<\/?(h1|p|ul|li|table|thead|tbody|tr|th|td|div|strong|code|a)\b[^>]*>/g, "")), h);
    assert.match(h, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  it("links: only http(s) and mailto get an anchor", () => {
    const ok = renderMarkdown("[a](https://example.com/x?y=1) [m](mailto:a@b.example) [h](http://example.com)");
    assert.match(ok, /<a href="https:\/\/example\.com\/x\?y=1" rel="noopener">a<\/a>/);
    assert.match(ok, /<a href="mailto:a@b\.example" rel="noopener">m<\/a>/);
    assert.match(ok, /<a href="http:\/\/example\.com" rel="noopener">h<\/a>/);
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x", "/relative", "//evil.example", "file:///etc/passwd", "ftp://x.example"]) {
      const h = renderMarkdown(`[click](${bad})`);
      assert.ok(!/<a\b/.test(h), `${bad}: ${h}`);
      assert.match(h, /click/);
    }
  });

  it("a quote or angle bracket cannot break out of the href", () => {
    const h = renderMarkdown('[x](https://e.example/"onmouseover="alert(1))');
    assert.ok(!/<a\b/.test(h), "a target with a quote is refused");
    const h2 = renderMarkdown("[x](https://e.example/<b>)");
    assert.ok(!/<a\b/.test(h2));
    assert.ok(!/onmouseover="/.test(h));
  });

  it("images are not rendered; bold and code nest safely; CRLF is fine", () => {
    assert.ok(!/<img/.test(renderMarkdown("![alt](https://e.example/a.png)")));
    assert.equal(renderMarkdown("**bold `c<>` x**"), "<p><strong>bold <code>c&lt;&gt;</code> x</strong></p>");
    assert.equal(renderMarkdown("a\r\nb\r\n\r\n- one\r\n- two"), "<p>a b</p>\n<ul><li>one</li><li>two</li></ul>");
  });

  it("tables keep their columns; a short row is padded, an extra cell dropped", () => {
    const h = renderMarkdown("| A | B |\n|---|---|\n| 1 |\n| 2 | 3 | 4 |");
    assert.match(h, /<td data-label="A">1<\/td><td data-label="B"><\/td>/);
    assert.match(h, /<td data-label="A">2<\/td><td data-label="B">3<\/td><\/tr>/);
    assert.ok(!/<td>4/.test(h));
  });

  it("each cell carries its column header as an escaped data-label so a phone can stack rows", () => {
    const h = renderMarkdown('| **Da"ta** | <b>Why</b> |\n|---|---|\n| x | y |');
    assert.match(h, /<td data-label="Da&quot;ta">x<\/td><td data-label="&lt;b&gt;Why&lt;\/b&gt;">y<\/td>/);
    assert.ok(!/<b>/.test(h));
  });
});
