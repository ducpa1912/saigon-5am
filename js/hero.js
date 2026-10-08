/**
 * hero.js — "Saigon, 5am"
 *
 * A 30.000-second, perfectly seamless motion-graphics hero, drawn entirely
 * from code: no images, no textures, no video. Four interlocking layers —
 *
 *   1. a phin coffee drip, with its ripple on the surface of the glass
 *   2. rain on the window, refracting the city behind it
 *   3. scooter light trails smearing across the street
 *   4. the city waking: exposure lifts, lamps come on, traffic thickens
 *
 * ---------------------------------------------------------------------------
 * THE LOOP
 * ---------------------------------------------------------------------------
 * One normalised clock:  p = (elapsedMs % 30000) / 30000  ∈ [0, 1)
 * Every single visual term in this file is a *pure function of p*. Nothing
 * integrates, nothing accumulates, there is no Math.random() anywhere and no
 * counter that survives a frame. That is what makes the loop seamless: any
 * term whose argument is periodic in p is pixel-identical at p=0 and p=1.
 *
 *   · breath       lift = 0.5 - 0.5·cos(2πp)           (0 at p=0 and p=1)
 *   · droplets     y  = fract(phase + rate·p), rate ∈ {0,1,2,3} — an INTEGER
 *                  number of window-heights per loop, so fract() returns to
 *                  exactly where it started
 *   · trails       heads live on a P-periodic lattice (P = spacing) and advance
 *                  exactly P window-widths per loop, so the *set* of heads and
 *                  their smears is invariant; positions are resolved with a
 *                  wrapped distance of period P, which is exact because the
 *                  trail set really is P-periodic
 *   · the drip      is a slot function: slot = floor(p·N), and slot N-1 is
 *                  always fully dead before p wraps
 *   · grain         fract(997·p) — per-frame grain that still closes the loop
 *
 * ---------------------------------------------------------------------------
 * THE PASSES
 * ---------------------------------------------------------------------------
 *   A. city       full-screen procedural shader  ─┐  rtA
 *   B. foreground lathe geometry, no clear        ─┘  (the phin, on rtA)
 *   C. rain       instanced droplet quads, sampling rtA as their lens  → rtB
 *   D. grade      ACES-ish curve, vignette, warm split-tone, chroma, grain → canvas
 *
 * ---------------------------------------------------------------------------
 * DEGRADE
 * ---------------------------------------------------------------------------
 * prefers-reduced-motion → we never create a context and never start a loop;
 * the still poster (assets/hero-poster.jpg) is a plain CSS background, which
 * also covers no-JS, no-WebGL and a missing poster file. Cheap Android halves
 * the droplet count, drops the trail subdivisions, caps DPR and FPS.
 */

/**
 * three.js is loaded LAZILY, on demand, from inside the idle callback.
 *
 * It used to be a static import at module scope, which meant the 1.27MB module
 * (256KB gzipped) was parsed and evaluated the instant hero.js was imported —
 * 539ms of main thread on a 4x-throttled Moto G, all of it inside the TBT
 * window, for a scene that may never be looked at.
 *
 * Nothing at module scope touches THREE (verified: zero references outside
 * function bodies), so there is nothing to defer *except* the module itself.
 * `start()` now awaits this before building, and every consumer runs after.
 */
let THREE = null;
let threePromise = null;
function loadThree() {
  if (THREE) return Promise.resolve(THREE);
  if (!threePromise) {
    threePromise = import("../vendor/three.module.js").then((mod) => {
      THREE = mod;
      /* Promote the placeholder vectors now that THREE exists, so nothing
         downstream has to care whether a uniform was created before or after
         the library loaded. */
      U.RES.value = new THREE.Vector2(U.RES.value.x, U.RES.value.y);
      U.RIP.value = new THREE.Vector4(0, 0, 0, 0);
      return mod;
    });
  }
  return threePromise;
}
import { ENV } from "./main.js";

/* ========================================================================== */
/* constants                                                                  */
/* ========================================================================== */

const LOOP_MS = 30000;
const TAU = Math.PI * 2;

/* Composition, in uv space (v = 0 at the bottom of the frame). Layered like a
 * real frame of film shot from a table at a window:
 *
 *   0.00 … 0.185   wet road. Scooter trails cross here.
 *   0.185… 0.315   far pavement, shutter fronts, warm shop openings.
 *   0.315… ~0.62   two layers of shophouses rising off the pavement.
 *   ~0.62 … 1.00   sky, dark at the top, a narrow ember band at the roofline.
 *
 * The phin is a foreground object in the lower right, occluding the street. */
const Y_ROAD_TOP = 0.185; /* top of the wet asphalt */
const Y_SHOP_TOP = 0.315; /* far pavement / shopfront line; buildings sit here */

const QUALITY = {
  /* 120 beads, not 52. A pane of water is a TEXTURE: many small beads read as
     a wet surface where a few large ones read as dust on a lens — and the
     bright ones were also the sole cause of the desktop lede dipping below
     4.5:1. Density is cheaper here than brightness. */
  full: { drops: 120, dpr: 2.0, fps: 60 },
  lite: { drops: 44, dpr: 1.25, fps: 30 },
};

/* ========================================================================== */
/* deterministic noise (integer hashing — no Math.sin, no drift)             */
/* ========================================================================== */

function hash(n) {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/* ========================================================================== */
/* GLSL                                                                       */
/* ========================================================================== */

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const GLSL_HASH = /* glsl */ `
float h11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float h21(vec2 p) {
  vec3 q = fract(vec3(p.x, p.y, p.x) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
`;

/* --------------------------------------------------------------------------
 * PASS A — the city. One full-screen fragment program: pre-dawn sky, two
 * silhouette layers of shophouses with lit windows, the far shopfront band,
 * wet asphalt, and the scooter light trails with their reflections.
 * -------------------------------------------------------------------------- */
const CITY_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform float uP;      /* loop position, 0..1                                    */
uniform float uLift;   /* the breath: 0 at the seam, 1 at mid-loop                */
uniform float uWin;    /* fraction of windows currently lit                       */
uniform float uAsp;    /* frame width / height                                    */
uniform vec4 uSubj;   /* x0, x1 = plateau edges in uv; z = falloff; w = depth      */

const float Y_ROAD_TOP = 0.1850;
const float Y_SHOP_TOP = 0.3150;

/* Aerial perspective. Every receding plane is mixed toward this, and the mix
 * amount IS the depth cue: far = 0.80, mid = 0.42, near = 0.00. */
const vec3 HAZE = vec3(0.0430, 0.0262, 0.0186);

/* --------------------------------------------------------------------------
 * A shophouse is a NARROW TUBE HOUSE: 3–4m wide, 5–8 storeys, terraces of the
 * same height shoulder to shoulder with a 40cm alley between. That ratio is
 * the silhouette. Wide squat blocks read as offices; narrow tall ones read as
 * Saigon.
 * -------------------------------------------------------------------------- */

${GLSL_HASH}

/* smooth 1-D value noise — rooflines that are not drawn with a ruler */
float vx(float x, float s) {
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(h11(i + s * 13.0), h11(i + 1.0 + s * 13.0), f);
}

/* --- a warm light pool (shop doorway, sign, sodium lamp) ------------------ */
float pool(vec2 uv, vec2 c, vec2 r, float amp) {
  vec2 d = (uv - c) / r;
  return amp * exp(-dot(d, d) * 1.25);
}

/* --- soft rectangle in (local x, world y) ---------------------------------
 * soft edges everywhere, because a silhouette with a hard edge is a bar.   */
float bx(float lx, float y, float a, float b, float y0, float y1, float soft) {
  return smoothstep(a - soft, a + soft, lx) * (1.0 - smoothstep(b - soft, b + soft, lx)) *
         smoothstep(y0 - 0.0018, y0 + 0.0018, y) * (1.0 - smoothstep(y1 - 0.0018, y1 + 0.0018, y));
}

/* --- scooter light trail ---------------------------------------------------
 * Heads sit on a lattice of spacing P and advance exactly P frame-widths per
 * loop, so the set is invariant and a wrapped distance of period P is exact.
 *
 * The vertical falloff lives INSIDE the same gaussian as the lateral one. It
 * used to be a separate exp(-dy^2) multiplied across a smear that had been cut
 * at a fixed length, which is what produced the hard-edged rectangles in the
 * road: a car headlight smeared sideways, not a streak of light on water.    */
float trail(vec2 uv, float P, float sw, float x0, float yc, float hh,
            float len, float dir, float amp) {
  float head = x0 + sw * uP;
  float d = mod(dir * (head - uv.x), P);

  /* The tail falls off FAST. A slow decay held the first third of the streak
     at nearly full brightness and then cut it, which is a lit bar; a real
     headlight smear loses most of its energy within a few centimetres. The
     smoothstep carries it exactly to zero at the clip so the clip is free. */
  float s = clamp(d / len, 0.0, 1.0);
  float smear = exp(-s * 3.30) * (1.0 - smoothstep(0.55, 1.0, s)) * step(d, len);

  /* Distance to the NEAREST head on the lattice, not to the one ahead. Folding
   * the period here is what makes the streak continuous as it crosses: with a
   * one-sided head every pixel behind it got the full smear and every pixel
   * ahead got none, which is a hard vertical edge travelling across the road. */
  float dd = min(d, P - d);
  float ey = (uv.y - yc) / hh;

  /* the head is a defocused ball: soft in BOTH axes, and roughly round */
  float ball = exp(-pow(dd / (len * 0.115), 2.0) - ey * ey * 0.9);
  /* the smear is much taller than the head — a defocused streak is soft */
  float band = exp(-ey * ey * 0.34);

  return (smear * 0.62 * band + ball * 0.85) * amp;
}

/* --- vertical smear of a light down wet asphalt --------------------------
 * A wet street is mostly recognisable by its vertical reflections. The lateral
 * scale stays narrow all the way down: a reflection stretches in y but NOT in x. */
float wetStreak(vec2 uv, float cx, float top, float reach, float amp,
                float phase, float side) {
  if (uv.y > top) return 0.0;
  float t = clamp((top - uv.y) / reach, 0.0, 1.0);
  float w = 0.020 + t * 0.024;
  float wob = 0.013 * sin(uv.x * 41.0 + phase) * (0.30 + t) +
              0.007 * sin(uv.x * 97.0 + phase * 2.1) * t;
  float lateral = exp(-pow((uv.x - cx - wob) / (w * side), 2.0));
  float along = (1.0 - smoothstep(0.16, 1.0, t)) * (0.22 + 0.78 * exp(-t * 1.7));
  float chop = 0.68 + 0.32 * sin(uv.y * 118.0 + phase * 3.0);
  return amp * lateral * along * chop;
}

/* --- low-frequency seam warp --------------------------------------------- */
float seamWarp(vec2 uv, float y, float amp, float f1, float f2, float ph) {
  return y + amp * (sin(uv.x * f1 + ph) * 0.62 + sin(uv.x * f2 + ph * 2.3) * 0.38);
}

/* --------------------------------------------------------------------------
 * ONE BAY OF TUBE HOUSES. mask + facade colour.
 *
 * Nothing here is a plain rectangle. Each bay gets its own height, the whole
 * roofline gets a slow undulation on top of that, and every bay carries a
 * random selection of rooftop junk — stairwell housing, a water tank on a
 * frame, an aerial with crossbars, an open billboard frame, a dish. Two
 * adjacent bays can therefore never share a top edge, and no edge is level.
 * -------------------------------------------------------------------------- */
vec4 shophouse(vec2 uv, float n, float span, float base, float seed,
               float haze, float shade, float detail) {
  float fx = uv.x * n;
  float ci = floor(fx);
  float lf = fx - ci;

  float r1 = h21(vec2(ci, seed));
  float r2 = h21(vec2(ci + 11.0, seed + 3.0));
  float r3 = h21(vec2(ci + 29.0, seed + 7.0));
  float r4 = h21(vec2(ci + 41.0, seed + 19.0));

  /* the alley: 40cm between two four-metre houses. Two smoothsteps, not one,
     or the gap closes to a line. */
  float gw = 0.026 + 0.048 * r1;
  float inX = smoothstep(gw * 0.5, gw * 0.5 + 0.004, lf) *
              (1.0 - smoothstep(1.0 - gw * 0.5 - 0.004, 1.0 - gw * 0.5, lf));

  /* r2*r2 pushes most bays short and leaves a few genuinely tall — a uniform
     draw would make the roofline a comb. */
  float hgt = span * (0.26 + 1.30 * r2 * r2 + 0.46 * r2);
  hgt *= 0.88 + 0.24 * vx(uv.x * 3.7 + seed, seed);
  float top = base + hgt;

  float inY = smoothstep(base - 0.0018, base + 0.0018, uv.y) *
              (1.0 - smoothstep(top - 0.0018, top + 0.0018, uv.y));
  float mask = inX * inY;

  /* ---------------- rooftop junk -----------------------------------------
     Each piece is its own silhouette with its own top edge, OR-ed over the
     body mask, so the roofline gets steps and verticals instead of a curve. */
  float cs = 0.014 + 0.030 * (hgt / max(span, 1e-4));
  float c = 0.0;

  /* stairwell / lift housing */
  if (r3 > 0.44) {
    float a = 0.06 + 0.58 * r4;
    c = max(c, bx(lf, uv.y, a, a + 0.15 + 0.13 * r1, top - 0.004, top + 0.024 + 0.026 * r2, 0.0035));
  }
  /* water tank on a steel frame — the most Saigon object on a roof there is */
  if (r1 > 0.48) {
    float a = 0.26 + 0.34 * r4;
    float b = a + 0.20 + 0.10 * r2;
    float leg = top + cs * 0.42;
    float th = 0.026 + 0.022 * r3;
    c = max(c, bx(lf, uv.y, a + 0.030, a + 0.055, top - 0.004, leg, 0.0030));
    c = max(c, bx(lf, uv.y, b - 0.055, b - 0.030, top - 0.004, leg, 0.0030));
    c = max(c, bx(lf, uv.y, a, b, leg - 0.004, leg + th, 0.0045));
    c = max(c, bx(lf, uv.y, a - 0.011, b + 0.011, leg + th - 0.004, leg + th + 0.007, 0.0030));
  }
  /* aerial mast with two crossbars */
  if (r4 > 0.52) {
    float a = 0.60 + 0.24 * r1;
    float mh = cs * (1.7 + 1.7 * r2);
    c = max(c, bx(lf, uv.y, a, a + 0.010, top - 0.004, top + mh, 0.0025));
    c = max(c, bx(lf, uv.y, a - 0.028, a + 0.038, top + mh * 0.60, top + mh * 0.645, 0.0025));
    c = max(c, bx(lf, uv.y, a - 0.018, a + 0.028, top + mh * 0.79, top + mh * 0.820, 0.0025));
  }
  /* rooftop billboard: two legs and an open frame, so sky shows through it */
  if (r3 > 0.80) {
    float a = 0.14 + 0.10 * r1;
    float b = a + 0.40 + 0.16 * r2;
    float th = cs * (1.5 + 1.2 * r4);
    float bot = top + cs * 0.60;
    c = max(c, bx(lf, uv.y, a, a + 0.014, top - 0.004, top + th, 0.0025));
    c = max(c, bx(lf, uv.y, b - 0.014, b, top - 0.004, top + th, 0.0025));
    c = max(c, bx(lf, uv.y, a - 0.009, b + 0.009, top + th - 0.013, top + th, 0.0025));
    c = max(c, bx(lf, uv.y, a - 0.009, b + 0.009, bot, bot + 0.009, 0.0025));
  }
  /* a satellite dish, and the laundry pole every balcony has */
  if (h21(vec2(ci + 71.0, seed + 23.0)) > 0.56) {
    float a = 0.84;
    float rr = 0.055 + 0.030 * r2;
    float cy = top + cs * 0.34;
    float dd = length(vec2((lf - a) / rr, (uv.y - cy) / (rr * 0.85)));
    c = max(c, 1.0 - smoothstep(0.78, 1.02, dd));
  }
  if (r2 > 0.55) {
    c = max(c, bx(lf, uv.y, 0.34 + 0.10 * r3, 0.345 + 0.10 * r3,
                  top - 0.004, top + cs * 1.1, 0.0022));
  }

  mask = clamp(max(mask, c * inX), 0.0, 1.0);
  if (mask <= 0.002) return vec4(0.0);

  /* ---------------- facade ------------------------------------------------
     Shadowed and cold at street level, catching a little sky at the top, and
     kept off pure black so it still reads as a material rather than a hole. */
  float fy = clamp((uv.y - base) / max(hgt, 1e-4), 0.0, 1.0);
  vec3 col = mix(vec3(0.0132, 0.0086, 0.0070), vec3(0.0290, 0.0180, 0.0142), fy * fy);
  col *= 0.70 + 0.55 * r3;

  if (detail > 0.5) {
    /* storey slabs: a thin lighter line with a shadow under it */
    float storeys = 4.0 + floor(h21(vec2(ci + 5.0, seed + 9.0)) * 4.0);
    float f = fract((uv.y - base) / max(hgt / storeys, 1e-4));
    float sy = (uv.y - base) / max(hgt, 1e-4);
    float slab = (1.0 - smoothstep(0.0, 0.024, f)) + smoothstep(0.960, 1.0, f);
    slab *= smoothstep(0.10, 0.24, sy);
    col += vec3(0.042, 0.026, 0.016) * slab;
    col *= 1.0 - 0.34 * smoothstep(0.026, 0.070, f) * smoothstep(0.170, 0.070, f)
              * smoothstep(0.06, 0.16, sy);

    /* roller shutters on the ground floor only */
    col *= 1.0 + 0.16 * (0.5 + 0.5 * sin(uv.y * 640.0 + r1 * 6.0)) *
           (1.0 - smoothstep(0.02, 0.20, sy));

    /* windows: two narrow openings per bay per storey, mullion between */
    vec2 wf = fract(vec2(lf * 2.0, sy * storeys));
    vec2 wc = floor(vec2(lf * 2.0, sy * storeys));
    float wm = smoothstep(0.20, 0.44, wf.x) * (1.0 - smoothstep(0.56, 0.80, wf.x)) *
               smoothstep(0.26, 0.48, wf.y) * (1.0 - smoothstep(0.58, 0.82, wf.y));
    wm *= smoothstep(0.14, 0.30, sy);
    col *= 1.0 - 0.42 * wm;                       /* the opening is a dark hole */

    float id = wc.x * 13.0 + wc.y * 57.0 + ci * 131.0 + seed * 17.0;
    float rank = h11(id);
    float on = smoothstep(rank - 0.015, rank + 0.06, uWin);
    float dim2 = 0.22 + 0.78 * h11(id + 0.5);
    vec3 wc3 = mix(vec3(1.00, 0.520, 0.185), vec3(1.00, 0.760, 0.450), h11(id + 1.7));
    col += wc3 * wm * on * dim2 * 0.20;
    float halo = exp(-length((wf - vec2(0.5)) * 3.4) * 2.7);
    col += wc3 * halo * on * dim2 * 0.040;

    /* a parapet lip at the top of each block */
    float par = smoothstep(0.0, 0.016, top - uv.y) * (1.0 - smoothstep(0.016, 0.028, top - uv.y));
    col += vec3(0.052, 0.030, 0.017) * par;
  }

  col = mix(col * shade, HAZE, haze);
  return vec4(col, mask);
}

/* --------------------------------------------------------------------------
 * A distant tower. Two of these are all it takes to stop the skyline having a
 * single ceiling height; both sit so far back that they are barely a value
 * apart from the sky.
 * -------------------------------------------------------------------------- */
vec4 tower(vec2 uv, float cx, float halfw, float top, float base, float haze) {
  float t = clamp((uv.y - base) / max(top - base, 1e-4), 0.0, 1.0);
  float w = 1.0;
  w *= 1.0 - 0.38 * smoothstep(0.58, 0.80, t);   /* first setback  */
  w *= 1.0 - 0.30 * smoothstep(0.82, 0.93, t);   /* second setback */
  w *= 1.0 - 0.62 * smoothstep(0.93, 0.99, t);   /* the mast       */
  float ww = halfw * w;
  float m = smoothstep(ww, ww - 0.0016, abs(uv.x - cx)) *
            smoothstep(base - 0.002, base + 0.002, uv.y) *
            (1.0 - smoothstep(top - 0.002, top + 0.002, uv.y));
  if (m <= 0.002) return vec4(0.0);
  /* a couple of dim window bands so it is not a dead slab */
  float band = exp(-pow((fract(uv.y * 34.0) - 0.5) * 3.4, 2.0));
  vec3 col = mix(vec3(0.0300, 0.0196, 0.0152), HAZE, haze) * (0.86 + 0.22 * band);
  return vec4(col, m);
}

/* --------------------------------------------------------------------------
 * Overhead cabling. Nothing says Saigon like the tangle of wires strung pole
 * to pole across the street, sagging in catenaries.
 * -------------------------------------------------------------------------- */
float cables(vec2 uv) {
  float m = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float x0 = -0.16 + 0.29 * fi + 0.10 * h11(fi * 5.0 + 2.0);
    float x1 = x0 + 0.30 + 0.14 * h11(fi * 9.0 + 5.0);
    float ty = 0.352 + 0.052 * h11(fi * 3.0 + 1.0);
    float sag = 0.048 + 0.052 * h11(fi * 7.0 + 3.0);
    /* the pole itself, standing on the pavement */
    float pole = smoothstep(0.0055, 0.0035, abs(uv.x - x0)) *
                 smoothstep(0.196, 0.204, uv.y) *
                 (1.0 - smoothstep(ty + 0.115, ty + 0.135, uv.y));
    /* a crossarm near the top */
    pole = max(pole, smoothstep(0.0030, 0.0018, abs(uv.y - (ty + 0.098))) *
                   smoothstep(0.020, 0.014, abs(uv.x - x0)));
    m = max(m, pole);
    if (uv.x > x0 && uv.x < x1) {
      float u = (uv.x - x0) / (x1 - x0);
      float cy = ty - sag * sin(3.14159265 * u);
      float d = abs(uv.y - cy);
      /* a bundle of four lines at slightly different sags */
      m = max(m, 0.95 * exp(-pow(d / 0.0017, 2.0)));
      m = max(m, 0.60 * exp(-pow((d - 0.0046) / 0.0013, 2.0)));
      m = max(m, 0.45 * exp(-pow((d - 0.0086) / 0.0012, 2.0)));
      m = max(m, 0.34 * exp(-pow((d - 0.0122) / 0.0011, 2.0)));
    }
  }
  return m;
}

