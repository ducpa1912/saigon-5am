/**
 * reveal.js — the page's shared scroll-reveal, plus the masthead scroll state.
 * Owned by the TYPOGRAPHY / LAYOUT track. Exports nothing; wires itself on import.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT GSAP?
 * ---------------------------------------------------------------------------
 * GSAP + ScrollTrigger are 115KB uncompressed and this file needs to do one
 * thing: fade a block from opacity 0 to 1 while it travels 24px up, once,
 * when it enters the viewport. `IntersectionObserver` for the trigger and the
 * Web Animations API for the tween do that with ~2.5KB of source, no library,
 * and — importantly — on the compositor, because both properties are
 * transform/opacity only. GSAP would have been the right call if we were
 * scrubbing, pinning, or staggering timelines across a hero; for a one-shot
 * fade it is 50x the bytes for a worse-feeling default ease.
 * GSAP was vendored for this and then removed: IntersectionObserver + WAAPI
 * turned out to be enough for a one-shot fade, and nothing else on the site
 * needs a timeline engine.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT
 * ---------------------------------------------------------------------------
 *  · Content is visible by default. The hidden state lives in
 *    css/sections.css behind `:root[data-reveal-armed="on"]`, which is set
 *    here synchronously — so if this module is never evaluated, never loads,
 *    or throws halfway, nothing on the page is ever invisible.
 *  · `prefers-reduced-motion: reduce` never arms the hidden state at all.
 *    Elements are simply left alone, fully visible, with no transform.
 *  · Anything already within the viewport at init is marked revealed
 *    immediately (no animation), so a reload at the top of the page, a jump
 *    to #talk, or a slow module load never produces a flash or a pop.
 * ---------------------------------------------------------------------------
 */

import { ENV } from "./main.js";

/* ------------------------------------------------------------------ config -- */

const root = document.documentElement;

/** Slow, weighted, calm. A film fade-in, not a SaaS product. */
const DURATION = 1050;
const EASE = "cubic-bezier(0.16, 1, 0.3, 1)"; /* == --ease-out */
const TRAVEL = 24; /* px of y */
const STAGGER = 90; /* ms — never faster than 70 */

/**
 * Elements index.html does not (yet) mark up. Kept here so the page has a
 * coherent reveal rhythm today with zero markup changes; the moment the
 * integrator adds real `data-reveal` / `data-reveal-stagger` attributes to
 * index.html these simply stop matching anything new.
 *
 * `single` fades the element. `stagger` fades the element's direct children
 * one after another.
 *
 * SCOPE IS DELIBERATE AND EXCLUSIVE. These are exactly the elements no other
 * track claims:
 *   · the episode cards belong to js/episodes.js, which stands down only when a
 *     card carries `data-reveal` — so touching `.cards` here would put two
 *     competing opacity tweens on the same node.
 *   · `.talk__cta`, `.footer__link` and `.footer__sign` belong to js/blocks.js.
 *   · the hero owns its own entrance and is never touched by this file.
 */
const AUTO_SINGLE = [".section__index", ".section__title", ".prose"];

const AUTO_STAGGER = [".ideas"];

/** Show the masthead scrim only once we are genuinely into the body copy. */
const SCROLLED_AT = 72;

/* ------------------------------------------------------------------- state -- */

/** @type {Set<Element>} elements already faded in — never re-animated. */
const done = new Set();
/** @type {Set<Element>} anything we have already claimed, so a track adding
    a real `data-reveal` and our structural fallback cannot double-register. */
const claimed = new Set();
/** @type {Array<{el: Element, items: Element[], index: number}>} */
const singles = [];
/** @type {Array<{el: Element, items: Element[]}>} */
const groups = [];

let observer = null;
let armed = false;
let scrolledState = false;
let scrollQueued = false;
let motionQuery = null;
/** Elements still waiting on the observer. */
const pending = [];
/** Elements with a tween currently in flight. `done` only fills on finish. */
const playing = new Set();

