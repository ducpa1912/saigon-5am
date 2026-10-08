/**
 * audio.js — "Saigon, 5am", synthesised.
 *
 * Three layers, all generated live with the Web Audio API. No audio files, no
 * CDN, no encoded samples: the only things shipped in this file are numbers and
 * algorithms.
 *
 *   1. RAIN      — looping pink-noise buffer through a wide band chain, breathing
 *                  under slow LFOs, plus Poisson-scheduled droplet transients
 *                  (tiny resonant noise bursts) with irregular clustering.
 *   2. CITY HUM  — very low low-passed noise + three low oscillators a few cents
 *                  apart, plus a *rare*, very soft swell of a vehicle passing and,
 *                  far rarer still, a two-note horn far off. No sirens, no honks.
 *   3. PAD       — Am9 (A E A B C) from detuned sine/triangle oscillators through
 *                  a slow-LFO low-pass, into a procedurally-built convolution
 *                  reverb (impulse response synthesised from decaying noise).
 *
 * Everything lands on: master gain → slow "distance" low-pass → limiter → out.
 *
 * HARD RULES honoured here
 * - Starts muted. Nothing at all is constructed until the user taps the toggle;
 *   the AudioContext is created *inside* the click handler, then resumed.
 * - No persistence. Every visit starts silent.
 * - Suspends when the tab hides; full teardown on pagehide (bfcache safe).
 * - No DOM access and no layout reads inside an audio callback or a scheduler tick.
 * - Reduced motion does not mute sound (that is a separate preference), but the
 *   `lite` flag thins the droplet rate and shortens the reverb tail.
 */

/* ------------------------------------------------------------------ tuning -- */

/**
 * Steady-state master level. Chosen by measuring the rendered bed: at 0.15 the
 * offline mix measures RMS ≈ -31.5 dBFS / peak ≈ -17.4 dBFS, which sits under
 * reading and leaves ~11 dB of headroom before the limiter. Do not raise this
 * without re-running `node .cache/audio-check.mjs`.
 */
const MASTER_TARGET = 0.15;
const FADE_IN = 2.0; // seconds, master
const FADE_OUT = 0.6; // seconds, master
const DIST_OPEN = 3.4; // seconds, distance-filter sweep

/**
 * Steady-state layer trims, mixed pre-master. Tuned by measurement: the bed is
 * rendered offline (see renderOffline) and each layer's RMS/peak read back, so
 * these numbers are repeatable rather than taste.
 */
const MIX = {
  rain: 0.62,
  // The hum is the *distant* bed: ~8 dB under the rain, so it is felt more than
  // noticed. Measured, not guessed.
  hum: 0.2,
  padDry: 0.4,
  padWet: 0.62,
  drips: 0.9,
  events: 1,
};

const NOISE_SECONDS = 12; // long loop → the crossfade seam is rare
const NOISE_XFADE = 4096;
const IR_SECONDS = 2.4;
const TICK_MS = 250; // scheduler interval
const LOOKAHEAD = 1.0; // seconds of drip events queued ahead of the clock

/* ------------------------------------------------------------------ helpers -- */

/** Deterministic PRNG so offline renders are reproducible and diffable. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Loop-safe pink noise. A 7-pole Voss-McCartney-ish network (much warmer than
 * white, which matters a lot for a rain bed) plus an overlap-add crossfade across
 * the loop seam so there is no tick every NOISE_SECONDS.
 */
function makePinkNoise(ctx, seconds, rng) {
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(sr * seconds));
  const xf = Math.min(NOISE_XFADE, Math.floor(len / 4));
  const gen = ctx.createBuffer(2, len + xf, sr);

  for (let ch = 0; ch < 2; ch++) {
    const d = gen.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = rng() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      b6 = w * 0.115926;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.045;
    }
  }

  const buf = ctx.createBuffer(2, len, sr);
  let peak = 0;
  for (let ch = 0; ch < 2; ch++) {
    const src = gen.getChannelData(ch);
    const out = buf.getChannelData(ch);
    out.set(src.subarray(0, len));
    // The head fades in while the material from past the loop point fades out,
    // so out[len-1] → out[0] is continuous.
    for (let i = 0; i < xf; i++) {
      const t = i / xf;
      out[i] = src[i] * t + src[len + i] * (1 - t);
    }
    for (let i = 0; i < len; i++) {
      const a = out[i] < 0 ? -out[i] : out[i];
      if (a > peak) peak = a;
    }
  }
  // Normalise so downstream trim values mean something predictable.
  const k = peak > 0 ? 0.5 / peak : 1;
  for (let ch = 0; ch < 2; ch++) {
    const out = buf.getChannelData(ch);
    for (let i = 0; i < out.length; i++) out[i] *= k;
  }
  return buf;
}