/* --------------------------------------------------------------------------
 * VERTICAL SIGNAGE. Saigon shopfronts project tall narrow boards up past the
 * first floor, and at 5am a handful of them are still burning. They are drawn
 * AFTER the buildings because they hang in front of them.
 * -------------------------------------------------------------------------- */
vec3 signage(vec2 uv, float shopTop) {
  vec3 s = vec3(0.0);
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float cx = 0.045 + 0.905 * h11(fi * 3.7 + 1.3);
    float w = 0.0060 + 0.0045 * h11(fi * 11.0 + 4.1);
    float y0 = shopTop - 0.014 - 0.010 * h11(fi * 5.0 + 2.9);
    float y1 = y0 + 0.055 + 0.085 * h11(fi * 17.0 + 8.3);
    float m = smoothstep(w, w - 0.0016, abs(uv.x - cx)) *
              smoothstep(y0 - 0.002, y0 + 0.002, uv.y) *
              (1.0 - smoothstep(y1 - 0.002, y1 + 0.002, uv.y));
    if (m <= 0.002) continue;
    /* the tube inside the board: brighter in the middle, dark at the ends */
    float tube = exp(-pow((uv.x - cx) / (w * 0.42), 2.0)) *
                 (0.35 + 0.65 * abs(sin((uv.y - y0) * 210.0 + h11(fi) * 6.0)));
    vec3 tint = mix(vec3(1.00, 0.360, 0.115), vec3(1.00, 0.640, 0.330), h11(fi * 23.0 + 1.1));
    s += tint * m * (0.07 + 0.26 * tube) * (0.55 + 0.45 * uLift);
    /* the halo the board throws on the wall behind it */
    s += tint * m * 0.20 * exp(-max(0.0, uv.y - y1) * 46.0);
  }
  return s;
}