/* ------------------------------------------------------------------- utils -- */

const prefersReduced = () =>
  motionQuery ? motionQuery.matches : false;

/** Show an element with no animation, no transform — its final state, now. */
function revealNow(el) {
  if (done.has(el)) return;
  done.add(el);
  playing.delete(el);
  el.classList.add("is-in");
}

/**
 * The actual tween. One shot, compositor-only, never re-run.
 * `fill: "backwards"` holds the from-state through the stagger delay and
 * releases at the end, at which point `.is-in` takes over — so there is no
 * frame where the element falls back to the CSS hidden state.
 */
function play(el, delay) {
  if (prefersReduced() || done.has(el) || playing.has(el)) {
    revealNow(el);
    return;
  }

  const travel = ENV?.lite ? TRAVEL * 0.7 : TRAVEL;
  let anim;
  try {
    anim = el.animate(
      [
        { opacity: 0, transform: `translate3d(0, ${travel}px, 0)` },
        { opacity: 1, transform: "none" },
      ],
      { duration: DURATION, delay, easing: EASE, fill: "backwards" }
    );
  } catch {
    /* No Web Animations (or a very odd element): just show it. */
    revealNow(el);
    return;
  }

  const finish = () => {
    done.add(el);
    playing.delete(el);
    el.classList.add("is-in");
    try {
      anim.cancel();
    } catch {
      /* already gone */
    }
  };

  anim.addEventListener("finish", finish, { once: true });
  anim.addEventListener("cancel", finish, { once: true });
}

/* ------------------------------------------------------------------ collect -- */

function markSingle(el) {
  if (!el || claimed.has(el) || done.has(el) || el.hasAttribute("data-reveal-off"))
    return;
  claimed.add(el);
  el.setAttribute("data-reveal", "auto");
  singles.push({ el, index: 0 });
}

function markGroup(el) {
  if (!el || claimed.has(el) || el.hasAttribute("data-reveal-off")) return;
  const items = [...el.children].filter(
    (c) =>
      !done.has(c) &&
      !claimed.has(c) &&
      !c.hasAttribute("data-reveal-off") &&
      !c.hasAttribute("data-reveal")
  );
  if (!items.length) return;
  claimed.add(el);
  items.forEach((c) => claimed.add(c));
  el.setAttribute("data-reveal-stagger", "auto");
  groups.push({ el, items });
}

function collect() {
  /* 1. Author-declared targets win. */
  document
    .querySelectorAll("[data-reveal]:not([data-reveal-stagger])")
    .forEach(markSingle);

  document
    .querySelectorAll("[data-reveal-stagger]")
    .forEach((el) => {
      if (claimed.has(el)) return;
      const items = [...el.children].filter(
        (c) => !done.has(c) && !claimed.has(c) && !c.hasAttribute("data-reveal-off")
      );
      if (items.length) {
        claimed.add(el);
        items.forEach((c) => claimed.add(c));
        groups.push({ el, items });
      } else {
        markSingle(el);
      }
    });

  /* 2. Structural fallback so the page reads as paced even before the markup
        carries explicit attributes. */
  for (const sel of AUTO_SINGLE) {
    document.querySelectorAll(sel).forEach(markSingle);
  }
  for (const sel of AUTO_STAGGER) {
    document.querySelectorAll(sel).forEach(markGroup);
  }
}

/** Everything this module will animate, in one flat list. */
function targets() {
  const all = [];
  for (const s of singles) all.push(s.el);
  for (const g of groups) all.push(...g.items);
  return all;
}

/* ------------------------------------------------------------------ masthead -- */

function setScrolled(next) {
  if (next === scrolledState) return;
  scrolledState = next;
  root.toggleAttribute("data-scrolled", next);
}

