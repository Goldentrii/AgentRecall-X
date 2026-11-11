// Generates the README artwork in assets/readme/ (light + dark variants).
//
//   cd assets/readme/build && npm install && npm run build
//
// Every glyph is converted to an outline path, so GitHub and npm render the
// same type on every OS (an SVG loaded through <img> cannot fetch web fonts).
// Fonts: Bricolage Grotesque + Courier Prime, both SIL Open Font License.
//
// Design tokens: a library catalog card. Navy ink, card paper, blue ruled
// lines, one red header rule, and a highlighter yellow reserved for "what
// matters now" (the hosted door, the HARD RULE every agent sees).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "..");
const fontDir = (pkg) => path.join(here, "node_modules", "@fontsource", pkg, "files");
const load = (pkg, file) => {
  const buf = fs.readFileSync(path.join(fontDir(pkg), file));
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  // opentype.js 2.0 can't run some GSUB lookups in these fonts (ccmp, type 6
  // format 2). Plain Latin text needs no substitution; GPOS kerning stays on.
  delete font.tables.gsub;
  return font;
};

const F = {
  display: load("bricolage-grotesque", "bricolage-grotesque-latin-800-normal.woff"),
  bold: load("bricolage-grotesque", "bricolage-grotesque-latin-700-normal.woff"),
  semi: load("bricolage-grotesque", "bricolage-grotesque-latin-600-normal.woff"),
  medium: load("bricolage-grotesque", "bricolage-grotesque-latin-500-normal.woff"),
  type: load("courier-prime", "courier-prime-latin-400-normal.woff"),
  typeBold: load("courier-prime", "courier-prime-latin-700-normal.woff"),
};

const PALETTE = {
  light: {
    ink: "#18233F", muted: "#566482", paper: "#FFFFFF", paperBack: "#F2F5FA", paperBack2: "#E7ECF4",
    stroke: "#18233F", rule: "#C9D8EE", red: "#DD3B45", hi: "#FFE45C", hiInk: "#18233F",
    wire: "#8C9AB5", pill: "#18233F", pillInk: "#FFFFFF", dash: "#8C9AB5",
  },
  dark: {
    ink: "#E8EEF8", muted: "#9AABC9", paper: "#141B27", paperBack: "#1A2232", paperBack2: "#20293B",
    stroke: "#B7C5DE", rule: "#26344C", red: "#FF6B6E", hi: "#F2D243", hiInk: "#141B27",
    wire: "#5E6F8F", pill: "#E8EEF8", pillInk: "#0D1117", dash: "#5E6F8F",
  },
};

// ── type helpers ──────────────────────────────────────────────────────────
// Glyphs are laid out by hand (opentype.js 2.0 emits NaN for some runs that
// contain a space) and each distinct glyph is defined once in <defs>, then
// placed with <use>, which keeps the files small.
const fontName = new Map(Object.entries(F).map(([k, f]) => [f, k]));
let defs = new Map(); // key -> { id, d }
const resetDefs = () => { defs = new Map(); };

function layout(font, str, size, tracking = 0) {
  const scale = size / font.unitsPerEm;
  const glyphs = [];
  let x = 0, prev = null;
  for (const ch of str) {
    const g = font.charToGlyph(ch);
    if (prev) {
      const k = font.getKerningValue(prev, g);
      if (Number.isFinite(k)) x += k * scale;
    }
    glyphs.push({ g, x });
    x += g.advanceWidth * scale + tracking * size;
    prev = g;
  }
  return { glyphs, width: x - tracking * size };
}

const width = (font, str, size, tracking = 0) => layout(font, str, size, tracking).width;