/** Short one-shot noise for droplets and vehicle swells. */
function makeNoiseBurst(ctx, seconds, rng) {
  const len = Math.max(64, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let lp = 0;
  let peak = 0;
  for (let i = 0; i < len; i++) {
    lp += (rng() * 2 - 1 - lp) * 0.55; // tame the very top end
    d[i] = lp;
    const a = lp < 0 ? -lp : lp;
    if (a > peak) peak = a;
  }
  const k = peak > 0 ? 0.6 / peak : 1;
  for (let i = 0; i < len; i++) d[i] *= k;
  return buf;
}

/**
 * Procedural impulse response: short pre-delay, brief density build-up, then
 * exponentially decaying noise, one-pole low-passed so the tail is dark (a warm
 * room, not a cathedral) with decorrelated L/R. NO IR FILE IS INVOLVED.
 */
function makeImpulse(ctx, seconds, rng) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  const preDelay = Math.floor(sr * 0.012);
  const build = Math.floor(sr * 0.03);
  const decay = 5.2 / seconds; // ≈ -45 dB by the end of the tail

  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = preDelay; i < len; i++) {
      const t = (i - preDelay) / sr;
      const env = Math.min(1, (i - preDelay) / build) * Math.exp(-t * decay);
      lp += (rng() * 2 - 1 - lp) * 0.32;
      d[i] = lp * env;
    }
  }
  return buf;
}

/**
 * Raised-cosine fade curve, 0 → `target`. Starts slow, lands gently, and never
 * touches 0 (which is illegal in an exponential context).
 * NOTE: setValueCurveAtTime writes *absolute* param values, so this is scaled by
 * the target rather than being handed to the param raw.
 */
function fadeCurve(points, target) {
  const c = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    c[i] = target * Math.sin((i / (points - 1)) * (Math.PI / 2));
  }
  return c;
}

/** Freeze a param at its *current* automated value (toggling mid-fade). */
function holdAt(param, t) {
  if (typeof param.cancelAndHoldAtTime === "function") {
    try {
      param.cancelAndHoldAtTime(t);
      return;
    } catch { /* fall through */ }
  }
  const v = param.value;
  param.cancelScheduledValues(t);
  param.setValueAtTime(v, t);
}

/* --------------------------------------------------------------- the graph -- */

/**
 * Builds the complete bed on any BaseAudioContext (real or offline).
 * `instant` skips the fades so an offline render measures the steady state.
 */