/** Re-check the pending list against the viewport. */
function sweepPending() {
  for (let i = pending.length - 1; i >= 0; i--) {
    const el = pending[i];
    if (el.getBoundingClientRect().top < innerHeight + 8) {
      pending.splice(i, 1);
      observer?.unobserve(el);
      revealNow(el);
    }
  }
  if (!pending.length) stopSweeping();
}

/**
 * Safety net for the observer, not the primary mechanism.
 *
 * IntersectionObserver delivers its callbacks on a frame, and that frame can
 * be very late on a page with a full-viewport WebGL canvas behind it. A fast
 * or programmatic scroll — a jump link, a Find-in-Page jump, an automated
 * screenshot pass — can carry an element straight through the trigger band and
 * back out again before the callback is ever delivered, stranding it at
 * opacity 0 for good. Measured, not theorised: a 497px-per-150ms sweep at
 * 768x900 lost all twelve targets that way.
 *
 * So while anything is still pending we re-read the pending rects on a 150ms
 * tick. Deliberately NOT tied to the scroll event: the same starvation that
 * delays the observer also delays scroll callbacks, and a scroll-tied net was
 * measurably flaky (12 of 12 stranded at dpr 3 on a phone). The tick stops
 * itself the moment `pending` empties, so a fully-read page pays nothing at
 * all — no rAF loop, no scroll reads, no timers.
 *
 * The reads are batched before any write, inside one task, so this is a single
 * layout flush rather than thrash.
 */
const SWEEP_MS = 150;
let sweepTimer = 0;

function stopSweeping() {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = 0;
}

function ensureSweeping() {
  if (sweepTimer || !pending.length) return;
  sweepTimer = setInterval(() => {
    if (document.hidden || !pending.length) {
      stopSweeping();
      return;
    }
    sweepPending();
    /* A negative bottom rootMargin has a dead zone in the last few percent of
       the document — nothing down there can ever cross the threshold. */
    if (pending.length && scrollY + innerHeight >= document.documentElement.scrollHeight - 2) {
      const rest = pending.splice(0, pending.length);
      rest.forEach((el) => {
        observer?.unobserve(el);
        schedule(el);
      });
      stopSweeping();
    }
  }, SWEEP_MS);
}

/* The masthead state is the only thing the scroll handler does. No layout
   reads here at all — `scrollY` is a cheap, already-resolved value, and the
   early-out means the class is only written on the two frames that actually
   cross the threshold. */
function onScrollFrame() {
  scrollQueued = false;
  if (document.hidden) return;
  setScrolled(scrollY > SCROLLED_AT);
}

function onScroll() {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(onScrollFrame);
}

function onResize() {
  if (!pending.length) return;
  sweepPending();
  onScrollFrame();
}

/* --------------------------------------------------------------------- wire -- */

function arm() {
  if (prefersReduced()) {
    /* Nothing hidden, nothing animated. Just make sure nothing that a
       previous run managed to hide stays hidden. */
    targets().forEach(revealNow);
    return;
  }

  /* Arm first (synchronously), then decide what is already on screen. */
  root.setAttribute("data-reveal-armed", "on");
  armed = true;

  const fold = innerHeight;
  const alreadySeen = [];
  const waiting = [];

  for (const el of targets()) {
    /* `top < fold` means any part of the element is already in (or above)
       the viewport. Those get no animation at all — the calmest possible
       "already in view" behaviour, and the one that cannot flash. */
    const rect = el.getBoundingClientRect();
    (rect.top < fold + 8 ? alreadySeen : waiting).push(el);
  }

  alreadySeen.forEach(revealNow);

  if (!waiting.length) return;

  if (!("IntersectionObserver" in window)) {
    waiting.forEach(revealNow);
    return;
  }

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        observer.unobserve(el);
        const i = pending.indexOf(el);
        if (i > -1) pending.splice(i, 1);
        schedule(el);
      }
    },
    {
      /* Fire once the element has climbed a little into the viewport, so the
         slow fade is already under way by the time it reaches the eye. */
      rootMargin: "0px 0px -8% 0px",
      threshold: 0,
    }
  );

  waiting.forEach((el) => {
    pending.push(el);
    observer.observe(el);
  });

  /* Two safety nets, both started here.
     1. The next frame, in case the browser resolved a URL fragment after this
        module already measured the fold — a deep link to #talk must never show
        a page of already-scrolled-past blank.
     2. A self-terminating 150ms tick for as long as anything is still pending,
        which covers the case where a starved frame never delivers the observer
        callback at all. */
  if (pending.length) {
    requestAnimationFrame(sweepPending);
    ensureSweeping();
  }
}

