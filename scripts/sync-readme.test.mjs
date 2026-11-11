import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { absolutize } from "./sync-readme.mjs";

const RAW = "https://raw.githubusercontent.com/Goldentrii/AgentRecall-X/main/";
const BLOB = "https://github.com/Goldentrii/AgentRecall-X/blob/main/";

test("relative images become raw.githubusercontent URLs (src and srcset)", () => {
  const out = absolutize('<source srcset="assets/readme/hero-dark.svg"><img src="./assets/readme/hero-light.svg" alt="x">');
  assert.equal(out, `<source srcset="${RAW}assets/readme/hero-dark.svg"><img src="${RAW}assets/readme/hero-light.svg" alt="x">`);
});

test("relative links become blob URLs, in markdown and HTML", () => {
  assert.equal(absolutize("[policy](PRIVACY.md)"), `[policy](${BLOB}PRIVACY.md)`);
  assert.equal(absolutize("[gate](docs/hosted-server.md#corrections-need-the-owner)"), `[gate](${BLOB}docs/hosted-server.md#corrections-need-the-owner)`);
  assert.equal(absolutize('<a href="docs/x.md">x</a>'), `<a href="${BLOB}docs/x.md">x</a>`);
});

test("anchors, absolute URLs and protocol-relative URLs are untouched", () => {
  const md = '[a](#the-math) <a href="#local-install">l</a> [b](https://example.com/x.md) <img src="https://img.shields.io/x.svg"> [c](//cdn.example.com/y) [m](mailto:a@b.c)';
  assert.equal(absolutize(md), md);
});

test("the real README has no relative URL left after absolutize", () => {
  const md = absolutize(fs.readFileSync(new URL("../README.md", import.meta.url), "utf8"));
  const urls = [...md.matchAll(/\b(?:src|srcset|href)="([^"]*)"/g), ...md.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  const relative = urls.filter((u) => !/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(u));
  assert.deepEqual(relative, []);
});

test("the published package READMEs are in sync (run `npm run sync-readme` after editing README.md)", () => {
  const lf = (t) => t.replace(/\r\n/g, "\n");
  const expected = lf(absolutize(fs.readFileSync(new URL("../README.md", import.meta.url), "utf8")));
  for (const p of ["core", "mcp-server", "sdk", "cli"]) {
    const actual = lf(fs.readFileSync(new URL(`../packages/${p}/README.md`, import.meta.url), "utf8"));
    assert.equal(actual, expected, `packages/${p}/README.md is stale`);
  }
});