void main() {
  vec2 uv = vUv;
  float shopTop = seamWarp(uv, Y_SHOP_TOP, 0.0165, 3.7, 8.9, 0.6);
  float roadTop = seamWarp(uv, Y_ROAD_TOP, 0.0125, 4.3, 9.7, 2.1);

  /* ---------------- sky -------------------------------------------------- */
  /* Linear radiance, graded once in PASS D.
   *
   * The single most important art-direction decision in this file: this is
   * 5am, so the sky is NOT a sunset. It is a narrow ember band trapped under
   * a deep roast-brown overcast. Red is pulled well below green+blue so nothing
   * ever reads as orange, and the whole gradient is compressed so the top
   * two-thirds of the frame stays close to black. */
  vec3 zenith = vec3(0.0125, 0.0092, 0.0084);
  vec3 upper  = vec3(0.0290, 0.0196, 0.0166);
  vec3 horiz  = vec3(0.1060, 0.0570, 0.0348);
  vec3 c = mix(upper, zenith, smoothstep(0.50, 1.10, uv.y));
  c = mix(horiz, c, smoothstep(0.300, 0.760, uv.y));

  /* pre-dawn: a low, tight bloom sitting in the gap between the rooflines */
  vec2 g = vec2((uv.x - 0.640) * 1.70, (uv.y - 0.300) * 4.60);
  c += vec3(0.310, 0.156, 0.068) * exp(-dot(g, g) * 2.45) * (0.26 + 0.74 * uLift);
  /* Sodium haze hugging the roofline.
   *
   * The decay rate was 15.5 per uv unit, which is 15px in a 1000px frame and
   * 10px in a 1600px one: on a tall viewport the exponential had fallen to
   * nothing before it had visibly started, so the term rendered as a HARD
   * HORIZONTAL EDGE across the full width of the phone poster — the single
   * most artificial thing in the portrait still. Decaying from the roofline
   * over 0.075 of the frame instead puts the falloff at 60-120px, which reads
   * as haze at every aspect ratio. */
  c += vec3(0.148, 0.070, 0.030) * exp(-max(0.0, uv.y - 0.290) * 13.3)
       * (0.42 + 0.58 * uLift);
  /* a soft cloud shelf, barely there */
  float shelf = exp(-pow((uv.y - 0.640) * 8.5, 2.0)) *
                (0.55 + 0.45 * sin(uv.x * 5.1 + 1.3));
  c += vec3(0.026, 0.017, 0.014) * shelf;

  /* The window is wet all the way up, not just at the street. */
  float sheet = exp(-pow((uv.y - 0.80) * 2.4, 2.0));
  c += vec3(0.0165, 0.0110, 0.0082) * sheet * (0.6 + 0.4 * sin(uv.x * 11.0));
  c += vec3(0.0090, 0.0056, 0.0038) * exp(-pow((uv.y - 0.97) * 5.0, 2.0));

  /* ---------------- the street ------------------------------------------
   * Bands, bottom up: wet asphalt | pavement kerb | motorbike parking under
   * its shelter | shopfront wall with awnings and shutter fronts. Every edge
   * is warped, because a dead-straight horizontal across a whole frame is the
   * most obviously procedural thing you can draw. */
  float pavTop = roadTop + 0.030 + 0.005 * sin(uv.x * 5.3 + 1.1);
  float wallBot = 0.238;

  /* ---- the ground: everything below the shopfront line is NOT sky ----
     The road and the shop wall do not meet. Between them is the far pavement
     and the kerb, and leaving it unpainted let the horizon gradient show
     straight through as a bright beige stripe across the entire frame — the
     single most obviously wrong thing in the frame, and it read as a horizon
     line drawn with a ruler. */
  float ground = 1.0 - smoothstep(shopTop - 0.008, shopTop + 0.004, uv.y);
  if (ground > 0.001) {
    vec3 pav = mix(vec3(0.0400, 0.0258, 0.0206), vec3(0.0190, 0.0124, 0.0104),
                   smoothstep(wallBot - 0.020, roadTop, uv.y));
    c = mix(c, pav, ground);
  }

  /* ---- shopfront wall ---- */
  float wall = (1.0 - smoothstep(shopTop - 0.006, shopTop + 0.004, uv.y)) *
               smoothstep(wallBot - 0.004, wallBot + 0.004, uv.y);
  if (wall > 0.001) {
    float sx = uv.x * 22.0;
    float bi = floor(sx);
    float bl = sx - bi;
    vec3 sh = vec3(0.0470, 0.0300, 0.0236);
    sh *= 0.55 + 0.90 * h21(vec2(bi, 91.0));
    /* roller shutters, corrugation and all */
    float roll = 0.5 + 0.5 * sin(uv.y * 660.0 + h21(vec2(bi, 3.0)) * 6.0);
    sh *= 1.0 + 0.20 * roll * (1.0 - smoothstep(0.30, 0.62, (uv.y - wallBot) / 0.09));
    /* Shopfronts are RECESSES, not lit panels. Filling the doorway rectangle
       with lamp colour turned the whole street into one beige stripe running
       edge to edge; a doorway has to be a dark hole with a small warm pool at
       the back of it, and only a few of them are open at 5am. */
    float dwid = 0.30 + 0.10 * h21(vec2(bi, 23.0));
    float door = bx(bl, uv.y, 0.5 - dwid, 0.5 + dwid, wallBot - 0.002, wallBot + 0.058, 0.014);
    float open = step(0.62, h21(vec2(bi, 57.0)));
    sh = mix(sh, vec3(0.0180, 0.0116, 0.0090), door);
    c = mix(c, sh, wall);
    float inside = door * open * exp(-pow((uv.y - (wallBot + 0.006)) / 0.030, 2.0)) *
                   (0.30 + 0.70 * smoothstep(0.30, 0.70, bl));
    c += vec3(1.00, 0.430, 0.150) * inside * 0.62 * wall * (0.45 + 0.55 * uLift);
  }

  /* ---- the people on the pavement --------------------------------------
   * A street with nothing standing in it is a backdrop, not a street. These
     are pure silhouette and they sit BELOW the shopfront line, where the eye
     reads scale: a figure is 1.7m, the shopfront band is 3m, and the gap
     between them is what makes a shophouse read as a building rather than as
     a rectangle. */
  {
    float fig = 0.0;
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      float h0 = h11(fi * 17.0 + 2.0);
      /* cluster them: a pavement queue, not an evenly spaced rank */
      float fx = 0.085 + 0.845 * (0.30 * h0 + 0.70 * h11(floor(h0 * 3.0) * 23.0 + 5.0));
      float sc = 0.80 + 0.34 * h11(fi * 7.0 + 9.0);
      float top = wallBot + 0.050 * sc;
      float w = 0.0050 * sc;
      /* a body, and a head that is a separate circle — a single tapered box
         reads as a bollard, and bollards do not have shoulders */
      float body = bx(uv.x, uv.y, fx - w, fx + w, wallBot - 0.002, top - 0.010, 0.0016);
      float head = 1.0 - smoothstep(0.0038, 0.0056,
        length(vec2(uv.x - fx, (uv.y - (top - 0.0052)) / 1.12)));
      fig = max(fig, max(body, head));
    }
    c = mix(c, vec3(0.0155, 0.0098, 0.0078), fig);
  }

  /* ---- awnings over the shopfronts ---- */
  float awx = uv.x * 22.0;
  float abi = floor(awx);
  float awY = 0.250 + 0.018 * h21(vec2(abi, 5.0));
  float awn = bx(fract(awx), uv.y, 0.10, 0.94, awY, awY + 0.024, 0.007);
  awn *= step(0.52, h21(vec2(abi, 77.0)));
  c = mix(c, vec3(0.0300, 0.0196, 0.0158), awn);
  /* one edge of the awning catches the shopfront glow — stripes, but faint */
  c += vec3(0.150, 0.066, 0.024) * awn *
       (0.5 + 0.5 * sin(fract(awx) * 26.0)) * 0.42;

  /* ---- motorbike parking: a shelter and a row of handlebars ---- */
  /* A parking row, not a stencil: irregular spacing, irregular sizes, and
     almost none of them lit. A regular rank of identical shapes with a red dot
     in each reads as a machine, which is exactly what this city must not be. */
  float row = 0.208 + 0.014 * vx(uv.x * 7.0 + 3.0, 7.0);
  float k = uv.x * 17.0 + 0.35 * vx(uv.x * 3.0, 11.0);
  float ki = floor(k);
  float kl = fract(k);
  float kwid = 0.34 + 0.34 * h21(vec2(ki, 131.0));
  float khgt = 0.010 + 0.014 * h21(vec2(ki, 17.0));
  float mb = bx(kl, uv.y, 0.5 - kwid, 0.5 + kwid, row - khgt, row + khgt * 0.5, 0.016);
  mb *= step(0.44, h21(vec2(ki, 53.0)));
  /* only a shade darker than what is behind it: a black box on a lit road is a
     box, a dark shape on a dark pavement is a parked motorbike */
  c = mix(c, c * 0.46 + vec3(0.0125, 0.0082, 0.0066), mb);
  /* one or two tail-lights in the whole row */
  float glint = exp(-pow((kl - 0.5) * 3.4, 2.0)) *
                exp(-pow((uv.y - row) * 300.0, 2.0));
  c += vec3(1.00, 0.26, 0.11) * mb * glint * 1.10 *
       step(0.80, h21(vec2(ki, 3.0)));

  /* ---- wet asphalt ---- */
  float road = 1.0 - smoothstep(roadTop - 0.005, roadTop + 0.007, uv.y);
  if (road > 0.001) {
    vec3 tarmac = mix(vec3(0.0158, 0.0098, 0.0080),
                      vec3(0.0062, 0.0039, 0.0034),
                      smoothstep(0.0, roadTop, uv.y));
    c = mix(c, tarmac, road);

    /* ---- reflections of the shopfronts, running toward the camera ---- */
    float st = 0.0;
    st += wetStreak(uv, 0.238, shopTop, 0.200, 0.340, 0.7, 1.0);
    st += wetStreak(uv, 0.560, shopTop, 0.170, 0.205, 2.4, 1.0);
    st += wetStreak(uv, 0.856, shopTop, 0.210, 0.290, 4.1, 1.0);
    st += wetStreak(uv, 0.772, shopTop, 0.145, 0.150, 5.5, 1.0);
    st *= 0.50 + 0.50 * uLift;
    c += vec3(1.00, 0.520, 0.210) * st * road;

    /* A broad wash across the carriageway so the road is never a flat black
       band — but kept well down. At the old amplitude it was the brightest
       thing in the frame and it read as an orange bar under a bar chart. */
    c += vec3(0.34, 0.163, 0.068) * road *
         exp(-pow((uv.y - roadTop * 0.68) / 0.070, 2.0)) *
         (0.34 + 0.20 * sin(uv.x * 3.1 + 0.7)) * (0.55 + 0.45 * uLift);

    /* kerb, catching the shopfront light */
    c += vec3(0.095, 0.046, 0.020) *
         exp(-pow((uv.y - pavTop) / 0.008, 2.0)) * road * 0.55;
  }

  /* ---------------- scooter light trails -------------------------------- */
  /* Long, low and slow: each head crosses the frame in one loop (or half a
     loop for the tighter pair), which is also what makes the wrap exact. */
  float warm = 0.0;
  warm += trail(uv, 1.00, 1.00, 0.145, 0.1710, 0.0175, 0.300,  1.0, 1.00);
  warm += trail(uv, 0.50, 0.50, 0.615, 0.1605, 0.0140, 0.180, -1.0, 0.66);
  warm += trail(uv, 0.50, 0.50, 0.375, 0.1765, 0.0145, 0.200,  1.0,
                0.78 * smoothstep(0.10, 0.45, uLift));
  float red = 0.0;
  red += trail(uv, 1.00, 1.00, 0.815, 0.1745, 0.0130, 0.205,  1.0, 0.82);
  red += trail(uv, 0.50, 0.50, 0.255, 0.1630, 0.0120, 0.145, -1.0, 0.56);
  red += trail(uv, 0.25, 0.25, 0.560, 0.1680, 0.0105, 0.110,  1.0,
               0.52 * smoothstep(0.10, 0.45, uLift));

  /* the smear only exists where there is road to reflect it */
  float onRoad = smoothstep(pavTop + 0.006, pavTop - 0.010, uv.y) *
                 smoothstep(0.002, 0.026, uv.y);

  c += vec3(1.00, 0.930, 0.845) * warm * 0.40 * onRoad;
  c += vec3(1.00, 0.230, 0.135) * red * 0.30 * onRoad;

  /* ---------------- the city: four receding planes --------------------- */
  /* FAR: almost no contrast at all — a value, not a shape. Lost in the haze. */
  vec4 L = shophouse(uv, 15.0, 0.056, shopTop + 0.068, 3.0, 0.80, 1.30, 0.0);
  c = mix(c, L.rgb, L.a);
  /* Two distant towers, so the skyline has more than one ceiling height. They
     sit at fixed x rather than at hashed ones: they are the two vertical
     accents in the composition and have to land either side of the dawn band,
     not wherever a hash happened to put them. */
  L = tower(uv, 0.208, 0.0140, 0.700, shopTop + 0.058, 0.88);
  c = mix(c, L.rgb, L.a);
  L = tower(uv, 0.505, 0.0105, 0.618, shopTop + 0.058, 0.90);
  c = mix(c, L.rgb, L.a);

  /* MID: a hint of facade, clearly lighter than the near plane */
  L = shophouse(uv, 8.5, 0.104, shopTop + 0.026, 17.0, 0.40, 0.90, 0.0);
  c = mix(c, L.rgb, L.a);

  /* NEAR: a near-black silhouette. This is the darkest mass in the frame and
     it is deliberate — it is the anchor everything else reads depth against. */
  L = shophouse(uv, 5.6, 0.168, shopTop - 0.012, 41.0, 0.00, 0.60, 1.0);
  c = mix(c, L.rgb, L.a);

  /* ---------------- signage boards, in front of the city --------------- */
  c += signage(uv, shopTop);

  /* ---------------- overhead cabling ----------------------------------- */
  float cb = cables(uv);
  c = mix(c, vec3(0.0072, 0.0044, 0.0034), cb * 0.92);

  /* ---- behind the subject -----------------------------------------------
   * The glass is transparent and the phin sits in front of the street, so the
   * city genuinely does show through it — that is the point of the glass. But
   * a hard-edged lit sign board a few pixels wide, seen through the middle of
   * a glass of coffee, reads as an object floating inside the drink rather
   * than as a street outside the window. So the emissive street detail is
   * attenuated across the subject's own column. */
  /* A PLATEAU, not a linear ramp: full strength across the width of the glass,
     falling off outside it. A single smoothstep across the plate's full width
     puts the attenuation in the middle of the glass and leaves the edges
     untouched, which is exactly where a shopfront light was leaking through. */
  float plateau = smoothstep(uSubj.x - uSubj.z, uSubj.x, uv.x) *
                  (1.0 - smoothstep(uSubj.y, uSubj.y + uSubj.z, uv.x));
  float streetMask = 1.0 - smoothstep(shopTop + 0.03, roadTop - 0.03, uv.y);
  c *= 1.0 - plateau * streetMask * uSubj.w;

  /* ---------------- near field: the window's own darkness --------------- */
  /* A soft, out-of-focus frame edge on the left. This is what guarantees the
     headline has something dark to sit on before a single line of CSS scrim. */
  float fr = smoothstep(0.165, 0.010, uv.x);
  c = mix(c, c * 0.11 + vec3(0.0092, 0.0054, 0.0038), fr);
  /* and a matching sliver on the right, so the frame reads as a frame */
  float fr2 = smoothstep(0.905, 1.0, uv.x);
  c = mix(c, c * 0.20, fr2);

  /* ---------------- out-of-focus practicals, up in the corner ---------- */
  float b1 = exp(-pow(length((uv - vec2(0.822, 0.848)) * vec2(1.0, 1.40)) / 0.108, 2.0));
  float b2 = exp(-pow(length((uv - vec2(0.918, 0.664)) * vec2(1.0, 1.40)) / 0.062, 2.0));
  float b3 = exp(-pow(length((uv - vec2(0.612, 0.934)) * vec2(1.0, 1.40)) / 0.050, 2.0));
  c += vec3(1.00, 0.570, 0.245) * (b1 * 0.180 + b2 * 0.115 + b3 * 0.070)
       * (0.50 + 0.50 * uLift);

  /* A soft warm gradient across the upper third, so the sky has somewhere for
     the eye to travel. */
  float ceil = smoothstep(0.34, 1.00, uv.y);
  c += vec3(0.050, 0.027, 0.018) * ceil *
       (0.28 + 0.72 * smoothstep(0.0, 1.0, uv.x));
  c += vec3(0.019, 0.011, 0.010) * smoothstep(0.58, 1.0, uv.y);

  /* ---------------- atmosphere ----------------------------------------- */
  /* Ground haze, warm, thickening toward the road. */
  float haze = smoothstep(0.52, 0.02, uv.y);
  c = mix(c, c * 0.92 + vec3(0.030, 0.015, 0.0078), haze * 0.20);

  gl_FragColor = vec4(max(c, 0.0), 1.0);
}
`;

/* --------------------------------------------------------------------------
 * PASS C — rain on the window. Instanced quads; each droplet samples rtA
 * through itself, which is what actually makes the glass read as glass.
 * -------------------------------------------------------------------------- */
const RAIN_VERT = /* glsl */ `
precision highp float;

uniform float uP;
uniform float uAsp;
uniform float uSize;   /* global droplet size multiplier */
uniform float uTrail;  /* 0 on lite: drops the trail subdivision entirely */

attribute vec4 aC; /* x, basePhase, headRadius, trailLen (units of headRadius) */
attribute vec4 aP; /* phase, rate (int), opacity, seed                     */
attribute vec4 aQ; /* matePhase, mateRate, isBig(-1/0/+1), seed2           */

varying vec2  vLocal;
varying vec2  vBend;
varying float vTrail;
varying float vAlpha;

void main() {
  /* Every droplet travels a WHOLE number of window-heights per loop, so
     fract() returns it to exactly where it started at p = 1. */
  float yv = fract(aC.y + aP.y * uP);
  float ym = fract(aQ.x + aQ.y * uP);

  /* merging: the pair's separation, wrapped. One grows, one is swallowed. */
  float d = abs(yv - ym);
  d = min(d, 1.0 - d);
  float mg = abs(aQ.z);
  float m = (1.0 - smoothstep(0.0, 0.055, d)) * mg;
  float grow = max(aQ.z, 0.0) * m;
  float swallow = max(-aQ.z, 0.0) * m;

  /* slow lateral meander — an integer number of cycles per loop */
  float cyc = 1.0 + floor(aQ.w * 2.0);
  float xw = aC.x + 0.0026 * sin(6.2831853 * (cyc * uP + aQ.w * 7.0));

  float edge = smoothstep(0.0, 0.075, yv) * (1.0 - smoothstep(0.925, 1.0, yv));

  float r = aC.z * uSize * (1.0 + 0.95 * grow) * (1.0 - 0.55 * swallow);
  /* Lite drops the trail subdivision: one fewer smoothstep chain per fragment
     and, more importantly, quads that are ~4x shorter to rasterise. */
  float tr = aC.w * (0.30 + 0.70 * step(1.5, aP.y)) * uTrail;
  float alpha = aP.z * edge * (1.0 - 0.92 * swallow);

  vec2 q = position.xy * 2.0;                       /* -1 .. 1 */
  float px = q.x * r * 1.18;
  float py = mix(-r * 1.08, r * (1.0 + tr), q.y * 0.5 + 0.5);

  vec2 c = vec2((xw * 2.0 - 1.0) * uAsp, 1.0 - 2.0 * yv);
  gl_Position = vec4(c + vec2(px, py), 0.0, 1.0);

  vLocal = vec2(px / max(r, 1e-5), py / max(r, 1e-5));
  vTrail = tr;
  vAlpha = alpha;

  /* The lens offset MUST be proportional to the droplet's own radius.
     vLocal is normalised (-1..1), so using it directly displaced the image by
     a fixed fraction of the *frame* — which smeared every large droplet into a
     bar across a sixth of the screen. Multiply by r, then convert NDC→uv. */
  vec2 bend = vLocal * (1.0 + tr * 0.30);
  vBend = vec2(bend.x * r / (2.0 * uAsp), -bend.y * r * 0.5) * 1.15;
}
`;

const RAIN_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D uTex;
uniform vec2  uRes;
uniform float uAsp;
uniform float uBend;

varying vec2  vLocal;
varying vec2  vBend;
varying float vTrail;
varying float vAlpha;

void main() {
  float R = length(vLocal);
  float head = smoothstep(1.02, 0.78, R);

  /* the wet trail a runner leaves above its head */
  float trail = 0.0;
  if (vTrail > 0.02) {
    float ty = clamp(vLocal.y / vTrail, 0.0, 1.0);
    float tw = mix(0.70, 0.05, ty);
    trail = smoothstep(tw, tw * 0.20, abs(vLocal.x)) *
            smoothstep(-0.34, 0.06, vLocal.y) *
            (1.0 - smoothstep(0.78, 1.0, ty));
  }

  float mask = clamp(max(head, trail * 0.62), 0.0, 1.0) * vAlpha;
  if (mask <= 0.002) discard;

  /* the droplet is a lens: it bends whatever is behind the window. vBend is
     already scaled to the droplet's radius and expressed in uv. */
  vec2 suv = clamp(gl_FragCoord.xy / uRes + vBend * uBend, 0.001, 0.999);
  vec3 bg = texture2D(uTex, suv).rgb;

  vec3 c = mix(bg, bg * 0.80 + vec3(0.026, 0.014, 0.008), trail * 0.6);

  /* surface of the bead: an off-white specular and a warm meniscus rim */
  float z = sqrt(max(0.0, 1.0 - min(1.0, R * R)));
  vec3 n = normalize(vec3(vLocal.x, vLocal.y, z * 0.92));
  float sp = pow(max(0.0, dot(n, normalize(vec3(-0.46, -0.58, 0.67)))), 7.0);
  c += vec3(1.00, 0.925, 0.820) * sp * head * 0.40;
  c += vec3(1.00, 0.620, 0.330) * pow(1.0 - z, 2.6) * head * 0.16;
  /* the bead picks up whatever is bright behind it */
  c += bg * head * 0.22;

  gl_FragColor = vec4(c, mask);
}
`;

/* --------------------------------------------------------------------------
 * PASS D — grade. Everything that makes it a frame of film and not a render.
 * -------------------------------------------------------------------------- */
const GRADE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D uTex;
uniform vec2  uRes;
uniform float uP;
uniform float uLift;
uniform float uExpo;
uniform float uChroma;

${GLSL_HASH}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec2 uv = vUv;
  vec2 d = uv - 0.5;
  float r2 = dot(d, d);

  /* a touch of lateral chromatic softness, only at the edges */
  vec2 ca = d * uChroma * (0.35 + r2 * 3.2);
  vec3 c;
  c.r = texture2D(uTex, uv - ca).r;
  c.g = texture2D(uTex, uv).g;
  c.b = texture2D(uTex, uv + ca).b;

  /* five-tap tent: kills the hard digital edge on the geometry */
  vec2 px = 1.35 / uRes;
  vec3 s = texture2D(uTex, uv + vec2(px.x, 0.0)).rgb
         + texture2D(uTex, uv - vec2(px.x, 0.0)).rgb
         + texture2D(uTex, uv + vec2(0.0, px.y)).rgb
         + texture2D(uTex, uv - vec2(0.0, px.y)).rgb;
  c = mix(c, (c * 2.0 + s) / 6.0, 0.55);

  /* exposure: the city breathes over the loop */
  c *= uExpo * (1.0 + 0.16 * uLift);

  c = aces(c);

  /* Warm split-tone. The ratios here are the difference between "5am in
     Saigon" and "orange sunset": shadows get pushed to ROAST (red-brown, but
     with green and blue lifted so they read as brown, not as orange), and the
     highlight lift is deliberately almost neutral so specular hits stay
     off-white instead of going yellow. */
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c *= vec3(0.985, 0.980, 1.010);                       /* global: not orange   */
  c += vec3(0.0175, 0.0122, 0.0092) * (1.0 - smoothstep(0.0, 0.42, l));
  c += vec3(0.0085, 0.0062, 0.0044) * smoothstep(0.50, 1.0, l);
  c = mix(vec3(l), c, 0.94);                           /* pull saturation back */

  /* a gentle S so it stays low-contrast and filmic, never crushed */
  c = c * c * (3.0 - 2.0 * c) * 0.26 + c * 0.74;
  c = max(c - 0.0030, 0.0) * 1.030 + 0.0075;

  /* vignette */
  float v = smoothstep(1.02, 0.20, length(d * vec2(1.06, 1.0)) * 1.32);
  c *= mix(0.40, 1.0, v);

  /* grain: per frame, but on an integer cycle so the loop still closes */
  float g = fract(uP * 997.0);
  float n = h21(gl_FragCoord.xy + vec2(g * 611.0, g * 397.0)) - 0.5;
  c += n * 0.0215 * (1.0 - 0.55 * smoothstep(0.3, 0.95, l));

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