function buildBed(ctx, opts = {}) {
  const { instant = false, lite = false } = opts;
  const rng = mulberry32(0x5a1a91);

  const noise = makePinkNoise(ctx, NOISE_SECONDS, rng);
  const burst = makeNoiseBurst(ctx, 0.3, rng);
  const ir = makeImpulse(ctx, lite ? IR_SECONDS * 0.6 : IR_SECONDS, rng);

  /** Everything that must be stopped on teardown. */
  const live = [];
  const keep = (o) => { live.push(o); return o; };

  /* ---- master chain ----------------------------------------------------- */
  const master = ctx.createGain();
  master.gain.value = instant ? MASTER_TARGET : 0;

  // Slow "distance" filter: shut hard when off, opening as the sound fades in,
  // so the bed arrives from far away instead of snapping in.
  const distance = ctx.createBiquadFilter();
  distance.type = "lowpass";
  distance.Q.value = 0.6;
  distance.frequency.value = instant ? 5400 : 300;

  // Gentle brickwall: the bed must never clip, whatever a droplet cluster does.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -12;
  limiter.knee.value = 8;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.006;
  limiter.release.value = 0.28;

  /* A second gain between master and the distance filter, so the fade-IN value
     curve and the fade-OUT ramp never share one AudioParam.
     Measured on the live page: `cancelAndHoldAtTime()` on a param whose last
     event was `setValueCurveAtTime()` does not hold in Chromium — the live
     fade-out collapsed 32.4 dB in 16 ms, and an offline replay of the identical
     call sequence showed the new ramp starting at the old curve's END value
     (~0.0036) rather than at the current level (0.15). Two gates, one param
     each, no cross-contamination. */
  const gate = keep(ctx.createGain());
  gate.gain.value = 1;

  master.connect(gate).connect(distance).connect(limiter).connect(ctx.destination);

  /* ---- slow LFO factory -------------------------------------------------- */
  function lfo(hz, depth, param) {
    const o = keep(ctx.createOscillator());
    o.type = "sine";
    o.frequency.value = hz;
    const g = keep(ctx.createGain());
    g.gain.value = depth;
    o.connect(g).connect(param);
    o.start(0);
  }

  /* ---- 1. RAIN ---------------------------------------------------------- */
  const rainBus = keep(ctx.createGain());
  rainBus.gain.value = instant ? 1 : 0.0001;
  const rainTrim = keep(ctx.createGain());
  rainTrim.gain.value = MIX.rain;
  rainBus.connect(rainTrim).connect(master);

  // Two decorrelated halves of the same buffer, panned hard left and right —
  // that is what makes rain feel like it is *outside a window* rather than a
  // mono hiss inside your head.
  [[-0.78, 1.0, 1500], [0.78, 0.88, 2400]].forEach(([pan, gain, centre]) => {
    const src = keep(ctx.createBufferSource());
    src.buffer = noise;
    src.loop = true;
    src.playbackRate.value = 1 + (rng() - 0.5) * 0.03;

    const hp = keep(ctx.createBiquadFilter());
    hp.type = "highpass";
    hp.frequency.value = 330;
    hp.Q.value = 0.7;

    const bp = keep(ctx.createBiquadFilter());
    bp.type = "peaking";
    bp.frequency.value = centre;
    bp.Q.value = 0.8;
    bp.gain.value = 4;

    const shelf = keep(ctx.createBiquadFilter());
    shelf.type = "lowpass";
    shelf.frequency.value = 6800;
    shelf.Q.value = 0.5;

    const g = keep(ctx.createGain());
    g.gain.value = gain;

    const p = keep(ctx.createStereoPanner());
    p.pan.value = pan;

    src.connect(hp).connect(bp).connect(shelf).connect(g).connect(p).connect(rainBus);
    src.start(0);

    lfo(0.041, centre * 0.34, bp.frequency); // the glass brightens and dulls
    lfo(0.017, 0.26, g.gain); // and the whole thing breathes
  });

  // A duller, lower layer: rain on the sill and the leaves, not the glass.
  {
    const src = keep(ctx.createBufferSource());
    src.buffer = noise;
    src.loop = true;
    src.playbackRate.value = 0.87;
    const hp = keep(ctx.createBiquadFilter());
    hp.type = "highpass";
    hp.frequency.value = 110;
    const lp = keep(ctx.createBiquadFilter());
    lp.type = "lowpass";
    lp.frequency.value = 480;
    lp.Q.value = 0.4;
    const g = keep(ctx.createGain());
    g.gain.value = 0.5;
    src.connect(hp).connect(lp).connect(g).connect(rainBus);
    src.start(0);
    lfo(0.023, 120, lp.frequency);
  }

  /* ---- 2. CITY HUM ------------------------------------------------------ */
  const humBus = keep(ctx.createGain());
  humBus.gain.value = instant ? 1 : 0.0001;
  const humTrim = keep(ctx.createGain());
  humTrim.gain.value = MIX.hum;
  humBus.connect(humTrim).connect(master); // centred, no pan

  // Rare city events get their own bus so they can be balanced against the
  // *whole* mix rather than inheriting the hum's (deliberately tiny) trim.
  // Always at unity: events are only ever scheduled while the bed is running.
  const eventBus = keep(ctx.createGain());
  eventBus.gain.value = 1;
  const eventTrim = keep(ctx.createGain());
  eventTrim.gain.value = MIX.events;
  eventBus.connect(eventTrim).connect(master);

  // Very low, very soft filtered noise: the mass of a sleeping city.
  {
    const src = keep(ctx.createBufferSource());
    src.buffer = noise;
    src.loop = true;
    src.playbackRate.value = 0.71;
    const lp = keep(ctx.createBiquadFilter());
    lp.type = "lowpass";
    lp.frequency.value = 150;
    lp.Q.value = 0.5;
    const g = keep(ctx.createGain());
    g.gain.value = 0.85;
    src.connect(lp).connect(g).connect(humBus);
    src.start(0);
    lfo(0.031, 34, lp.frequency);
  }

  // Low oscillators a few cents apart → a slow beat, so it never sits static.
  // Kept far under the noise layer: this is the *mass* of a sleeping city, and
  // 54 Hz is felt rather than heard (and is inaudible on a phone speaker anyway).
  // 54.5 and 58.2 rather than 54.5 and 55.1: the pair was 0.6 Hz apart, which is
  // a 1.67s amplitude cycle in the loudest part of the spectrum — it reads as a
  // slow pulse rather than as city, and on a phone speaker it is the only thing
  // in that band that survives. 3.7 Hz apart gives a 0.27 Hz beat, below the
  // threshold of "rhythmic".
  [[54.5, "sine", 0.09], [58.2, "sine", 0.06], [82.4, "triangle", 0.045]].forEach(
    ([hz, type, gain]) => {
      const o = keep(ctx.createOscillator());
      o.type = type;
      o.frequency.value = hz;
      const g = keep(ctx.createGain());
      g.gain.value = gain;
      o.connect(g).connect(humBus);
      o.start(0);
      lfo(0.019, gain * 0.32, g.gain);
    }
  );

  /* ---- 3. PAD ----------------------------------------------------------- */
  const padBus = keep(ctx.createGain());
  padBus.gain.value = instant ? 1 : 0.0001;
  padBus.connect(master);

  const dry = keep(ctx.createGain());
  dry.gain.value = MIX.padDry;
  dry.connect(padBus);

  const convolver = keep(ctx.createConvolver());
  convolver.normalize = true;
  convolver.buffer = ir;
  const wet = keep(ctx.createGain());
  wet.gain.value = MIX.padWet;
  convolver.connect(wet).connect(padBus);

  const padTone = keep(ctx.createBiquadFilter());
  padTone.type = "lowpass";
  padTone.frequency.value = 760;
  padTone.Q.value = 0.9;
  const padLevel = keep(ctx.createGain());
  padLevel.gain.value = 0.34;
  padTone.connect(padLevel);
  padLevel.connect(dry);
  padLevel.connect(convolver);

  // Am9 — warm, and the 9th (B) never quite resolves.
  const voices = [
    [110.0, "triangle", -0.55, 0.5],
    [164.81, "triangle", 0.3, 0.34],
    [220.0, "sine", -0.2, 0.42],
    [246.94, "sine", 0.62, 0.2], // the B — the colour of 5am
    [261.63, "triangle", -0.68, 0.3], // the minor 3rd, kept soft
  ];
  voices.forEach(([hz, type, pan, gain]) => {
    const p = keep(ctx.createStereoPanner());
    p.pan.value = pan;
    p.connect(padTone);
    // Two slightly detuned oscillators per note: chorus, not "a synth".
    [-6, 6].forEach((cents) => {
      const o = keep(ctx.createOscillator());
      o.type = type;
      o.frequency.value = hz;
      o.detune.value = cents;
      const g = keep(ctx.createGain());
      g.gain.value = gain * (cents < 0 ? 0.6 : 0.4);
      o.connect(g).connect(p);
      o.start(0);
    });
  });

  lfo(0.026, 260, padTone.frequency); // slow filter drift
  lfo(0.014, 0.17, padLevel.gain); // and a very slow swell

  /* ---- droplets --------------------------------------------------------- */
  const dripBus = keep(ctx.createGain());
  dripBus.gain.value = instant ? 1 : 0.0001;
  const dripTrim = keep(ctx.createGain());
  dripTrim.gain.value = MIX.drips;
  dripBus.connect(dripTrim).connect(master);

  /**
   * One droplet: a 1.5 ms attack of noise through a resonant band-pass with a
   * fast exponential tail. Three transient nodes, retired the moment it ends.
   *
   * The band-pass is deliberately wide (Q 1.6–4): a high-Q filter throws away
   * almost all of a broadband transient, and you get an inaudible tick instead
   * of a drop. The character comes from the centre frequency, not from Q.
   */
  function drip(when, r = rng()) {
    const src = ctx.createBufferSource();
    src.buffer = burst;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    // Most hits are glassy and high; a few are fat drops off the sill.
    const fat = r < 0.16;
    bp.frequency.value = fat ? 420 + r * 520 : 1150 + r * r * 3400;
    bp.Q.value = fat ? 2.2 + r * 1.8 : 1.6 + r * 2.4;
    const g = ctx.createGain();
    const amp = (fat ? 1.15 : 0.7) * (0.45 + r * 0.55);
    const decay = fat ? 0.09 + r * 0.1 : 0.028 + r * 0.055;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(amp, when + 0.0015);
    g.gain.exponentialRampToValueAtTime(0.0001, when + decay);
    const p = ctx.createStereoPanner();
    p.pan.value = (r - 0.5) * 1.5;
    src.connect(bp).connect(g).connect(p).connect(dripBus);
    src.start(when, r * 0.2, decay + 0.03);
    src.stop(when + decay + 0.05);
    /* Release the chain when it has finished rather than leaving it to GC
       timing. Measured: ~27 node allocations/second for the life of the bed
       (6.9 gains, 6.7 biquads, 13.6 panners per second). The JS heap is flat,
       so this is hygiene and not a leak fix — but createStereoPanner allocates
       an internal merger graph each call, and on the `lite` path this is
       already the device we assumed would be slow. */
    src.onended = () => {
      try {
        src.disconnect();
        bp.disconnect();
        g.disconnect();
        p.disconnect();
      } catch {
        /* already torn down */
      }
    };
  }

  /**
   * Schedules droplets from `cursor` up to `horizon`, returning the new cursor.
   * Poisson inter-arrivals with occasional short clustering ("patter" runs when
   * a gust hits the window). Shared by the live scheduler and the offline
   * renderer so both hear the same distribution.
   *
   * The candidate timestamp is discarded rather than committed when it overshoots
   * `horizon`. Exponential gaps are unbounded, so committing an overshoot would
   * leave the cursor permanently ahead of the look-ahead window and every later
   * tick would break immediately — the rain would silently stop a few seconds in.
   * Resampling instead keeps the distribution exact and the cursor bounded.
   */
  function dripsBetween(cursor, horizon, gust) {
    const rate = (lite ? 1.1 : 1.6) * (1 + gust * 1.7);
    let t = cursor;
    let guard = 0;
    while (guard++ < 512) {
      const candidate = t + -Math.log(1 - rng()) / rate;
      if (candidate >= horizon) break; // discard: resample next tick
      t = candidate;
      drip(t);
      if (rng() < 0.18) {
        // A short run of quick hits: the window pattering in a gust.
        let step = 0.04 + rng() * 0.05;
        const cluster = 2 + Math.floor(rng() * 5);
        for (let i = 0; i < cluster; i++) {
          step += 0.035 + rng() * 0.06;
          if (t + step >= horizon) break;
          t += step;
          drip(t);
        }
      }
    }
    return t;
  }

  /* ---- rare city events -------------------------------------------------- */
  /**
   * A vehicle passing in the street below, heard through rain and a shut window:
   * filtered noise that swells, drifts across the stereo field and fades. No
   * pitch, so it can never read as a siren or a horn loop. Very rare (~every
   * 35–90 s) and soft enough to sit under the bed.
   */
  function vehiclePass(when, r = rng()) {
    const dur = 5 + r * 4;
    const src = ctx.createBufferSource();
    src.buffer = burst;
    src.loop = true; // a passing vehicle is longer than our burst buffer
    src.playbackRate.value = 0.5 + r * 0.25;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 90; // no subsonic rumble
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 460 + r * 420; // muffle increases as it moves away
    lp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.34 + r * 0.28, when + dur * 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    const p = ctx.createStereoPanner();
    p.pan.setValueAtTime(-0.8 - r * 0.1, when);
    p.pan.linearRampToValueAtTime(0.8 + r * 0.1, when + dur);
    src.connect(hp).connect(lp).connect(g).connect(p).connect(eventBus);
    src.start(when, 0);
    src.stop(when + dur + 0.15);
  }

  /**
   * A very soft, very distant two-note horn, A or Bb, low-passed to ~1 kHz so it
   * arrives as a colour rather than a pitch. Rare on purpose: roughly one in
   * five vehicles, which works out to once every few minutes.
   */
  function horn(when, r = rng()) {
    const dur = 2.6 + r * 1.4;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1000;
    lp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.13 + r * 0.09, when + dur * 0.45);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    const p = ctx.createStereoPanner();
    p.pan.value = (r - 0.5) * 1.1;
    lp.connect(g).connect(p).connect(eventBus);
    const f = 233.08 * (r < 0.5 ? 1 : 1.12246); // A or Bb, heard through rain
    [f, f * 1.5].forEach((hz) => {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = hz;
      o.detune.value = (rng() - 0.5) * 14;
      const og = ctx.createGain();
      og.gain.value = 0.5;
      o.connect(og).connect(lp);
      o.start(when);
      o.stop(when + dur + 0.2);
    });
  }

  /* ---- entrances / exits -------------------------------------------------- */
  function fadeIn(now) {
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(0, now);
    master.gain.setValueCurveAtTime(fadeCurve(96, MASTER_TARGET), now, FADE_IN);

    /* Re-open the exit gate. A plain set, never a curve, so the next fadeOut is
       always starting from a clean, held 1. */
    gate.gain.cancelScheduledValues(now);
    gate.gain.setValueAtTime(1, now);

    distance.frequency.cancelScheduledValues(now);
    distance.frequency.setValueAtTime(300, now);
    distance.frequency.exponentialRampToValueAtTime(5400, now + DIST_OPEN);

    // Staggered entrances: rain first, the pad takes its time to arrive.
    // The pad is the only tonal content — the thing that makes this a place
    // rather than a hiss — so it used to reach full at 6.8s, which reads as a
    // broken toggle rather than as atmosphere. Capped at 4s.
    [
      [rainBus.gain, 0, 1.6],
      [humBus.gain, 0.35, 2.6],
      [padBus.gain, 0.7, 4.0],
      [dripBus.gain, 0.2, 2.0],
    ].forEach(([param, delay, dur]) => {
      param.cancelScheduledValues(now);
      param.setValueAtTime(0.0001, now + delay);
      param.exponentialRampToValueAtTime(1, now + delay + dur);
    });
  }

  function fadeOut(now) {
    const t = now + FADE_OUT;
    /* Fade the GATE, not master. Raised cosine 1 -> 0 on a param that has only
       ever seen plain setValueAtTime calls, so there is nothing for
       cancelAndHoldAtTime to mis-hold. */
    const curve = new Float32Array(96);
    for (let i = 0; i < curve.length; i++) {
      curve[i] = Math.cos((i / (curve.length - 1)) * (Math.PI / 2));
    }
    gate.gain.cancelScheduledValues(now);
    gate.gain.setValueAtTime(gate.gain.value, now);
    gate.gain.setValueCurveAtTime(curve, now, FADE_OUT);
    gate.gain.setValueAtTime(0, t + 0.02);

    holdAt(distance.frequency, now);
    distance.frequency.exponentialRampToValueAtTime(300, t);
    return FADE_OUT * 1000 + 80;
  }

  function stop() {
    live.forEach((o) => {
      try {
        o.stop?.();
      } catch { /* already stopped */ }
    });
  }

  return {
    master, distance, limiter, rainBus, humBus, padBus, dripBus, eventBus,
    fadeIn, fadeOut, dripsBetween, vehiclePass, horn, stop,
  };
}

