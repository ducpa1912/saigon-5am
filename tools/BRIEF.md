# SHARED BRIEF — read this first. Every track obeys it.

## Project
`/Users/happynghia/Public/Project/sitting_duc` — a **static one-page site**, no build step.
Owner: a YouTube channel called "Saigon, 5am" by Andy (unemployed marketer in Saigon).
Bar: **Awwwards Site of the Day**. Calm, warm, still-frame-from-a-slow-film. Not busy.

## Files that already exist — READ THEM before writing anything
- `index.html` — the full document. **The copy in it is FINAL.** Every word, every
  punctuation mark, every em dash. Do NOT rewrite, extend, "improve", add slogans,
  add stats, add testimonials, add press logos, add subscriber counts. Invent nothing.
- `css/tokens.css` — palette + type scale + spacing. **Use the tokens**, don't invent colours.
- `css/base.css` — reset, buttons, focus rings, film grain. Treat as read-only library.
- `js/main.js` — orchestrator. Loads your module dynamically AFTER first paint and
  records timings in `window.__diag`.
- `js/config.js` — the 6 URL tokens. Not your problem unless you own them.
- `vendor/three.module.js` — a **local copy**, imported only by the hero and
  lazily, from inside its idle callback. Import from `../vendor/...` only; never a CDN.
  GSAP/ScrollTrigger were vendored early and then deleted: `js/reveal.js` uses
  IntersectionObserver + the Web Animations API, so nothing references them.
- `assets/fonts/` — self-hosted Archivo Black + Inter. Never Google Fonts.
- `tools/shot.mjs`, `tools/lh.mjs`, `tools/serve.mjs` — verification harness.

## Palette (fixed)
- `--roast-900 #1a100b` page · `--roast-850 #221510` surface · `--roast-800 #2b1a13` card
- `--paper #f4ece1` text · `--paper-dim #d9cdbe` · `--paper-mute #a2937f`
- `--ember #d4562a` burnt orange accent · `--ember-hot #ef6b34` hover
- Subtle film grain already overlays the whole page via `body::after` in base.css.

## Cross-module contracts (tracks MUST agree on these — do not invent new ones)

`main.js` imports every track and records timings in `window.__diag`.

**1. `ENV` (from `main.js`, already available)**
`ENV.reducedMotion:boolean` · `ENV.coarsePointer:boolean` · `ENV.lite:boolean` · `ENV.dpr:number`
Also readable as `document.documentElement.dataset.motion` (`"full"|"reduced"`) and
`document.documentElement.dataset.perf` (`"full"|"lite"`).

**2. `window.__govern` — created by the PERF track (`js/perf.js`)**
Read it lazily (it may not exist yet when you start). Shape:
```js
window.__govern = {
  fps: 60,          // target cap for rAF loops (30 when lite)
  dprCap: 2,        // max devicePixelRatio for any canvas (1.5 when lite)
  registerLoop({ start, stop }),  // perf calls stop() when hero is off-screen or tab hidden
}
```
**Any track that owns a continuous rAF loop (that is: the HERO track) MUST register it
via `govern.registerLoop()` when available, and must also self-pause on
`document.visibilitychange`.** Never keep animating a hidden canvas.

**3. `js/reveal.js` — created by the TYPOGRAPHY/LAYOUT track**
Exports nothing you call; on import it wires `[data-reveal]` and `[data-reveal-stagger]`
scroll reveals for the whole page, honouring reduced motion. Every other track may add
`data-reveal` to its own markup via CSS only — but since you may not edit `index.html`,
ask for it in your final report if you need it.

**4. Do NOT edit `index.html`, `css/base.css`, `css/tokens.css` or `js/main.js`.**
If you need a markup or token change, put the exact diff in your final report and the
integrator will apply it. This keeps seven parallel tracks from trampling each other.

## Non-negotiable rules
1. **Respect `prefers-reduced-motion: reduce`.** `ENV.reducedMotion` is exposed by
   `main.js`. Read `document.documentElement.dataset.motion` / `matchMedia` directly
   if you prefer. Under reduce: no looping animation, no parallax, no scroll-jacking.
   Reveal content immediately with no transform.
2. **Never block first paint.** Copy lives in the HTML. Your module is loaded after
   first paint. Do not add render-blocking `<script>` or `<link>` to index.html.
3. **Budget: mobile Lighthouse performance 90+, accessibility 95+.**
   - No layout thrash. Batch reads/writes. Use `transform`/`opacity` only.
   - Respect `ENV.lite` (cheap-Android proxy) and degrade deliberately, not randomly.
   - Animate `opacity`/`transform`. Never animate width/height/top/left/filter on
     anything large, and never per-frame layout reads.
4. **Accessibility: 95+.** Keyboard reachable, visible focus (base.css ring is
   already there — don't remove it), 4.5:1 text contrast minimum, touch targets
   ≥ 44px, no information conveyed by colour alone, `aria-hidden` on decoration.
5. **Touch:** nothing critical under 44px. No hover-only affordances.
6. **Budget sizes.** Mobile gets a slow CPU. Aim: hero ≤ 4ms CPU/frame,
   total JS across the site ≤ ~90KB uncompressed beyond the three vendor libs.
7. Don't edit files you don't own. Don't run `npm install`. Don't add dependencies.
8. ES modules only, `type="module"`. Three.js imports as `import * as THREE from "../vendor/three.module.js"`.

## Verification you must run before reporting done
The static server should already be running on **http://localhost:8099**
(if not: `cd /Users/happynghia/Public/Project/sitting_duc && nohup node tools/serve.mjs 8099 > .cache/serve.log 2>&1 &`)

Take screenshots and **actually LOOK at them** with the read tool — a PNG is an
image you can see. This is the only way to know if it is beautiful:

```bash
cd /Users/happynghia/Public/Project/sitting_duc
node tools/shot.mjs hero --w=1440 --h=900 --dpr=2
node tools/shot.mjs hero --w=390 --h=844 --dpr=3
node tools/shot.mjs hero --w=1440 --h=900 --motion=reduce
node tools/shot.mjs hero --w=390 --h=844 --motion=reduce
node tools/shot.mjs hero --w=1440 --h=900 --full     # full page
```
They land in `.cache/shots/`. Read them. Judge them as a harsh art director.
`tools/shot.mjs` also prints console errors, page errors and 404s — fix all of them.

Useful page handles for inspecting from Playwright: `window.__diag` (module load
timings, `data-ready`), `document.documentElement.dataset.perf` (`lite`/`full`).

## Definition of "Site of the Day"
- Restrained. Lots of negative space. Nothing fighting for attention.
- Type does the heavy lifting; the 3D is atmosphere, not spectacle.
- Motion is slow, weighted and confident — never bouncy, never fast, never busy.
- Every pixel earns its place. If you cannot justify an element, delete it.
- Works and still looks considered on a 390px phone on a cracked screen.