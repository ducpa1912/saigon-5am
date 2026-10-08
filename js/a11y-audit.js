/**
 * a11y-audit.js — ACCESSIBILITY TRACK: the verification surface.
 *
 * Nothing in this file runs during a normal visit. It is loaded on demand by
 * ./a11y.js (see `warm()` there) whenever a human or a harness calls
 * window.__a11y.audit() / .issues() / .contrast() … — or as soon as the first
 * sign of intent arrives, so that call is still synchronous.
 *
 * What it provides, all from live computed style rather than from assumptions:
 *
 *   · audit()             the full report: every focusable with its accessible
 *                         name and measured contrast, every text node and its
 *                         measured contrast vs its effective background,
 *                         heading order, landmarks, dl/dt/dd validity, aria
 *                         wiring, tabindex sanity, roles without a name,
 *                         invisible-but-focusable elements, CSS scan for
 *                         outline:none, running motion, runtime fixes
 *   · collectIssues()     a flat, ranked defect list with exact evidence
 *   · contrastReport()    per-text-node WCAG ratios
 *   · headingsReport() / landmarksReport() / dlReport()
 *   · focusablesList()    tab order with names, roles, hidden reasons
 *   · checkSoundToggle()  read-only verification of the toggle's state channels
 *   · runningMotion() / cssScan()
 *   · log()               console table of the ranked list
 *
 * Shared primitives (describe, visibleText, cssVisible, textNodes, the issue
 * list, …) are imported one-way from ./a11y.js. There is no circular import:
 * a11y.js only ever reaches this file through a dynamic import().
 */

import {
  qs,
  qsa,
  issues,
  fixes,
  issue,
  describe,
  visibleText,
  isHiddenForName,
  hasBox,
  cssVisible,
  invisibilityReason,
  textNodes,
  reduced,
  stuckFocus,
  recordFocusStuck,
  sound,
  soundLabel,
  stateFromLabel,
  REVEAL_SEL,
} from "./a11y.js";

/* ========================================================================== *
 * 1. focusable selectors
 * ========================================================================== */

const FOCUSABLE = [
  "a[href]",
  "area[href]",
  "button",
  "input",
  "select",
  "textarea",
  "iframe",
  "summary",
  "audio[controls]",
  "video[controls]",
  "embed",
  "object",
  "[tabindex]",
  "[contenteditable]:not([contenteditable='false'])",
].join(",");

const LANDMARK = "main, nav, header, footer, aside, section[aria-labelledby], section[aria-label], form, [role]";

/* ========================================================================== *
 * 2. colour maths — real computed colours, real WCAG ratios
 * ========================================================================== */

const probe = document.createElement("canvas").getContext("2d", {
  willReadFrequently: true,
});

/**
 * Normalise ANY CSS colour syntax (rgb, rgba, oklab, color-mix, hex, named…)
 * to sRGB + alpha by letting the compositor parse it. Returns null if the
 * browser cannot paint the value at all.
 */
function toRGBA(color) {
  if (!color) return null;
  const c = String(color).trim();
  if (!c || c === "transparent") return [0, 0, 0, 0];
  try {
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = "#000";
    probe.fillStyle = c;
    probe.fillRect(0, 0, 1, 1);
    const d = probe.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  } catch {
    return null;
  }
}