// Compact relative path data. Absolute points are rounded first (one decimal
// at 100 px, so at most ±0.05 px), then differenced, so rounding never drifts.
const R = (v) => Math.round(v * 10);           // tenths, as integers
const num = (t) => {                           // tenths → shortest decimal string
  const v = t / 10;
  return (Object.is(v, -0) ? 0 : v).toString().replace(/^(-?)0\./, "$1.");
};
function compactPath(commands) {
  let out = "", x = 0, y = 0, sx = 0, sy = 0;
  const emit = (cmd, ...vals) => {
    out += cmd;
    vals.forEach((v, i) => { const t = num(v); out += i > 0 && !t.startsWith("-") ? " " + t : t; });
  };
  for (const c of commands) {
    const X = c.x === undefined ? 0 : R(c.x), Y = c.y === undefined ? 0 : R(c.y);
    if (c.type === "M") { emit("m", X - x, Y - y); x = sx = X; y = sy = Y; }
    else if (c.type === "L") {
      if (Y === y) emit("h", X - x); else if (X === x) emit("v", Y - y); else emit("l", X - x, Y - y);
      x = X; y = Y;
    } else if (c.type === "Q") { emit("q", R(c.x1) - x, R(c.y1) - y, X - x, Y - y); x = X; y = Y; }
    else if (c.type === "C") { emit("c", R(c.x1) - x, R(c.y1) - y, R(c.x2) - x, R(c.y2) - y, X - x, Y - y); x = X; y = Y; }
    else if (c.type === "Z") { out += "z"; x = sx; y = sy; }
  }
  return out;
}

function glyphId(font, g) {
  const key = `${fontName.get(font)}:${g.index}`;
  if (!defs.has(key)) {
    const d = compactPath(g.getPath(0, 0, 100).commands);
    if (d.includes("NaN")) throw new Error(`NaN outline for glyph ${g.name} in ${key}`);
    defs.set(key, { id: `g${defs.size}`, d });
  }
  return defs.get(key);
}

function text(font, str, size, x, y, fill, { anchor = "start", tracking = 0 } = {}) {
  const { glyphs, width: w } = layout(font, str, size, tracking);
  let x0 = x;
  if (anchor === "middle") x0 = x - w / 2;
  if (anchor === "end") x0 = x - w;
  const s = size / 100;
  let out = `<g fill="${fill}" transform="translate(${+x0.toFixed(2)} ${+y.toFixed(2)}) scale(${+s.toFixed(4)})">`;
  for (const { g, x: gx } of glyphs) {
    if (!g.path || !g.path.commands || g.path.commands.length === 0) continue; // space
    const { id, d } = glyphId(font, g);
    if (!d) continue;
    const ux = +(gx / s).toFixed(1);
    out += ux ? `<use href="#${id}" x="${ux}"/>` : `<use href="#${id}"/>`;
  }
  return out + "</g>";
}

function svg({ w, h, title, desc, body }) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const glyphDefs = [...defs.values()].map(({ id, d }) => `<path id="${id}" d="${d}"/>`).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="title desc">
<title id="title">${esc(title)}</title>
<desc id="desc">${esc(desc)}</desc>
<defs>
${glyphDefs}
</defs>
${body}
</svg>
`;
}

// A catalog card: paper, stroke, optional red header rule and blue ruled lines.
function card(p, { x, y, w, h, fill = p.paper, rot = 0, redAt = null, lines = [], r = 6, strokeW = 1.6 }) {
  const cx = x + w / 2, cy = y + h / 2;
  const t = rot ? ` transform="rotate(${rot} ${cx} ${cy})"` : "";
  let s = `<g${t}><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${p.stroke}" stroke-width="${strokeW}"/>`;
  for (const ly of lines) s += `<line x1="${x + 1}" x2="${x + w - 1}" y1="${ly}" y2="${ly}" stroke="${p.rule}" stroke-width="1.2"/>`;
  if (redAt != null) s += `<line x1="${x + 1}" x2="${x + w - 1}" y1="${redAt}" y2="${redAt}" stroke="${p.red}" stroke-width="1.6"/>`;
  return s + "</g>";
}

// The mark: a catalog guide card (body + tab), red rule, one highlighted line.
function mark(p, x, y, s = 1) {
  const k = (v) => +(v * s).toFixed(2);
  return `<g transform="translate(${x} ${y})">
<path d="M${k(2)} ${k(10)} H${k(12)} V${k(4)} Q${k(12)} ${k(2)} ${k(14)} ${k(2)} H${k(26)} Q${k(28)} ${k(2)} ${k(28)} ${k(4)} V${k(10)} H${k(46)} Q${k(48)} ${k(10)} ${k(48)} ${k(12)} V${k(40)} Q${k(48)} ${k(42)} ${k(46)} ${k(42)} H${k(4)} Q${k(2)} ${k(42)} ${k(2)} ${k(40)} Z" fill="${p.paper}" stroke="${p.stroke}" stroke-width="${k(2)}" stroke-linejoin="round"/>
<line x1="${k(3)}" x2="${k(47)}" y1="${k(19)}" y2="${k(19)}" stroke="${p.red}" stroke-width="${k(2)}"/>
<rect x="${k(8)}" y="${k(25)}" width="${k(30)}" height="${k(6)}" rx="${k(1)}" fill="${p.hi}"/>
<line x1="${k(8)}" x2="${k(34)}" y1="${k(36)}" y2="${k(36)}" stroke="${p.rule}" stroke-width="${k(2)}" stroke-linecap="round"/>
</g>`;
}

