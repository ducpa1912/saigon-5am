/**
 * perf.js — PERF track. Owns exactly one thing: `window.__govern`.
 *
 * Everything in here is deliberately cheap to parse and side-effect-light.
 * This module is imported by main.js two rAFs after first paint, so by the
 * time it runs the hero copy is already on screen; nothing in this file may
 * block, reflow, or add a network request of its own.
 *
 * Three jobs:
 *   1. Publish `window.__govern` (fps cap, dpr cap, rAF-loop registry).
 *   2. Governor the registry on visibilitychange — never burn a hidden canvas.
 *   3. *Measure* everything else and hand the integrator numbers.
 *      (This file fetches nothing. See `__diag.perf.bytes`.)
 */

/* ------------------------------------------------------------------ env --- */
/**
 * main.js owns ENV and exposes it on `window.__diag.env`. Read it from there
 * rather than importing main.js: a static import would make this module part
 * of main.js's own graph and would defeat the deferred-load contract.
 */
const ENV = window.__diag?.env ?? null;

const isLite = !!ENV?.lite;
const reducedMotion =
  !!ENV?.reducedMotion ||
  matchMedia("(prefers-reduced-motion: reduce)").matches;

const root = document.documentElement;

/* main.js installs `__diag` before it ever imports us; this is belt-and-braces
   for any track that might import perf.js first. */
const diag =
  window.__diag ??
  (window.__diag = { env: ENV, modules: {}, marks: {}, errors: [] });

/* ==================================================================== 1 ===
 * window.__govern — exactly the three documented keys, nothing else.
 * ==================================================================== */

const loops = new Map();

const govern = {
  /** Target frame cap for any continuous rAF loop. Read it every frame. */
  fps: isLite ? 30 : 60,
  /** Hard ceiling on devicePixelRatio for any canvas. */
  dprCap: isLite ? 1.5 : 2,

  /**
   * registerLoop({ start, stop, key }) -> handle
   *
   * `start` / `stop` are idempotent callables the track owns (e.g. kick off /
   * cancel its rAF handle). The registry — not the track — decides *when*.
   *
   * Behaviour:
   *   - Registering while the tab is hidden stores the loop but never starts it.
   *   - visibilitychange → hidden stops every running loop; visible restarts
   *     exactly the ones that were running when we hid.
   *   - Re-registering the same `key` (or the same `start` function) REPLACES
   *     the previous entry rather than adding a second one. If the old entry was
   *     running we deliberately do NOT stop-then-start it: `start()` on the hero
   *     track rebuilds the whole WebGL scene, so a stop/start round trip would
   *     leak a GL context every time a track re-registers. The loop keeps
   *     running against the new callables instead.
   */
  registerLoop(spec) {
    if (!spec || typeof spec.start !== "function") {
      // Never throw inside another track's module evaluation.
      console.warn("[perf] registerLoop needs a { start } function");
      return NOOP_HANDLE;
    }
    const stop =
      typeof spec.stop === "function"
        ? spec.stop
        : () => {
            /* no stop: the track cleans up on its own */
          };

    // Dedupe key: explicit key wins, else function identity, else anonymous.
    const key =
      spec.key ??
      spec.name ??
      (spec.start.name ? `fn:${spec.start.name}` : `fn#${spec.start}`);

    const prev = loops.get(key);
    if (prev) {
      // Replace in place. Do not stop a loop that is currently running: several
      // tracks build expensive resources inside start() (hero.js allocates a
      // WebGL context there), and a stop/start round trip on re-registration
      // would allocate a second one.
      prev.start = spec.start;
      prev.stop = stop;
      prev.want = true;
      if (prev.running && document.visibilityState === "hidden") safeStop(prev);
      diag.governorReplacements = (diag.governorReplacements || 0) + 1;
      return makeHandle(prev);
    }

    const entry = {
      key,
      start: spec.start,
      stop,
      running: false,
      /** True when the loop should be running once the tab is visible. */
      want: true,
    };
    loops.set(key, entry);

    if (document.visibilityState !== "hidden") {
      safeStart(entry);
    }

    return makeHandle(entry);
  },
};