const srgbToLinear = (u) => {
  const s = u / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

function luminance([r, g, b]) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrast(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** Flatten a translucent layer over an opaque backdrop. */
function over(layer, backdrop) {
  const a = layer[3];
  if (a >= 1) return layer.slice(0, 3);
  if (a <= 0) return backdrop.slice(0, 3);
  return [
    layer[0] * a + backdrop[0] * (1 - a),
    layer[1] * a + backdrop[1] * (1 - a),
    layer[2] * a + backdrop[2] * (1 - a),
  ];
}

const hex = ([r, g, b]) =>
  "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Effective background behind an element, walking ancestors and compositing
 * every translucent background layer. Flags the cases this cannot resolve
 * honestly in-page (gradients/images/ancestor opacity/blend modes) rather than
 * reporting a number it made up — the Playwright sampler measures those from
 * real pixels instead.
 */
function effectiveBackground(el) {
  const layers = [];
  let unverified = null;
  let node = el;
  let guard = 0;

  while (node && node.nodeType === 1 && guard++ < 60) {
    const cs = getComputedStyle(node);

    if (cs.backgroundImage && cs.backgroundImage !== "none") {
      unverified ||= "background-image/gradient on " + describe(node);
    }
    const op = parseFloat(cs.opacity);
    if (node !== el && op < 1) {
      unverified ||= "ancestor opacity " + op + " on " + describe(node);
    }
    if (cs.mixBlendMode && cs.mixBlendMode !== "normal") {
      unverified ||= "mix-blend-mode " + cs.mixBlendMode + " on " + describe(node);
    }
    if (cs.filter && cs.filter !== "none") {
      unverified ||= "filter on " + describe(node);
    }

    const bg = toRGBA(cs.backgroundColor);
    if (bg && bg[3] > 0) {
      layers.push(bg);
      if (bg[3] >= 1) break;
    }
    node = node.parentElement;
  }

  // Page canvas: if we walked off the top without an opaque layer, the browser
  // paints white (or the UA canvas colour) underneath.
  let out = [255, 255, 255];
  for (let i = layers.length - 1; i >= 0; i--) out = over(layers[i], out);

  return { rgb: out, hex: hex(out), unverified };
}

/* ========================================================================== *
 * 3. accessible names + descriptions
 * ========================================================================== */

/** Accessible name, per accname order of preference for this document. */
function accName(el) {
  const labelled = el.getAttribute("aria-labelledby");
  if (labelled) {
    const t = labelled
      .split(/\s+/)
      .map((id) => qs("#" + CSS.escape(id)))
      .filter(Boolean)
      .map((n) => visibleText(n))
      .join(" ")
      .trim();
    if (t) return t;
  }
  const label = el.getAttribute("aria-label");
  if (label && label.trim()) return label.trim();
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
    const lb = el.labels && el.labels[0];
    if (lb) return visibleText(lb);
    const ph = el.getAttribute("placeholder");
    if (ph) return ph.trim();
    const title = el.getAttribute("title");
    if (title) return title.trim();
    return "";
  }
  if (el.tagName === "IMG") return el.getAttribute("alt") || "";
  const txt = visibleText(el);
  if (txt) return txt;
  const title = el.getAttribute("title");
  return title ? title.trim() : "";
}

function accDescription(el) {
  const ids = (el.getAttribute("aria-describedby") || "").trim();
  if (!ids) return null;
  const missing = [];
  let text = "";
  for (const id of ids.split(/\s+/)) {
    const n = document.getElementById(id);
    if (!n) {
      missing.push(id);
      continue;
    }
    text += (text ? " " : "") + visibleText(n);
  }
  return { text, missing, refs: ids };
}

/* ========================================================================== *
 * 4. visibility predicates used only by the audit
 * ========================================================================== */

/** Painted: has a box and is not display:none / visibility:hidden. */
function cssPainted(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse")
      return false;
    if (n.hidden || n.hasAttribute("inert")) return false;
  }
  return hasBox(el);
}

/** Would a screen reader announce this element? (opacity:0 still counts.) */
function inA11yTree(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.display === "none" || cs.visibility === "hidden" || n.hasAttribute("aria-hidden") || n.hasAttribute("inert"))
      return false;
  }
  return true;
}

function isDisabled(el) {
  return el.disabled === true || el.getAttribute("aria-disabled") === "true";
}

/* ========================================================================== *
 * 5. focusables, in tab order
 * ========================================================================== */

function focusables(root = document) {
  const out = [];
  for (const el of qsa(FOCUSABLE, root)) {
    const ti = el.getAttribute("tabindex");
    // NOTE: opacity:0 does NOT remove an element from the tab order — only
    // display:none, visibility:hidden, inert and disabled do. So tabbability is
    // computed from `painted`, and `visible` is reported separately as the
    // "invisible but focusable" defect.
    const tabbable =
      ti === null
        ? !isDisabled(el) && cssPainted(el)
        : Number(ti) >= 0 && !isDisabled(el) && cssPainted(el);
    const rec = {
      el,
      sel: describe(el),
      name: accName(el),
      tabindex: ti,
      focusable: focusablesMatch(el),
      tabbable,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || implicitRole(el),
      hidden: !cssVisible(el),
      hiddenReason: invisibilityReason(el),
    };
    out.push(rec);
  }
  // Positive tabindexes come first in ascending order, then everything else in
  // DOM order — that is what the UA does.
  return out.sort((a, b) => {
    const ap = a.tabindex === null ? -1 : Number(a.tabindex);
    const bp = b.tabindex === null ? -1 : Number(b.tabindex);
    if (ap > 0 && bp > 0) return ap - bp || domOrder(a.el, b.el);
    if (ap > 0) return -1;
    if (bp > 0) return 1;
    return domOrder(a.el, b.el);
  });
}

/** Public shape: the live element is stripped, exactly as before. */
export function focusablesList(root = document) {
  return focusables(root).map(({ el, ...rest }) => rest);
}

