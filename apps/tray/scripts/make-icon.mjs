// Generates src-tauri/icons/source.png: a gold ring with a small gap (the brand mark). Pure Node, no deps.
// Usage: node scripts/make-icon.mjs && npx tauri icon src-tauri/icons/source.png
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const N = 512, C = N / 2, R_OUT = 226, R_IN = 150;
const GOLD = [0xf5, 0xc4, 0x51];
const GAP_CENTER = -Math.PI / 4, GAP_HALF = 0.2; // radians, upper right

function cover(x, y) {
  const dx = x - C, dy = y - C, r = Math.hypot(dx, dy);
  if (r > R_OUT || r < R_IN) return 0;
  let a = Math.atan2(dy, dx) - GAP_CENTER;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return Math.abs(a) < GAP_HALF ? 0 : 1;
}

const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    let s = 0;
    for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) s += cover(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3);
    const o = y * (N * 4 + 1) + 1 + x * 4;
    raw[o] = GOLD[0]; raw[o + 1] = GOLD[1]; raw[o + 2] = GOLD[2];
    raw[o + 3] = Math.round((s / 9) * 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
mkdirSync("src-tauri/icons", { recursive: true });
writeFileSync("src-tauri/icons/source.png", png);
console.log("wrote src-tauri/icons/source.png");