/* --------------------------------------------------------------------------
 * FOREGROUND — the phin, the glass, the coffee. Stylised, hand-shaded, three
 * point-ish lights baked into the material. No scene lights, no shadows.
 * -------------------------------------------------------------------------- */
const LATHE_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vP;
varying vec3 vM;

void main() {
  /* vM is model space. The whole foreground group is offset to y ~ -0.6 in
     world space, so anything keying a material threshold off world position is
     silently wrong — that is what made the coffee surface and its ripple dead
     and the phin's specular band invisible. These are hand-authored materials,
     so they are written against the model, not the world. */
  vM = position;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vP = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/* A view-space quad that honours its own model matrix. FS_VERT cannot be used
 * for anything inside fgScene: FS_VERT ignores the model/view/projection
 * matrices entirely (it is a clip-space fullscreen triangle), so a plane drawn
 * with it always fills the whole frame no matter where you put it. */
const SPRITE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}
`;

const METAL_FRAG = /* glsl */ `
precision highp float;
varying vec3 vN;
varying vec3 vP;
varying vec3 vM;

uniform vec3  uBase;
uniform vec3  uRim;
uniform vec3  uSpec;
uniform vec3  uSky;
uniform float uKeyY;

${GLSL_HASH}

/* Brushed stainless, spun on a lathe.
 *
 * The old material was one diffuse term against one key plus a single
 * hairline band, which is a formula for beige ceramic. Three things make it
 * read as metal: TWO lights of opposite colour temperature, so the surface
 * has a warm side and a cool side; an anisotropic highlight smeared along the
 * grain; and the grain itself — circumferential tool marks, which seen
 * head-on are horizontal rings.
 *
 * Model space, in units where the phin's perforated plate sits at y = 0.640,
 * the cylinder wall runs from 0.762 to 1.355 and the knob tops out at 1.433. */
void main() {
  vec3 N = normalize(vN);
  vec3 V = vec3(0.0, 0.0, 1.0);

  /* The ember band in the window is right of frame and low. The sky over the
     roofline is everywhere and cold. */
  vec3 Lw = normalize(vec3(0.76, -0.24, 0.46));
  vec3 Lc = normalize(vec3(-0.68, -0.30, 0.44));

  float nw = max(0.0, dot(N, Lw));
  float nc = max(0.0, dot(N, Lc));
  float up = max(0.0, N.y);
  float ndv = max(0.0, dot(N, V));

  float r = length(vM.xz);
  float ang = atan(vM.z, vM.x);

  /* ---- the grain: turned rings ----------------------------------------
     Kept subtle on purpose. At 0.76 + 0.32 the rings read as CORRUGATION —
     the phin looked like a piece of flexible ducting. At this size the grain
     is a texture, not a shape, and it has to stay under the eye. */
  float g1 = h11(floor(vM.y * 250.0) * 1.7 + floor(ang * 6.0) * 31.0);
  float g2 = h11(floor(vM.y * 760.0) * 3.1 + floor(ang * 13.0) * 7.0);
  float brush = 0.90 + 0.13 * g1 + 0.05 * g2;

  vec3 c = uBase * (0.14 + 0.86 * nw) * brush;
  c += uSky * 0.62 * nc * brush;
  /* The flat lid faces the sky, and that is the single clearest signal that it
     is a disc and not a dome. */
  c += uSky * 0.34 * up * up;

  /* THE UNDERSIDE OF THE PLATE.
   *
   * Keyed off the surface's own coordinates, not off its normal. The underside
     is a very shallow cone -- 0.029 units of rise across a 0.26 radius, about
     six degrees -- so its interpolated normal points downward by only
     sin(6 deg) and any dot(N, -Y) test returns ~0.1. That let the x-keyed
     specular bands paint a bright inverted pyramid straight down the middle of
     a surface no light in the scene can reach: a lampshade, hanging under a
     coffee filter. Inside the rim radius and below the rim height IS the
     underside, and nothing else in the profile is, so that is the test. */
  float under = (1.0 - smoothstep(0.2560, 0.2660, r)) *
                (1.0 - smoothstep(0.6690, 0.6765, vM.y));

  /* ---- anisotropic specular: two tight bands on opposite sides ---------
     Restrained. This is a dark café at 5am: the phin is a silhouette with a
     rim and two highlights, and the first pass at this material lit the whole
     cylinder and turned the filter into a roll of kitchen foil. */
  float w1 = exp(-pow((vM.x - 0.106) * 19.0, 2.0));   /* warm, broad  */
  float w2 = exp(-pow((vM.x + 0.150) * 30.0, 2.0));   /* cool, broad  */
  float w3 = exp(-pow((vM.x - 0.118) * 105.0, 2.0));  /* the hot core */
  float w4 = exp(-pow((vM.x + 0.156) * 120.0, 2.0));  /* cool core     */
  float lit = 1.0 - under;                /* no specular on an underside */
  c += uSpec * w3 * 0.52 * lit;
  c += uSpec * w1 * 0.30 * brush * lit;
  c += uSky * w2 * 0.85 * lit;
  c += uSky * w4 * 0.90 * lit;

  /* ---- seams -----------------------------------------------------------
   * A phin is four turned parts screwed together. The joins are the fastest
   * read of "manufactured object" there is, and the previous profile was one
   * continuous smooth blob with no join anywhere on it. */
  float lidSeam   = exp(-pow((vM.y - 1.3672) * 470.0, 2.0));
  float plateSeam = exp(-pow((vM.y - 0.7252) * 430.0, 2.0));
  float plateLip  = exp(-pow((vM.y - 0.6975) * 330.0, 2.0));
  c += uSpec * (lidSeam * 0.34 + plateSeam * 0.22 + plateLip * 0.14) * (0.35 + 0.65 * brush);
  /* the shadow inside each step */
  c *= 1.0 - 0.50 * exp(-pow((vM.y - 1.3560) * 540.0, 2.0));
  c *= 1.0 - 0.44 * exp(-pow((vM.y - 0.7160) * 480.0, 2.0));

  /* ---- perforation -----------------------------------------------------
   * A phin is a strainer, and its bottom is a drilled plate. It is the only
   * part of the object that says "filter" rather than "pot", so it is the part
   * that has to carry the hole pattern. Two lattices: one on the plate seen
   * from underneath, foreshortening into ellipses exactly as it does in life,
   * and one on the outer ring of the plate where the holes face the camera
   * square on. */
  if (vM.y < 0.7290) {
    float face = smoothstep(0.7290, 0.7205, vM.y);
    /* the well is the only part of the underside that is not drilled */
    float wellMask = 1.0 - smoothstep(0.080, 0.110, length(vM.xz));

    /* The perforated band is 10 pixels tall in the graded still, so a realistic
       40-hole pitch aliases into a grey smear. Two rows of 5px holes is what
       actually reads as "drilled" at this size — the pitch is a lie, and the
       lie is the right one. */
    vec2 fu = fract(vec2(r, vM.y - 0.6400) / 0.0132) - 0.5;
    float eU = length(fu);
    float under = 1.0 - smoothstep(0.22, 0.40, eU);

    vec2 fr = fract(vec2(ang * 0.2620, vM.y) / 0.0132) - 0.5;
    float eR = length(fr);
    float ring = 1.0 - smoothstep(0.22, 0.40, eR);

    float ringMask = smoothstep(0.2330, 0.2460, r);
    float holes = mix(under * (1.0 - wellMask), max(under, ring), ringMask) * face;
    /* The band's OUTER RING is a turned ring with a chamfer top and bottom, so
       it catches more light than the wall above it. Dark holes on a lit band
       is the only way perforation reads at all; dark holes on a dark band is
       a smudge. Gated on the ring mask only -- applying it across the whole
       perforated region re-lit the downward-facing underside the shading above
       had just killed, and put a bright cone straight back under the plate. */
    c *= 1.0 + 1.05 * face * ringMask;

    /* A hole is a void. The burr is a thin bright arc just OUTSIDE the hole —
       the drilled lip catching the light — and it has to be outside, or every
       pixel between the holes lights up and the band becomes a bright woven
       ring instead of a dark perforated one. */
    c = mix(c, c * 0.10, holes);
    float burr = smoothstep(0.34, 0.42, eU) * (1.0 - smoothstep(0.42, 0.52, eU));
    float burrR = smoothstep(0.34, 0.42, eR) * (1.0 - smoothstep(0.42, 0.52, eR));
    c += uSpec * (burr + burrR * ringMask) * 0.20 * face * ringMask;
  }

  /* ---- edges ----------------------------------------------------------- */
  /* Two rims. The tight one is the silhouette itself, which is the only thing
     separating a black cylinder from a black rectangle; the wide one is the
     ember band wrapping round the far edge, and it is what gives the object
     volume without lighting the face. */
  /* nothing reaches the underside at all: no rim, no sky wrap, no ember
     bounce off the table, because the table is below the light */
  c *= 1.0 - 0.74 * under;
  c += uRim * pow(1.0 - ndv, 2.4) * 0.62 * (1.0 - under);
  c += uSpec * pow(1.0 - ndv, 8.0) * 0.30 * (1.0 - under);

  /* ember bounce off the wet table, from below — the bottom fifth of the phin
     only. At the old width it reached halfway up the cylinder and contributed
     more light than the key did. */
  c += vec3(0.155, 0.060, 0.020) * smoothstep(uKeyY, uKeyY - 0.14, vM.y) *
       (0.25 + 0.60 * nw);

  gl_FragColor = vec4(max(c, 0.0), 1.0);
}
`;

/* The drink, inside the glass. Opaque, drawn BEFORE the glass shell.
   Condensed milk genuinely is pale, but at 5am in a dark café it sits far
   below white — keeping it dark is what stops this being the brightest thing
   in the frame. */
/* The drink, inside the glass. Opaque, drawn BEFORE the glass shell.
 *
 * Three things it has to do that it did not do before:
 *   · be LAYERED — condensed milk at the bottom, dark coffee above it, and a
 *     bright meniscus line where they meet;
 *   · carry a SURFACE that rises over the loop and can therefore be struck by
 *     a drop, with a crown, a ring and a displaced meniscus at the impact;
 *   · stop being a flat colour. Ice, marbling and depth make it a drink.
 *
 * The surface height arrives in uSurf.x and the shader clips above it, so the
 * lathe can be built taller than the drink ever gets and the meniscus, the
 * ice line and the ripple all sit on the REAL surface. */
const LIQUID_FRAG = /* glsl */ `
precision highp float;
varying vec3 vN;
varying vec3 vP;
varying vec3 vM;

uniform vec3 uCream;
uniform vec3 uCoffee;
uniform vec4 uSurf;    /* x surface y, y ring radius, z ring amp, w crown amp */
uniform vec2 uStrat;   /* x cream top,    y impact x                         */

void main() {
  vec2 q = vec2(vM.x, vM.y);
  float surf = uSurf.x;
  if (vM.y > surf) discard;          /* air above the drink */

  float x = vM.x;
  float y = vM.y;

  /* ---- the two layers --------------------------------------------------
     Ca phe sua da is condensed milk under dark coffee. Keeping the contrast
     legible is what stops the glass reading as an empty plastic cup. */
  float cream = uStrat.x;
  float strat = smoothstep(cream - 0.008, cream + 0.018, y);
  vec3 liq = mix(uCream, uCoffee, strat);

  /* condensed milk marbling up into the coffee: the swirl is most of what
     makes a glass of this read as this and not as a glass of anything */
  float w = 0.5 + 0.5 * sin(x * 19.0 + 2.1) * sin(x * 7.3 - 0.6);
  float wisp = smoothstep(0.50, 0.95, w) *
               exp(-pow((y - (cream + 0.050)) * 6.0, 2.0));
  liq = mix(liq, liq + vec3(0.115, 0.080, 0.050), wisp * 0.55);

  /* depth: much less light reaches the bottom of a tall glass */
  float depth = clamp((y - 0.045) / 0.44, 0.0, 1.0);
  liq *= 0.50 + 0.58 * (1.0 - depth);

  /* ---- ice ------------------------------------------------------------- */
  float ice = 0.0;
  ice += 1.0 - smoothstep(0.0, 0.050,
        length(max(abs(q - vec2(-0.082, surf - 0.050)) - vec2(0.052, 0.036), 0.0)));
  ice += 1.0 - smoothstep(0.0, 0.042,
        length(max(abs(q - vec2(0.084, surf - 0.084)) - vec2(0.044, 0.030), 0.0)));
  ice *= step(0.060, y);
  liq = mix(liq, liq * 2.7 + vec3(0.020, 0.014, 0.009), ice * 0.40);

  /* ---- the meniscus where the layers meet ------------------------------
     This is the line that says "two liquids in a glass". At 0.95 it was
     invisible: the glass is 235px tall in the still, the boundary falls on
     about three pixels of it, and a 3-pixel line at 50% brightness is a
     suggestion. It has to be the brightest thing inside the drink. */
  liq += vec3(0.62, 0.395, 0.205) * exp(-pow((y - cream) * 120.0, 2.0)) * 2.10;
  liq += vec3(0.135, 0.086, 0.048) * exp(-pow((y - cream) * 20.0, 2.0));
  /* the settled edge of the milk against the wall */
  liq += vec3(0.20, 0.128, 0.070) * exp(-pow((y - cream) * 60.0, 2.0)) * 0.55;

  /* ---- the surface, seen edge-on --------------------------------------
     Under an orthographic camera a horizontal disc is a line, so the top of
     the drink is exactly what you would see looking at a tall glass: a bright
     line with the liquid climbing the wall just under it, and the ember band
     lying flat on it. */
  liq += vec3(0.68, 0.430, 0.215) * exp(-pow((y - surf + 0.003) * 150.0, 2.0)) * 1.35;
  /* the flat top of the drink, catching the window */
  liq += vec3(0.150, 0.088, 0.052) * smoothstep(surf - 0.026, surf, y) * 1.25;

  /* ---- the impact ------------------------------------------------------
     This is the payoff shot. A crown of droplets thrown up, a ring spreading
     out across the surface seen edge-on as a brightening that travels left and
     right, the wave running down the wall behind it, and a meniscus that dips
     at the strike point and rebounds. */
  float R = uSurf.y;
  float A = uSurf.z;
  float cr = uSurf.w;
  float d = abs(x - uStrat.y);

  /* The crest riding the waterline. The band is 1/78 model units tall, which is
     SIX PIXELS in the still — a ring drawn that thin disappears into the
     surface highlight it is supposed to be breaking up. A real ring on a drink
     catches light across the whole slope of its front, not on its crest, so
     this is a wide band centred on the surface with a tight core inside it. */
  float ring = exp(-pow((d - R) * 9.5, 2.0));
  float crest = exp(-pow((y - surf) * 34.0, 2.0));
  liq += vec3(1.00, 0.600, 0.280) * ring * A * crest * 3.60;
  liq += vec3(1.00, 0.660, 0.340) * ring * A * exp(-pow((y - surf) * 120.0, 2.0)) * 2.30;

  /* the wave running down the wall behind the crest, and the trough in front */
  float back = 1.0 - clamp(R / 0.215, 0.0, 1.0);
  liq += vec3(0.62, 0.360, 0.170) * ring * A * back *
         smoothstep(surf + 0.004, surf - 0.090, y) * 0.95;
  liq *= 1.0 - 0.34 * ring * A *
                smoothstep(surf - 0.004, surf + 0.034, d) * 0.9;

  /* the crown: a bright arc thrown up just above the waterline, plus beads */
  float crown = exp(-pow((d - R * 0.50) * 14.0, 2.0)) *
                exp(-pow((y - surf - 0.016) * 62.0, 2.0));
  liq += vec3(0.98, 0.600, 0.290) * crown * cr * 3.20;
  float beads = exp(-pow((d - R * 1.05) * 19.0, 2.0)) *
                exp(-pow((y - surf - 0.032) * 52.0, 2.0));
  liq += vec3(0.86, 0.510, 0.240) * beads * cr * 2.30;

  /* the displaced meniscus: the waterline dips at the strike point */
  liq *= 1.0 - 0.40 * cr * exp(-pow((d - R * 0.5) * 13.0, 2.0)) *
                exp(-pow((y - surf) * 42.0, 2.0));

  gl_FragColor = vec4(max(liq, 0.0), 1.0);
}
`;

/* The glass shell itself. Rendered AFTER the liquid with alpha transmission,
 * so the street genuinely shows through the body of the glass and only the
 * edges go opaque. That is what stops this reading as a plastic cup. */
const GLASS_FRAG = /* glsl */ `
precision highp float;
varying vec3 vN;
varying vec3 vP;
varying vec3 vM;