// ── hero ──────────────────────────────────────────────────────────────────
function hero(p, { narrow = false } = {}) {
  const W = narrow ? 480 : 960, H = narrow ? 700 : 400;
  let b = "";
  // wordmark
  b += mark(p, 24, 22, 1);
  b += text(F.bold, "AgentRecall", 30, 84, 62, p.ink);
  // promise
  const hs = 52;
  b += text(F.display, "Teach one agent.", hs, 22, 168, p.ink, { tracking: -0.012 });
  b += text(F.display, "Every agent", hs, 22, 228, p.ink, { tracking: -0.012 });
  b += text(F.display, "remembers.", hs, 22, 288, p.ink, { tracking: -0.012 });
  b += text(F.type, "One memory for Claude Code, Codex,", 18, 24, 336, p.muted);
  b += text(F.type, "Cursor and any MCP client.", 18, 24, 362, p.muted);

  // agents → memory (narrow: the same diagram, moved under the headline)
  const head = b;
  b = "";
  const agents = ["Claude Code", "Codex", "Cursor", "claude.ai", "any MCP client"];
  const ax = 474, aw = 146, ah = 38, ay0 = 70, gap = 60;
  const stack = { x: 684, y: 64, w: 262, h: 282 };
  const join = { x: stack.x - 2, y: stack.y + stack.h / 2 };
  agents.forEach((name, i) => {
    const y = ay0 + i * gap;
    const generic = i === agents.length - 1;
    const sy = y + ah / 2;
    const tx = join.x, ty = join.y - 48 + i * 24;
    b += `<path d="M${ax + aw} ${sy} C ${ax + aw + 40} ${sy}, ${tx - 40} ${ty}, ${tx} ${ty}" fill="none" stroke="${p.wire}" stroke-width="1.6"/>`;
    b += `<circle cx="${ax + aw}" cy="${sy}" r="3.2" fill="${p.wire}"/>`;
    b += `<rect x="${ax}" y="${y}" width="${aw}" height="${ah}" rx="19" fill="${p.paper}" stroke="${generic ? p.dash : p.stroke}" stroke-width="1.6"${generic ? ' stroke-dasharray="4 4"' : ""}/>`;
    b += text(F.medium, name, 16, ax + aw / 2, y + 25, generic ? p.muted : p.ink, { anchor: "middle" });
  });

  // card stack: owner card, state card, hard rules on top
  b += card(p, { x: stack.x + 6, y: stack.y - 2, w: stack.w, h: stack.h, fill: p.paperBack2, rot: 3.2 });
  b += card(p, { x: stack.x + 2, y: stack.y, w: stack.w, h: stack.h, fill: p.paperBack, rot: -2.4 });
  const cx = stack.x, cy = stack.y, lh = 28;
  const top = cy + 44;
  const ruled = Array.from({ length: 8 }, (_, i) => top + lh * (i + 1));
  b += card(p, { x: cx, y: cy, w: stack.w, h: stack.h, redAt: top, lines: ruled });
  b += text(F.typeBold, "session_start", 16.5, cx + 18, cy + 30, p.ink);
  const tx = cx + 18, fs = 14.5;
  const row = (i) => top + lh * (i + 1) - 7;
  b += text(F.typeBold, "HARD RULES", fs, tx, row(0), p.red);
  b += `<rect x="${tx - 5}" y="${row(1) - 15}" width="${width(F.type, "ask before a version bump", fs) + 10}" height="21" rx="2" fill="${p.hi}"/>`;
  b += text(F.type, "ask before a version bump", fs, tx, row(1), p.hiInk);
  b += text(F.typeBold, "STATE", fs, tx, row(3), p.ink);
  b += text(F.type, "next: open the README PR", fs, tx, row(4), p.ink);
  b += text(F.typeBold, "OWNER", fs, tx, row(6), p.ink);
  b += text(F.type, "prefers short answers", fs, tx, row(7), p.ink);
  b = head + (narrow ? `<g transform="translate(-470 338)">${b}</g>` : b);

  return svg({
    w: W, h: H,
    title: "AgentRecall: teach one agent, every agent remembers",
    desc: "Claude Code, Codex, Cursor, claude.ai and any MCP client all connect to one AgentRecall memory. At session_start each agent receives the same cards: the HARD RULES (for example: ask before a version bump), the project state and the owner card.",
    body: b,
  });
}