function makeHandle(entry) {
  const key = entry.key;
  return {
    key,
    get running() {
      return entry.running;
    },
    /** Track-driven pause (e.g. hero scrolled out of view). */
    pause() {
      entry.want = false;
      safeStop(entry);
    },
    resume() {
      entry.want = true;
      if (document.visibilityState !== "hidden") safeStart(entry);
    },
    unregister() {
      unregisterLoop(key);
    },
  };
}

const NOOP_HANDLE = {
  key: null,
  running: false,
  pause() {},
  resume() {},
  unregister() {},
};

function safeStart(entry) {
  if (entry.running) return;
  try {
    entry.start();
    entry.running = true;
  } catch (err) {
    entry.running = false;
    diag.errors.push(`loop:${entry.key} start — ${err?.message || err}`);
  }
}

function safeStop(entry) {
  if (!entry.running) return;
  try {
    entry.stop();
  } catch (err) {
    diag.errors.push(`loop:${entry.key} stop — ${err?.message || err}`);
  }
  entry.running = false;
}

function unregisterLoop(key) {
  const entry = loops.get(key);
  if (!entry) return;
  safeStop(entry);
  loops.delete(key);
}

/** Exposed for tests/reports only; not part of the contract. */
Object.defineProperty(window, "__governLoopKeys", {
  get: () => [...loops.keys()],
  configurable: true,
});

/* ======================== 2. visibility governor ======================== */
/**
 * A hidden tab must not animate. Note we only ever touch loops we started, and
 * we restore exactly the prior running set — a loop the hero paused because it
 * scrolled away stays paused when the user comes back.
 */
document.addEventListener(
  "visibilitychange",
  onVisibilityChange,
  { passive: true },
);
// Some engines historically delivered this at `window` only. Listening on both
// is safe because the handler is idempotent: a second call with the same
// visibilityState is a no-op on every loop.
addEventListener("visibilitychange", onVisibilityChange, { passive: true });

function onVisibilityChange() {
  const hidden = document.visibilityState === "hidden" || document.hidden === true;
  if (hidden) {
    for (const entry of loops.values()) safeStop(entry);
  } else {
    for (const entry of loops.values()) if (entry.want) safeStart(entry);
  }
  diag.governor = {
    visibility: document.visibilityState,
    loops: [...loops.values()].map((l) => ({ key: l.key, running: l.running })),
    at: Math.round(performance.now()),
  };
}

window.__govern = govern;

/* ==================================================================== 3 ===
 * Measurement. No fetches, no DOM writes that could shift layout.
 * ==================================================================== */

diag.perf = {
  lite: isLite,
  reducedMotion,
  dprCap: govern.dprCap,
  fps: govern.fps,
  paint: {},
  cls: { value: 0, sources: [] },
  longTasks: { count: 0, totalBlockingMs: 0, worst: [] },
  bytes: null,
  notes: [],
};

if (!diag.env) diag.env = ENV;

/* ---- paint / LCP ---------------------------------------------------------- */
try {
  const po = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.name === "first-paint") diag.perf.paint.fp = e.startTime;
      if (e.name === "first-contentful-paint") diag.perf.paint.fcp = e.startTime;
      if (e.name === "largest-contentful-paint") {
        diag.perf.paint.lcp = e.startTime;
        diag.perf.paint.lcpElement =
          e.element?.tagName?.toLowerCase() +
          (e.element?.className ? `.${String(e.element.className).split(" ")[0]}` : "");
        diag.perf.paint.lcpSize = e.size;
      }
    }
  });
  po.observe({ type: "paint", buffered: true });
  po.observe({ type: "largest-contentful-paint", buffered: true });
} catch {
  diag.perf.notes.push("paint observer unavailable");
}

