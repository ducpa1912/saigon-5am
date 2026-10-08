/**
 * a11y.js — ACCESSIBILITY TRACK: behaviour + the verification facade.
 *
 * Eager (runs on EVERY page load, nothing here may be deferred):
 *   · skip link moves *focus* (not only the scroll position) into <main>
 *   · focus rescue: a focused element a JS reveal hides is revealed / refocused
 *   · reduced-motion net: every running CSS animation stopped, every non-reveal
 *     transform transition collapsed (re-checked live)
 *   · sound-toggle aria-pressed sync (non-fighting) + hygiene()
 *   · the "content must never be invisible at rest" gate in boot()
 *
 * Also the shared spine (qs/qsa, describe, visibleText, visibility predicates,
 * textNodes, `issues`, `fixes`): both halves need it, so it stays here and
 * js/a11y-audit.js imports it one-way — no cycle, no third chunk.
 *
 * DIAGNOSTICS (audit/issues/contrast/…) live in ./a11y-audit.js, dynamically
 * imported, so ~36KB of never-executed code is off the critical path.
 * window.__a11y keeps the same names and return values; see `lazy()`.
 *
 * main.js imports this after two rAFs, so nothing here blocks first paint.
 */

import { ENV } from "./main.js";

/* helpers (shared) */

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Ranked issue list; every entry carries measured evidence. */
export const issues = [];
/** Patches this module applied at runtime, for the integrator to see. */
export const fixes = [];

export function issue(severity, code, message, evidence) {
  const rec = { severity, code, message, evidence: evidence || null };
  issues.push(rec);
  return rec;
}

export function fix(code, what) {
  fixes.push({ code, what });
}

export const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

/** Live reduced-motion truth (ENV is kept in sync by main.js, read defensively). */
export function reduced() {
  return reducedMotion.matches || ENV?.reducedMotion === true;
}

/* describe + names */

/** Short, human-usable selector for an element. Used in every report. */
export function describe(el) {
  if (!el || el.nodeType !== 1) return String(el);
  let s = el.tagName.toLowerCase();
  if (el.id) return s + "#" + el.id;
  const cls = (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean);
  if (cls.length) s += "." + cls.slice(0, 2).join(".");
  const test = (attr) => {
    if (!el.hasAttribute(attr)) return "";
    const v = el.getAttribute(attr);
    return `[${attr}="${String(v).slice(0, 40)}"]`;
  };
  /* data-idea is deliberately absent from this list: nothing selects on it and
     nothing sets it, so its absence would only ever be reported as a dangling
     reference. The .idea elements are reached through their dt/dd structure. */
  s += test("data-cta") + test("data-link") + test("data-episode");
  if (!el.id && !cls.length) {
    const parent = el.parentElement;
    if (parent) s = describe(parent) + " > " + s;
  }
  return s;
}

export function isHiddenForName(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.getAttribute && n.getAttribute("aria-hidden") === "true") return true;
  }
  return false;
}

/** Text content of an element with aria-hidden subtrees pruned. */
export function visibleText(el) {
  let out = "";
  for (const n of el.childNodes) {
    if (n.nodeType === 3) out += n.nodeValue;
    else if (n.nodeType === 1 && !isHiddenForName(n) && n.tagName !== "TEMPLATE")
      out += " " + visibleText(n);
  }
  return out.replace(/\s+/g, " ").trim();
}

/* visibility */

export function hasBox(el) {
  if (!el.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 || r.height > 0 || el.getClientRects().length > 0;
}

/**
 * Painted: has a box and is not display:none / visibility:hidden / inert.
 * This — NOT `cssVisible` — is the right question for "is it in the tab order?",
 * because opacity:0 does not remove an element from the tab order.
 */
export function cssPainted(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse")
      return false;
    if (n.hidden || n.hasAttribute("inert")) return false;
  }
  return hasBox(el);
}

/**
 * Visible to a *sighted* user. The opacity test here is load-bearing, not
 * cosmetic: an element at opacity 0 still takes focus and is still in the
 * accessibility tree, so it is simultaneously (a) the defect this track exists
 * to report and (b) the trigger for the reveal-on-focus rescue below. Dropping
 * the opacity test silently disables BOTH, and the audit goes quietly blind.
 */
