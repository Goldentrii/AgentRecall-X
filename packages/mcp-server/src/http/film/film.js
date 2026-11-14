(() => {
// Home page film: "Intelligent Distance" in five beats. Raw WebGL2, no libraries.
// Served inline (CSP hash) by film.ts; the five plates come from /film/*.jpg.
// Without this script the page is a plain stacked document (see film.css).
// The scroll position is the only clock: p in [0,1] drives the worlds, the jumps and the copy.
// Two worlds sit on either side of a gap. The human tree never changes. The machine
// structure is rebuilt by each correction, and the gap narrows but never closes.
const canvas = document.getElementById("stage");
const beats = [...document.querySelectorAll(".beat")];
const sessionEl = document.getElementById("session");
const distEl = document.getElementById("dist");
const hintEl = document.querySelector(".hint");
const track = document.getElementById("track");
const root = document.documentElement;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const MESH_U = 420, MESH_W = 64;   // 27k vertices: fine enough that the interpolated normal shows no facets across the band
const PLATES = ["human", "m0", "wrong", "m2", "m3"];
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
/** Half the gap between the two worlds, in screen heights. Mirrors sep() in the shader. */
const sepAt = (p) => 0.50 - 0.13 * smooth(0.33, 0.42, p) - 0.10 * smooth(0.58, 0.67, p) - 0.05 * smooth(0.80, 0.95, p);

const VERT = `#version 300 es
in vec2 a; out vec2 v;
void main(){ v = a * 0.5 + 0.5; gl_Position = vec4(a, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v; out vec4 o;
uniform sampler2D H, M0, MW, M2, M3;
uniform vec2 res, mouse;
uniform float p, time, calm;

float hash(vec2 x){ return fract(sin(dot(x, vec2(12.9898, 78.233))) * 43758.5453); }
float bump(float c, float w, float x){ return exp(-pow((x - c) / w, 2.0)); }
float sep(float q){
  return 0.50 - 0.13 * smoothstep(0.33, 0.42, q) - 0.10 * smoothstep(0.58, 0.67, q) - 0.05 * smoothstep(0.80, 0.95, q);
}
// a square plate centred at ctr with height s; edges fade so the square never shows
const vec3 GOLD = vec3(0.961, 0.769, 0.318);
// the human plate is graded toward gold; luminance is kept, so detail is not washed out
vec3 gold(vec3 c){ float l = dot(c, vec3(0.299, 0.587, 0.114)); return mix(c, GOLD * l * 1.55, 0.6); }
vec3 plate(sampler2D t, vec2 c, vec2 ctr, float s){
  vec2 q = (c - ctr) / s + 0.5;
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) return vec3(0.0);
  // round falloff: the plate's own dark background must never read as a square
  float e = smoothstep(0.50, 0.24, length((q - 0.5) * vec2(1.0, 0.92)));
  vec3 col = texture(t, q).rgb;
  return max(col - 0.05, 0.0) * 1.08 * e;
}
// the whole scene at centred coords c (x scaled by aspect, y in -0.5..0.5, up positive)
vec3 scene(vec2 c, float a){
  float fit = min(1.0, a / 1.75);                 // narrow screens: smaller plates, tighter gap
  float s = 0.80 * fit;
  float sp = sep(p) * fit;
  vec2 hc = vec2(-sp, 0.07) + mouse * vec2(-0.012, 0.008);
  vec2 mc = vec2( sp, 0.07) + mouse * vec2( 0.012, 0.008);
  vec3 col = gold(plate(H, c, hc, s));

  // machine: monolith -> wrong growth -> lattice -> tree. Each change is a rebuild, not a fade.
  float toWrong = smoothstep(0.14, 0.22, p);
  float toM2    = smoothstep(0.355, 0.40, p);
  float toM3    = smoothstep(0.605, 0.65, p);
  float tear = bump(0.18, 0.035, p) * 0.9 + bump(0.375, 0.02, p) + bump(0.625, 0.02, p);
  vec2 cm = c;
  cm.x += (hash(vec2(floor(c.y * 90.0), floor(time * 24.0))) - 0.5) * 0.06 * tear;
  vec3 m = plate(M0, cm, mc, s);
  m = mix(m, plate(MW, cm, mc, s), toWrong);
  m = mix(m, plate(M2, cm, mc, s), toM2);
  m = mix(m, plate(M3, cm, mc, s), toM3);
  col = max(col, m);

  // the correction: light leaves the human crown and lands on the machine
  vec2 pa = hc + vec2(0.02, 0.20) * s, pb = mc + vec2(-0.02, 0.20) * s;
  vec2 ab = pb - pa;
  float h = clamp(dot(c - pa, ab) / dot(ab, ab), 0.0, 1.0);
  float arc = sin(h * 3.14159) * 0.05 * fit;
  float d = length(c - (pa + ab * h + vec2(0.0, arc)));
  float grow = smoothstep(0.27, 0.36, p);                       // the first crossing draws itself
  float live = smoothstep(grow, grow - 0.06, h) * step(0.001, grow) * (bump(0.345, 0.05, p) + 0.22 * smoothstep(0.40, 0.48, p));
  float pulse = pow(0.5 + 0.5 * sin((h - time * 0.35) * 28.0), 6.0) * smoothstep(0.42, 0.50, p);
  vec3 beamCol = mix(GOLD, vec3(0.45, 0.95, 1.0), h);
  col += beamCol * live * (0.0022 / (d * d + 0.00002) * 0.012 + 0.012 / (d + 0.012));
  col += mix(beamCol, vec3(1.0), 0.6) * pulse * 0.010 / (d + 0.004) * 0.35;

  // the gap that stays: a hairline of light between the two worlds at the end
  float endAmt = smoothstep(0.84, 0.97, p);
  col += vec3(0.85, 0.95, 1.0) * endAmt * 0.0016 / (abs(c.x) + 0.0016) * smoothstep(0.34, 0.0, abs(c.y - 0.07));
  return col;
}

// ---- the galaxy behind the worlds ----
const vec3 CYAN = vec3(0.45, 0.95, 1.0);
float noise(vec2 x){
  vec2 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + 1.0), f.x), f.y);
}
float fbm(vec2 x){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++){ s += a * noise(x); x = x * 2.03 + 11.7; a *= 0.5; }
  return s;
}
// one depth layer of stars: nearer layers are larger, sparser, and fly outward faster as p grows
vec3 starLayer(vec2 c, float fi){
  vec2 q = c * (1.0 + p * (0.10 + 0.45 * fi)) + mouse * (0.01 + 0.03 * fi) + vec2(0.0, -0.02 * p * fi);
  float sc = 46.0 - 14.0 * fi;
  vec2 g = q * sc + fi * 17.3;
  vec2 id = floor(g);
  float h = hash(id);
  vec2 jit = (vec2(hash(id + 3.1), hash(id + 7.7)) - 0.5) * 0.6;
  float r = length(fract(g) - 0.5 - jit);
  float st = step(0.90 + 0.04 * fi, h) * smoothstep(0.30 + 0.06 * fi, 0.0, r);
  float tw = 0.7 + 0.3 * sin(time * (0.5 + h * 2.0) + h * 40.0);
  vec3 tint = mix(vec3(0.72, 0.88, 1.0), vec3(1.0, 0.86, 0.60), fract(h * 9.0));
  return tint * st * st * tw * (0.45 + 0.35 * fi);
}
// a bright technological star: crisp core and a small four-point flare
vec3 flare(vec2 c, vec2 at, float size, vec3 tint){
  vec2 d = c - at;
  float r = length(d);
  float cross = 0.0012 / (abs(d.x) + 0.0016) * smoothstep(size, 0.0, abs(d.y)) + 0.0012 / (abs(d.y) + 0.0016) * smoothstep(size, 0.0, abs(d.x));
  return tint * (0.0016 / (r * r + 0.00006) * 0.025 + cross * 0.55);
}
float link(vec2 c, vec2 a, vec2 b){
  vec2 ab = b - a;
  float h = clamp(dot(c - a, ab) / dot(ab, ab), 0.0, 1.0);
  return 0.00035 / (length(c - a - ab * h) + 0.0007);
}
vec3 galaxy(vec2 c, float fit){
  vec3 o = starLayer(c, 0.0) + starLayer(c, 1.0) + starLayer(c, 2.0);
  // the galactic band: dust with lanes, gold toward the human side, cyan toward the machine
  float th = 0.42 + 0.02 * sin(time * 0.05);
  vec2 bq = vec2(c.x * cos(th) + c.y * sin(th), c.y * cos(th) - c.x * sin(th));
  float lane = exp(-pow((bq.y - 0.04 + 0.05 * sin(bq.x * 2.3)) / 0.20, 2.0));
  float cloud = fbm(bq * 3.2 + vec2(0.0, p * 0.6) + mouse * 0.2);
  float dust = lane * smoothstep(0.30, 0.85, cloud) * (0.4 + 0.6 * fbm(bq * 7.0 - time * 0.01));
  o += mix(GOLD * 0.9, CYAN, smoothstep(-0.45, 0.45, c.x)) * dust * 0.65;
  vec2 pr = mouse * 0.02 + vec2(0.0, -0.03) * p;
  vec2 fx = vec2(fit, 1.0);                       // narrow screens: the network contracts toward the middle
  vec2 s0 = vec2(-0.62, 0.26) * fx + pr, s1 = vec2(-0.21, 0.29) * fx + pr * 1.4, s2 = vec2(0.26, 0.27) * fx + pr * 1.2, s3 = vec2(0.66, 0.20) * fx + pr, s4 = vec2(0.02, -0.10) * fx + pr * 0.6;
  o += flare(c, s0, 0.07, vec3(1.0, 0.88, 0.62)) + flare(c, s1, 0.05, vec3(1.0)) + flare(c, s2, 0.09, vec3(0.7, 0.95, 1.0))
     + flare(c, s3, 0.06, vec3(0.7, 0.95, 1.0)) + flare(c, s4, 0.04, vec3(1.0, 0.9, 0.75));
  o += vec3(0.8, 0.9, 1.0) * (link(c, s0, s1) + link(c, s1, s2) + link(c, s2, s3)) * 0.5;
  return o;
}

void main(){
  float a = res.x / res.y;
  vec2 c = vec2((v.x - 0.5) * a, v.y - 0.5);
  float j1 = bump(0.375, 0.030, p), j2 = bump(0.625, 0.030, p);
  float rush = clamp(j1 + j2, 0.0, 1.0) * (1.0 - calm);   // calm = prefers-reduced-motion

  // the jump: the camera is thrown at the gap, the frame smears, the world lands rebuilt
  float push = 1.0 + 0.05 * p + rush * 0.9;
  vec2 cz = c / push;
  vec3 col = vec3(0.0);
  int n = rush > 0.01 ? 14 : 1;
  float w = 0.0;
  for (int i = 0; i < 14; i++){
    if (i >= n) break;
    float f = float(i) / 13.0;
    float wt = 1.0 - f * 0.7;
    col += scene(cz * (1.0 - rush * 0.55 * f), a) * wt; w += wt;
  }
  col /= w;

  float r = length(c);
  float ang = atan(c.y, c.x);
  float rays = pow(abs(sin(ang * 36.0 + hash(vec2(floor(ang * 36.0), 3.0)) * 6.28 + time * 1.5)), 16.0);
  vec3 warm = vec3(1.0, 0.82, 0.62), cold = vec3(0.62, 0.92, 1.0);
  col += mix(warm, cold, smoothstep(-0.3, 0.3, c.x)) * rays * rush * rush * smoothstep(0.08, 0.8, r) * 0.55;
  col = mix(col, vec3(1.0, 0.98, 0.95), 0.7 * pow(rush, 5.0) * (1.0 - 0.55 * smoothstep(0.0, 0.9, r)));

  // behind the worlds: the strip (already drawn) and the galaxy show only where the plates and the beam are dark
  float open = 1.0 - clamp(dot(col, vec3(0.33)) * 4.0, 0.0, 1.0);
  // nothing bright behind the header or the caption block
  vec3 b = galaxy(cz, min(1.0, a / 1.75)) * smoothstep(0.40, 0.28, c.y) * smoothstep(-0.15, 0.0, c.y);
  col += b * open;

  // air: drifting motes, a cool floor of mist, vignette, grain
  vec2 g = c * 34.0 + vec2(time * 0.05, time * 0.11);
  float mote = step(0.992, hash(floor(g))) * smoothstep(0.35, 0.0, length(fract(g) - 0.5));
  col += vec3(0.7, 0.8, 0.9) * mote * 0.35;
  col += vec3(0.02, 0.05, 0.07) * smoothstep(0.0, -0.5, c.y);
  col *= 1.0 - 0.5 * smoothstep(0.45, 1.05, r);
  col += (hash(v * res + time * 60.0) - 0.5) * 0.03;
  col *= 1.0 - 0.55 * smoothstep(-0.12, -0.5, c.y) * (1.0 - pow(rush, 5.0));   // scrim under the copy
  o = vec4(pow(max(col, 0.0), vec3(0.94)), open);   // blended over the strip: dst * open + this
}`;

const MESH_VERT = `#version 300 es
// The Mobius strip as a triangle mesh in screen-height units (y up, x scaled by aspect).
in vec2 uv;                       // u: around the loop 0..2pi, w: across the band -1..1
uniform vec2 res, mouse;
uniform float p, time, spread;
out vec3 pos; out vec3 nrm; out vec2 st; out float presence; out float grade; out float screenY;
const float TILT = 0.62, DEPTH = 1.7, TWISTS = 0.5;
float sep(float q){
  return 0.50 - 0.13 * smoothstep(0.33, 0.42, q) - 0.10 * smoothstep(0.58, 0.67, q) - 0.05 * smoothstep(0.80, 0.95, q);
}
float bump(float c, float w, float x){ return exp(-pow((x - c) / w, 2.0)); }
vec3 strip(float u, float w, vec2 axes, float halfWidth, float sway){
  vec2 rim = vec2(cos(u), sin(u));
  vec2 outward = normalize(vec2(rim.x / axes.x, rim.y / axes.y));
  float t = u * TWISTS;
  vec3 q = vec3(rim * axes, 0.0) + w * halfWidth * vec3(outward * cos(t), sin(t));
  float cs = cos(TILT), sn = sin(TILT);
  q = vec3(q.x, q.y * cs - q.z * sn, q.y * sn + q.z * cs);              // lean the loop back: the top comes toward us
  float cy = cos(sway), sy = sin(sway);
  return vec3(q.x * cy + q.z * sy, q.y, q.z * cy - q.x * sy);           // slow turn about the vertical axis
}
void main(){
  float a = res.x / res.y;
  float fit = min(1.0, a / 1.75);
  float size = fit * (1.0 + 0.5 * (1.0 - fit));                          // narrow screens: a tighter gap, but not a tiny loop
  vec2 axes = vec2(sep(p) * fit + 0.09 * size, 0.26 * size);            // the loop's ends sit behind the two plates
  float halfWidth = 0.16 * size * spread;
  float sway = 0.30 * sin(time * 0.17) + mouse.x * 0.25;
  float e = 0.004;
  vec3 q = strip(uv.x, uv.y, axes, halfWidth, sway);
  nrm = normalize(cross(strip(uv.x + e, uv.y, axes, halfWidth, sway) - strip(uv.x - e, uv.y, axes, halfWidth, sway),
                        strip(uv.x, uv.y + e, axes, halfWidth, sway) - strip(uv.x, uv.y - e, axes, halfWidth, sway)));
  pos = q; st = uv;
  float rush = clamp(bump(0.375, 0.030, p) + bump(0.625, 0.030, p), 0.0, 1.0);
  float beam = 0.85 * (smoothstep(0.22, 0.30, p) - smoothstep(0.50, 0.58, p));   // the strip yields to the correction beam
  float hairline = 0.35 * smoothstep(0.84, 0.97, p);                    // and to the hairline at the end
  presence = (1.0 - rush) * (1.0 - beam) * (1.0 - hairline);
  float push = 1.0 + 0.05 * p + rush * 0.9;
  vec2 c = (q.xy * DEPTH / (DEPTH - q.z) + vec2(0.0, 0.10) + mouse * vec2(0.01, 0.006)) * push;
  screenY = c.y;
  grade = 1.0 - 0.5 * smoothstep(0.45, 1.05, length(c));                // the same vignette as the film grade
  gl_Position = vec4(c.x * 2.0 / a, c.y * 2.0, 0.0, 1.0);
}`;

const MESH_FRAG = `#version 300 es
precision highp float;
in vec3 pos; in vec3 nrm; in vec2 st; in float presence; in float grade; in float screenY;
uniform float time, spread;
out vec4 o;
const vec3 GOLD = vec3(0.961, 0.769, 0.318), CYAN = vec3(0.45, 0.95, 1.0);
float threadAt(float f, float fw){
  float dist = abs(f - floor(f + 0.5));                          // distance to the nearest thread centre
  float hw = 0.17;
  float line = 1.0 - smoothstep(hw - 0.75 * fw, hw + 0.75 * fw, dist);
  return mix(line, 2.0 * hw, smoothstep(0.30, 0.60, fw));        // sub-pixel threads fade to their mean: no moire
}
void main(){
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 N = normalize(nrm);
  if (dot(N, V) < 0.0) N = -N;                                   // light both faces of the one surface
  vec3 L = normalize(vec3(-0.55, 0.65, 0.55));
  float lit = max(dot(N, L), 0.0);
  float spec = pow(max(dot(N, normalize(L + V)), 0.0), 32.0);
  float rim = pow(1.0 - abs(dot(N, V)), 3.0);
  float across = abs(st.y);
  vec3 tone = mix(GOLD, CYAN * 1.35, smoothstep(-0.30, 0.30, pos.x));   // cyan carries gold's weight
  float depth = mix(0.28, 1.0, smoothstep(-0.2, 0.2, pos.z));    // the far half sits behind and dimmer
  vec3 col;
  if (spread > 1.0) {
    col = tone * 0.035 * (1.0 - across) * (0.4 + lit);            // a soft halo around the strip
  } else {
    // Seam-consistent by construction: one trip round maps w to -w, so every pattern is even in w
    // (the wave bends the thread spacing through w * g(u), g 2pi-periodic) and the pulses depend on u alone at integer frequency.
    float flow = st.y * (9.0 + 1.0 * sin(st.x * 3.0 + time * 0.4));   // one shared thread function of w, same on both halves
    float fw = fwidth(flow);                                       // thread spacing in pixels, from the local footprint
    // Integer octaves of the same thread (9, 18, 36, 72 per half-turn): pick the octave whose threads are ~3.5 px apart
    // and cross-fade to the next, so a wide near face and a narrow far face show the same fine thread, never broad stripes.
    float lvl = clamp(log2(0.28 / max(fw, 1e-4)), 0.0, 3.0);
    float l0 = floor(lvl);
    float thread = mix(threadAt(flow * exp2(l0), fw * exp2(l0)), threadAt(flow * exp2(l0 + 1.0), fw * exp2(l0 + 1.0)), smoothstep(0.0, 1.0, lvl - l0));
    float pulse = pow(0.5 + 0.5 * sin(st.x * 4.0 - time * 0.9), 3.0);   // broad soft pulses riding the threads
    float edge = smoothstep(0.80, 1.0, across);
    col = tone * (0.03 + 1.25 * lit * lit) * (0.40 + 0.60 * thread) * (0.8 + 0.5 * pulse)
        + tone * pulse * thread * 0.35
        + mix(tone, vec3(1.0), 0.65) * spec * (0.9 + 1.6 * edge)
        + tone * rim * (0.5 + 1.4 * edge)
        + mix(tone, vec3(1.0), 0.5) * edge * 0.18 * (0.4 + lit);
  }
  float keep = smoothstep(0.34, 0.24, screenY) * smoothstep(-0.15, 0.0, screenY);   // clear of the header and the caption scrim, judged on screen
  float cov = clamp((1.0 - across) / max(1.5 * fwidth(across), 1e-4), 0.0, 1.0);   // silhouette falloff over ~1.5 px
  o = vec4(col * depth * keep * presence * grade * 1.25 * cov, 1.0);
}`;

function loadImage(src) {
  return new Promise((ok, err) => { const i = new Image(); i.onload = () => ok(i); i.onerror = err; i.src = src; });
}

function updateCopy(p) {
  for (const b of beats) {
    const on = p >= +b.dataset.from && p < +b.dataset.to;
    b.classList.toggle("on", on);
    // An off-screen caption is still read by a screen reader, but its links must not take focus unseen.
    for (const a of b.querySelectorAll("a")) a.tabIndex = on ? 0 : -1;
  }
  // Matches the captions: session 2 until that beat ends, 50 by the time "Session 50" appears.
  const session = p < 0.36 ? 1 : p < 0.58 ? 2 : Math.round(2 + 48 * smooth(0.58, 0.66, p));
  sessionEl.textContent = "SESSION " + String(session).padStart(2, "0");
  distEl.textContent = "DISTANCE " + (sepAt(p) / sepAt(0)).toFixed(2);
  hintEl.classList.toggle("off", p >= 0.02);
}

async function start() {
  root.classList.add("film");
  let target = 0;
  const readScroll = () => {
    const max = track.offsetHeight - innerHeight;
    target = max > 0 ? clamp01(scrollY / max) : 0;
  };
  let running = false;
  addEventListener("scroll", () => { readScroll(); if (!running) updateCopy(target); }, { passive: true });
  readScroll();
  updateCopy(target);          // the first beat must be readable before the first frame

  const gl = canvas.getContext("webgl2", { antialias: true });
  if (!gl) {
    // No WebGL: the copy still tells the story over the CSS background.
    root.classList.add("nogl");
    addEventListener("scroll", () => updateCopy(target), { passive: true });
    updateCopy(target);
    return;
  }
  const sh = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const link = (vert, frag) => {
    const program = gl.createProgram();
    gl.attachShader(program, sh(gl.VERTEX_SHADER, vert));
    gl.attachShader(program, sh(gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    return program;
  };
  const prog = link(VERT, FRAG);
  const meshProg = link(MESH_VERT, MESH_FRAG);
  const u = (n) => gl.getUniformLocation(prog, n);
  const um = (n) => gl.getUniformLocation(meshProg, n);
  gl.useProgram(prog);                       // the plate samplers below belong to the main program

  const quadVao = gl.createVertexArray();
  gl.bindVertexArray(quadVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(gl.getAttribLocation(prog, "a"));
  gl.vertexAttribPointer(gl.getAttribLocation(prog, "a"), 2, gl.FLOAT, false, 0, 0);

  // The Mobius strip: a (u, w) grid, u around the loop, w across the band.
  const meshVao = gl.createVertexArray();
  gl.bindVertexArray(meshVao);
  const grid = [], tris = [];
  for (let i = 0; i <= MESH_U; i++) for (let j = 0; j <= MESH_W; j++) grid.push((i / MESH_U) * 2 * Math.PI, (j / MESH_W) * 2 - 1);
  for (let i = 0; i < MESH_U; i++) for (let j = 0; j < MESH_W; j++) {
    const k = i * (MESH_W + 1) + j, m = k + MESH_W + 1;
    tris.push(k, m, k + 1, k + 1, m, m + 1);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(grid), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(gl.getAttribLocation(meshProg, "uv"));
  gl.vertexAttribPointer(gl.getAttribLocation(meshProg, "uv"), 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(tris), gl.STATIC_DRAW);

  const images = await Promise.all(PLATES.map((n) => loadImage("/film/" + n + ".jpg")));
  ["H", "M0", "MW", "M2", "M3"].forEach((name, unit) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, images[unit]);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(u(name), unit);
  });

  gl.clearColor(0, 0, 0, 1);
  readScroll();
  let p = target, mx = 0, my = 0, tmx = 0, tmy = 0, dirty = true, snapped = false;
  // The browser may restore the scroll position after this point: jump there once, do not play through.
  addEventListener("scroll", () => { if (!snapped && performance.now() < 1500) p = target; snapped = true; }, { passive: true, once: true });
  addEventListener("pointermove", (e) => { tmx = e.clientX / innerWidth - 0.5; tmy = 0.5 - e.clientY / innerHeight; }, { passive: true });
  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, innerWidth < 700 ? 1 : 1.5);
    canvas.width = Math.round(innerWidth * dpr); canvas.height = Math.round(innerHeight * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
    readScroll();
    dirty = true;
  };
  addEventListener("resize", resize);
  resize();

  const frame = (t) => {
    const np = reduced ? target : p + (target - p) * 0.08;     // eased: the film has weight
    const nmx = mx + (tmx - mx) * 0.05, nmy = my + (tmy - my) * 0.05;
    const moved = Math.abs(np - p) > 0.00005 || Math.abs(nmx - mx) > 0.0002 || Math.abs(nmy - my) > 0.0002;
    p = np; mx = nmx; my = nmy;
    // Motes, pulses and grain move on their own, so keep drawing while the page is visible.
    const covered = scrollY > track.offsetHeight;          // the page below the film has scrolled over it
    const clock = reduced ? 0 : t / 1000;
    if ((moved || dirty || !reduced) && !document.hidden && !covered) {
      // the strip goes down first, on black; the film frame is then laid over it and lets it through only where it is dark
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(meshProg);
      gl.bindVertexArray(meshVao);
      gl.uniform2f(um("res"), canvas.width, canvas.height);
      gl.uniform2f(um("mouse"), mx, my);
      gl.uniform1f(um("p"), p);
      gl.uniform1f(um("time"), clock);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE_MINUS_DST_COLOR, gl.ONE);
      for (const spread of [2.6, 1]) {
        gl.uniform1f(um("spread"), spread);
        gl.drawElements(gl.TRIANGLES, MESH_U * MESH_W * 6, gl.UNSIGNED_SHORT, 0);
      }
      gl.blendFuncSeparate(gl.ONE, gl.SRC_ALPHA, gl.ZERO, gl.ONE);
      gl.useProgram(prog);
      gl.bindVertexArray(quadVao);
      gl.uniform2f(u("res"), canvas.width, canvas.height);
      gl.uniform2f(u("mouse"), mx, my);
      gl.uniform1f(u("p"), p);
      gl.uniform1f(u("calm"), reduced ? 1 : 0);
      gl.uniform1f(u("time"), clock);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.disable(gl.BLEND);
      updateCopy(p);
      dirty = false;
    }
    requestAnimationFrame(frame);
  };
  canvas.addEventListener("webglcontextlost", () => root.classList.add("nogl"));
  running = true;
  requestAnimationFrame(frame);
}

// Any failure (shader, image, lost context) falls back to the gradient; the captions still follow the scroll.
start().catch(() => {
  root.classList.add("nogl");
  const follow = () => {
    const max = track.offsetHeight - innerHeight;
    updateCopy(max > 0 ? clamp01(scrollY / max) : 0);
  };
  addEventListener("scroll", follow, { passive: true });
  follow();
});
})();