uniform vec3 uTint;
uniform vec3 uRim;
uniform vec3 uSpec;
uniform vec4 uSurf;    /* x surface y, y ring radius, z ring amp, w crown amp  */
uniform vec4 uRip;     /* x ripple age, y strength                               */

void main() {
  /* Analytic normal for a surface of revolution: using the interpolated vertex
     normal on a lathe facets visibly. */
  vec3 N = normalize(vec3(vM.x, 0.0, vM.z) + vec3(0.0, 0.0, 1e-5));
  float ndv = clamp(abs(vM.x) / 0.2520, 0.0, 1.0);
  float fres = pow(ndv, 2.4);

  /* Body: nearly clear, so the street and the drink read through it. */
  float a = 0.030 + 0.66 * fres;

  /* Two narrow speculars on opposite sides and a SEPARATE rim band, with
     headroom left so the speculars stay highlights. */
  float sp = exp(-pow((vM.x + 0.238) * 52.0, 2.0)) * 0.62
           + exp(-pow((vM.x - 0.244) * 66.0, 2.0)) * 0.22;

  vec3 rim = uRim * pow(fres, 5.0) * 0.80;

  /* Only the very foot of the glass is thick, so only the foot is milky. It
     used to run a sixth of the way up the glass, which is what made the whole
     object read as frosted plastic. */
  float base = 1.0 - smoothstep(0.0, 0.024, vM.y);
  a = max(a, base * 0.36);
  vec3 milk = uTint * base * 0.16;

  vec3 c = rim + uSpec * sp + milk;
  a = clamp(a + sp * 0.34, 0.0, 0.88);

  /* ---- the ripple, seen through the wall --------------------------------
     A ring spreading on a drink in a tall glass reads as a brightening
     travelling up and down the wall, which is why it lives here and not on a
     horizontal disc, which under an orthographic camera is a line. */
  float age = uRip.x;
  float amp = uRip.y;
  float band = exp(-pow((vM.y - uSurf.x) * 24.0, 2.0));
  float ring = exp(-pow((abs(vM.x) - age * 0.215) * 13.0, 2.0));
  float decay = (1.0 - age) * (1.0 - age);
  c += vec3(0.95, 0.56, 0.27) * band * ring * decay * amp * 0.55;

  gl_FragColor = vec4(c, a);
}
`;


/* THE DROP.
 *
 * This is the entire point of the piece, so it gets a real material rather
 * than a bright dot. A falling drop of coffee seen against a dark street has
 * three separable things on it, and it needs all three or it reads as a pixel:
 *
 *   1. a TIGHT specular from the ember band, on the side facing the light —
 *      this is what makes it visible at all against the background;
 *   2. a cool fresnel rim, which is the drop's edge catching the sky, and which
 *      is what separates it from the black it is falling through;
 *   3. refraction-in-miniature: the dark body is not black, it is the coffee,
 *      and it brightens where it is thin.
 *
 * uStretch drives the motion blur elongation. Under an orthographic camera a
 * sphere has no motion cue at all, so the stretch IS the velocity read.
 */
const DROP_FRAG = /* glsl */ `
precision highp float;
varying vec3 vN;
varying vec3 vP;
uniform vec3 uCore;
uniform vec3 uHot;
uniform float uStretch;

void main() {
  vec3 N = normalize(vN);
  vec3 V = vec3(0.0, 0.0, 1.0);
  float ndv = max(0.0, dot(N, V));

  /* the ember band in the window, warm, from the right and slightly above */
  vec3 L = normalize(vec3(0.62, 0.40, 0.68));
  float nl = max(0.0, dot(N, L));

  /* Body: dark coffee, brightening toward the edge where the liquid is thin. */
  float fres = pow(1.0 - ndv, 2.2);
  vec3 c = mix(uCore, vec3(0.32, 0.150, 0.072), fres);

  /* the tight specular — small, hot, off-centre */
  float sp = pow(nl, 26.0);
  c += uHot * sp * 1.30;
  /* a second, broader sheen so the drop has a lit side as well as a hot point */
  c += uHot * pow(nl, 3.4) * 0.24;

  /* The rim: the drop's edge against the sky. This is what draws its shape,
     and on a background this dark it has to be strong -- a drop lit only by a
     specular is a bright dot with no object around it.

     LEGIBILITY NOTE. The drop falls INSIDE the glass, so it is read through
     the transmissive shell, against a near-black ground, at roughly 18px. At
     the previous strengths it measured as a dark oval and the eye filed it as
     a bubble rather than as falling coffee — which defeats the entire piece.
     The rim and the silhouette line are therefore lifted hard: a wet drop at
     5am is one of the few genuinely specular things in frame, and it should
     read as a lit bead from across the room. */
  c += vec3(0.86, 0.62, 0.42) * pow(1.0 - ndv, 2.2) * 1.55;
  /* and a thin hot line right at the silhouette */
  c += vec3(1.00, 0.80, 0.58) * pow(1.0 - ndv, 7.0) * 1.45;
  /* A wide, weak sheen across the body so the drop has volume rather than
     reading as an outline with nothing behind it. */
  c += uHot * pow(nl, 1.8) * 0.30;

  /* A drop accelerating downward elongates, and the elongation brightens the
     leading end. Without this the fall has no velocity in a still frame. */
  float lead = smoothstep(0.0, 1.0, clamp(vP.y * 0.0 + uStretch, 0.0, 1.0));
  c += uHot * lead * pow(nl, 8.0) * 0.16;

  gl_FragColor = vec4(c, 1.0);
}
`;

/* The thread left behind for a moment after release: a very thin tapering
   stream from the plate down to the falling drop. Open-ended cone, additive,
   and only alive for the first fifth of the fall. */
const TAIL_FRAG = /* glsl */ `
precision highp float;
varying vec3 vN;
varying vec3 vP;
uniform vec3 uColor;
uniform float uAmp;

void main() {
  vec3 N = normalize(vN);
  float ndv = max(0.0, dot(N, vec3(0.0, 0.0, 1.0)));
  /* bright along the lit edge, transparent down the middle — a thread of
     liquid is a lens, not a rod */
  float edge = pow(1.0 - ndv, 1.6);
  float a = (0.16 + 0.84 * edge) * uAmp;
  gl_FragColor = vec4(uColor * a, a);
}
`;

/* The crown thrown up where the drop lands: a torus facing the camera, so it
 * reads as a ring of water standing on the surface. Under an orthographic
 * camera a horizontal annulus would be a line — this one is vertical on
 * purpose, because that is how a crown of splash actually reads to a viewer
 * looking at a glass from the side. */
const CROWN_FRAG = /* glsl */ `
precision highp float;
varying vec3 vN;
varying vec3 vP;
uniform vec3 uColor;
uniform float uAmp;

void main() {
  vec3 N = normalize(vN);
  vec3 L = normalize(vec3(0.60, 0.42, 0.68));
  float nl = max(0.0, dot(N, L));
  float sp = pow(nl, 12.0);
  float a = (0.22 + 0.78 * sp) * uAmp;
  gl_FragColor = vec4(uColor * a, a);
}
`;

const GLOW_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec3 uColor;
uniform float uAmp;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float a = exp(-d * d * 2.6) * uAmp;
  /* Exactly zero at the quad's edge.
   *
   * exp(-2.6) is 0.074, not 0, so the sprite was still adding 2% of a warm
   * colour where it stopped — and a quad is a hard boundary. On a 900x1600
   * portrait frame that showed as a bright orange edge running clean across
   * the picture with haze above it and haze below it, which read as a horizon
   * line drawn with a ruler. The ramp costs nothing and removes the seam. */
  a *= 1.0 - smoothstep(0.62, 1.0, d);
  gl_FragColor = vec4(uColor * a, a);
}
`;

/* ========================================================================== */
/* geometry                                                                   */
/* ========================================================================== */

/* THE PHIN — phin pha ca phe, the Vietnamese drip filter.
 *
 * Profile in (radius, height). This is a REBUILD, not a tweak: the old profile
 * was a smooth dome with a knob on top, which is the silhouette of a teapot
 * lid and reads as one. A real phin is four turned stainless parts and nothing
 * else:
 *
 *   y 0.640  the lowest point of the drip well, dead centre of the underside.
 *            It hangs 0.016 BELOW the glass rim (0.656) so the drop has to be
 *            seen falling down a slot between the plate and the glass wall.
 *   y 0.692  outer bottom edge of the perforated plate: radius 0.2655,
 *            which is 1.134x the glass bore (0.234), so the plate visibly
 *            RESTS ON the rim instead of sinking into the glass.
 *   y 0.718  the plate band. Perforated, and it is the bottom 11% of the
 *            whole object, which is exactly where a phin's holes live.
 *   y 0.762  the cylinder wall starts: radius 0.2280, CONSTANT all the way
 *            up. No taper, no dome, no curve.
 *   y 1.355  the cylinder wall ends. 0.5930 tall against a 0.4560 diameter is
 *            a height:width of 1.300 — a real phin is about 1.3x as tall as
 *            it is wide, and getting this ratio right is most of why the
 *            object now reads as a filter.
 *   y 1.369  the lid seats. A chamfer, not a shoulder.
 *   y 1.389  the FLAT lid: radius 0.2510, i.e. 1.101x the body radius, so it
 *            overhangs by 0.023 and reads as a separate disc lying on top. It
 *            is 0.020 thick and completely flat, and the material lights its
 *            upward face from the sky so the plane reads as a plane.
 *   y 1.433  the finial: a turned knob, 0.032 tall, max radius 0.043.
 *
 * Total height 0.793 against a 0.656 glass: the phin is slightly taller than
 * the glass it stands on, which is what it is in life.
 */
const PHIN_PROFILE = [
  /* --- the drip well: a SHORT cone down to the outlet, then a flat annulus.
     The first profile ran a smooth 0.052-unit cone from the centre to the rim,
     which under a lit-from-above key renders as a bright inverted pyramid —
     unmistakably a LAMPSHADE. A real phin's underside is nearly flat: a small
     recessed well at the centre, a flat plate around it, and a turned rim. --- */
  [0.0000, 0.6400], [0.0250, 0.6418], [0.0480, 0.6448], [0.0700, 0.6480],
  [0.0880, 0.6512], [0.0980, 0.6538],
  /* the flat plate: barely any slope at all from here to the rim */
  [0.1400, 0.6570], [0.1850, 0.6602], [0.2250, 0.6632], [0.2480, 0.6652],
  /* --- plate rim, a flat annulus you can see the phin standing on ------ */
  [0.2600, 0.6690], [0.2655, 0.6760],
  /* --- the perforated band: 0.676 → 0.7175, radius constant ------------- */
  [0.2655, 0.7175],
  /* --- the step up onto the body wall ---------------------------------- */
  [0.2590, 0.7250], [0.2380, 0.7315], [0.2320, 0.7430], [0.2280, 0.7620],
  /* --- THE CYLINDER: constant radius 0.2280, 0.5930 tall -------------- */
  [0.2280, 1.3550],
  /* --- lid seat, flat lid, turned finial ------------------------------ */
  [0.2300, 1.3630], [0.2470, 1.3690], [0.2510, 1.3810], [0.2510, 1.3890],
  [0.2420, 1.3950], [0.1300, 1.3990], [0.0580, 1.4010], [0.0430, 1.4070],
  [0.0390, 1.4210], [0.0270, 1.4290], [0.0000, 1.4330],
];

/* The furthest-out radius of the phin, used by measure() to solve framing. */
const PHIN_HALF_W = 0.2655;
/* The lowest point of the phin: where a drop forms and where it detaches. */
const PHIN_TIP_Y = 0.6400;

/* A tall iced-coffee glass: real shell, so the rim catches a highlight. */
const GLASS_PROFILE = [
  [0.0, 0.0], [0.180, 0.0], [0.235, 0.006], [0.262, 0.024], [0.268, 0.060],
  [0.252, 0.080], [0.246, 0.140], [0.248, 0.300], [0.252, 0.460],
  [0.256, 0.560], [0.258, 0.640], [0.256, 0.652], [0.238, 0.656],
  [0.234, 0.600], [0.230, 0.440], [0.226, 0.260], [0.222, 0.120],
  [0.206, 0.070], [0.150, 0.044], [0.0, 0.040],
];

/* The liquid inside it. Built deliberately TALLER than the drink ever gets —
 * up to 0.560, while the surface runs between 0.352 and 0.392 — and LIQUID_FRAG
 * discards everything above uSurf.x. That is what lets the surface actually
 * RISE over the loop with a real, animated meniscus and a real surface for the
 * drop to land on, instead of a fixed painted line.
 *
 * Radius is inset from the glass bore (0.2264 at this height) so the drink
 * never z-fights the wall. */
const LIQUID_PROFILE = [
  [0.000, 0.046], [0.140, 0.048], [0.196, 0.074], [0.210, 0.124],
  [0.213, 0.260], [0.214, 0.400], [0.215, 0.500], [0.216, 0.556],
  [0.150, 0.560], [0.000, 0.560],
];

function lathe(profile, segments) {
  const pts = profile.map(([x, y]) => new THREE.Vector2(x, y));
  const g = new THREE.LatheGeometry(pts, segments);
  g.computeVertexNormals();
  return g;
}

/* ========================================================================== */
/* the module state                                                           */
/* ========================================================================== */

const DIAG = { hero: { mode: "off", lite: false, frames: 0, ms: 0 } };
/* main.js owns window.__diag; publish this track's numbers onto it so there is
   one diagnostic surface for the whole site, per the contracts section. */
if (typeof window !== "undefined") {
  window.__diag = window.__diag || {};
  window.__diag.hero = DIAG.hero;
}

let built = false;
let failed = false;
let running = false;
let everRendered = false;
/* Diagnostic-only switch: suppresses the drip entirely so the effect of the
   drip can be isolated by differencing two real renders. Always false in
   production; nothing else in the file reads it. */
let noDrip = false;

/* Cached size — never read layout inside the loop. */
const size = { w: 1, h: 1, asp: 1, dpr: 1, pxW: 1, pxH: 1 };

let renderer = null;
let rtA = null;
let rtB = null;
let cityPass = null;
let copyPass = null;
let rainPass = null;
let gradePass = null;
let fgScene = null;
let fgCam = null;
let rainMesh = null;
let phinGroup = null;
let glassGroup = null;
let fgGlassScene = null;
let dropMesh = null;
let tailMesh = null;
let crownMesh = null;
/* Hoisted: the drip writes uStretch every frame and reaching through the mesh
   to .material.uniforms would be a property walk per frame for no reason. */
let dropMat_uniforms = null;
let tableMesh = null;
let glowMesh = null;

/* Vector uniforms start as plain literals and are swapped for real THREE
   instances inside loadThree(). three uploads vec2/vec4 uniforms by reading
   .x/.y/.z/.w, so these behave identically — but constructing them at module
   scope would mean touching THREE at import time, which is exactly what the
   lazy load exists to avoid. */
const U = {
  P: { value: 0 },
  LIFT: { value: 0 },
  WIN: { value: 0.05 },
  ASP: { value: 1.6 },
  RES: { value: { x: 1, y: 1, set(x, y) { this.x = x; this.y = y; return this; } } },
  EXPO: { value: 0.86 },
  CHROMA: { value: 0.0017 },
  SIZE: { value: 1 },
  RIP: {
    value: {
      x: 0, y: 0, z: 0, w: 0,
      set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; },
    },
  },
  /* x = surface y, y = ring radius, z = ring amplitude, w = crown amplitude */
  SURF: {
    value: {
      x: 0.470, y: 0, z: 0, w: 0,
      set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; },
    },
  },
  /* x0, x1 = plateau edges in uv; z = falloff width; w = depth of attenuation.
     Written in measure(), which is layout, not animation. */
  SUBJ: {
    value: {
      x: 0, y: 0, z: 0.05, w: 0.82,
      set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; },
    },
  },
  /* x = condensed-milk top, y = impact x */
  STRAT: {
    value: {
      x: 0.150, y: 0,
      set(x, y) { this.x = x; this.y = y; return this; },
    },
  },
};

