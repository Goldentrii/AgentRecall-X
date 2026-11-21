/**
 * site-look.test.mjs — the site's stylesheet is dark-only and reads only tokens it defines.
 * Pure: renders a page, pulls the one <style> out of it, checks the CSS text.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { messagePage, FAVICON_SVG } from "../dist/http/site-pages.js";
import { SITE_TOKENS } from "../dist/http/site-theme.js";

const html = messagePage({ base: "http://x", privacyUrl: "http://x/p", hosted: true }, "t", "m", { href: "/", label: "b" });
const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];

describe("site stylesheet", () => {
  it("has no light palette: no prefers-color-scheme rule", () => {
    assert.ok(!/prefers-color-scheme/.test(css));
    assert.ok(css.includes("color-scheme:dark"));
  });
  it("every var(--x) it reads is a defined token", () => {
    const defined = new Set([...SITE_TOKENS.matchAll(/(--[\w-]+):/g)].map((m) => m[1]));
    const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
    const missing = [...used].filter((n) => !defined.has(n));
    assert.deepEqual(missing, []);
  });
  it("the favicon mark only uses colours that are token values", () => {
    const tokenHex = new Set([...SITE_TOKENS.matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0].toLowerCase()));
    const markHex = [...FAVICON_SVG.matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0].toLowerCase());
    assert.deepEqual(markHex.filter((h) => !tokenHex.has(h)), []);
  });
});

describe("small buttons keep their own text colour", () => {
  it(".small (dim note text) never reaches a .btn.small", () => {
    assert.ok(/\.small:not\(\.btn\)\{[^}]*color:var\(--dim\)/.test(css));
    assert.ok(!/(^|\n)\.small\{[^}]*color/.test(css));
  });
});
