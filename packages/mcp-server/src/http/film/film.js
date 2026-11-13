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
  vec3 col = plate(H, c, hc, s);

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
  vec3 beamCol = mix(vec3(1.0, 0.62, 0.25), vec3(0.45, 0.95, 1.0), h);
  col += beamCol * live * (0.0022 / (d * d + 0.00002) * 0.012 + 0.012 / (d + 0.012));
  col += mix(beamCol, vec3(1.0), 0.6) * pulse * 0.010 / (d + 0.004) * 0.35;

  // the gap that stays: a hairline of light between the two worlds at the end
  float endAmt = smoothstep(0.84, 0.97, p);
  col += vec3(0.85, 0.95, 1.0) * endAmt * 0.0016 / (abs(c.x) + 0.0016) * smoothstep(0.34, 0.0, abs(c.y - 0.07));
  return col;
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

  // air: drifting motes, a cool floor of mist, vignette, grain
  vec2 g = c * 34.0 + vec2(time * 0.05, time * 0.11);
  float mote = step(0.992, hash(floor(g))) * smoothstep(0.35, 0.0, length(fract(g) - 0.5));
  col += vec3(0.7, 0.8, 0.9) * mote * 0.35;
  col += vec3(0.02, 0.05, 0.07) * smoothstep(0.0, -0.5, c.y);
  col *= 1.0 - 0.5 * smoothstep(0.45, 1.05, r);
  col += (hash(v * res + time * 60.0) - 0.5) * 0.03;
  col *= 1.0 - 0.55 * smoothstep(-0.12, -0.5, c.y) * (1.0 - pow(rush, 5.0));   // scrim under the copy
  o = vec4(pow(max(col, 0.0), vec3(0.94)), 1.0);
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

  const gl = canvas.getContext("webgl2", { antialias: false });
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
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "a");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u = (n) => gl.getUniformLocation(prog, n);

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
    if ((moved || dirty || !reduced) && !document.hidden && !covered) {
      gl.uniform2f(u("res"), canvas.width, canvas.height);
      gl.uniform2f(u("mouse"), mx, my);
      gl.uniform1f(u("p"), p);
      gl.uniform1f(u("calm"), reduced ? 1 : 0);
      gl.uniform1f(u("time"), reduced ? 0 : t / 1000);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
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