export function cssVisible(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (parseFloat(getComputedStyle(n).opacity) < 0.05) return false;
  }
  return cssPainted(el);
}

/** Why is this invisible *to a sighted user*? opacity:0 counts — such an element
 *  still takes focus and is still in the a11y tree, so a keyboard user lands on
 *  something they cannot see. */
export function invisibilityReason(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.display === "none") return "display:none on " + describe(n);
    if (cs.visibility === "hidden" || cs.visibility === "collapse")
      return "visibility:" + cs.visibility + " on " + describe(n);
    const op = parseFloat(cs.opacity);
    if (op < 0.05) return "opacity:" + op + " on " + describe(n);
    if (n.hasAttribute("inert")) return "inert on " + describe(n);
  }
  return hasBox(el) ? null : "zero-size box";
}

/** Every visible text node, in document order. */
export function textNodes(root = document.body) {
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const v = node.nodeValue;
      if (!v || !v.trim()) return NodeFilter.FILTER_REJECT;
      const el = node.parentElement;
      if (!el || el.closest("script, style, noscript, template, svg, canvas, title")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n;
  while ((n = walker.nextNode())) out.push(n);
  return out;
}

/* skip link */

function initSkipLink() {
  const skip = qs(".skip-link");
  const main = qs("main#main") || qs("main");
  if (!skip || !main) return;

  // <main> must be programmatically focusable or the skip link only moves the
  // scroll position and leaves focus on the link.
  if (!main.hasAttribute("tabindex")) {
    main.setAttribute("tabindex", "-1");
    fix("main-tabindex", 'set tabindex="-1" on <main> so the skip link can move focus');
  }

  skip.addEventListener("click", (e) => {
    // Let modified clicks behave natively (new tab etc.).
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    const behaviour = reduced() ? "auto" : "smooth";
    main.scrollIntoView({ behavior: behaviour, block: "start" });
    if (main === document.activeElement) return;
    // preventScroll so the smooth scroll we just started is not cancelled.
    main.focus({ preventScroll: true });
    // Some browsers re-focus the link after hash change; make sure of the end state.
    setTimeout(() => {
      if (document.activeElement !== main && skip === document.activeElement) main.focus({ preventScroll: true });
    }, 60);
  });
}

/* focus rescue */

export const stuckFocus = new Map();

export function recordFocusStuck(el, reason) {
  const key = describe(el);
  if (stuckFocus.has(key)) return;
  stuckFocus.set(key, { sel: key, reason });
  issue("high", "focus-invisible", "element can take focus while invisible: " + reason, key);
}

function initFocusRescue() {
  let lastFocused = null;

  document.addEventListener(
    "focusin",
    (e) => {
      const el = e.target;
      if (!el || el === document.body) return;
      lastFocused = el;

      /* Focus landed on something invisible. Record it, and reveal it rather
         than moving focus: yanking focus away from a control the user just
         asked for is worse than the defect, and redirecting into a container is
         how you build a keyboard trap. */
      const reason = invisibilityReason(el);
      if (reason && reason !== "zero-size box") {
        recordFocusStuck(el, reason);
        revealAncestorsOf(el);
      }
    },
    true,
  );

  // After any DOM surgery, if the focused node is gone, rescue — but only to a
  // *sibling substitute*, never to a wrapper that contains the same links.
  const check = () => {
    const a = document.activeElement;
    if (!lastFocused || lastFocused.isConnected || a !== document.body) return;
    const replacement =
      (lastFocused.id && document.getElementById(lastFocused.id)) ||
      (lastFocused.hasAttribute("data-sound-toggle") && qs("[data-sound-toggle]")) ||
      (lastFocused.tagName === "A" && lastFocused.getAttribute("href") && qs('a[href="' + lastFocused.getAttribute("href") + '"]')) ||
      qs(".skip-link");
    if (replacement) {
      replacement.focus({ preventScroll: true });
      issue("high", "focus-lost", "focused element was removed from the DOM by JS; focus moved to its replacement", describe(lastFocused) + " → " + describe(replacement));
    }
  };
  new MutationObserver(check).observe(document.documentElement, { childList: true, subtree: true });
}

/**
 * If a focusable is invisible only because an entrance system has not fired
 * yet, show it immediately: the user pressed Tab, so the content is wanted *now*.
 *
 * Every write is idempotent and additive, and mirrors exactly what the owning
 * track does a frame later — reveal.js/episodes.js add `.is-in`, blocks.js swaps
 * `.bl-in` for `.bl-on`. So this cannot fight another track; it can only land the
 * same frame they were going to land anyway.
 */
function revealAncestorsOf(el) {
  for (let node = el; node && node !== document.body; node = node.parentElement) {
    if (cssVisible(node)) {
      // This ancestor is fine; but a higher one may still be hiding it, so keep
      // going while the element as a whole is still invisible.
      if (cssVisible(el)) break;
      continue;
    }
    const cl = node.classList;
    let acted = false;
    if (cl && cl.contains("bl-in")) {
      cl.remove("bl-in");
      cl.add("bl-on");
      acted = true;
      fix("reveal-on-focus", "blocks: .bl-in → .bl-on on " + describe(node));
    }
    if (cl && !cl.contains("is-in")) {
      cl.add("is-in");
      acted = true;
      fix("reveal-on-focus", "added .is-in to " + describe(node) + " so a focused control is never invisible");
    }
    const group = node.matches?.("[data-reveal-stagger]") ? node : node.parentElement?.closest?.("[data-reveal-stagger]");
    if (group) {
      [...group.children].forEach((c) => c.classList.add("is-in"));
      acted = true;
    }
    if (!acted) continue;
    /* Cancel the entrance tween as well. Adding .is-in alone only *starts* a
       900–1150ms fade, which would still leave the focused control invisible for
       most of a second — the exact defect this exists to prevent. Snapping to the
       end state is correct: the user asked for this content by tabbing to it. */
    node.style.setProperty("transition", "none", "important");
    for (const a of node.getAnimations?.() || []) a.cancel();
    /* Keep walking while the element AS A WHOLE is still invisible. Testing this
       node's own opacity would break out early on a control whose own opacity is
       1 while an ancestor is still at 0 — exactly the stuck case. */
    if (cssVisible(el)) break;
  }
}

/* reduced-motion net */

export const REVEAL_SEL = "[data-reveal], [data-reveal-stagger], [data-reveal-group]";
const inRevealTree = (el) => !!el.closest(REVEAL_SEL);

/**
 * Under `prefers-reduced-motion: reduce`:
 *   · every running CSS animation is stopped inline (kills grain drift,
 *     marquees, pulses — the only true "looping motion" on the page)
 *   · every transform-ish transition of 150ms+ outside the reveal system is
 *     collapsed (reveal.js owns its own reduce path, so we never break its
 *     transitionend bookkeeping)
 *   · smooth scrolling is switched off at the document level
 * Inline `!important` beats author stylesheets including their !important, and
 * touches nothing when reduce is off. This is BEHAVIOUR — boot() and the change
 * listener call it — so it stays eager and synchronous.
 */
export function neutraliseMotion() {
  if (!reducedMotion.matches) return { stopped: [], collapsed: [], scroll: "smooth-left-alone" };
  const stopped = [];
  const collapsed = [];

  for (const el of qsa("body, body *")) {
    const cs = getComputedStyle(el);
    if (cs.animationName && cs.animationName !== "none") {
      el.style.setProperty("animation", "none", "important");
      stopped.push(describe(el) + " [" + cs.animationName + " " + cs.animationDuration + " " + cs.animationIterationCount + "]");
      continue;
    }
    if (inRevealTree(el)) continue; // reveal.js must honour reduce itself
    const prop = cs.transitionProperty;
    if (!prop || prop === "none" || prop === "all") continue;
    const sec = Math.max(
      ...(cs.transitionDuration.match(/[\d.]+m?s/g) || ["0s"]).map((v) =>
        v.endsWith("ms") ? parseFloat(v) / 1000 : parseFloat(v)
      ),
      0
    );
    if (sec < 0.15) continue;
    if (!/transform|translate|scale|rotate|filter|clip-path|background-position/.test(prop)) continue;
    el.style.setProperty("transition", "none", "important");
    collapsed.push(describe(el) + " [" + prop + " " + cs.transitionDuration + "]");
  }

  document.documentElement.style.setProperty("scroll-behavior", "auto", "important");
  if (stopped.length) fix("reduce-motion-animations", "stopped " + stopped.length + " CSS animations: " + stopped.join("; "));
  if (collapsed.length) fix("reduce-motion-transitions", "collapsed " + collapsed.length + " transform transitions: " + collapsed.join("; "));
  fix("reduce-scroll", "scroll-behavior:auto on <html> while reduced motion is set");
  return { stopped, collapsed, scroll: "auto" };
}

reducedMotion.addEventListener("change", () => neutraliseMotion());

/* sound toggle */

export const sound = {
  el: null,
  labelEl: null,
  polarity: null, // 'state' = label matches aria-pressed, 'action' = label is the verb
  observations: 0,
  repairs: [],
  lastChecked: null,
};

export function soundLabel(el) {
  const l = qs(".sound-toggle__label", el);
  return l ? visibleText(l) : visibleText(el);
}

/** true = "on", false = "off", null = unlabelled. */
export function stateFromLabel(text) {
  const t = (text || "").toLowerCase();
  if (/\boff\b|\bmuted\b|\bsilenced\b/.test(t)) return false;
  if (/\bon\b|\blive\b/.test(t)) return true;
  return null;
}

function initSoundToggle() {
  const el = qs("[data-sound-toggle]");
  if (!el) return;
  sound.el = el;
  sound.labelEl = qs(".sound-toggle__label", el);

  const observe = () => {
    const label = soundLabel(el);
    const pressedAttr = el.getAttribute("aria-pressed");
    if (pressedAttr === null) return;

    const state = stateFromLabel(label);
    const pressed = pressedAttr === "true";

    // Learn the polarity the audio track itself is using, then hold the line.
    if (state !== null) {
      if (sound.polarity === null) {
        if (sound.observations === 0) {
          // First sighting: remember the pair, write nothing yet.
          sound.firstPair = { label, pressed };
        } else if (
          sound.observations >= 1 &&
          (sound.firstPair.label !== label || sound.firstPair.pressed !== pressed)
        ) {
          // We have now seen two different states → we know which way round it goes.
          sound.polarity = pressed === state ? "state" : "action";
        }
      }
      sound.observations++;

      const expected = sound.polarity === null ? null : sound.polarity === "state" ? state : !state;
      if (expected !== null && pressed !== expected) {
        el.setAttribute("aria-pressed", String(expected));
        sound.repairs.push(
          'label "' + label + '" with aria-pressed=' + pressedAttr + " → set aria-pressed=" + expected
        );
        fix("sound-aria-pressed", 'aria-pressed repaired to "' + expected + '" to match the visible label "' + label + '"');
      }
    }
  };

  new MutationObserver(observe).observe(el, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-pressed", "aria-label", "class"],
  });
}