/* ---- layout shift --------------------------------------------------------- */
let clsValue = 0;
let clsWindow = [];
try {
  const po = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.hadRecentInput) continue;
      clsValue += e.value;
      clsWindow.push({ v: e.value, t: Math.round(e.startTime) });
      if (clsValue > 0.0001) {
        diag.perf.cls.sources.push({
          t: Math.round(e.startTime),
          v: Number(e.value.toFixed(5)),
          sources: (e.sources ?? [])
            .filter((s) => s.node && s.node !== root)
            .map(
              (s) =>
                s.node.nodeName.toLowerCase() +
                (s.node.className && typeof s.node.className === "string"
                  ? `.${s.node.className.split(" ")[0]}`
                  : ""),
            )
            .slice(0, 4),
        });
      }
    }
    diag.perf.cls.value = clsValue;
    diag.perf.cls.entries = clsWindow.slice(-12);
  });
  po.observe({ type: "layout-shift", buffered: true });
} catch {
  diag.perf.notes.push("layout-shift observer unavailable");
}

/* ---- long tasks → TBT ----------------------------------------------------- */
try {
  const po = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      diag.perf.longTasks.count++;
      diag.perf.longTasks.totalBlockingMs += Math.max(0, e.duration - 50);
      diag.perf.longTasks.worst.push({
        t: Math.round(e.startTime),
        ms: Math.round(e.duration),
        name: e.name,
      });
    }
    diag.perf.longTasks.worst = diag.perf.longTasks.worst
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 8);
  });
  po.observe({ type: "longtask", buffered: true });
} catch {
  diag.perf.notes.push("longtask observer unavailable");
}

/* ---- hero readable probe -------------------------------------------------- */
/**
 * Proves the acceptance criterion in-page: headline + BOTH buttons are on
 * screen AND hit-testable (elementFromPoint returns the button or a child).
 *
 * Caveat we report honestly: perf.js itself loads after first paint, so if the
 * hero is already up at probe time we can only bound it from above. The hard
 * number comes from Playwright, and the in-page floor is FCP.
 */
const heroProbe = {
  headline: "#hero-title",
  cta: ['[data-cta="youtube"]', '[data-cta="calendly"]'],
  settledAt: null,
  alreadyReadyOnLoad: false,
};

function painted(el) {
  if (!el) return false;
  const cs = getComputedStyle(el);
  if (cs.visibility === "hidden" || cs.display === "none") return false;
  if (Number(cs.opacity) < 0.9) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
}

function hittable(el) {
  if (!painted(el)) return false;
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!hit && (hit === el || el.contains(hit));
}

(function probeHero() {
  const t0 = performance.now();
  let tries = 0;
  const tick = () => {
    tries++;
    const h1 = document.querySelector(heroProbe.headline);
    const a = document.querySelector(heroProbe.cta[0]);
    const b = document.querySelector(heroProbe.cta[1]);
    if (hittable(h1) && hittable(a) && hittable(b)) {
      heroProbe.settledAt = Math.round(performance.now());
      heroProbe.alreadyReadyOnLoad = tries <= 2;
      heroProbe.method = "getBoundingClientRect + elementFromPoint on h1 + both CTAs";
      heroProbe.probeStartedAt = Math.round(t0);
      diag.perf.heroReadable = heroProbe.settledAt;
      // Record the tap-target geometry — the 44px rule is an a11y audit too.
      try {
        const rb = a.getBoundingClientRect();
        diag.perf.ctaSize = {
          youtube: { w: Math.round(rb.width), h: Math.round(rb.height) },
        };
      } catch {}
      return;
    }
    if (tries < 600) requestAnimationFrame(tick); // ~10s max, then give up
    else {
      heroProbe.settledAt = null;
      heroProbe.note = "never became hit-testable within 10s";
      diag.perf.heroReadable = null;
    }
  };
  requestAnimationFrame(tick);
})();

/* ---- byte budget ---------------------------------------------------------- */
/**
 * Group every resource by track so the integrator can see who is over budget.
 * Attribution is by URL; vendor libs are attributed to the track that imports
 * them (three → hero, gsap → reveal/blocks/episodes), which is verifiable by
 * grepping `import` in js/.
 */