function focusablesMatch(el) {
  return !isDisabled(el) && (el.getAttribute("tabindex") !== null || el.matches(FOCUSABLE));
}

function implicitRole(el) {
  const t = el.tagName;
  if (t === "A") return el.hasAttribute("href") ? "link" : "generic";
  if (t === "BUTTON") return "button";
  if (t === "NAV") return "navigation";
  if (t === "MAIN") return "main";
  if (t === "FOOTER") return el.closest("article, aside, main, nav, section") ? "generic" : "contentinfo";
  if (t === "HEADER") return el.closest("article, aside, main, nav, section") ? "generic" : "banner";
  if (t === "SECTION") return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : "generic";
  if (t === "IMG") return "img";
  return "generic";
}

function domOrder(a, b) {
  const p = a.compareDocumentPosition(b);
  if (p & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  if (p & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  return 0;
}

/* ========================================================================== *
 * 6. contrast — every text node on the page
 * ========================================================================== */

function largeText(fontSizePx, fontWeight) {
  const w = parseInt(fontWeight, 10) || 400;
  return fontSizePx >= 24 || (fontSizePx >= 18.66 && w >= 700);
}

/**
 * Measure contrast for one text node. Uses computed colour (composited over its
 * effective background) and the *smallest* ratio across all its client rects.
 */
function measureTextNode(node) {
  const el = node.parentElement;
  const cs = getComputedStyle(el);
  const size = parseFloat(cs.fontSize) || 16;
  const weight = cs.fontWeight;
  const big = largeText(size, weight);
  const fg = toRGBA(cs.color) || [0, 0, 0, 1];
  const bgInfo = effectiveBackground(el);

  const range = document.createRange();
  range.selectNodeContents(node);
  const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);

  let worst = Infinity;
  for (let r = rects.length - 1; r >= 0; r--) {
    const c = contrast(over(fg, bgInfo.rgb), bgInfo.rgb);
    if (c < worst) worst = c;
  }
  if (!rects.length) worst = null;

  const decorative = isHiddenForName(el);
  return {
    sel: describe(el),
    text: node.nodeValue.replace(/\s+/g, " ").trim().slice(0, 70),
    fg: hex(fg.slice(0, 3)),
    fgAlpha: fg[3],
    bg: bgInfo.hex,
    bgUnverified: bgInfo.unverified,
    size: Math.round(size * 10) / 10,
    weight,
    large: big,
    required: big ? 3 : 4.5,
    ratio: worst === null ? null : round2(worst),
    pass: worst === null ? null : worst >= (big ? 3 : 4.5),
    decorative,
    rects: rects.length,
  };
}

export function contrastReport() {
  const rows = textNodes().map(measureTextNode);
  const fails = rows.filter((r) => r.pass === false);
  return { total: rows.length, fails, all: rows };
}

/* ========================================================================== *
 * 7. heading + landmark + dl audit
 * ========================================================================== */

export function headingsReport() {
  const hs = qsa("h1,h2,h3,h4,h5,h6,[role=heading]")
    .filter((el) => !isHiddenForName(el) || el.getAttribute("role") === "heading")
    .map((el) => {
      const level = /^H([1-6])$/.test(el.tagName)
        ? Number(el.tagName[1])
        : Number(el.getAttribute("aria-level") || 2);
      return { level, sel: describe(el), name: visibleText(el).slice(0, 60), hidden: isHiddenForName(el) };
    });

  const problems = [];
  const visible = hs.filter((h) => !h.hidden);
  if (!visible.length) problems.push({ code: "no-heading", message: "No exposed heading on the page" });
  const h1s = visible.filter((h) => h.level === 1);
  if (h1s.length === 0) problems.push({ code: "no-h1", message: "No <h1> exposed to AT" });
  if (h1s.length > 1)
    problems.push({ code: "multiple-h1", message: `${h1s.length} <h1> exposed`, evidence: h1s.map((h) => h.sel) });

  let prev = null;
  for (const h of visible) {
    if (prev !== null && h.level > prev + 1) {
      problems.push({
        code: "heading-skip",
        message: `h${prev} → h${h.level} skips a level`,
        evidence: `${prev && prev.sel} then ${h.sel} ("${h.name}")`,
      });
    }
    prev = h.level;
  }

  // headings that are exposed but visually hidden carry meaning nobody sees.
  const hiddenHeadings = hs.filter((h) => h.hidden);
  return { headings: hs, problems, hiddenHeadings };
}

export function landmarksReport() {
  const found = qsa(LANDMARK)
    .filter((el) => el.getAttribute("role") !== "presentation" && el.getAttribute("role") !== "none")
    .map((el) => {
      const name = accName(el);
      return {
        sel: describe(el),
        role: el.getAttribute("role") || implicitRole(el),
        name,
        labelled: el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby"),
      };
    });
  const problems = [];

  const mains = qsa("main, [role=main]");
  if (mains.length !== 1)
    problems.push({ code: "main-count", message: `expected exactly 1 <main>, found ${mains.length}` });

  for (const el of qsa("nav")) {
    if (!el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby"))
      problems.push({ code: "nav-unnamed", message: "<nav> has no accessible name", evidence: describe(el) });
  }
  for (const el of qsa("section")) {
    const named = el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby");
    const deep = el.querySelector("section");
    if (!named && !deep)
      problems.push({ code: "section-unnamed", message: "<section> is not a labelled landmark", evidence: describe(el) });
  }
  // aria-labelledby / aria-describedby targets must exist.
  for (const el of qsa("[aria-labelledby], [aria-describedby]")) {
    for (const id of (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)) {
      if (!document.getElementById(id))
        problems.push({ code: "dangling-aria", message: "aria reference to missing #" + id, evidence: describe(el) });
    }
    for (const id of (el.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean)) {
      if (!document.getElementById(id))
        problems.push({ code: "dangling-aria", message: "aria-describedby to missing #" + id, evidence: describe(el) });
    }
  }
  // Duplicate ids break every aria reference.
  const seen = new Map();
  for (const el of qsa("[id]")) {
    seen.set(el.id, (seen.get(el.id) || 0) + 1);
  }
  for (const [id, n] of seen) {
    if (n > 1) problems.push({ code: "duplicate-id", message: `#${id} appears ${n}×`, evidence: "id must be unique" });
  }
  return { landmarks: found, problems };
}

export function dlReport() {
  const problems = [];
  for (const dl of qsa("dl")) {
    const groups = [...dl.children];
    let open = false;
    for (const child of groups) {
      if (child.tagName === "DT") {
        if (open) problems.push({ code: "dl-order", message: "consecutive <dt>", evidence: describe(dl) });
        open = true;
      } else if (child.tagName === "DD") {
        if (!open) problems.push({ code: "dl-order", message: "<dd> with no preceding <dt>", evidence: describe(child) });
        open = false;
      } else if (child.tagName === "DIV") {
        // HTML permits div wrappers, but the contents must alternate dt/dd.
        const kids = [...child.children].map((k) => k.tagName);
        let expect = "DT";
        for (const k of kids) {
          if (k !== expect)
            problems.push({
              code: "dl-div-order",
              message: `<div> inside <dl> must hold dt then dd, saw ${kids.join(",")}`,
              evidence: describe(child),
            });
          expect = expect === "DT" ? "DD" : "DT";
        }
        open = false;
      } else {
        problems.push({
          code: "dl-child",
          message: `<${child.tagName.toLowerCase()}> is not allowed as a direct child of <dl>`,
          evidence: describe(child),
        });
        open = false;
      }
    }
    if (open) problems.push({ code: "dl-order", message: "<dt> with no <dd>", evidence: describe(dl) });
    if (!dl.querySelector("dt")) problems.push({ code: "dl-empty", message: "<dl> with no <dt>", evidence: describe(dl) });
  }
  return { problems };
}

/* ========================================================================== *
 * 8. CSS scan — outline:none, viewport locks, big motion
 * ========================================================================== */

export function cssScan() {
  const out = { outlineNone: [], motion: [], sheets: 0, blocked: 0 };
  const DUR = /(\d*\.?\d+)(m?s)/;

  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      out.blocked++;
      continue; // cross-origin sheet — cannot be a defect we own
    }
    if (!rules) continue;
    out.sheets++;

    const walk = (list, ctxSel) => {
      for (const r of list) {
        const sel = r.selectorText ? (ctxSel ? ctxSel + " :: " : "") + r.selectorText : ctxSel;
        // NOTE: modern Chrome exposes an (usually empty) `cssRules` on every
        // CSSStyleRule for nested-CSS support, so recursing on the mere
        // presence of `.cssRules` silently drops every normal rule. Recurse
        // only when there is genuinely something to recurse into.
        const kids = r.cssRules;
        if (kids && kids.length && r.style === undefined) {
          walk(kids, sel + (r.conditionText ? " @" + r.conditionText : r.conditionText === "" ? "" : ""));
          continue;
        }
        if (!r.style) continue;
        const st = r.style;

        const outline = st.getPropertyValue("outline") || st.getPropertyValue("outline-style");
        if (/^(none|0)\b/.test(outline.trim()) || /outline:\s*(none|0)/.test(st.cssText)) {
          out.outlineNone.push({ selector: sel, css: st.cssText.slice(0, 120) });
        }

        const props = (st.getPropertyValue("transition") || "").trim();
        const anim = (st.getPropertyValue("animation") || "").trim();
        const durS = (v) => {
          const m = DUR.exec(v || "");
          if (!m) return 0;
          return parseFloat(m[1]) * (m[2] === "ms" ? 0.001 : 1);
        };
        for (const [kind, value] of [["transition", props], ["animation", anim]]) {
          if (!value || value === "none" || value === "0s") continue;
          const moved = /\b(transform|translate|all)\b/.test(value);
          const infinite = /\binfinite\b/.test(value);
          const d = Math.max(...(value.match(/[\d.]+m?s/g) || ["0s"]).map(durS), 0);
          if (infinite || (moved && (d >= 0.15 || kind === "animation"))) {
            out.motion.push({ selector: sel, kind, value: value.slice(0, 160), infinite, seconds: d });
          }
        }
      }
    };
    walk(rules, "");
  }
  return out;
}