/* ------------------------------------------------------------------- state -- */

const button = () => document.getElementById("sound-toggle");

let ctx = null;
let bed = null;
let on = false;
let supported = true;
let contextsCreated = 0;
let timer = 0;
let suspendTimer = 0;
let nextDrip = 0;
let nextEvent = 0;
let rng = mulberry32(1);
let hooked = false;

/* -------------------------------------------------------------- the toggle -- */

/** The visible label is the ONLY state channel.
 *
 *  A toggle button must not carry state twice. This used to set aria-pressed
 *  *and* rewrite the label to its opposite, so a screen reader announced
 *  "sound on, toggle button, not pressed" — the name describing one state while
 *  aria-pressed asserted the other. WAI-ARIA APG allows either channel, never
 *  both.
 *
 *  The brief's copy is fixed, so the label carries state and aria-pressed is
 *  gone: at rest it reads exactly "sound on", and pressing announces
 *  "sound off". `data-on` is presentational only (CSS), never announced. */
function paint() {
  const el = button();
  if (!el) return;
  if (on) el.setAttribute("data-on", "true");
  else el.removeAttribute("data-on");
  const label = el.querySelector(".sound-toggle__label");
  if (label) label.textContent = on ? "sound off" : "sound on";
}

/** Temporary failure: turn the bed off but allow a retry. */
function fail() {
  on = false;
  paint();
}