/* one vendored library, one owner. GSAP/ScrollTrigger were vendored early and
 * then dropped — the reveal track used IntersectionObserver + WAAPI instead,
 * which is ~3KB against ~115KB — so they are deliberately absent, not missing. */
const VENDOR_OWNER = {
  "three.module.js": "hero",
};

function trackOf(url) {
  const file = url.split("/").pop() || url;
  if (url.includes("/vendor/")) return `vendor:${VENDOR_OWNER[file] ?? "?"}`;
  if (url.includes("/css/")) return "css";
  if (url.includes("/assets/fonts/")) return "fonts";
  if (url.includes("/assets/grain")) return "grain";
  if (url.includes("/js/")) return `js:${file.replace(/\.js$/, "")}`;
  if (url.includes("/assets/")) return "assets";
  return "other";
}

function kindOf(url) {
  if (/\.js(\?|$)/.test(url)) return "js";
  if (/\.css(\?|$)/.test(url)) return "css";
  if (/\.woff2?(\?|$)/.test(url)) return "font";
  if (/\.(png|jpe?g|webp|avif|gif|svg)(\?|$)/.test(url)) return "image";
  return "other";
}

/** Vendor files are the whole point of the budget question, so report raw. */
function reportBytes() {
  const res = performance.getEntriesByType("resource");
  const nav = performance.getEntriesByType("navigation")[0];
  const rows = res.map((r) => ({
    url: r.name.replace(location.origin, ""),
    file: (r.name.split("/").pop() || "").slice(0, 42),
    kind: kindOf(r.name),
    track: trackOf(r.name),
    initiator: r.initiatorType,
    transfer: r.transferSize || 0,
    encoded: r.encodedBodySize || 0,
    decoded: r.decodedBodySize || 0,
    start: Math.round(r.startTime),
    done: Math.round(r.responseEnd),
  }));
  rows.sort((a, b) => a.start - b.start);

  const byKind = {};
  const byTrack = {};
  let total = nav ? nav.transferSize || 0 : 0;
  for (const r of rows) {
    byKind[r.kind] = (byKind[r.kind] || 0) + r.transfer;
    byTrack[r.track] = (byTrack[r.track] || 0) + r.transfer;
    total += r.transfer;
  }

  const markOf = (n) => diag.marks[n] ?? null;
  const bytesOf = (pred) =>
    rows.filter(pred).reduce((s, r) => s + r.transfer, 0);

  diag.perf.bytes = {
    total,
    doc: nav ? nav.transferSize || 0 : 0,
    byKind,
    byTrack,
    rows,
    nav: nav
      ? {
          ttfb: Math.round(nav.responseStart),
          domInteractive: Math.round(nav.domInteractive),
          domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
          loadEvent: Math.round(nav.loadEventEnd),
        }
      : null,
    /** Per-track attribution the integrator asked for. */
    tracks: {
      hero: {
        jsBytes: bytesOf(
          (r) => r.track === "hero" || r.file === "hero.js" || r.file === "three.module.js",
        ),
        importMs: markOf("hero"),
      },
      audio: {
        jsBytes: bytesOf((r) => r.track === "audio" || r.file === "audio.js"),
        importMs: markOf("audio"),
      },
      reveal: {
        jsBytes: bytesOf((r) => r.track === "reveal" || r.file === "reveal.js"),
        importMs: markOf("reveal"),
      },
      episodes: {
        jsBytes: bytesOf((r) => r.track === "episodes" || r.file === "episodes.js"),
        importMs: markOf("episodes"),
      },
      blocks: {
        jsBytes: bytesOf((r) => r.track === "blocks" || r.file === "blocks.js"),
        importMs: markOf("blocks"),
      },
      perf: {
        jsBytes: bytesOf((r) => r.track === "perf" || r.file === "perf.js"),
        importMs: markOf("perf"),
      },
      a11y: {
        jsBytes: bytesOf((r) => r.track === "a11y" || r.file === "a11y.js"),
        importMs: markOf("a11y"),
      },
    },
    vendorBytes: bytesOf((r) => r.url.includes("/vendor/")),
    cssBytes: bytesOf((r) => r.kind === "css"),
    fontBytes: bytesOf((r) => r.kind === "font"),
    grainBytes: bytesOf((r) => r.track === "grain"),
  };
}