/* --------------------------------------------------------------------------
 * THE DRIP — the reason the piece exists.
 *
 * One slot at a time, so at most one drop is ever in flight: that is how a phin
 * behaves, and three drops falling at once reads as a leaking tap. A slot is
 * one drip, and the beats within it are:
 *
 *   delay   0 – 0.07  the pause. HASHED, so the rhythm is irregular — a real
 *                     phin goes drip-drip, pause, drip, and a metronome is the
 *                     single thing that would give the loop away as synthetic.
 *   SWELL   0.08      a bead gathers under a hole and hangs, growing
 *   NECK    0.05      it necks off and the thread thins
 *   FALL    0.58      detached, accelerating under gravity, tail behind it
 *   RIPPLE  0.22      crown, expanding ring, displaced meniscus
 *
 * 0.07 + 0.08 + 0.05 + 0.58 + 0.22 = 1.00 exactly. That exactness is not
 * tidiness, it is the seam guarantee: a slot is a closed cycle that has fully
 * finished — bead gone, ring faded — before the next one starts, so slot
 * DRIP_SLOTS-1 is completely dead at p = 1 and nothing is in flight at p = 0.
 * The earlier schedule let the hashed fall length push the ripple past the slot
 * boundary, where the next slot's phase calculation overwrote it, and the
 * ripple silently disappeared in roughly a third of all slots.
 *
 * FALL gets 58% of the slot deliberately. A real drop crosses that gap in about
 * a third of a second and would be in frame maybe one frame in twenty; the
 * brief asks for a slow cycle with a visible drop, so the fall is stretched to
 * about 1.7s and gravity is kept honest in shape (u²) rather than in rate.
 */
const DRIP_SLOTS = 10;
const SWELL = 0.08;
const NECK = 0.05;
const FALL = 0.58;
const DRIP_FALL = FALL;
const DRIP_RIPPLE = 0.22;
const DRIP_DELAY = 0.07;

/* Phase table, filled in draw(). Reading these in the diagnostic surface is how
 * "is a drop actually visible" gets answered by measurement rather than by
 * squinting at a screenshot. */
const DRIP_STATE = { swell: 0, neck: 0, fall: 0, ripple: 0 };

function dripAt(p) {
  const n = p * DRIP_SLOTS;
  let slot = Math.floor(n);
  if (slot >= DRIP_SLOTS) slot = DRIP_SLOTS - 1;
  const t = n - slot;

  /* Zero delay on the last slot, so nothing at all straddles the wrap even
     before the beat arithmetic closes. Belt and braces: the schedule already
     fits inside a slot, and this guarantees it cannot start straddling. */
  const delay = slot >= DRIP_SLOTS - 1 ? 0 : DRIP_DELAY * hash(slot * 7 + 3);
  let s = t - delay;

  /* this drop's own size — hashed, so consecutive drops are not identical */
  const size = 0.74 + 0.58 * hash(slot * 13 + 5);

  const st = { slot, size, swell: 0, neck: 0, u: -1, age: -1, live: false, ripple: false };

  if (s >= 0 && s < SWELL) {
    st.swell = s / SWELL;
    st.live = true;
    return st;
  }
  s -= SWELL;
  if (s >= 0 && s < NECK) {
    st.neck = s / NECK;
    st.live = true;
    return st;
  }
  s -= NECK;
  if (s >= 0 && s <= FALL) {
    st.u = s / FALL;
    st.live = true;
    return st;
  }
  s -= FALL;
  if (s >= 0 && s <= DRIP_RIPPLE) {
    st.age = s / DRIP_RIPPLE;
    st.ripple = true;
  }
  return st;
}

/* ========================================================================== */
/* build                                                                      */
/* ========================================================================== */

function makePass(frag, uniforms, extra) {
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: FS_VERT,
    fragmentShader: frag,
    depthTest: false,
    depthWrite: false,
    ...extra,
  });
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { scene, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), mat };
}

/* ---- the droplet field: built once, never mutated ------------------------ */
function buildRain(lite) {
  const count = lite ? QUALITY.lite.drops : QUALITY.full.drops;
  const aC = new Float32Array(count * 4);
  const aP = new Float32Array(count * 4);
  const aQ = new Float32Array(count * 4);

  for (let i = 0; i < count; i++) {
    const o = i * 4;
    /* water collects at the edges of a pane */
    const zone = hash(i * 5 + 1);
    let x;
    if (zone < 0.34) x = 0.018 + 0.215 * hash(i * 5 + 2);
    else if (zone < 0.58) x = 0.225 + 0.55 * hash(i * 5 + 2);
    else x = 0.765 + 0.217 * hash(i * 5 + 2);

    let phase = hash(i * 5 + 3);
    let rate = 0;
    let size = 0.0034 + 0.0026 * hash(i * 5 + 4);
    let trail = 0;
    let opacity = 0.5;

    const pick = hash(i * 11 + 9);
    if (pick > 0.955) {
      /* a few hero drops: big, slow, with a real lens */
      rate = 1;
      size = 0.0165 + 0.005 * hash(i * 11 + 10);
      trail = 2.6 + 1.4 * hash(i * 11 + 11);
      opacity = 0.96;
    } else if (pick > 0.66) {
      /* Halved size in both runner bands: a wide bead catches a big specular
         that lands under the headline. Small beads catch the same light over
         fewer pixels. */
      rate = 1;
      size = 0.0036 + 0.0021 * hash(i * 11 + 10);
      trail = 1.5 + 1.6 * hash(i * 11 + 11);
      opacity = 0.86;
    } else if (pick > 0.40) {
      rate = 2;
      size = 0.0026 + 0.0016 * hash(i * 11 + 10);
      trail = 1.2 + 1.4 * hash(i * 11 + 11);
      opacity = 0.72;
    } else if (pick > 0.26) {
      rate = 3;
      size = 0.0022 + 0.0014 * hash(i * 11 + 10);
      trail = 0.7 + 0.9 * hash(i * 11 + 11);
      opacity = 0.6;
    } else {
      /* clinging beads that never move */
      rate = 0;
      size = 0.0026 + 0.0026 * hash(i * 11 + 10);
      trail = 0;
      opacity = 0.42;
    }

    aC[o] = x;
    aC[o + 1] = phase;
    aC[o + 2] = size;
    aC[o + 3] = trail;
    aP[o] = phase;
    aP[o + 1] = rate;
    aP[o + 2] = opacity;
    aP[o + 3] = hash(i * 13 + 2);
    aQ[o] = phase;   /* replaced below for merge pairs */
    aQ[o + 1] = 0;
    aQ[o + 2] = 0;
    aQ[o + 3] = hash(i * 13 + 5);
  }

  /* merge pairs: a heavy slow bead and a fast runner that swallows it */
  for (let i = 0; i + 1 < count; i += 5) {
    const a = i * 4;
    const b = (i + 1) * 4;
    aP[b + 1] = 2 + (hash(i * 3 + 8) > 0.5 ? 1 : 0);
    aP[b + 2] = 0.8;
    aC[b + 2] = 0.0044;
    aC[b + 3] = 1.4;
    /* each needs the other's trajectory; aQ.z says who is who */
    aQ[a] = aC[b + 1];
    aQ[a + 1] = aP[b + 1];
    aQ[a + 2] = 1;
    aQ[b] = aC[a + 1];
    aQ[b + 1] = aP[a + 1];
    aQ[b + 2] = -1;
  }

  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute("position", base.getAttribute("position"));
  geo.setAttribute("aC", new THREE.InstancedBufferAttribute(aC, 4));
  geo.setAttribute("aP", new THREE.InstancedBufferAttribute(aP, 4));
  geo.setAttribute("aQ", new THREE.InstancedBufferAttribute(aQ, 4));
  geo.instanceCount = count;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 8);

  return geo;
}

function build() {
  const lite = ENV.lite === true;
  const q = lite ? QUALITY.lite : QUALITY.full;

  const canvas = document.getElementById("hero-canvas");
  const stage = document.querySelector(".hero-stage");
  if (!canvas || !stage) throw new Error("hero stage not found");

  /* preserveDrawingBuffer costs real bandwidth on some drivers, so it is only
   * enabled on demand: `?poster=1` lets tools/poster.mjs capture this exact
   * frame with toDataURL without making every visitor pay for it. */
  const wantPoster = new URLSearchParams(location.search).has("poster");

  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    powerPreference: lite ? "low-power" : "high-performance",
    preserveDrawingBuffer: wantPoster,
  });
  renderer.autoClear = false;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x0d0805, 1);

  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    stop();
    revealPoster();
  });

  const rtOpts = {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  };
  rtA = new THREE.WebGLRenderTarget(1, 1, rtOpts);
  rtB = new THREE.WebGLRenderTarget(1, 1, rtOpts);

  cityPass = makePass(CITY_FRAG, {
    uP: U.P, uLift: U.LIFT, uWin: U.WIN, uAsp: U.ASP, uSubj: U.SUBJ,
  });
  copyPass = makePass(/* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uTex;
    void main(){ gl_FragColor = texture2D(uTex, vUv); }
  `, { uTex: { value: rtA.texture } });

  const rainUniforms = {
    uP: U.P, uAsp: U.ASP, uRes: U.RES, uSize: U.SIZE,
    uTrail: { value: lite ? 0 : 1 },
    uTex: { value: rtA.texture },
    uBend: { value: lite ? 0.75 : 1.0 },
  };
  rainPass = makePass(RAIN_FRAG, rainUniforms, {
    vertexShader: RAIN_VERT,
    transparent: true,
    blending: THREE.NormalBlending,
  });
  rainMesh = new THREE.Mesh(buildRain(lite), rainPass.mat);
  rainMesh.frustumCulled = false;
  rainPass.scene.add(rainMesh);

  gradePass = makePass(GRADE_FRAG, {
    uTex: { value: rtB.texture },
    uRes: U.RES, uP: U.P, uLift: U.LIFT,
    uExpo: U.EXPO, uChroma: U.CHROMA,
  });

  buildForeground(lite);

  U.SIZE.value = lite ? 0.82 : 1.0;
  DIAG.hero.mode = "built";
  DIAG.hero.lite = lite;
  DIAG.hero.drops = lite ? QUALITY.lite.drops : QUALITY.full.drops;

  measure(q.dpr);
  built = true;
}

function buildForeground(lite) {
  const seg = lite ? 26 : 44;

  fgScene = new THREE.Scene();
  fgGlassScene = new THREE.Scene();
  fgCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -20, 20);

  /* --- the phin -------------------------------------------------------
   * Brushed stainless, not aluminium and emphatically not ceramic. The old
   * uBase was a warm near-black which, under a single warm key, resolved to
   * beige; the new one is neutral and the warmth comes from the light, which
   * is the only way a metal gets to be warm. uSky is the cold half: without a
   * second colour temperature the surface has no cool side to be warm against
   * and reads as painted plaster however bright the highlight is. */
  const phinMat = new THREE.ShaderMaterial({
    uniforms: {
      uBase: { value: new THREE.Color(0.0460, 0.0478, 0.0530) },
      uRim: { value: new THREE.Color(0.50, 0.34, 0.215) },
      uSpec: { value: new THREE.Color(0.95, 0.80, 0.62) },
      uSky: { value: new THREE.Color(0.072, 0.090, 0.124) },
      uKeyY: { value: 0.760 },
    },
    vertexShader: LATHE_VERT,
    fragmentShader: METAL_FRAG,
  });
  const phin = new THREE.Mesh(lathe(PHIN_PROFILE, seg), phinMat);

  /* --- the glass ------------------------------------------------------ */
  /* The glass shell, drawn in a SECOND scene after everything opaque. Alpha
     transmission is what lets the street show through it; with a depth buffer
     and a single scene it would sort against the phin unpredictably, so the two
     groups are separated by render order instead. */
  /* The glass shell. More segments than the rest of the scene: it is a small
     mesh, so the silhouette smoothness is nearly free, and a faceted silhouette
     is the first thing that reads as "3D model" rather than "photograph". */
  const glassMat = new THREE.ShaderMaterial({
    uniforms: {
      uTint: { value: new THREE.Color(0.26, 0.208, 0.166) },
      uRim: { value: new THREE.Color(0.74, 0.56, 0.40) },
      uSpec: { value: new THREE.Color(0.96, 0.86, 0.72) },
      uRip: U.RIP,
      uSurf: U.SURF,
    },
    vertexShader: LATHE_VERT,
    fragmentShader: GLASS_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const glass = new THREE.Mesh(lathe(GLASS_PROFILE, lite ? 40 : 72), glassMat);

  /* --- the drink, opaque, drawn before the shell ----------------------
   * Layered, and rising over the loop: the surface is clipped in the shader,
   * so this is a real moving waterline rather than a painted one. Condensed
   * milk genuinely is pale — pale RELATIVE to the coffee. Keeping both ends
   * dark is what stops this being the brightest thing in the frame. */
  const liquidMat = new THREE.ShaderMaterial({
    uniforms: {
      uCream: { value: new THREE.Color(0.345, 0.250, 0.172) },
      uCoffee: { value: new THREE.Color(0.0400, 0.0215, 0.0128) },
      uSurf: U.SURF,
      uStrat: U.STRAT,
    },
    vertexShader: LATHE_VERT,
    fragmentShader: LIQUID_FRAG,
  });
  const liquid = new THREE.Mesh(lathe(LIQUID_PROFILE, seg), liquidMat);

  /* --- the drop in flight --------------------------------------------
   * A 14x10 sphere, not 8x6. It is the only bright object in the lower right
   * and it is roughly 6px across in the graded still, so its silhouette has
   * to survive that. Segments are per-tier: lite drops to 10x7, full keeps 14. */
  const dropMat = new THREE.ShaderMaterial({
    uniforms: {
      uCore: { value: new THREE.Color(0.052, 0.028, 0.018) },
      uHot: { value: new THREE.Color(1.0, 0.80, 0.55) },
      uStretch: { value: 0 },
    },
    vertexShader: LATHE_VERT,
    fragmentShader: DROP_FRAG,
  });
  dropMat_uniforms = dropMat.uniforms;
  dropMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, lite ? 10 : 14, lite ? 7 : 11),
    dropMat
  );
  dropMesh.visible = false;

  /* --- the thread left behind after release ---------------------------
   * An open-ended cone, apex up at the plate, widening down to the drop. It
   * only lives for the first fifth of the fall, and it is what makes the fall
   * read as a drip off an edge rather than as a sphere moving downward. */
  tailMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0022, 1.0, 1.0, lite ? 6 : 10, 1, true),
    new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0.62, 0.36, 0.19) },
        uAmp: { value: 0 },
      },
      vertexShader: LATHE_VERT,
      fragmentShader: TAIL_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  tailMesh.visible = false;

  /* --- the crown at the moment of impact -----------------------------
   * A torus facing the camera. It is the only element that reads as splash
   * rather than as a brightening, and it only exists for the first 30% of the
   * ripple — after that the ring has taken over. */
  /* Unit-radius torus so that mesh.scale IS the radius in model units. The
   * previous geometry carried its own 0.030 radius and the scale was then
   * multiplied on top of it, so the crown's actual radius was 0.030 × 0.035 =
   * 0.001 model units — about a third of a pixel. It had never been visible. */
  crownMesh = new THREE.Mesh(
    new THREE.TorusGeometry(1.0, 0.19, lite ? 5 : 7, lite ? 16 : 26),
    new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(1.0, 0.60, 0.28) },
        uAmp: { value: 0 },
      },
      vertexShader: LATHE_VERT,
      fragmentShader: CROWN_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  crownMesh.visible = false;

  /* --- the table: a dark out-of-focus foreground mass ------------------ */
  /* A short band hugging the bottom edge: the café table, catching one warm
     reflection from the glass standing on it. Deliberately shallow — it must
     anchor the phin without ever eating the street behind it. */
  tableMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(5.6, 1.15),
    new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: SPRITE_VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        void main() {
          /* depth = 0 at the near lip, 1 at the far edge: the table recedes */
          float depth = smoothstep(0.86, 0.18, vUv.y);
          vec3 c = vec3(0.0165, 0.0102, 0.0076) * (0.34 + 0.66 * depth);
          /* one warm reflection pooling directly under the glass (vUv.x 0.5 is
             the table's centre, which is where the glass stands) */
          float pool = exp(-pow((vUv.x - 0.5) * 6.4, 2.0)) *
                       exp(-pow((vUv.y - 0.74) * 4.4, 2.0));
          c += vec3(0.85, 0.36, 0.13) * pool * 0.95;
          /* the faintest grain of the wood */
          c *= 1.0 + 0.055 * sin(vUv.x * 37.0);
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    })
  );
  /* The glass stands ON this, so its lit top edge has to be inside the frame —
     otherwise the phin reads as floating, and as a crop rather than a
     composition. Placed so the top edge sits just under the glass foot. */
  tableMesh.position.set(0, -0.60, -0.5);

  /* --- the ember pool: the café's own light, out of frame --------------- */
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0.98, 0.44, 0.17) },
        uAmp: { value: 0.30 },
      },
      vertexShader: SPRITE_VERT,
      fragmentShader: GLOW_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    })
  );
  glowMesh = glow;
  glowMesh.scale.set(1.5, 1.05, 1);
  glowMesh.position.set(0, -0.58, 0.4);

  phinGroup = new THREE.Group();
  /* Opaque pass: table, phin, drink, drop, tail, crown, glow. Render order is
     the sort order and there is no depth buffer, so this list IS the paint
     order: the drink has to go down before the drop that falls onto it, and
     the thread has to go down before the drop that hangs off its end. */
  phinGroup.add(tableMesh, phin, liquid, tailMesh, dropMesh, crownMesh, glow);
  fgScene.add(phinGroup);
  /* Transparent pass: the glass shell, so it composites over all of the above. */
  glassGroup = new THREE.Group();
  glassGroup.add(glass);
  fgGlassScene.add(glassGroup);
}