/** Permanent failure: audio is impossible here, so stop offering it. */
function disable() {
  supported = false;
  on = false;
  paint();
}

function teardown() {
  if (timer) { clearInterval(timer); timer = 0; }
  if (suspendTimer) { clearTimeout(suspendTimer); suspendTimer = 0; }
  if (bed) { bed.stop(); bed = null; }
  if (ctx) {
    const dying = ctx;
    ctx = null;
    dying.close?.().catch(() => {});
  }
  on = false;
  paint();
}

/* --------------------------------------------------------------- scheduler -- */

/**
 * Look-ahead scheduler: one interval, droplet times computed a second ahead of
 * the audio clock. The audio clock is the only clock touched in here — no DOM,
 * no layout, no allocation of anything that outlives a tick.
 */
function schedule() {
  if (!ctx || !bed || ctx.state !== "running") return;
  const now = ctx.currentTime;
  const horizon = now + LOOKAHEAD;
  if (nextDrip < now) nextDrip = now + 0.05;

  // A slow synthetic gust, so the window is never hit by identical rain.
  const gust = 0.5 + 0.5 * Math.sin(now * 0.23) * Math.sin(now * 0.071);
  nextDrip = bed.dripsBetween(nextDrip, horizon, gust);

  if (nextEvent < now) nextEvent = now + 22 + rng() * 40;
  if (nextEvent < horizon) {
    bed.vehiclePass(nextEvent);
    // roughly one passing vehicle in five has a far-off horn under it
    if (rng() < 0.2) bed.horn(nextEvent + 1.2 + rng() * 1.5);
    nextEvent += 34 + rng() * 55;
  }
}