/* ========================================================================== *
 * 9. motion — what actually runs right now
 * ========================================================================== */

export function runningMotion() {
  const out = [];
  for (const el of qsa("body *")) {
    const cs = getComputedStyle(el);
    const aName = cs.animationName;
    const aIter = cs.animationIterationCount;
    const aDur = cs.animationDuration;
    if (aName && aName !== "none") {
      out.push({
        sel: describe(el),
        kind: "animation",
        name: aName,
        iterations: aIter,
        duration: aDur,
        infinite: aIter.split(",").some((v) => v.trim() === "infinite"),
      });
    }
    const tProp = cs.transitionProperty;
    const tDur = cs.transitionDuration;
    if (tProp && tProp !== "none" && tProp !== "all" && !tProp.includes("none")) {
      out.push({ sel: describe(el), kind: "transition", name: tProp, duration: tDur, iterations: "-" });
    }
  }
  return out;
}

/* ========================================================================== *
 * 10. sound toggle — read-only verification
 * ========================================================================== */

/**
 * Read-only verification. Returns the facts the critic needs:
 * native button?, aria-pressed present?, accessible name stable?, does
 * aria-describedby resolve to visible hint text?
 */
export function checkSoundToggle() {
  const el = qs("[data-sound-toggle]");
  if (!el) {
    return { present: false, note: "no [data-sound-toggle] in the document" };
  }
  const label = soundLabel(el);
  const pressedAttr = el.getAttribute("aria-pressed");
  const desc = accDescription(el);
  const hintId = (el.getAttribute("aria-describedby") || "").trim().split(/\s+/)[0];
  const hint = hintId ? document.getElementById(hintId) : null;
  const name = accName(el);

  const res = {
    present: true,
    sel: describe(el),
    tag: el.tagName.toLowerCase(),
    nativeButton: el.tagName === "BUTTON",
    type: el.getAttribute("type"),
    keyboardOperable: el.tagName === "BUTTON" && !isDisabled(el) && el.getAttribute("tabindex") === null,
    ariaPressed: pressedAttr,
    visibleLabel: label,
    accessibleName: name,
    nameIsTheLabel: name === label,
    describedBy: el.getAttribute("aria-describedby"),
    describedByResolves: !!desc && desc.missing.length === 0,
    descriptionText: desc ? desc.text : null,
    hintVisible: hint ? cssVisible(hint) : null,
    hintSel: hint ? describe(hint) : null,
    labelState: stateFromLabel(label),
    consistent: null,
    polarity: sound.polarity,
    repairs: sound.repairs.slice(),
  };

  /* --- the real question: how many state channels does this button have? -- */
  // A toggle button must use exactly ONE. `aria-pressed` is a state channel.
  // A label that also changes state ("sound on" <-> "sound off") is a second.
  // WAI-ARIA APG is explicit: either keep the name static and let aria-pressed
  // carry state, or drop aria-pressed and let the name carry state.
  res.stateChannels = pressedAttr === null ? ["accessible name"] : ["accessible name", "aria-pressed"];
  res.mixedSemantics = pressedAttr !== null;
  res.mixedSemanticsWhy =
    "aria-pressed is present AND the accessible name changes with state, so a screen reader " +
    'announces e.g. "' +
    label +
    ', toggle button, ' +
    (pressedAttr === "true" ? "pressed" : "not pressed") +
    '" — the name reads as a statement of state while aria-pressed states the opposite. ' +
    "WAI-ARIA APG: a toggle button uses one state channel, not two.";

  if (pressedAttr === null) {
    res.consistent = null;
    res.note = "no aria-pressed: the toggle relies on the changing label only";
  } else {
    const pressed = pressedAttr === "true";
    if (res.labelState === null) {
      res.consistent = null;
      res.note = "aria-pressed present but the visible label states no on/off value";
    } else if (sound.polarity === null) {
      res.consistent = pressed === res.labelState;
      res.note = res.consistent
        ? "label and aria-pressed agree (read polarity: label = state)"
        : 'CONTRADICTION: aria-pressed=' + pressedAttr + ' while the visible label says "' + label + '". A screen reader announces "sound on, toggle button, not pressed".';
    } else {
      const expected = sound.polarity === "state" ? res.labelState : !res.labelState;
      res.consistent = pressed === expected;
      res.note = res.consistent
        ? "consistent (" + sound.polarity + " polarity, " + sound.observations + " transitions observed)"
        : "inconsistent with the " + sound.polarity + " polarity this button has always used";
    }
  }
  sound.lastChecked = res;
  return res;
}

