/**
 * episodes.js — the "Latest episodes" cards.
 *
 * Two jobs, both tiny:
 *   1. a calm staggered entrance (js/reveal.js only ever owns [data-reveal],
 *      and cards ship without it, so we drive our own — but we stand down
 *      completely if reveal.js is given the markup instead);
 *   2. nothing else. Links are already real hrefs from config.js; we never
 *      intercept navigation and never add target/rel.
 *
 * All art is CSS. There is no canvas, no image request, no work at runtime.
 */
import { ENV } from "./main.js";

const cards = Array.from(document.querySelectorAll("[data-episode]"));
const list = document.querySelector(".cards");

/* Cards handed to reveal.js get its entrance, not ours. */
const mine = cards.filter((c) => !c.hasAttribute("data-reveal"));

function showAll() {
  mine.forEach((c) => c.classList.add("is-in"));
}

function onScreen(el) {
  const r = el.getBoundingClientRect();
  return r.top < innerHeight && r.bottom > 0;
}

/* Nothing may depend on an observer firing: if a card is already in view (deep
   link, restored scroll, print, full-page capture) reveal it immediately.

   Reveal ONLY what is on screen. This used to be `mine.filter(onScreen).forEach(showAll)`
   — which hard-revealed all three cards the moment the FIRST crossed 15%, and
   a `setTimeout(showAll, 2500)` that fired regardless of scroll. Both meant the
   entrance played off-screen and was never seen: measured, all three cards hit
   opacity 1 at t=2601ms while still 817px below the fold, so by the time a
   reader scrolled to them the 950ms fade was already spent. */
function settle() {
  for (const card of mine) {
    if (!card.classList.contains("is-in") && onScreen(card)) card.classList.add("is-in");
  }
}

/* Reduced motion: no transforms, no transitions — just be there. */
if (ENV.reducedMotion || !mine.length || !("IntersectionObserver" in window)) {
  showAll();
} else {
  /* If anything throws from here on, the cards MUST still end up visible —
     they are the page's main content. Arming the hidden state is therefore the
     LAST thing we do, so any throw before it leaves them visible by default,
     and the two global nets cover a throw that happens after it. */
  try {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("is-in");
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.15 }
    );

    /* The stagger lives in CSS as --in-delay, consumed ONLY by the entrance
       rule. It used to be an inline `transition-delay`, which applies to every
       transition on the element — so each card's HOVER was also delayed by up to
       180ms and the 2-up felt like it was loading rather than alive. */
    mine.forEach((card) => io.observe(card));

    /* Check now, after fonts land (the hero resizes the page), and again on
       resize in case layout settled late. Not `once` — the one-shot missed the
       reflow it existed to catch. */
    settle();
    document.fonts?.ready.then(settle).catch(() => {});
    addEventListener("resize", settle, { passive: true });

    /* Safety net: reveals only what is CURRENTLY on screen, so it can never
       pre-empt the trigger and spend the animation off-screen. Self-clearing,
       then hard-cleared after 15s so no timer outlives the page's interest. */
    const net = setInterval(() => {
      if (mine.every((c) => c.classList.contains("is-in"))) return clearInterval(net);
      settle();
    }, 500);
    setTimeout(() => clearInterval(net), 15000);

    /* Belt and braces, mirroring reveal.js: a failure anywhere on the page
       reveals the cards rather than leaving a blank section. */
    addEventListener("error", showAll);
    addEventListener("unhandledrejection", showAll);

    if (list) list.classList.add("episodes--armed"); // armed LAST
  } catch {
    showAll();
  }
}

/* NOTE — the load-failure net lives in js/main.js, not here.
   main.js imports us with `import("./episodes.js")` inside a try/catch. If ANY
   top-level statement in this module throws, the module never finishes
   evaluating, so NOTHING here runs — not the try/catch below, not the
   addEventListener calls inside it. Measured: routing this module to one that
   adds `.episodes--armed` and then throws left all three cards at opacity 0 with
   no recovery path. The net therefore has to be registered by the orchestrator,
   which is the only thing guaranteed to still be alive. See `load()` in main.js. */