// ── doors ─────────────────────────────────────────────────────────────────
function door(p, { tab, tabFill, title, lines, cta, alt }) {
  const W = 420, H = 272;
  let b = "";
  const tw = width(F.bold, tab, 19) + 36;
  // guide-card silhouette: tab + body in one path
  const x = 2, y = 2, bw = W - 4, top = 40, bh = H - 4;
  b += `<path d="M${x} ${top + 6} Q${x} ${top} ${x + 6} ${top} H${x + 14} V${y + 6} Q${x + 14} ${y} ${x + 20} ${y} H${x + 14 + tw - 6} Q${x + 14 + tw} ${y} ${x + 14 + tw} ${y + 6} V${top} H${x + bw - 6} Q${x + bw} ${top} ${x + bw} ${top + 6} V${y + bh - 6} Q${x + bw} ${y + bh} ${x + bw - 6} ${y + bh} H${x + 6} Q${x} ${y + bh} ${x} ${y + bh - 6} Z" fill="${p.paper}" stroke="${p.stroke}" stroke-width="1.8" stroke-linejoin="round"/>`;
  if (tabFill) b += `<path d="M${x + 15} ${top} V${y + 7} Q${x + 15} ${y + 1} ${x + 21} ${y + 1} H${x + 14 + tw - 7} Q${x + 13 + tw} ${y + 1} ${x + 13 + tw} ${y + 7} V${top} Z" fill="${tabFill}"/>`;
  b += text(F.bold, tab, 19, x + 14 + tw / 2, y + 27, tabFill ? p.hiInk : p.ink, { anchor: "middle" });
  b += text(F.bold, title, 27, 26, 88, p.ink, { tracking: -0.01 });
  const red = 106, lh = 32;
  for (let i = 1; i <= 4; i++) b += `<line x1="3" x2="${W - 3}" y1="${red + lh * i}" y2="${red + lh * i}" stroke="${p.rule}" stroke-width="1.2"/>`;
  b += `<line x1="3" x2="${W - 3}" y1="${red}" y2="${red}" stroke="${p.red}" stroke-width="1.6"/>`;
  lines.forEach((l, i) => { b += text(F.type, l, 17, 26, red + lh * (i + 1) - 9, p.ink); });
  const cw = width(F.semi, cta, 16) + 40;
  b += `<rect x="${W - 22 - cw}" y="${H - 58}" width="${cw}" height="36" rx="18" fill="${p.pill}"/>`;
  b += text(F.semi, cta, 16, W - 22 - cw / 2, H - 34.5, p.pillInk, { anchor: "middle" });
  return svg({ w: W, h: H, title: `${tab}: ${title}`, desc: alt, body: b });
}

const hosted = (p) => door(p, {
  tab: "Hosted", tabFill: p.hi, title: "recall.aiakada.com",
  lines: ["Sign in with GitHub", "One URL for any MCP agent", "Ready in about a minute"],
  cta: "Connect an agent",
  alt: "Hosted: sign in with GitHub at recall.aiakada.com. One URL works for any MCP agent and setup takes about a minute.",
});
const local = (p) => door(p, {
  tab: "Local", tabFill: null, title: "On your own machine",
  lines: ["Fully offline, plain markdown", "Hooks run the memory loop", "One npx command"],
  cta: "Install locally",
  alt: "Local: runs fully offline on your machine with plain markdown files. Hooks run the memory loop, installed with one npx command.",
});