/* ========================================================================== *
 * 11. focus ring — resolved statically from the cascade
 * ========================================================================== */

/**
 * Does a real focus state produce a visible indicator?
 *
 * `:focus-visible` deliberately does NOT match a programmatic focus() unless the
 * browser's heuristic says the last interaction was a keyboard one, so calling
 * .focus() and reading the outline is unreliable — it produced false positives
 * for every control on the page. Instead we resolve the question statically:
 * walk the cascade for rules that match this element and set an outline or a
 * box-shadow on :focus / :focus-visible / :focus-within, then confirm the
 * resolved value is not `none`. Real keyboard verification of the ring is done
 * by the audit harness pressing Tab and reading computed style, which is the
 * authoritative check.
 */
function focusRingReport() {
  const missing = [];
  const seen = [];
  const rings = [];

  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    if (!rules) continue;
    const walk = (list) => {
      for (const r of list) {
        const kids = r.cssRules;
        if (kids && kids.length && r.style === undefined) {
          walk(kids);
          continue;
        }
        if (!r.style || !r.selectorText) continue;
        const sel = r.selectorText;
        if (!/:focus/.test(sel)) continue;
        const outline = (r.style.getPropertyValue("outline") || "").trim();
        const outlineStyle = (r.style.getPropertyValue("outline-style") || "").trim();
        const boxShadow = (r.style.getPropertyValue("box-shadow") || "").trim();
        if (/^none$/.test(outline) && /^none$/.test(outlineStyle) && (!boxShadow || boxShadow === "none")) {
          rings.push({ selector: sel, removesIndicator: true });
          continue;
        }
        rings.push({
          selector: sel,
          outline: outline || outlineStyle || null,
          boxShadow: boxShadow && boxShadow !== "none" ? boxShadow : null,
          removesIndicator: false,
        });
      }
    };
    walk(rules);
  }

  // Nothing anywhere in the cascade provides an indicator → global defect.
  const provides = rings.some((r) => !r.removesIndicator);
  if (!provides) missing.push({ sel: ":root", why: "no :focus / :focus-visible rule in any stylesheet sets an outline or box-shadow" });

  const removals = rings.filter((r) => r.removesIndicator);
  for (const r of removals) missing.push({ sel: r.selector, why: "rule removes the focus indicator" });

  return { missing, rings, provides };
}

