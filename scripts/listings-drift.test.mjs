// Listing files that directories read must not drift from the packages or the hosted URL.
// Run: node --test scripts/listings-drift.test.mjs
// ROOT can be overridden (used to trace the failure path against a temp copy).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { inflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.LISTINGS_ROOT ?? join(here, "..");
const p = (...a) => join(ROOT, ...a);
const text = (...a) => readFileSync(p(...a), "utf8");
const json = (...a) => JSON.parse(text(...a));

const mcp = json("packages/mcp-server/package.json");
const serverJson = json("packages/mcp-server/server.json");
const fields = json("docs/listings/fields.json");
const HOSTED = fields.hostedUrl;

function pngSize(file) {
  const b = readFileSync(file);
  assert.equal(b.subarray(1, 4).toString("latin1"), "PNG", `${file} is not a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) walk(f, out);
    else out.push(f);
  }
  return out;
}

test("all four packages share one version, and it is the version everywhere", () => {
  for (const pkg of ["core", "mcp-server", "sdk", "cli"]) {
    assert.equal(json("packages", pkg, "package.json").version, mcp.version, pkg);
  }
  assert.equal(serverJson.version, mcp.version);
});

test("hosted URL: fields.json, server.json, mcp.json, docker entry agree", () => {
  assert.equal(serverJson.remotes[0].url, HOSTED);
  assert.equal(json("mcp.json").mcpServers["agent-recall"].url, HOSTED);
  assert.match(text("docs/listings/docker/server.yaml"), new RegExp(`^  url: ${HOSTED}$`, "m"));
});

test(".cursor-plugin/plugin.json follows the Cursor rules and matches package.json", () => {
  const m = json(".cursor-plugin/plugin.json");
  assert.match(m.name, /^[a-z0-9][a-z0-9.-]*$/, "name must be lowercase kebab-case");
  assert.equal(m.version, mcp.version);
  assert.equal(m.repository, fields.repoUrl);
  assert.equal(m.homepage, fields.websiteUrl);
  assert.equal(m.license, "MIT");
  assert.ok(m.description.length > 0);
  assert.ok(m.author?.name);
  for (const v of [m.logo]) {
    assert.ok(!v.startsWith("/") && !v.includes(".."), "paths must be relative, no ..");
    assert.ok(existsSync(p(v)), `${v} must exist`);
  }
});

test("glama.json lists the maintainer", () => {
  const g = json("glama.json");
  assert.ok(Array.isArray(g.maintainers) && g.maintainers.length > 0);
  assert.equal(new Set(g.maintainers).size, g.maintainers.length);
  assert.ok(g.maintainers.includes("Goldentrii"));
});

test("smithery.yaml launches the published package and has no stale tool count", () => {
  const y = text("smithery.yaml");
  assert.ok(y.includes(`"${mcp.name}@latest"`), "must launch the npm package name");
  assert.doesNotMatch(y, /\b18 MCP tools\b/);
  assert.ok(y.includes(HOSTED));
});

test("llms-install.md names the package and the hosted URL", () => {
  const t = text("llms-install.md");
  assert.ok(t.includes(`npx`) && t.includes(`"${mcp.name}"`));
  assert.ok(t.includes(HOSTED));
});

test("docker entry: remote, empty tools.json, name matches", () => {
  const y = text("docs/listings/docker/server.yaml");
  assert.match(y, /^type: remote$/m);
  assert.match(y, /^name: agent-recall$/m);
  assert.deepEqual(json("docs/listings/docker/tools.json"), []);
});

test("icons are PNGs of the exact sizes the directories ask for", () => {
  assert.deepEqual(pngSize(p("assets/brand/icon-400.png")), [400, 400]);
  assert.deepEqual(pngSize(p("assets/brand/icon-512.png")), [512, 512]);
});

test("listing text respects the directory limits", () => {
  assert.ok(fields.name.length <= 100);
  assert.ok(fields.oneLiner100.length <= 100, `${fields.oneLiner100.length}`);
  assert.ok(fields.oneLiner200.length <= 200, `${fields.oneLiner200.length}`);
  assert.ok(fields.description.length <= 2000, `${fields.description.length}`);
  assert.ok(fields.categories.length >= 1 && fields.categories.length <= 5);
  assert.ok(serverJson.description.length <= 100);
});

test("positioning: never plain memory storage; Intelligent Distance is named", () => {
  assert.match(fields.oneLiner200, /Intelligent Distance/);
  assert.match(fields.description, /Intelligent Distance/);
  assert.doesNotMatch(fields.oneLiner100 + fields.oneLiner200 + fields.description, /memory storage|persistent memory|memory palace/i);
});

test("docs/listings/*.md: no stale host, no other /mcp URL, no stale package version", () => {
  const files = walk(p("docs/listings")).filter((f) => f.endsWith(".md") || f.endsWith(".yaml"));
  assert.ok(files.length > 0);
  for (const f of files) {
    const t = readFileSync(f, "utf8");
    // Lines that talk about the old address on purpose carry the marker OLD-HOST.
    for (const line of t.split("\n")) {
      if (/OLD-HOST/.test(line)) continue;
      assert.doesNotMatch(line, /recall\.aiakada\.com/, `${f}: ${line}`);
    }
    for (const m of t.matchAll(/https:\/\/agentrecallx\.com\/mcp\S*/g)) {
      assert.equal(m[0].replace(/[)`'".,;]+$/, ""), HOSTED, `${f}: ${m[0]}`);
    }
    for (const m of t.matchAll(/agent-recall-mcp@(\d+\.\d+\.\d+)/g)) {
      assert.equal(m[1], mcp.version, `${f}: pinned version ${m[1]}`);
    }
  }
});