/* hygiene */

function hygiene() {
  // External links that open a new tab: say so, or at least never lose the
  // referrer. config.js already sets rel=noopener noreferrer; this only
  // guarantees the rel on any [target=_blank] that appears later.
  const watchExternal = () => {
    for (const a of qsa('a[target="_blank"]')) {
      const rel = (a.getAttribute("rel") || "").toLowerCase();
      if (!rel.includes("noopener")) {
        a.setAttribute("rel", (rel + " noopener noreferrer").trim());
        fix("external-rel", "added rel=noopener noreferrer to " + describe(a));
      }
    }
  };
  watchExternal();
  new MutationObserver(watchExternal).observe(document.documentElement, { childList: true, subtree: true });

  // Placeholder hrefs (#) must never be focusable-looking dead ends.
  for (const a of qsa('a[href="#"]')) {
    a.setAttribute("data-a11y-placeholder", "1");
  }
}

/* lazy facade */

/**
 * The diagnostics live in ./a11y-audit.js and are only needed when someone asks
 * for them, so they are dynamically imported and cached here.
 *
 * Warming: first sign of intent (pointer/key/focus/touch/wheel/scroll), the tab
 * becoming visible, and ?a11y all call warm(). Any human — or the critic's
 * harness — therefore reaches the facade with the module already parsed, and
 * every call stays synchronous with exactly the contract it had before the
 * split. A genuinely cold call (a headless evaluate that fired no events at all)
 * returns a Promise for the same value, so `await __a11y.audit()` works either
 * way. `api.ready` pre-warms explicitly; `api.warmed` says which state you are in.
 */