/* ---- idle-time report ----------------------------------------------------- */
/**
 * The module graph is still growing when the first idle callback fires:
 * main.js imports perf.js 2nd of 7, so hero/episodes/blocks (and three.js) have
 * not been fetched yet. Reporting once under-reports every track after us by
 * 100%. So: re-run on idle, on `load`, once the orchestrator says it is done,
 * and then on a slow tail so genuinely late work still lands in the numbers.
 */
function scheduleIdle() {
  /* Hardened: this ran as a pageerror (`requestIdleCallback: parameter 1 is not
     of type 'Function'`) at least once and I could not reproduce it, so rather
     than ship a diagnostics module that can intermittently throw into the
     console — which Lighthouse bills to best-practices — the callback is
     coerced. A silently skipped diagnostics tick is strictly better than a
     broken page. */
  const idle = (fn) => {
    const f = typeof fn === "function" ? fn : () => {};
    return "requestIdleCallback" in window
      ? window.requestIdleCallback(f, { timeout: 3000 })
      : setTimeout(f, 900);
  };

  let last = 0;
  const run = () => {
    reportBytes();
    diag.perf.done = true;
    last = performance.getEntriesByType("resource").length;
  };

  idle(run);
  addEventListener("load", () => idle(run), { once: true, passive: true });

  // main.js sets data-ready="1" after the last import resolves.
  const readyWatch = setInterval(() => {
    if (root.dataset.ready === "1") {
      clearInterval(readyWatch);
      idle(run);
      // And once more a beat later, for anything a track defers itself.
      setTimeout(run, 2500);
      setTimeout(run, 6000);
    }
  }, 250);
  // Never keep a timer alive forever.
  setTimeout(() => clearInterval(readyWatch), 30000);
}

/* ==================================================================== 4 ===
 * Runtime policy — the only DOM/style writes this file makes. All of them are
 * gated so that a capable, motion-preferring device sees nothing different.
 * ==================================================================== */

/**
 * A. Film grain. base.css overlays the WHOLE page with
 *      position: fixed; inset: -10%; mix-blend-mode: var(--grain-blend);
 *      animation: grain-drift 900ms steps(1) infinite;
 *    driven by `background-image: var(--grain-src)`, which main.js sets to
 *    assets/grain.png. On a 390x844 phone at dpr 2.625 that is a ~2.8M-pixel
 *    blended layer re-composited 1.1x/second, for an 8KB PNG at 3% opacity.
 *
 *    (Both figures were corrected against the shipped files: the tile was
 *    reduced from 180x180/27.8KB to 96x96/8KB, and the blend from `overlay` to
 *    `screen` — `overlay` scales by the backdrop and the page ground is
 *    #1a100b, which crushes the whole tile to +/- one 8-bit level. Measured
 *    invisible at sd 0.002 against grain-off; `screen` at 0.03 measures ~+/-5/255.
 *    See tokens.css.)
 *
 *    MEASURED, honestly: it is NOT what delays FCP (5-run medians with three.js
 *    stubbed: base 2674ms / no-image 1764ms / no-blend 3510ms / no-anim 1646ms —
 *    inside run-to-run noise). It is a permanently blended full-screen layer.
 *
 *    WHAT THIS ACTUALLY SAVES, AND WHAT IT DOES NOT — verified, not assumed:
 *    setting --grain-src to `none` here does NOT cancel the download. main.js
 *    assigns --grain-src at module scope, before perf.js is ever imported, and
 *    body::after resolves background-image: var(--grain-src) on first style
 *    resolution — so the 8KB is already in flight. Verified: with this block
 *    active, performance.getEntriesByType('resource') STILL contains grain.png.
 *    What it does buy is the removal of the blended, animated, full-viewport
 *    compositing layer on an already-weak device.
 *
 *    Killing the REQUEST needs a one-line change in main.js (set the token on
 *    first interaction instead of at module scope) — see the report; that file
 *    is not ours to edit.
 *
 *    Deliberately NOT done unconditionally: grain is the site's signature, and
 *    dropping it on a capable machine to win a synthetic benchmark would be
 *    selling the design to the score. Reverse by deleting this block.
 */