/* ========================================================================== */
/* sizing                                                                     */
/* ========================================================================== */

function measure(capDpr) {
  if (!renderer) return;
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  const govern = window.__govern;
  const cap = govern?.dprCap;
  const dpr = Math.min(window.devicePixelRatio || 1, cap || 2, capDpr);

  size.w = w;
  size.h = h;
  size.asp = w / h;
  size.dpr = dpr;
  size.pxW = Math.max(1, Math.round(w * dpr));
  size.pxH = Math.max(1, Math.round(h * dpr));

  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  rtA.setSize(size.pxW, size.pxH);
  rtB.setSize(size.pxW, size.pxH);

  U.ASP.value = size.asp;
  U.RES.value.set(size.pxW, size.pxH);

  /* Framing.
   *
   * Two layouts, both SOLVED rather than eyeballed.
   *
   * The subject's own extents are read from the profile: half-width
   * PHIN_HALF_W = 0.2655 (the perforated plate, the widest thing on it) and
   * total height 1.433 (the top of the finial) plus the 0.656 glass below it.
   * The old 0.33 and 1.154 were the widest point and the height of the old
   * domed lid, so leaving them would have pushed the plate off the right edge
   * and cropped the finial.
   *
   * LANDSCAPE (asp >= 1.05): subject in the lower right, the whole silhouette
   * inside the frame, with a 9%-of-frame-width margin.
   *
   * PORTRAIT: a tall viewport has no room beside the copy, so the subject moves
   * UP into the top third and the city, the road and the dawn band get the
   * lower half to themselves. y is solved from the MEASURED headline position.
   */
  const SUBJECT_H = 1.433;      /* top of the finial, in model units */
  const wide = Math.min(1, size.asp / 1.15);
  const portrait = size.asp < 1.05;

  let s, gx, gy;
  if (portrait) {
    /* PORTRAIT: the subject goes in the top band and the city keeps the rest.
     *
     * It used to be solved UP FROM THE MEASURED HEADLINE, which on a phone
     * means the only available band is the 19% of the frame above the h1 — so
     * the phin came out 46 pixels wide, a thumbnail in an empty sky. A phone
     * does not have room beside the copy; it has room BEHIND it. The portrait
     * scrim is already 0.82-alpha over the top third, so the subject sits
     * behind the copy, dimmed, and the copy still measures well above 4.5:1 —
     * which tools/ contrast.mjs re-checks at every position of the loop
     * rather than being assumed here.
     *
     * FOOT is the glass's foot in world y. It is solved so the subject's top
     * lands just under the frame edge and its foot stops well above the road,
     * which is what keeps the wet asphalt and the light trails readable. */
    const LID = 0.955;
    const FOOT = 0.330;
    /* Width clamp: the subject's half-width against the frame's half-width,
       i.e. s < asp / (2 * PHIN_HALF_W). It used to compare the FULL width
       against the FULL frame — four times too tight. */
    const widthFit = Math.min(1, size.asp / (2 * PHIN_HALF_W));
    s = ((LID - FOOT) / SUBJECT_H) * widthFit;
    gy = FOOT;
    const halfW = PHIN_HALF_W * s;
    const margin = 0.10 * 2 * size.asp;
    gx = Math.min(size.asp * 0.52, size.asp - margin - halfW);
  } else {
    /* 0.95, not 0.78. At 0.78 the phin's perforated plate was 8 pixels across
       in a 1600x1000 still, which is below the threshold where a stranger can
       tell a filter from a thermos. */
    s = 0.95 * wide;
    const halfW = PHIN_HALF_W * s;
    const margin = 0.09 * 2 * size.asp;
    gx = Math.min(size.asp * 0.60, size.asp - margin - halfW);
    gy = -0.86;                                  /* glass foot on the lit table */
  }

  phinGroup.scale.setScalar(s);
  phinGroup.position.set(gx, gy, 0);
  glassGroup.scale.setScalar(s);
  glassGroup.position.set(gx, gy, 0);
  /* Tell the city pass which column of the frame the subject occupies, so it
     can hold the bright street detail back from directly behind the glass.
     Solved in uv, from the same gx/s the geometry uses, so it cannot drift out
     of agreement with where the phin actually is. */
  /* The plateau is the GLASS bore (0.238 model units at the rim), not the
     plate: the plate overhangs the glass by 0.03 on each side, and using its
     width meant the attenuation barely reached the wall the street was
     actually showing through. */
  const halfU = (0.238 * s) / (2 * size.asp);
  const midU = (gx / (2 * size.asp)) + 0.5;
  U.SUBJ.value.set(midU - halfU, midU + halfU, halfU * 1.9, 0.82);
  fgCam.left = -size.asp;
  fgCam.right = size.asp;
  fgCam.top = 1;
  fgCam.bottom = -1;
  fgCam.updateProjectionMatrix();
  /* THE TABLE — and this was a real bug in portrait.
   *
   * The table mesh is a CHILD of phinGroup, so its position is in model units
   * and gets multiplied by the group's scale. Portrait used to place it at
   * gy - 0.90, which is a world-space-looking number applied as a local one:
   * on a 900x1600 frame that put the top edge of the table at v = 0.56, a
   * bright horizontal slab floating in the middle of the sky with the city
   * visible both above and below it. It read as a horizon line drawn with a
   * ruler, and it was the single most artificial thing in the phone still.
   *
   * Correct construction: the table is under the glass, so its TOP EDGE goes
   * just below the glass foot and it falls away off the bottom of the frame.
   * -0.595 local puts the top edge 0.02 model units below the foot, and the
   * same number works in both layouts because the child-space relationship to
   * the foot is what matters. It is also x-offset to gx so the warm pool in
   * its shader lands under the glass rather than under the frame centre. */
  tableMesh.scale.set(portrait ? 1.9 : 1, portrait ? 0.60 : 1, 1);
  tableMesh.position.set(gx, -0.595, -0.5);
  /* The ember pool is a single quad, so its aspect has to be corrected for the
   * frame or it renders as a hard-edged BAR: at 0.5625 aspect the old
   * 1.15 x 0.85 portrait scale stretched it 40% wider than tall and the phone
   * poster had a bright orange stripe clean across the middle. Scaling both
   * axes by the same factor keeps it a pool. */
  const gAsp = size.asp / 1.6;
  const gS = portrait ? 1.05 : 1.45 * wide;
  glowMesh.scale.set(gS / Math.max(0.55, gAsp) * 1.6, gS * (portrait ? 0.62 : 1.0), 1);
  glowMesh.position.set(gx, gy + (portrait ? 0.16 : -0.58 * (s / 0.95)), 0.4);

  if (everRendered) draw(currentP());
}

let resizeTimer = 0;
function scheduleMeasure() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!renderer) {
      // Reduced motion still needs the visibility gate recomputed on resize,
      // because the gate is a fraction of the viewport height.
      applyScroll();
      return;
    }
    const cap = ENV.lite ? QUALITY.lite.dpr : QUALITY.full.dpr;
    measure(cap);
  }, 160);
}

/* ========================================================================== */
/* the frame                                                                  */
/* ========================================================================== */

function currentP() {
  return (performance.now() % LOOP_MS) / LOOP_MS;
}

/**
 * Everything below is a pure function of `p`. Feed it the same p twice and
 * you get the same frame, byte for byte — which is the whole trick.
 */
function draw(p) {
  /* The breath. A single cosine: exactly 0 at p=0 and p=1 and exactly 1 at
   p=0.5, so it cannot introduce a seam. It drives the ambient sky lift, the
   exposure, the lamp brightness and the traffic density together — which is
   what makes the city read as *waking* rather than as a brightness ramp.
   The exposure swing is deliberately wide (0.94 -> 1.22): at 6.7% the beat was
   real but unfeelable, which is the worst of both. */
  const lift = 0.5 - 0.5 * Math.cos(TAU * p);

  U.P.value = p;
  U.LIFT.value = lift;
  /* Windows: a small base of lamps are lit all through, the rest come up with
     the breath, staggered by each window's own hash rank. */
  U.WIN.value = 0.055 + (ENV.lite ? 0.28 : 0.34) * lift;
  U.EXPO.value = 0.86 + 0.26 * (1 - lift);

  /* ---- the drink ----------------------------------------------------
   * The surface rises over the loop, driven by the SAME cosine as everything
   * else, so it cannot introduce a seam. 0.352 → 0.392 over 30 seconds: slow
   * enough to be almost subliminal, which is the point — a glass visibly
   * filling is a progress bar, and a phin filling over four minutes is a
   * thing you notice once and then can't stop noticing.
   *
   * It starts LOW on purpose. The phin's drip well sits at 0.640, barely below
   * the glass rim at 0.656, which is where a real phin sits — so the height of
   * the surface is the only thing that sets how far a drop falls. At 0.470 the
   * drop had 0.17 model units to travel, which is 78 pixels: a dot, not a fall.
   * At 0.352 it has 0.29 units, 133 pixels, and the accelerating stretch reads
   * as gravity rather than as a dot sliding down a stick. The drink also ends
   * up in the lower third of the glass, which is how much coffee there
   * actually is at this point in a phin brew. */
  const surf = 0.352 + 0.040 * lift;
  /* Condensed milk settles in the bottom; the boundary rises with the drink
     but lags it slightly, because the milk is denser and does not get lifted
     at the same rate. */
  U.SURF.value.x = surf;
  U.STRAT.value.x = 0.098 + 0.034 * lift;

  /* ---- the drip ----------------------------------------------------- */
  const d = noDrip
    ? { slot: 0, size: 1, swell: 0, neck: 0, u: -1, age: -1, live: false, ripple: false }
    : dripAt(p);
  /* The surface height is where a drop disappears, not a fixed number: the two
     have to agree or the drop visibly stops short of the water or sinks into
     it. */
  const impactY = surf - 0.002;
  /* 0.0185, not 0.0142. At 0.0142 the drop was a 6px sphere at poster size,
     which is under the threshold where a person looking at the still
     registers an object rather than a speck of dust. */
  const rBase = 0.0255 * d.size;

  DRIP_STATE.swell = d.swell;
  DRIP_STATE.neck = d.neck;
  DRIP_STATE.fall = d.u >= 0 ? d.u : 0;
  DRIP_STATE.ripple = d.ripple ? d.age : 0;
  DRIP_STATE.landing = false;

  if (d.swell > 0 || d.neck > 0) {
    /* --- hanging at the plate -------------------------------------------
     * A bead sitting on the underside of the perforated plate, growing, then
     * stretching downward as its weight overcomes surface tension. It has to
     * be attached to the plate: a bead floating in the gap below the phin
     * would be the single clearest way to say this is not a real phin. */
    const g = d.neck > 0 ? 1.0 + d.neck * 0.55 : 0.25 + 0.75 * d.swell;
    const r = rBase * (0.30 + 0.70 * g);
    const drop = r * (0.35 + 1.9 * g * g);
    dropMesh.visible = true;
    dropMesh.position.set(0, PHIN_TIP_Y - r * 0.7 - drop, 0);
    /* it hangs: taller than wide, and taller still as it necks */
    dropMesh.scale.set(r, r * (1.0 + 1.35 * g), r);
    dropMat_uniforms.uStretch.value = 0;
    tailMesh.visible = false;
  } else if (d.u >= 0) {
    /* --- in flight ------------------------------------------------------
     * Gravity: slow at first, then it lets go. u^2 over a 0.29-unit fall,
     * which at this scale is a shade under two seconds — real enough to read
     * as a drip, and long enough that the acceleration is legible. */
    const u = d.u;
    const y = PHIN_TIP_Y - (PHIN_TIP_Y - impactY) * u * u;
    /* surface tension: it stretches as it accelerates */
    const stretch = 1.0 + 1.55 * u * u;
    const r = rBase * (1.0 - 0.16 * u);
    dropMesh.visible = true;
    dropMesh.position.set(0, y, 0);
    dropMesh.scale.set(r, r * stretch, r);
    dropMat_uniforms.uStretch.value = u * u;

    /* The thread: alive for the first fifth of the fall only. It hangs from
       the plate — a cylinder from PHIN_TIP_Y down to the top of the drop, with
       the wide end at the bottom because it is being drawn out. */
    const th = 0.20;
    if (u < th) {
      const k = 1 - u / th;
      const top = PHIN_TIP_Y - 0.004;
      const bot = y + r * stretch * 0.5;
      const len = Math.max(1e-4, top - bot);
      tailMesh.visible = true;
      tailMesh.scale.set(r * 0.34, len, r * 0.34);
      tailMesh.position.set(0, bot + len * 0.5, 0);
      tailMesh.material.uniforms.uAmp.value = k * k * 0.85;
    } else {
      tailMesh.visible = false;
    }
  } else {
    dropMesh.visible = false;
    tailMesh.visible = false;
  }

  /* --- the impact -------------------------------------------------------
   * Three things happen in the 0.34 slot units after the drop lands, in the
   * order they happen in life: a crown of splash, an expanding ring on the
   * surface, and the meniscus wobbling back to level. */
  if (d.ripple) {
    const a = d.age;
    /* The crown: up fast, gone by the time the ring is halfway. It lives the
       first 38% of the ripple — at 26% it was already invisible by the only
       frames anyone ever looks at. */
    const cAge = Math.min(1, a / 0.38);
    if (cAge < 1) {
      /* Radius in model units. It opens fast and is already 3x its starting
         radius while still bright. */
      const cs = rBase * (1.6 + 4.2 * cAge);
      crownMesh.visible = true;
      crownMesh.position.set(0, surf + cs * 0.50 * (1 - cAge * cAge * 0.80), 0);
      crownMesh.scale.set(cs, cs * (1.0 - 0.30 * cAge), cs);
      crownMesh.material.uniforms.uAmp.value =
        (1 - cAge) * (1 - cAge * 0.45) * 1.55;
    } else {
      crownMesh.visible = false;
    }
    /* the ring: radius grows fast at first then linearly, amplitude decays as
       (1-a)^1.6. Feeding the radius to the liquid shader is what puts the
       highlight on the actual waterline and not floating above it. */
    const R = 0.215 * (1 - (1 - a) * (1 - a) * 0.42);
    U.SURF.value.set(surf, R, Math.pow(1 - a, 1.6), cAge < 1 ? (1 - cAge) : 0);
    U.RIP.value.set(a, 1 - 0.35 * a, 0, 0);
    /* the displaced meniscus: the waterline dips for an instant at the strike
       point, which is what makes it read as LIQUID rather than as a lamp */
    U.STRAT.value.y = Math.sin(a * Math.PI) * 0.010 * (1 - a);
  } else {
    crownMesh.visible = false;
    U.SURF.value.set(surf, 0, 0, 0);
    U.RIP.value.set(0, 0, 0, 0);
    U.STRAT.value.y = 0;
  }

  /* ---- A: city, straight onto rtA ------------------------------- */
  renderer.setRenderTarget(rtA);
  renderer.clear(true, false, false);
  renderer.render(cityPass.scene, cityPass.cam);

  /* ---- B: the foreground, onto the same target, no clear ------------- */
  /* Two passes: everything opaque, then the glass shell over it. Render order
     is the sort order, which is why the glass lives in its own scene. */
  renderer.setRenderTarget(rtA);
  renderer.render(fgScene, fgCam);
  renderer.render(fgGlassScene, fgCam);

  /* ---- C: rain, sampling rtA as its lens -------------------------- */
  copyPass.mat.uniforms.uTex.value = rtA.texture;
  renderer.setRenderTarget(rtB);
  renderer.clear(true, false, false);
  renderer.render(copyPass.scene, copyPass.cam);
  rainPass.mat.uniforms.uTex.value = rtA.texture;
  renderer.render(rainPass.scene, rainPass.cam);

  /* ---- D: grade, to the screen ----------------------------------- */
  renderer.setRenderTarget(null);
  renderer.clear(true, false, false);
  renderer.render(gradePass.scene, gradePass.cam);

  DIAG.hero.frames++;
  everRendered = true;
}