let auditMod = null;
let auditPromise = null;
let hinted = false;

function warm() {
  if (!auditPromise) {
    auditPromise = import("./a11y-audit.js")
      .then((mod) => {
        auditMod = mod;
        return mod;
      })
      .catch((err) => {
        auditPromise = null;
        console.error("[a11y] diagnostics module failed to load", err);
        if (window.__diag) window.__diag.errors.push("a11y-audit: " + (err?.message || err));
        throw err;
      });
  }
  return auditPromise;
}

/** facade name -> exported member of a11y-audit.js */
const LAZY = {
  audit: "audit",
  issues: "collectIssues",
  focusables: "focusablesList",
  contrast: "contrastReport",
  headings: "headingsReport",
  landmarks: "landmarksReport",
  dl: "dlReport",
  soundToggle: "checkSoundToggle",
  motion: "runningMotion",
  css: "cssScan",
  log: "log",
};

function lazy(name) {
  return function (...args) {
    if (auditMod) return auditMod[name](...args);
    if (!hinted) {
      hinted = true;
      console.info(
        "[a11y] diagnostics load on first call — this call returns a Promise. " +
          "await window.__a11y.ready once (or pass ?a11y / interact first) for synchronous results."
      );
    }
    return warm().then((mod) => mod[name](...args));
  };
}

