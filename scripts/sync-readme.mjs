#!/usr/bin/env node
// Copies README.md into every published package (npm run sync-readme).
//
// npm resolves relative links against packages/<name>/ (the `directory` in each
// package.json's repository field), so relative paths in the root README break
// on npmjs.com. The copies get absolute URLs instead: images point at
// raw.githubusercontent.com, everything else at github.com/.../blob/main.
// In-page anchors (#...) and absolute URLs are left alone.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "Goldentrii/AgentRecall-X";
const BRANCH = "main";
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;
const BLOB = `https://github.com/${REPO}/blob/${BRANCH}/`;
const PACKAGES = ["core", "mcp-server", "sdk", "cli"];

const isRelative = (url) => url !== "" && !/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(url);
const isImage = (url) => /\.(?:svg|png|jpe?g|gif|webp)(?:[?#].*)?$/i.test(url);
const absolute = (url) => (isImage(url) ? RAW : BLOB) + url.replace(/^\.\//, "");

export function absolutize(md) {
  return md
    // HTML attributes: src="…", srcset="…", href="…"
    .replace(/\b(src|srcset|href)="([^"]*)"/g, (m, attr, url) => (isRelative(url) ? `${attr}="${absolute(url)}"` : m))
    // Markdown links and images: [text](url) / ![alt](url)
    .replace(/(\]\()([^)\s]+)(\))/g, (m, open, url, close) => (isRelative(url) ? `${open}${absolute(url)}${close}` : m));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const md = absolutize(fs.readFileSync(path.join(root, "README.md"), "utf8"));
  for (const p of PACKAGES) {
    fs.writeFileSync(path.join(root, "packages", p, "README.md"), md);
    console.log(`packages/${p}/README.md`);
  }
}