test("every submission file that quotes a field quotes it verbatim", () => {
  const dir = p("docs/listings/submissions");
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  assert.ok(files.length >= 5, "expected the submission files");
  for (const f of files) {
    const t = readFileSync(join(dir, f), "utf8");
    for (const key of ["oneLiner100", "oneLiner200"]) {
      // a file may omit a field; if it includes the first 30 chars it must include all of it
      if (t.includes(fields[key].slice(0, 30))) {
        assert.ok(t.includes(fields[key]), `${f}: ${key} is not verbatim`);
      }
    }
  }
});

test("descriptions: server.json is the source; fields.json, plugin.json, docker, llms-install follow it", () => {
  assert.equal(fields.oneLiner100, serverJson.description);
  assert.ok(json(".cursor-plugin/plugin.json").description.startsWith(serverJson.description));
  assert.ok(text("docs/listings/docker/server.yaml").includes(serverJson.description.replace(/\.$/, "")));
  assert.match(text("llms-install.md"), /closes the Intelligent Distance[^\n]*reaches every connected agent/);
  // Old wording must not survive anywhere in the listing material.
  const files = [...walk(p("docs/listings")), p("llms-install.md"), p("smithery.yaml"), p(".cursor-plugin/plugin.json")];
  for (const f of files) {
    const t = readFileSync(f, "utf8");
    assert.doesNotMatch(t, /narrows the Intelligent Distance|remembered by every agent|Correction-first memory/i, f);
  }
});

test("package descriptions on main carry the positioning (the four npm packages)", () => {
  for (const pkg of ["core", "mcp-server", "sdk", "cli"]) {
    const d = json("packages", pkg, "package.json").description;
    assert.doesNotMatch(d, /memory palace/i, pkg);
  }
});

test("icons use the site gold #F5C451 at the centre", () => {
  // Decode with node:zlib: 8-bit RGB(A) non-interlaced PNG, filters undone for one scanline.
  for (const n of [400, 512]) {
    const b = readFileSync(p(`assets/brand/icon-${n}.png`));
    const w = b.readUInt32BE(16), colour = b[25], bpp = colour === 6 ? 4 : 3;
    assert.equal(b[24], 8);
    let off = 8, idat = [];
    while (off < b.length) {
      const len = b.readUInt32BE(off), type = b.subarray(off + 4, off + 8).toString("latin1");
      if (type === "IDAT") idat.push(b.subarray(off + 8, off + 8 + len));
      off += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(idat)), stride = 1 + w * bpp, h = w;
    const rows = [];
    for (let y = 0; y < h; y++) {
      const f = raw[y * stride], line = Buffer.from(raw.subarray(y * stride + 1, (y + 1) * stride)), prev = rows[y - 1] ?? Buffer.alloc(line.length);
      for (let i = 0; i < line.length; i++) {
        const a = i >= bpp ? line[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        const pr = f === 1 ? a : f === 2 ? up : f === 3 ? (a + up) >> 1 : f === 4 ? (() => { const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c); return pa <= pb && pa <= pc ? a : pb <= pc ? up : c; })() : 0;
        line[i] = (line[i] + pr) & 255;
      }
      rows.push(line);
    }
    const px = rows[h >> 1].subarray((w >> 1) * bpp, (w >> 1) * bpp + 3);
    assert.deepEqual([...px], [0xf5, 0xc4, 0x51], `icon-${n} centre`);
  }
});