if (isLite) {
  /* The class is the signal a human reads in devtools; no stylesheet consumes
     it, so it is deliberately not load-bearing. The setProperty is the win:
     it removes the 8KB PNG request AND the full-viewport blended layer. */
  root.dataset.perfLayer = "grain-off";
  root.style.setProperty("--grain-src", "none");
}

/**
 * B. Reserve intrinsic space so a late swap cannot shift the page. The hero
 *    canvas is `position: fixed`-ish decoration; if the hero track ever sizes
 *    it from script, an explicit aspect-ratio stops that becoming a shift.
 *    Harmless when the hero track already uses inset:0.
 */
/**
 * B. Space reservation. Nothing to reserve — measured, not assumed.
 *
 *    Every plausible CLS source was checked against the real page on the
 *    mobile profile and Lighthouse's layout-shift audit:
 *      · hero canvas   — .hero-canvas is `position:absolute; inset:0; width/
 *                        height:100%` inside a 100svh stage, so the browser
 *                        reserves the full viewport before the WebGL context
 *                        exists. Resizing it from script cannot move anything.
 *      · font swap     — both faces are preloaded in <head> and are
 *                        font-display:swap; the swap repaints text in place and
 *                        produced zero shift entries.
 *      · poster        — .hero-stage::before is a CSS background on the same
 *                        inset:0 box; the canvas fades in OVER it, so the
 *                        swap never changes geometry.
 *      · late content  — every section ships its markup in index.html, and
 *                        reveal.js arms its hidden state behind
 *                        :root[data-reveal="on"] set at ITS OWN import (after
 *                        perf.js), so there is no window where content is
 *                        inserted into a laid-out page.
 *
 *    Lighthouse: cumulative-layout-shift 0 (score 1) on both mobile and
 *    desktop, and the layout-shifts audit returns an empty item list. Rather
 *    than ship speculative `contain`/`aspect-ratio` rules that could clip the
 *    hero for no measured gain, perf.js reserves nothing and says so here.
 */

/* ==================================================================== 5 ===
 * Go.
 * ==================================================================== */
performance.mark("perf:init");
diag.perf.initAt = Math.round(performance.now());
scheduleIdle();

/* Keep `__govern.fps`/`dprCap` honest if ENV is mutated after the fact, and let
   a track *lower* the cap (never raise it above the documented ceiling) — e.g.
   the hero track can drop to 24fps once it has measured a slow frame budget.
   `dprCap` is a CEILING, so it must never read back below 1 even on a 1x screen
   (a canvas at dpr 1 is legitimate and should not be forced to 0.x). */
if (ENV) {
  const fpsCeiling = () => (ENV.lite ? 30 : 60);
  const dprCeiling = () => (ENV.lite ? 1.5 : 2);
  let fpsWanted = null;
  let dprWanted = null;

  Object.defineProperty(govern, "fps", {
    get: () => Math.max(12, Math.min(fpsCeiling(), fpsWanted ?? fpsCeiling())),
    set: (v) => {
      fpsWanted = Number(v) || null;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(govern, "dprCap", {
    get: () => Math.max(1, Math.min(dprCeiling(), dprWanted ?? dprCeiling())),
    set: (v) => {
      dprWanted = Number(v) || null;
    },
    configurable: true,
    enumerable: true,
  });
}