/* ========================================================================== *
 * 12. ISSUES — the ranked, applyable list
 * ========================================================================== */

export function collectIssues() {
  issues.length = 0;
  stuckFocus.clear();

  /* --- motion / niceties ------------------------------------------------ */
  const meta = qs('meta[name="viewport"]');
  if (meta) {
    const c = (meta.getAttribute("content") || "").replace(/\s+/g, " ");
    if (/user-scalable\s*=\s*no|user-scalable\s*=\s*0|maximum-scale\s*=\s*1(?!\.)/i.test(c))
      issue("high", "viewport-zoom-lock", "viewport blocks pinch zoom: " + c, "index.html:5");
  }
  for (const el of qsa("[autofocus]"))
    issue("high", "autofocus", "autofocus steals focus on load", describe(el));
  for (const el of qsa("[tabindex]")) {
    const v = Number(el.getAttribute("tabindex"));
    if (v > 0)
      issue("high", "positive-tabindex", 'tabindex="' + v + '" reorders the page for keyboard users', describe(el));
    if (Number.isNaN(v))
      issue("medium", "bad-tabindex", 'tabindex="' + el.getAttribute("tabindex") + '" is not a number', describe(el));
  }
  const css = cssScan();
  for (const o of css.outlineNone)
    issue("high", "outline-none", "outline removed: " + o.selector, o.css);
  for (const m of css.motion) {
    issue(
      "medium",
      "css-motion",
      m.kind + " " + m.value + " on " + m.selector + (m.infinite ? "  (infinite)" : ""),
      m.seconds ? m.seconds + "s" : ""
    );
  }

  /* --- structure -------------------------------------------------------- */
  for (const p of headingsReport().problems)
    issue(p.code === "heading-skip" || p.code === "no-h1" || p.code === "multiple-h1" ? "high" : "medium", p.code, p.message, p.evidence);
  for (const p of landmarksReport().problems) issue("high", p.code, p.message, p.evidence);
  for (const p of dlReport().problems) issue("medium", p.code, p.message, p.evidence);

  /* --- focusables ------------------------------------------------------- */
  const tab = focusables();
  for (const f of tab) {
    if (!f.name)
      issue("high", "no-accessible-name", "focusable element has no accessible name", f.sel);
    // The headline defect this whole track exists to catch.
    if (f.hidden && f.tabbable && inA11yTree(f.el))
      issue(
        "high",
        "focusable-but-invisible",
        "Tab lands on this element but it is invisible: " + f.hiddenReason,
        f.sel + ' — announced as "' + f.name + '" with no visible focus indicator'
      );
    if (f.role !== "generic" && f.role && f.el.hasAttribute("role") && !f.name)
      issue("high", "role-without-name", 'role="' + f.role + '" with no accessible name', f.sel);
    const interactive = ["a", "button", "input", "select", "textarea"].includes(f.tag);
    if (interactive) {
      const r = f.el.getBoundingClientRect();
      const size = `${Math.round(r.width)}×${Math.round(r.height)}`;
      /* cssPainted, not cssVisible: geometry must be reported whether or not an
         entrance animation has fired yet. cssVisible treats an opacity:0 target
         as exempt, so an unrevealed control was silently skipped by the
         touch-target audit. */
      if (cssPainted(f.el) && (r.width < 44 || r.height < 44))
        issue(
          r.width < 24 || r.height < 24 ? "high" : "medium",
          "touch-target",
          `${f.name || f.sel} is ${size} CSS px`,
          f.sel
        );
      if (f.tag === "a" && !f.el.hasAttribute("href"))
        issue("high", "link-not-reachable", "<a> without href is not keyboard reachable", f.sel);
    }
  }
  for (const f of tab) {
    if (f.hidden) recordFocusStuck(f.el, f.hiddenReason);
  }

  /* --- roles without names --------------------------------------------- */
  const roleNoName = qsa("[role]")
    .filter((el) => !isHiddenForName(el) && el.getAttribute("role") !== "presentation")
    .filter((el) => !accName(el))
    .map(describe);

  /* --- sound toggle ----------------------------------------------------- */
  const snd = checkSoundToggle();
  if (snd.present) {
    if (snd.consistent === false)
      issue("high", "sound-toggle-state", snd.note, snd.sel + ' label="' + snd.visibleLabel + '" aria-pressed=' + snd.ariaPressed);
    if (!snd.describedByResolves)
      issue("high", "sound-toggle-describedby", "aria-describedby does not resolve to visible hint text: " + snd.describedBy);
    else if (!snd.hintVisible)
      issue("high", "sound-toggle-describedby", "aria-describedby resolves to " + snd.hintSel + " but that element is not visibly rendered");
    else if (!snd.descriptionText)
      issue("high", "sound-toggle-describedby", "aria-describedby target " + snd.hintSel + " has no text to describe the control with");
    if (snd.mixedSemantics)
      issue("high", "sound-toggle-mixed-semantics", snd.mixedSemanticsWhy, "index.html:61-73 (aria-pressed + .sound-toggle__label text swapped by js/audio.js paint())");
    if (snd.note && snd.note.startsWith("CONTRADICTION"))
      issue("high", "sound-toggle-contradiction", snd.note, "at rest, before any interaction");
  }

  /* --- contrast --------------------------------------------------------- */
  const cr = contrastReport();
  for (const f of cr.fails) {
    const ev = `${f.fg} on ${f.bg} = ${f.ratio}:1 (needs ${f.required}:1, ${f.size}px/${f.weight}${f.bgUnverified ? ", UNVERIFIED bg: " + f.bgUnverified : ""})`;
    issue(f.decorative ? "low" : "high", f.decorative ? "contrast-decorative" : "contrast-fail", `"${f.text}" — ${f.sel}`, ev);
  }
  for (const f of cr.fails) {
    if (!f.bgUnverified) continue;
    issue("low", "contrast-unverified", `"${f.text}" sits on a gradient/image — measure from pixels`, f.bgUnverified);
  }

  /* --- focus ring ------------------------------------------------------- */
  for (const r of focusRingReport().missing)
    issue("high", "no-focus-ring", "no visible focus indicator on focus", r.sel + " — " + r.why);

  /* --- reveal visibility ------------------------------------------------ */
  for (const el of qsa(REVEAL_SEL)) {
    const op = parseFloat(getComputedStyle(el).opacity);
    const rects = el.getClientRects().length;
    if (rects && op < 0.05 && !el.classList.contains("is-revealed"))
      issue("medium", "reveal-hidden-content", "un-revealed block still occupies layout at opacity " + op, describe(el));
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return issues.slice().sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/* ========================================================================== *
 * 13. the full report
 * ========================================================================== */

export function audit() {
  const tab = focusables();
  const cr = contrastReport();
  const hd = headingsReport();
  const lm = landmarksReport();
  const dlr = dlReport();
  const snd = checkSoundToggle();
  const list = collectIssues();

  // Per-focusable contrast: use the text the control actually renders.
  const controlContrast = tab
    .filter((f) => f.focusable && !f.hidden)
    .map((f) => {
      const node = [...f.el.childNodes].find((n) => n.nodeType === 3 && n.nodeValue.trim());
      const via = node
        ? measureTextNode(node)
        : (() => {
            const info = effectiveBackground(f.el);
            const cs = getComputedStyle(f.el);
            const fg = toRGBA(cs.color) || [0, 0, 0, 1];
            const big = largeText(parseFloat(cs.fontSize), cs.fontWeight);
            const c = contrast(over(fg, info.rgb), info.rgb);
            return { ratio: round2(c), required: big ? 3 : 4.5, pass: c >= (big ? 3 : 4.5), fg: hex(fg.slice(0, 3)), bg: info.hex, bgUnverified: info.unverified, size: cs.fontSize, weight: cs.fontWeight };
          })();
      return {
        sel: f.sel,
        name: f.name,
        role: f.role,
        tag: f.tag,
        tabindex: f.tabindex,
        focusable: f.focusable,
        tabbable: f.tabbable,
        hidden: f.hidden,
        contrast: via.ratio,
        required: via.required,
        pass: via.pass,
        fg: via.fg,
        bg: via.bg,
        bgUnverified: via.bgUnverified,
        fontSize: via.size,
        fontWeight: via.weight,
        description: accDescription(f.el),
      };
    });

  return {
    ok: list.filter((i) => i.severity === "high").length === 0,
    url: location.href,
    viewport: { w: innerWidth, h: innerHeight },
    reducedMotion: reduced(),
    dataMotion: document.documentElement.dataset.motion,
    counts: {
      focusables: tab.length,
      tabbable: tab.filter((f) => f.tabbable).length,
      textNodes: cr.total,
      headings: hd.headings.length,
      landmarks: lm.landmarks.length,
      contrastFails: cr.fails.length,
      issuesHigh: list.filter((i) => i.severity === "high").length,
    },
    tabOrder: tab.filter((f) => f.tabbable).map((f, i) => ({ stop: i + 1, sel: f.sel, name: f.name, role: f.role })),
    focusables: tab.map((f) => ({
      sel: f.sel,
      name: f.name,
      role: f.role,
      tag: f.tag,
      tabindex: f.tabindex,
      tabbable: f.tabbable,
      hidden: f.hidden,
      hiddenReason: f.hiddenReason,
    })),
    contrast: {
      controls: controlContrast,
      textFails: cr.fails,
      unverified: cr.all.filter((t) => t.bgUnverified),
    },
    headings: hd,
    landmarks: lm,
    dl: dlr,
    soundToggle: snd,
    rolesWithoutName: qsa("[role]")
      .filter((el) => !isHiddenForName(el) && el.getAttribute("role") !== "presentation" && !accName(el))
      .map(describe),
    css: cssScan(),
    motionRunning: runningMotion(),
    fixes: fixes.slice(),
    issues: list,
  };
}

/* ========================================================================== *
 * 14. console convenience
 * ========================================================================== */

/** Log the ranked defect list to the console. Returns the list. */
export function log() {
  const list = collectIssues();
  console.groupCollapsed(
    `%c a11y ${list.length ? "✗ " + list.length + " findings" : "✓ clean"} ` +
      `(${focusables().length} focusable, ${contrastReport().fails.length} contrast fails)`
  );
  console.table(list.map(({ severity, code, message, evidence }) => ({ severity, code, message, evidence })));
  if (fixes.length) console.log("runtime fixes applied:", fixes);
  console.groupEnd();
  return list;
}