/* ----------------------------------------------------------------- toggle -- */

async function soundOn() {
  try {
    await ctx.resume();
    if (ctx.state !== "running") return fail();
  } catch {
    return fail();
  }
  on = true;
  paint();
  bed.fadeIn(ctx.currentTime + 0.02);
  nextDrip = 0;
  nextEvent = 0;
  if (!timer) timer = setInterval(schedule, TICK_MS);
}

function soundOff() {
  on = false;
  paint();
  const wait = bed.fadeOut(ctx.currentTime + 0.02);
  if (timer) { clearInterval(timer); timer = 0; }
  if (suspendTimer) clearTimeout(suspendTimer);
  // suspend(), not close(): waking back is instant and keeps the graph.
  suspendTimer = setTimeout(() => {
    suspendTimer = 0;
    ctx?.suspend().catch(() => {});
  }, wait);
}

async function toggle() {
  const el = button();
  if (!el || !supported) return;
  el.setAttribute("aria-busy", "true");

  try {
    if (!ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return disable();
      // Created inside the handler, always. Never at import time.
      ctx = new Ctor({ latencyHint: "playback" });
      contextsCreated++;
      bed = buildBed(ctx, { lite: document.documentElement.dataset.perf === "lite" });
      rng = mulberry32(((Date.now() & 0xffff) + 1) >>> 0);
      // Some builds hand back a suspended context until the first resume().
      if (ctx.state === "suspended") await ctx.resume();
      await soundOn();
    } else if (on) {
      soundOff();
    } else {
      await soundOn();
    }
  } catch (err) {
    console.warn("[audio] unavailable:", err?.message || err);
    fail();
  } finally {
    el.removeAttribute("aria-busy");
  }
}