/**
 * Play everything that came due on the same frame, in one pass. Anything
 * revealed mid-frame is queued here and flushed on the next frame, so a
 * stagger group and its sibling singles that enter together land together
 * rather than racing each other by a frame.
 */
let batch = [];
let batchQueued = false;

function schedule(el) {
  batch.push(el);
  if (batchQueued) return;
  batchQueued = true;
  requestAnimationFrame(flushBatch);
}

function flushBatch() {
  batchQueued = false;
  const items = batch;
  batch = [];

  /* Local dedup for this batch only. Without it, step 3 sees the group
     children as "not done" — `done` is only filled when a tween finishes —
     and starts a SECOND animation on top of the first with a zero delay,
     which silently destroys the stagger. */
  const played = new Set();

  const singlesInBatch = singles.filter((s) => items.includes(s.el));
  const groupsInBatch = groups.filter((g) => g.items.some((i) => items.includes(i)));

  /* 1. Group children, staggered, in document order. */
  groupsInBatch.forEach((g) => {
    g.items.forEach((child, i) => {
      if (!items.includes(child) || played.has(child)) return;
      played.add(child);
      play(child, i * STAGGER);
    });
  });

  /* 2. Plain singles run alongside their group's children: within one section
        the marker, the heading and the copy should arrive as one gesture, not
        as three queued beats. */
  singlesInBatch.forEach((s) => {
    if (played.has(s.el)) return;
    played.add(s.el);
    play(s.el, 0);
  });

  /* 3. Safety net: anything in the batch that nothing claimed still gets shown. */
  items.forEach((el) => {
    if (!done.has(el) && !played.has(el)) revealNow(el);
  });
}

function onMotionChange(e) {
  if (e.matches) {
    /* Reduce switched on mid-session: stop everything, show everything,
       and take the hidden state back off the document entirely. */
    stopSweeping();
    try {
      observer?.disconnect();
    } catch {
      /* noop */
    }
    observer = null;
    targets().forEach(revealNow);
    if (armed) {
      root.removeAttribute("data-reveal-armed");
      armed = false;
    }
  } else {
    /* Reduce switched off mid-session: leave the page exactly as it is.
       Re-animating settled content would be worse than doing nothing. */
    if (!armed) return;
  }
}

/* --------------------------------------------------------------------- init -- */

try {
  motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
  collect();
  arm();

  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onResize, { passive: true });
  motionQuery.addEventListener?.("change", onMotionChange);

  /* First paint after any late-arriving content or a restored scroll. */
  addEventListener(
    "pageshow",
    () => {
      if (!observer) targets().forEach(revealNow);
      onScrollFrame();
    },
    { once: true }
  );

  /* A JS error anywhere below must never be able to leave the page blank. */
  addEventListener("error", disarm);
  addEventListener("unhandledrejection", disarm);
} catch (err) {
  disarm();
  console.warn("[reveal] disabled:", err?.message || err);
}

function disarm() {
  try {
    observer?.disconnect();
  stopSweeping();
  } catch {
    /* noop */
  }
  observer = null;
  if (armed) {
    root.removeAttribute("data-reveal-armed");
    armed = false;
  }
  targets().forEach(revealNow);
}