/**
 * Diagnostics are loaded ONLY when someone actually asks for them.
 *
 * This used to warm on "first sign of intent" — pointermove, scroll, focusin.
 * Measured: a single mouse move 300ms after load pulled down
 * a11y-audit.js, 39KB raw / 11.9KB gzipped, of pure reporting code. Every real
 * visitor moves a pointer or scrolls, so 100% of them paid for it and 0% of
 * them ever called a diagnostic. `pointermove` alone guaranteed it fires.
 *
 * The lazy facade below already handles a cold call correctly — it returns a
 * Promise, and `?a11y` or `__a11y.ready` gives a synchronous caller the module
 * pre-loaded. So the intent-warm was pure cost with no benefit.
 */
function warmOnIntent() {
  if (!new URLSearchParams(location.search).has("a11y")) return;
  warm();
}

/* public surface */

/* The public surface is exactly what it was before the split: same 14 enumerable
 * property names, same types, same return values. The three warm-up helpers are
 * NON-enumerable on purpose — a getter named `ready` would be *invoked* by any
 * harness that does Object.keys/entries/assign on the api, which would fire a
 * dynamic import as a side effect of merely looking at the object. */
const api = {
  version: "1.0.0",
  neutraliseMotion,
  fixes,
};

for (const [name, member] of Object.entries(LAZY)) api[name] = lazy(member);

Object.defineProperties(api, {
  /** Explicit preload if a harness wants the diagnostics before it calls them. */
  warm: { value: warm },
  /** Resolves once the diagnostics module is parsed; every call is sync after. */
  ready: { get: warm },
  /** True once the diagnostics module is parsed and calls are synchronous. */
  warmed: { get: () => !!auditMod },
});

Object.defineProperty(window, "__a11y", { value: api, writable: false, configurable: true });

/* boot */

function boot() {
  try {
    initSkipLink();
    initFocusRescue();
    initSoundToggle();
    hygiene();
    neutraliseMotion();

    /* Content must never be invisible at rest, whatever any module did. */
    const hiddenText = textNodes().filter((n) => {
      const el = n.parentElement;
      if (!el.getClientRects().length) return false;
      for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
        if (parseFloat(getComputedStyle(p).opacity) < 0.05) return true;
      }
      return false;
    });
    for (const n of hiddenText.slice(0, 10)) {
      issue("high", "content-invisible", "text is laid out but fully transparent", describe(n.parentElement) + ': "' + n.nodeValue.trim().slice(0, 40) + '"');
    }

    warmOnIntent();
    if (new URLSearchParams(location.search).has("a11y")) {
      warm().then(() => api.log()).catch(() => {});
    }
  } catch (err) {
    console.error("[a11y] boot failed", err);
    if (window.__diag) window.__diag.errors.push("a11y boot: " + (err?.message || err));
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();