/* ------------------------------------------------------------------- hooks -- */

function hook() {
  if (hooked) return;
  const el = button();
  if (!el) return;
  hooked = true;
  el.addEventListener("click", toggle);

  document.addEventListener("visibilitychange", () => {
    if (!ctx) return;
    if (document.hidden) {
      ctx.suspend().catch(() => {});
    } else if (on) {
      ctx.resume()
        .then(() => { if (bed && on) bed.fadeIn(ctx.currentTime + 0.05); })
        .catch(() => fail());
    }
  });

  // Back/forward cache: a context must never outlive the page that made it.
  // The listeners live on window/document, which survive a bfcache freeze, so
  // they are never re-added — pageshow only has to restore the visual state.
  addEventListener("pagehide", teardown);
  addEventListener("pageshow", () => {
    if (on || ctx) { on = false; paint(); }
  });
}

/* -------------------------------------------------------------------- api -- */

export function init() {
  paint(); // label and aria agree before the first possible tap
  hook();
}

/**
 * Offline verification hook: renders the *same* graph into an OfflineAudioContext
 * at its steady-state level and reports what the bed actually measures. Nothing
 * on the live path calls it; it exists so the graph can be proven in headless
 * Chromium, which produces no audible output.
 */
export async function renderOffline(seconds = 8, opts = {}) {
  const { events = true, target = MASTER_TARGET, withBuffer = false } = opts;
  const sr = 48000;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const octx = new OAC(2, Math.floor(sr * seconds), sr);
  const offline = buildBed(octx, { instant: true });
  offline.master.gain.value = target;
  offline.dripsBetween(0.05, seconds, 0.6);
  if (events) {
    offline.vehiclePass(1.5);
    offline.horn(4.2);
  }
  const rendered = await octx.startRendering();

  const winLen = Math.floor(sr * 0.25);
  let sum = 0;
  let peak = 0;
  let n = 0;
  const frames = [];
  for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
    const d = rendered.getChannelData(ch);
    let wsum = 0;
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      sum += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      wsum += v * v;
      if (i % winLen === winLen - 1) {
        if (ch === 0) frames.push(Math.sqrt(wsum / winLen));
        wsum = 0;
      }
      n++;
    }
  }
  const rms = Math.sqrt(sum / n);
  const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
  const sorted = [...frames].sort((a, b) => a - b);
  return {
    seconds,
    sampleRate: sr,
    target,
    rms: +rms.toFixed(5),
    peak: +peak.toFixed(5),
    rmsDb: +db(rms).toFixed(2),
    peakDb: +db(peak).toFixed(2),
    crestDb: +(db(peak) - db(rms)).toFixed(2),
    quietest250msDb: +db(sorted[0]).toFixed(2),
    loudest250msDb: +db(sorted[sorted.length - 1]).toFixed(2),
    clipped: peak >= 0.999,
    // Raw samples, for writing a WAV so a human can actually listen to the mix.
    buffer: withBuffer ? rendered : undefined,
  };
}

/** Read-only diagnostics surface, same spirit as window.__diag. */
Object.defineProperty(window, "__sound", {
  configurable: true,
  get() {
    return {
      get on() { return on; },
      get supported() { return supported; },
      get contextState() { return ctx ? ctx.state : "none"; },
      get contextsCreated() { return contextsCreated; },
      get masterGain() { return bed ? bed.master.gain.value : 0; },
      get masterTarget() { return MASTER_TARGET; },
      get sampleRate() { return ctx ? ctx.sampleRate : 0; },
      get scheduler() { return timer ? "running" : "stopped"; },
    };
  },
});
