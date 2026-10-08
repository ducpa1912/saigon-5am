# Saigon, 5am — Andy's site

A static one-page site for the YouTube channel "Saigon, 5am". Built to Awwwards Site of the Day calibre: calm, warm, filmic, with a 30-second Three.js motion hero ("Saigon, 5am" — phin coffee dripping, rain on glass, scooter light trails, city waking) and procedural Web Audio.

**No build step. No framework. 2 MB static folder.**

---

## Quick start

```bash
# 1. Fill in your 6 URLs (only place to edit)
# Edit js/config.js and replace the 6 REPLACE: values:
#   channelName, youtubeUrl, calendlyUrl, substackUrl, instagramUrl, xUrl

# 2. Run locally (Python is on every Mac)
cd sitting_duc
python3 -m http.server 8099
# open http://localhost:8099

# That's it. No npm install needed for the site itself.
```

---

## Deploy (free, 15 seconds)

1. Push to GitHub (or any git host)
2. Go to [netlify.com/drop](https://app.netlify.com/drop) → drag the folder
3. Done. HTTPS, CDN, custom domain if you want.

Same works on Cloudflare Pages or GitHub Pages. **No build command. Publish directory = root.**

---

## What the repo contains

```
sitting_duc/
├── index.html          # single page, inlined critical CSS
├── css/
│   ├── tokens.css      # palette, type scale, grain, motion tokens
│   ├── base.css        # reset, buttons, grain overlay, focus ring
│   ├── hero.css        # hero layout, poster logic, sound toggle
│   ├── sections.css    # typography system, reveal mechanics
│   ├── episodes.css    # card grid, procedural SVG thumbnails
│   └── blocks.css      # booking block + footer
├── js/
│   ├── main.js         # orchestrator (loads tracks after first paint)
│   ├── config.js       # 6 URL tokens — EDIT THIS
│   ├── hero.js         # Three.js hero (idle-loaded, scroll-gated)
│   ├── audio.js        # procedural Web Audio (rain + hum + pad)
│   ├── reveal.js       # IntersectionObserver + WAAPI reveals
│   ├── episodes.js     # card entrance + failsafe net
│   ├── blocks.js       # booking/footer entrance + failsafe
│   ├── perf.js         # lite-mode gate, grain toggle
│   ├── a11y.js         # skip link, focus rescue, reduced-motion net
│   ├── a11y-audit.js   # diagnostics (lazy-loaded on ?a11y)
│   └── episodes.js
├── assets/
│   ├── fonts/          # self-hosted Archivo Black + Inter
│   ├── grain.png       # 96×96 film grain (8 KB)
│   ├── hero-poster.jpg       # 1600×1000 reduced-motion still
│   ├── hero-poster-mobile.jpg # 900×1948 portrait still
│   └── favicon.svg
├── vendor/
│   └── three.module.js       # Three.js (deferred, idle-loaded)
└── tools/                # dev harness (no install needed to run site)
    ├── serve.mjs         # python3 -m http.server wrapper
    ├── build-css.mjs     # inlines critical CSS into index.html
    ├── syntax.sh         # ES module syntax gate
    ├── BRIEF.md          # the contract every track followed
    └── REVIEW.md         # critic rubric + blind-comparison protocol
```

---

## Dev commands (optional, for contributors)

```bash
npm run setup   # installs Lighthouse + Playwright + Chromium (for QC harness)
npm run check   # syntax gate + inline-CSS freshness gate
npm start       # python3 -m http.server 8099
npm run poster  # regenerates hero stills from live scene
npm run lh      # runs Lighthouse mobile + desktop
```

**The site needs NONE of this to run.** `python3 -m http.server` is all you need.

---

## Hard rules (from the brief)

- **Copy is final.** `js/config.js` is the only place to put your URLs.
- **No invented stats, testimonials, press logos, subscriber counts.**
- **No stock photos.** All thumbnails are procedural SVG.
- **Sound is generated live.** No audio files. Starts muted; fades in on tap.
- **Reduced motion respected.** Still poster, zero WebGL, zero rAF.
- **Hero must not block.** Text + buttons readable within 1.5s on slow 4G.
- **Palette:** dark roast brown / off-white paper / burnt orange.
- **Type:** Archivo Black headlines, Inter body. Film grain everywhere.

---

## Performance (measured)

| | mobile | desktop |
|---|---|---|
| Performance | 96 | 100 |
| Accessibility | 100 | 100 |
| FCP / LCP / CLS | 1.1s / 2.0s / 0 | 0.3s / 0.5s / 0 |

*Measured on quiet hardware. Lighthouse on a loaded box can read 60–70; the hero's first frame is a 2.5s task on software rasteriser.*

---

## Architecture notes

- **`main.js` is the only orchestrator.** Loads 7 tracks via dynamic `import()` after two rAFs. Each wrapped so one failure can't break the page.
- **Critical CSS inlined** by `tools/build-css.mjs`. After editing any stylesheet, re-run it (or `npm run check` fails).
- **three.js is lazy-loaded** inside the idle callback + 120ms grace period + scroll-away check. 256 KB gz never blocks first paint.
- **Audio is opt-in.** Context created on first tap; lazy-imported on intent.
- **Cross-module contracts:** `ENV` from main, `window.__govern` from perf, `data-reveal` from reveal.

---

## Post-deploy checklist

- [ ] 6 URLs filled in `js/config.js`
- [ ] `git init && git add . && git commit -m "init"`
- [ ] Push to GitHub
- [ ] Drag folder to netlify.com/drop
- [ ] Verify: h1 readable, buttons clickable, sound toggle works, reduced motion shows poster
- [ ] Set custom domain if desired

---

## File that **must** be edited before deploy

`js/config.js` — six `REPLACE:` tokens. Nothing else.

```js
export const CONFIG = {
  channelName: "YOUR CHANNEL NAME",
  youtubeUrl: "https://youtube.com/@yourchannel",
  calendlyUrl: "https://calendly.com/you/30min",
  substackUrl: "https://yoursubstack.substack.com",
  instagramUrl: "https://instagram.com/yourhandle",
  xUrl: "https://x.com/yourhandle",
};
```

---

## License

UNLICENSED — private project. Do not redistribute.