/* ========================================================================== */
/* loop                                                                       */
/* ========================================================================== */

let t0 = performance.now();
let lastDraw = -1e9;
let lastCost = 0;

function fpsCap() {
  const govern = window.__govern;
  const f = govern?.fps || (ENV.lite ? QUALITY.lite.fps : QUALITY.full.fps);
  return 1000 / Math.max(12, Math.min(120, f || 60));
}

function frame() {
  if (!running) return;
  const now = performance.now();
  if (now - lastDraw < fpsCap() - 1.5) return;
  const a = performance.now();
  draw(currentP());
  lastCost = lastCost * 0.85 + (performance.now() - a) * 0.15;
  lastDraw = now;
  DIAG.hero.ms = Math.round(lastCost * 1000) / 1000;
}

/* ========================================================================== */
/* reveal / fallback plumbing                                                 */
/* ========================================================================== */

function revealPoster() {
  const stage = document.querySelector(".hero-stage");
  if (!stage) return;
  delete stage.dataset.heroLive;
  /* The poster is the fallback for every way the scene can fail to run, so
     this is the ONLY place that switches its image on. Keeping it JS-driven
     means the happy path never fetches the 104KB JPEG at all, while a device
     that falls back still gets a real image instead of an empty gradient. */
  stage.dataset.heroPoster = "1";
}

function revealCanvas() {
  const stage = document.querySelector(".hero-stage");
  if (stage && document.documentElement.dataset.motion !== "reduced") {
    stage.dataset.heroLive = "1";
  }
}

/* ========================================================================== */
/* scroll: settle a few px, then get out of the way completely               */
/* ========================================================================== */

/* Fraction of the viewport height by which the hero has finished exiting.
   0.72 puts it fully gone comfortably above #what-this-is, so no body copy is
   ever read through the scene. */
const SCROLL_GATE = 0.72;

/* True once the hero is fully scrolled away. Gates the render loop: a fixed
   stage nobody can see has no business asking for frames. */
let hiddenByScroll = false;

let scrollQueued = false;
function onScroll() {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    applyScroll();
  });
}

function applyScroll() {
  const stage = document.querySelector(".hero-stage");
  if (!stage) return;

  const y = window.scrollY || 0;
  const gate = Math.max(1, window.innerHeight * SCROLL_GATE);
  const k = Math.min(1, y / gate);
  const e = k * k * (3 - 2 * k); /* smoothstep: settles rather than ramps */

  /* The fade and the visibility gate apply in EVERY motion mode, reduced
     included — otherwise a reduced-motion visitor gets the poster painted over
     the whole article instead of the canvas. */
  stage.style.setProperty("--hero-dim", (1 - e).toFixed(3));
  const gone = k >= 1;
  stage.style.setProperty("--hero-vis", gone ? "hidden" : "visible");

  /* Parallax and the scale settle are motion, so reduced motion skips them.
     With no WebGL context there is no frame to re-animate anyway. */
  if (ENV.reducedMotion) {
    stage.style.setProperty("--hero-par", "0px");
    stage.style.setProperty("--hero-scale", "1");
  } else {
    stage.style.setProperty("--hero-par", (e * 14).toFixed(2) + "px");
    stage.style.setProperty("--hero-scale", (1 + e * 0.035).toFixed(4));
  }

  hiddenByScroll = gone;
  /* Reversible and cheap: pause or resume the existing loop. No re-init, no
     context rebuild, and the clock is wall-clock so it resumes in place. */
  if (gone) stop();
  else resume();
}

/* ========================================================================== */
/* public API                                                                 */
/* ========================================================================== */

/* The scroll gate is not motion: the stage is position:fixed, so once the hero
   is gone it has to stop painting over the article in EVERY mode, including
   reduced motion (where the poster would otherwise sit on top of every
   reading section for the whole page). Wired before the reduced-motion
   early-return so both paths get it. */
function wireScrollGate() {
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", scheduleMeasure, { passive: true });
  applyScroll();
}

/** True once the hero has been scrolled far enough past that building the
 *  scene would be pure waste — nothing of it is ever going to be seen. */
function scrolledAway() {
  return Math.max(0, scrollY - (SCROLL_GATE * innerHeight || 1)) > 0;
}

function start() {
  if (failed || running) return;

  const motion = document.documentElement.dataset.motion;
  if (ENV.reducedMotion || motion === "reduced") {
    /* Still frame, no context, no rAF. The CSS poster is already up — but it
       still has to obey the scroll gate. */
    wireScrollGate();
    revealPoster();
    DIAG.hero.mode = "reduced";
    expose();
    return;
  }

  /* The scene is built and first drawn in IDLE TIME, never inline.
   *
   * Measured: building the scene and drawing the first frame costs ~2.9s of
   * main-thread time on a software rasteriser (three.js parse + 3 fullscreen
   * passes + shader links). Done inline in start(), that lands inside the TBT
   * window and mobile Lighthouse drops to 72 with TBT 1740ms and Max Potential
   * FID 1070ms — even though the copy itself paints in 1.2s and nothing is
   * interactive until much later anyway.
   *
   * Deferring it costs nothing perceptibly: the CSS poster is already on screen
   * underneath, the hero is atmosphere, and the text is HTML. The canvas simply
   * cross-fades in when the frame is ready. */
  const idle =
    typeof window.requestIdleCallback === "function"
      ? (fn) => window.requestIdleCallback(fn, { timeout: 1200 })
      : (fn) => setTimeout(fn, 1);

  idle(async () => {
    /* The reader may have scrolled past the hero while we waited. */
    if (document.hidden || scrolledAway()) return;

    /* One macrotask of grace before committing to a 256KB fetch.
       requestIdleCallback can fire within ~50ms, which is faster than a fast
       flick or a restored scroll position lands. Measured: deep-scrolling to
       the footer and back down would still download three.js because we had
       already committed by the time the scroll settled. */
    await new Promise((r) => setTimeout(r, 120));
    if (document.hidden || scrolledAway()) return;

    try {
      /* three.js first: 256KB gzipped of module graph, and it is the single
         largest item on the main thread. Fetched only now, only if we are
         actually going to build something. */
      await loadThree();
      if (document.hidden || scrolledAway()) return;
      build();
    } catch (err) {
      failed = true;
      revealPoster();
      DIAG.hero.mode = "fallback";
      DIAG.hero.error = String(err?.message || err);
      console.debug("[hero] WebGL unavailable — using the still.");
      expose();
      return;
    }

    try {
      const t = performance.now();
      draw(currentP());
      /* First-frame watchdog. If a single draw blows the budget, this device
         cannot afford the loop at all — stay on the still rather than ship a
         page that janks every frame. */
      const cost = performance.now() - t;
      DIAG.hero.firstFrameMs = Math.round(cost * 100) / 100;
      if (cost > 120 && ENV.lite) {
        failed = true;
        revealPoster();
        DIAG.hero.mode = "fallback";
        console.debug("[hero] first frame too slow — using the still.");
        expose();
        return;
      }
      revealCanvas();
    } catch (err) {
      failed = true;
      revealPoster();
      DIAG.hero.mode = "fallback";
      DIAG.hero.error = String(err?.message || err);
      console.debug("[hero] first draw failed — using the still.");
      expose();
      return;
    }

    t0 = performance.now();
    lastDraw = -1e9;
    running = true;
    renderer.setAnimationLoop(frame);
    DIAG.hero.mode = "live";

    bindGovernor();
    expose();
  });

  wireScrollGate();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else resume();
  });
  expose();
}

/** Pause. Called by the governor, by context loss, by visibilitychange and by
 *  the scroll gate. Idempotent, and never tears anything down. */
function stop() {
  if (!running) return;
  running = false;
  renderer?.setAnimationLoop(null);
}

/** Resume if — and only if — the hero should currently be animating. All four
 *  conditions live here so every entry point (scroll, tab, governor) agrees. */
function resume() {
  if (running || failed || ENV.reducedMotion) return;
  if (!built || !renderer) return;
  if (document.hidden || hiddenByScroll) return;
  if (!document.querySelector('.hero-stage[data-hero-live="1"]')) return;
  lastDraw = -1e9;
  running = true;
  renderer.setAnimationLoop(frame);
}

let govTries = 0;
function bindGovernor() {
  const g = window.__govern;
  if (g && typeof g.registerLoop === "function") {
    g.registerLoop({ start, stop });
    DIAG.hero.governed = true;
    return true;
  }
  /* perf.js is loaded before us, but be forgiving about the ordering. */
  if (govTries++ < 4) setTimeout(bindGovernor, 500 + govTries * 500);
  return false;
}

/* Read back an RGBA8 target (or the canvas when `rt` is null) and reduce it to
 * a mean luminance. Diagnostics only — never called from the loop. */
function readRT(rt) {
  const gl = renderer.getContext();
  const w = rt ? rt.width : renderer.domElement.width;
  const h = rt ? rt.height : renderer.domElement.height;
  if (rt) renderer.setRenderTarget(rt);
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  if (rt) renderer.setRenderTarget(null);
  return px;
}

function meanOf(px) {
  let s = 0;
  for (let i = 0; i < px.length; i += 4) s += (px[i] + px[i + 1] + px[i + 2]) / 3;
  return +(s / (px.length / 4)).toFixed(2);
}

/* A tiny diagnostic surface so the harness can verify the seam and the grade
 * without waiting 30 seconds. Read-only apart from `seek`. */
function expose() {
  window.__hero = {
    get mode() {
      return DIAG.hero.mode;
    },
    get frames() {
      return DIAG.hero.frames;
    },
    get ms() {
      return DIAG.hero.ms;
    },
    get size() {
      return { ...size };
    },
    /** Render one exact frame of the loop and return its position. */
    seek(p) {
      if (!renderer || ENV.reducedMotion) return false;
      if (running) stop();
      draw(p);
      return true;
    },
    /** Which beat of the drip cycle is live right now, and how far through.
     *  Read-only; the way "is a drop actually visible" gets answered by
     *  measurement instead of by squinting at a screenshot. */
    drip() {
      return {
        swell: DRIP_STATE.swell,
        neck: DRIP_STATE.neck,
        fall: DRIP_STATE.fall,
        ripple: DRIP_STATE.ripple,
      };
    },
    /** The subject's on-screen box in canvas pixels, and specifically the gap
     *  between the phin's perforated plate and the surface of the drink —
     *  which is the strip a falling drop occupies. */
    subjectBox() {
      const s = phinGroup.scale.x || 1;
      const gx = phinGroup.position.x;
      const gy = phinGroup.position.y;
      const asp = size.asp;
      /* world x -> canvas px */
      const toX = (wx) => ((wx + asp) / (2 * asp)) * size.pxW;
      const toY = (wy) => ((1 - wy) / 2) * size.pxH;
      const wx0 = gx - PHIN_HALF_W * s;
      const wx1 = gx + PHIN_HALF_W * s;
      return {
        x0: toX(wx0),
        x1: toX(wx1),
        top: toY(gy + 1.433 * s),
        bottom: toY(gy),
        gapTop: toY(gy + PHIN_TIP_Y * s),
        gapBot: toY(gy + U.SURF.value.x * s),
      };
    },
    /** True only if a WebGL context was actually created. Under reduced motion
     *  this stays false, which is how tools/ prove we never touched the GPU
     *  without the probe itself being the thing that creates a context. */
    get hasGl() {
      return renderer !== null;
    },
    /** Is the rAF loop actually running right now? tools/ reads this to prove
     *  the loop stops when scrolled away and restarts when it comes back. */
    get running() {
      return running;
    },
    /** Why the loop is not running, or "" if it is. */
    get parked() {
      if (running) return "";
      if (!built || !renderer) return "not-built";
      if (ENV.reducedMotion) return "reduced-motion";
      if (document.hidden) return "tab-hidden";
      if (hiddenByScroll) return "scrolled-away";
      return "paused";
    },
    /**
     * Diagnostic scaffolding for tools/. It is how the loop seam, the per-pass
     * luminance and the reduced-motion guarantee were actually measured rather
     * than asserted. Everything here reads; only seek() mutates, and it only
     * re-renders one exact frame of the loop.
     */
    _dbg: {
      /** Ablation: set the no-drip flag and redraw. Exists so a tool can
       *  render the same frame of the loop twice, with and without the drip,
       *  and difference the two — the only way to isolate the drip's own
       *  contribution from the phin's highlights and the city's, both of
       *  which are permanently brighter than any drop. The caller must pass
       *  false again. Never true in production. */
      _ablateNoDrip(on) {
        noDrip = !!on;
        draw(currentP());
        return noDrip;
      },
      get passes() {
        return { cityPass, copyPass, rainPass, gradePass, fgScene, fgGlassScene, fgCam, rtA, rtB };
      },
      get uniforms() {
        return U;
      },
      /** Compile/link diagnostics for every program three.js has built. A GLSL
       *  typo makes three.js drop the whole pass SILENTLY, which is how the
       *  scene went black once — so tools/ asserts this before any pixel is
       *  trusted. */
      programs() {
        return renderer.info.programs;
      },
      /** Mean luminance of a render target ("a" = city+fg, "b" = after rain). */
      rt(which) {
        return meanOf(readRT(which === "a" ? rtA : rtB));
      },
      /** Mean luminance of the presented canvas. */
      screen() {
        return meanOf(readRT(null));
      },
      /** Render one stage of the chain to the canvas, then measure it.
       *  "city" | "fg" | "copy" | "rain" | "full". */
      only(stage) {
        const to = (t, sc, cam) => {
          renderer.setRenderTarget(t);
          renderer.clear(true, false, false);
          renderer.render(sc, cam);
        };
        if (stage === "city") to(rtA, cityPass.scene, cityPass.cam);
        else if (stage === "fg") {
          to(rtA, cityPass.scene, cityPass.cam);
          to(rtA, fgScene, fgCam);
        } else if (stage === "copy") {
          to(rtA, cityPass.scene, cityPass.cam);
          to(rtA, fgScene, fgCam);
          copyPass.mat.uniforms.uTex.value = rtA.texture;
          to(rtB, copyPass.scene, copyPass.cam);
        } else if (stage === "rain") {
          to(rtA, cityPass.scene, cityPass.cam);
          to(rtA, fgScene, fgCam);
          copyPass.mat.uniforms.uTex.value = rtA.texture;
          to(rtB, copyPass.scene, copyPass.cam);
          rainPass.mat.uniforms.uTex.value = rtA.texture;
          to(rtB, rainPass.scene, rainPass.cam);
        } else draw(currentP());
        renderer.setRenderTarget(null);
        /* Measure the target the stage actually wrote, not the canvas: stages
           render into rtA/rtB and nothing redraws the canvas, so reading it
           returned the previous frame's number for every stage. */
        const src = stage === "city" || stage === "fg" ? rtA : rtB;
        return meanOf(readRT(src));
      },
    },
  };
}

/* main.js calls hero.start() once. */
export { start };
export default { start };
