/**
 * blocks.js — the two closing blocks: the booking statement (#talk) and the
 * page's ending (#footer). Owned by the BOOKING & FOOTER track.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES, AND WHY IT IS ALMOST NOTHING
 * ---------------------------------------------------------------------------
 * css/blocks.css already renders both blocks in their finished state. This
 * module only *arms* them (a hidden state + a single IntersectionObserver) and
 * plays one slow entrance per element. Consequences worth stating plainly:
 *
 *  · No JS, a failed import, or a blocked network → the page reads perfectly.
 *    There is no state in which the booking button or the footer links are
 *    hidden, because the hidden state lives behind a class this file adds.
 *  · `prefers-reduced-motion: reduce` → this module arms nothing at all. No
 *    transform, no transition, no delay; the finished CSS state is already the
 *    visible state.
 *  · `ENV.lite` (cheap Android) → opacity only, no travel, no stagger.
 *  · One observer, one shot per element, no rAF loop, no per-frame work. This
 *    track owns no continuous animation, so there is nothing to register with
 *    `window.__govern` and no reason to watch visibilitychange.
 *
 * config.js owns href / target / rel for every link. There are no click
 * handlers here, no dialog, no newsletter capture, no exit intent, no
 * focus-trap. The footer is three links and one sentence.
 */

import { ENV } from "./main.js";

const reduced = ENV?.reducedMotion === true;

if (!reduced) {
  const talk = document.querySelector("#talk");
  const cta = document.querySelector("#talk .talk__cta");
  const nav = document.querySelector("#footer .footer__nav");
  const sign = document.querySelector("#footer .footer__sign");
  const links = nav ? [...nav.querySelectorAll("[data-footer-link]")] : [];

  /* ------------------------------------------------------- hand-off ------
     Defensive, and today a no-op: js/reveal.js has ceded `.talk__cta`,
     `.footer__link` and `.footer__sign` to this module, so its structural
     fallback list no longer reaches the footer.

     Keep it anyway, because two systems animating one node is the single way
     this block breaks — the nav would fade up as a whole while the links
     staggered inside it, and every link would travel twice. If a later edit
     puts `.footer__nav` or `.footer__sign` back into that list, dropping the
     attribute which drives its hidden state and cancelling the animation it
     has already queued keeps the two from colliding. Cancelling trips
     reveal.js's own cancel handler, which marks the element done for good. */
  const taken = new Set([nav, sign].filter(Boolean));
  for (const el of taken) el.removeAttribute("data-reveal");

  /** Cancel anything the shared reveal may have in flight on an element we took. */
  const release = (el) => {
    if (!taken.has(el) || typeof el.getAnimations !== "function") return;
    for (const anim of el.getAnimations()) anim.cancel();
  };

  /* ------------------------------------------------------- arm ----------
     Travel, in document order. The booking action arrives first; the footer
     then reads as three destinations landing in sequence, with the sign-off
     after them — the eye is walked down the page to the last word. */
  const items = [];
  if (cta) items.push([cta, 0]);
  links.forEach((el, i) => items.push([el, i + 1]));
  if (sign) items.push([sign, links.length + 1]);

  /* Cheap device: keep the arrival, drop the choreography. */
  const calm = ENV?.lite === true;

  for (const [el, i] of items) {
    el.style.setProperty("--i", String(i));
    el.classList.add("bl-in");
    if (calm) el.classList.add("bl-in--calm");
  }
  if (talk) talk.classList.add("bl-lit");

  const shown = new Set();
  const show = (el) => {
    /* Idempotent, so the observer and the safety sweep below can both call it
       without one cancelling the other's animation. */
    if (shown.has(el)) return;
    shown.add(el);
    release(el);
    el.classList.add("bl-on");
    /* One more pass on the next frame: reveal.js batches its own plays through
       a rAF, so an animation it has not created yet can still be cancelled. */
    requestAnimationFrame(() => release(el));
  };

  const observed = items.map(([el]) => el);
  if (talk) observed.push(talk);

  if (typeof IntersectionObserver !== "function") {
    observed.forEach(show);
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          io.unobserve(entry.target);
          show(entry.target);
        }
      },
      /* No negative bottom margin: the sign-off is the last thing in the
         document, so it must never need a scroll that does not exist. */
      { threshold: 0 }
    );
    observed.forEach((el) => io.observe(el));

    /* Safety net, NOT a second system.
       IntersectionObserver delivers callbacks on a frame, and that frame can be
       very late behind a full-viewport WebGL canvas. reveal.js measured this:
       a 497px-per-150ms sweep at 768x900 lost all twelve of its targets —
       they crossed the trigger band and left again before the callback was
       ever delivered, stranding them at opacity: 0 permanently.

       Here the stakes are worse than a paragraph failing to fade: these five
       elements are the page's ONLY conversion action and its ONLY links, plus
       the hairlines that frame the plate. A fast fling on a cheap phone that
       skips the trigger band would leave them invisible for good.

       Self-terminating: the timer clears itself the moment the list empties, so
       a reader who never scrolls pays nothing. */
    const pending = new Set(observed);
    const sweep = setInterval(() => {
      for (const el of pending) {
        if (el.getBoundingClientRect().top < innerHeight + 8) {
          pending.delete(el);
          show(el);
        }
      }
      if (!pending.size) clearInterval(sweep);
    }, 150);
  }
}