// ── architecture ──────────────────────────────────────────────────────────
function architecture(p) {
  const W = 960, H = 470;
  let b = "";
  const box = (x, y, w, h, title, sub = [], { fill = p.paper, dashed = false, hi = false } = {}) => {
    let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${hi ? p.hi : fill}" stroke="${p.stroke}" stroke-width="1.6"${dashed ? ' stroke-dasharray="5 4"' : ""}/>`;
    s += text(F.semi, title, 17, x + 16, y + 27, hi ? p.hiInk : p.ink);
    sub.forEach((t, i) => { s += text(F.type, t, 13.5, x + 16, y + 49 + i * 19, hi ? p.hiInk : p.muted); });
    return s;
  };
  const arrow = (x1, y1, x2, y2) => {
    const a = Math.atan2(y2 - y1, x2 - x1), L = 8;
    const hx1 = x2 - L * Math.cos(a - 0.45), hy1 = y2 - L * Math.sin(a - 0.45);
    const hx2 = x2 - L * Math.cos(a + 0.45), hy2 = y2 - L * Math.sin(a + 0.45);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${p.wire}" stroke-width="1.6"/><path d="M${x2} ${y2} L${hx1.toFixed(1)} ${hy1.toFixed(1)} L${hx2.toFixed(1)} ${hy2.toFixed(1)} Z" fill="${p.wire}"/>`;
  };
  const lane = (x, w, label) => text(F.bold, label, 19, x, 30, p.ink) ;

  // lanes
  b += lane(20, 0, "Local");
  b += text(F.type, "stdio, one user, on your disk", 14, 88, 30, p.muted);
  b += lane(500, 0, "Hosted");
  b += text(F.type, "HTTPS, many users, one URL", 14, 578, 30, p.muted);

  // row 1: entry points
  b += box(20, 52, 186, 92, "ar CLI + hooks", ["packages/cli", "and the SDK"]);
  b += box(222, 52, 258, 92, "agent-recall-mcp", ["stdio entry point:", "mcp-server/src/index.ts"]);
  b += box(500, 52, 168, 92, "Caddy (TLS)", ["deploy/hosted/", "Compose kit"]);
  b += box(688, 52, 252, 92, "agent-recall-server", ["mcp-server/src/http/", "OAuth, tokens, limits"]);
  b += arrow(668, 98, 686, 98);

  // row 2: shared assembly
  b += box(250, 186, 690, 74, "build-server.ts: one MCP server, both modes", ["same tools in both; hosted builds one per request, inside the user's scope"], { hi: true });
  b += arrow(351, 144, 351, 184);
  b += arrow(814, 144, 814, 184);

  // row 3: core
  b += box(20, 300, 920, 74, "agent-recall-core", ["storage, retrieval, the math, tool logic: one engine under every surface"]);
  b += arrow(113, 144, 113, 298);
  b += arrow(595, 260, 595, 298);

  // row 4: storage
  b += box(20, 400, 460, 62, "~/.agent-recall/", ["plain markdown on your machine"], { dashed: true });
  b += box(500, 400, 440, 62, "DATA/tenants/<uid>/", ["one private folder per user, EU server"], { dashed: true });
  b += arrow(250, 374, 250, 398);
  b += arrow(720, 374, 720, 398);

  return svg({
    w: W, h: H,
    title: "AgentRecall architecture: local and hosted modes share one core",
    desc: "Local mode: the ar CLI with hooks, the SDK, and agent-recall-mcp over stdio write to ~/.agent-recall on your disk. Hosted mode: agents reach Caddy (deploy/hosted) over HTTPS, then agent-recall-server (packages/mcp-server/src/http) with OAuth, tokens and limits. Both MCP entry points build their server with build-server.ts, and everything runs on agent-recall-core. Hosted memory is stored in one folder per user under DATA/tenants.",
    body: b,
  });
}

const assets = { hero, "hero-narrow": (p) => hero(p, { narrow: true }), "door-hosted": hosted, "door-local": local, architecture };
for (const [name, fn] of Object.entries(assets)) {
  for (const mode of ["light", "dark"]) {
    const file = path.join(out, `${name}-${mode}.svg`);
    resetDefs();
    fs.writeFileSync(file, fn(PALETTE[mode]));
    console.log(`${path.relative(out, file)}  ${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
  }
}
