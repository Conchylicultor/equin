// The SFX synth: every SfxCue synthesized with Web Audio in an
// OfflineAudioContext (48 kHz stereo) and returned as a base64 16-bit PCM WAV
// for the mixer to lay under the music. Runs in the film page (bundled with
// the renderer, exposed as `__film.renderSfx`).
//
// Same cues ⇒ byte-identical WAV: all randomness comes from a seeded PRNG
// (keyed by the cue's own fields), dither included, and every fan-in in the
// graph is a binary sum (see DETERMINISM below).
//
// Level contract: at gain 1 each synthesized cue peaks near -12 dBFS (tick / key a
// little lower, shimmer lower still, impact a little hotter) and a click — a
// real recording, not a synth — peaks at CLICK_PEAK_DBFS (cues.ts). The SFX
// bus is NOT normalized (nor is it by the mixer: audio.ts normalizes the music
// bed alone), and a compressor (makeup gain cancelled) + soft limiter on the
// master only touch overlaps that pile up past -10 dBFS.

import { CLICK_PEAK_DBFS, type SfxCue } from "../cues";

/** Where the film page serves the recorded samples (serve.ts). */
export const SAMPLE_PREFIX = "/__film/samples/";

async function loadSample(
  ctx: BaseAudioContext,
  url: string,
): Promise<AudioBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`renderSfx: sample ${url} HTTP ${res.status}`);
  return ctx.decodeAudioData(await res.arrayBuffer());
}

/** A buffer's sample peak (linear); throws on a silent one. */
function peakOf(buf: AudioBuffer): number {
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++)
    for (const x of buf.getChannelData(c)) peak = Math.max(peak, Math.abs(x));
  if (!(peak > 0)) throw new Error("renderSfx: a silent sample");
  return peak;
}

/** Render `cues` into a `duration`-long 48 kHz stereo WAV (16-bit PCM, TPDF-dithered), as base64. */
export async function renderSfx(
  cues: readonly SfxCue[],
  duration: number,
): Promise<string> {
  if (!(duration > 0))
    throw new Error(`renderSfx: bad duration ${String(duration)}`);

  const SR = 48000;
  const length = Math.ceil(duration * SR);

  // ---------------------------------------------------------------- PRNG ----
  /** mulberry32: a 32-bit seeded PRNG in [0, 1). */
  const prng = (seed: number): (() => number) => {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  /** A seed from numbers (FNV-1a over their millisecond-rounded values). */
  const seedOf = (...xs: number[]): number => {
    let h = 0x811c9dc5;
    for (const x of xs) {
      const v = Math.round(x * 1000) | 0;
      for (let b = 0; b < 4; b++) {
        h ^= (v >>> (b * 8)) & 0xff;
        h = Math.imul(h, 0x01000193);
      }
    }
    return h >>> 0;
  };
  const dbToGain = (db: number): number => Math.pow(10, db / 20);

  // ----------------------------------------------------- shared buffers ----
  const fillNoise = (buf: AudioBuffer, seed: number): AudioBuffer => {
    const rnd = prng(seed);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1;
    }
    return buf;
  };

  /**
   * A stereo reverb impulse response: decorrelated noise under an exponential
   * decay reaching -60 dB at `t60`, darkened over time by a one-pole lowpass
   * sweeping `brightHz` → `darkHz`, with a short fade-in after `predelay`.
   * Each channel carries unit energy, so a send level reads as wet/dry energy.
   */
  const impulse = (
    ctx: BaseAudioContext,
    seconds: number,
    t60: number,
    predelay: number,
    brightHz: number,
    darkHz: number,
    seed: number,
  ): AudioBuffer => {
    const n = Math.ceil(seconds * SR);
    const buf = ctx.createBuffer(2, n, SR);
    const rnd = prng(seed);
    const pre = Math.floor(predelay * SR);
    const fade = Math.floor(0.008 * SR);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      let energy = 0;
      for (let i = pre; i < n; i++) {
        const t = (i - pre) / SR;
        const x = t / seconds;
        const fc = brightHz * Math.pow(darkHz / brightHz, x);
        const a = 1 - Math.exp((-2 * Math.PI * fc) / SR);
        lp += a * (rnd() * 2 - 1 - lp);
        const env =
          Math.exp((-6.9078 * t) / t60) * Math.min(1, (i - pre) / fade);
        // Fade the last 5% to zero so the tail never stops on a step.
        const end = Math.min(1, (1 - x) / 0.05);
        const v = lp * env * end;
        d[i] = v;
        energy += v * v;
      }
      const k = 1 / Math.sqrt(energy);
      for (let i = 0; i < n; i++) d[i] = (d[i] ?? 0) * k;
    }
    return buf;
  };

  // ------------------------------------------------- compressor settings ----
  const COMP = {
    threshold: -10,
    knee: 8,
    ratio: 3,
    attack: 0.004,
    release: 0.2,
  };
  const makeCompressor = (ctx: BaseAudioContext): DynamicsCompressorNode => {
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = COMP.threshold;
    c.knee.value = COMP.knee;
    c.ratio.value = COMP.ratio;
    c.attack.value = COMP.attack;
    c.release.value = COMP.release;
    return c;
  };

  /**
   * Chromium's DynamicsCompressor adds automatic makeup gain and a lookahead
   * delay. Measure both — the gain on a quiet sine well under threshold, the
   * delay on a quiet click — so the master can cancel them: sub-threshold cues
   * keep exactly their designed level, and every cue lands on its frame.
   */
  const calibrateCompressor = async (): Promise<{
    makeupInverse: number;
    latency: number;
  }> => {
    const n = Math.ceil(0.4 * SR);
    const c = new OfflineAudioContext(2, n, SR);
    const o = c.createOscillator();
    o.frequency.value = 1000;
    const g = c.createGain();
    g.gain.value = 0.05;
    const click = c.createBuffer(1, n, SR);
    const at = Math.floor(0.05 * SR);
    click.getChannelData(0)[at] = 0.05;
    const src = c.createBufferSource();
    src.buffer = click;
    const merge = c.createChannelMerger(2);
    o.connect(g).connect(makeCompressor(c)).connect(merge, 0, 0);
    src.connect(makeCompressor(c)).connect(merge, 0, 1);
    merge.connect(c.destination);
    o.start(0);
    src.start(0);
    const out = await c.startRendering();
    const sine = out.getChannelData(0);
    let peak = 0;
    for (let i = Math.floor(0.25 * SR); i < n; i++) {
      peak = Math.max(peak, Math.abs(sine[i] ?? 0));
    }
    const imp = out.getChannelData(1);
    let best = 0;
    let bestAt = -1;
    for (let i = 0; i < n; i++) {
      const v = Math.abs(imp[i] ?? 0);
      if (v > best) {
        best = v;
        bestAt = i;
      }
    }
    if (!(peak > 0) || bestAt < at) {
      throw new Error(
        `renderSfx: compressor calibration failed (peak ${peak}, click at ${bestAt})`,
      );
    }
    return { makeupInverse: 0.05 / peak, latency: bestAt - at };
  };
  const { makeupInverse, latency } = await calibrateCompressor();

  // ------------------------------------------------------------ the graph ---
  // The compressor starts at unity and only reaches its (cancelled) makeup gain
  // after its release time, so a cue in the first ~200 ms would come out
  // ~3.5 dB quieter than the same cue later. Every cue is scheduled PRE_ROLL
  // late and that silent second is cut off, together with the lookahead
  // `latency`, so the WAV starts on the film's first frame with the master
  // already settled.
  const PRE_ROLL = 1;
  const skip = PRE_ROLL * SR + latency;
  const ctx = new OfflineAudioContext(2, length + skip, SR);
  /** The recorded mouse press / release, fetched only when a click cue needs them. */
  const mouse = cues.some((c) => c.kind === "click")
    ? await (async () => {
        const press = await loadSample(ctx, SAMPLE_PREFIX + "mouse-press.wav");
        const release = await loadSample(
          ctx,
          SAMPLE_PREFIX + "mouse-release.wav",
        );
        return {
          press,
          release,
          scale: dbToGain(CLICK_PEAK_DBFS) / peakOf(press),
        };
      })()
    : null;

  const noiseMono = fillNoise(ctx.createBuffer(1, 4 * SR, SR), 0x5eed1);
  const noiseStereo = fillNoise(ctx.createBuffer(2, 6 * SR, SR), 0x5eed2);

  // Master: dry bus + reverb returns → compressor → makeup cancel → soft limiter.
  const mix = ctx.createGain();
  const comp = makeCompressor(ctx);
  const post = ctx.createGain();
  post.gain.value = makeupInverse;
  const limiter = ctx.createWaveShaper();
  {
    // Curve domain [-1, 1] stands for an input of [-4, 4] (pre-scaled by 1/4):
    // identity below 0.85, then a tanh knee asymptotic to 1.0.
    const N = 16385;
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const s = ((i / (N - 1)) * 2 - 1) * 4;
      const a = Math.abs(s);
      const y = a <= 0.85 ? a : 0.85 + 0.15 * Math.tanh((a - 0.85) / 0.15);
      curve[i] = Math.sign(s) * y;
    }
    limiter.curve = curve;
    limiter.oversample = "none";
  }
  const preLimit = ctx.createGain();
  preLimit.gain.value = 0.25;
  mix
    .connect(comp)
    .connect(post)
    .connect(preLimit)
    .connect(limiter)
    .connect(ctx.destination);

  /** A reverb: convolver → 150 Hz highpass (no mud under the tails). */
  const makeReverb = (
    ir: AudioBuffer,
  ): { input: AudioNode; output: AudioNode } => {
    const conv = ctx.createConvolver();
    conv.normalize = false;
    conv.buffer = ir;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 150;
    hp.Q.value = 0.7;
    conv.connect(hp);
    return { input: conv, output: hp };
  };
  const room = makeReverb(impulse(ctx, 1.4, 1.1, 0.012, 9000, 2500, 0xa11));
  const hall = makeReverb(impulse(ctx, 3.8, 3.2, 0.025, 7000, 1200, 0xa12));

  // DETERMINISM: Chromium sums the connections into one input in an order that
  // varies from run to run, and float addition of 3+ terms depends on order
  // (a 1-LSB flip here and there). Two terms commute exactly, so EVERY fan-in
  // in this graph goes through `sum`/`sumInto`: a binary tree of unity gains,
  // never more than two connections into one input. The buses below collect
  // their inputs and are summed once every cue is scheduled.
  const dryIn: AudioNode[] = [];
  const roomIn: AudioNode[] = [];
  const hallIn: AudioNode[] = [];

  // ------------------------------------------------------- node helpers ----
  type Param = AudioParam;
  /** Pairwise-sum `nodes` into one node (see DETERMINISM above). */
  const sum = (nodes: AudioNode[]): AudioNode => {
    let level = nodes;
    if (level.length === 0) throw new Error("renderSfx: sum of nothing");
    while (level.length > 1) {
      const next: AudioNode[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const a = level[i];
        const b = level[i + 1];
        if (a === undefined) continue;
        if (b === undefined) {
          next.push(a);
          continue;
        }
        const g = ctx.createGain();
        a.connect(g);
        b.connect(g);
        next.push(g);
      }
      level = next;
    }
    const only = level[0];
    if (only === undefined) throw new Error("renderSfx: sum lost its nodes");
    return only;
  };
  const gain = (v = 0): GainNode => {
    const g = ctx.createGain();
    g.gain.value = v;
    return g;
  };
  const biquad = (
    type: BiquadFilterType,
    f: number,
    q = 0.707,
  ): BiquadFilterNode => {
    const b = ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  };
  const osc = (
    type: OscillatorType,
    f: number,
    t0: number,
    t1: number,
  ): OscillatorNode => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.start(t0);
    o.stop(t1);
    return o;
  };
  const noise = (
    t0: number,
    t1: number,
    rnd: () => number,
    stereo = false,
  ): AudioBufferSourceNode => {
    const s = ctx.createBufferSource();
    s.buffer = stereo ? noiseStereo : noiseMono;
    s.loop = true;
    s.start(t0, rnd() * (s.buffer.duration - 0.5));
    s.stop(t1);
    return s;
  };
  /** Linear attack to `peak`, then exponential decay with time constant `tau`. */
  const ad = (
    p: Param,
    t0: number,
    attack: number,
    peak: number,
    tau: number,
  ): void => {
    p.setValueAtTime(0, t0);
    p.linearRampToValueAtTime(peak, t0 + attack);
    p.setTargetAtTime(0, t0 + attack, tau);
  };
  /** Exponential glide written as a value curve (`points` samples). */
  const glide = (
    p: Param,
    t0: number,
    dur: number,
    shape: (x: number) => number,
    points = 128,
  ): void => {
    const c = new Float32Array(points);
    for (let i = 0; i < points; i++) c[i] = shape(i / (points - 1));
    p.setValueCurveAtTime(c, t0, dur);
  };
  const expInterp = (a: number, b: number, x: number): number =>
    a * Math.pow(b / a, x);

  /** Send a layer to the dry bus and the reverbs, panned. */
  const route = (
    node: AudioNode,
    sends: { pan?: number; dry?: number; room?: number; hall?: number },
  ): StereoPannerNode => {
    const p = ctx.createStereoPanner();
    p.pan.value = sends.pan ?? 0;
    node.connect(p);
    const dry = sends.dry ?? 1;
    if (dry > 0) dryIn.push(p.connect(gain(dry)));
    if ((sends.room ?? 0) > 0) roomIn.push(p.connect(gain(sends.room)));
    if ((sends.hall ?? 0) > 0) hallIn.push(p.connect(gain(sends.hall)));
    return p;
  };

  // Per-kind output trims, calibrated by ear and peak meter (v1 audition) so
  // each cue at gain 1 lands at its target peak.
  // Targets (peak dBFS): -12, except key -15, tick -16, shimmer -18
  // (textures and small transients sit under the hero sounds) and impact -10.
  const TRIM = {
    whoosh: 0.26,
    key: 0.529,
    pop: 0.335,
    riser: 0.289,
    impact: 0.337,
    chime: 0.371,
    shimmer: 0.259,
    ding: 0.441,
    tick: 0.244,
  } as const;

  // -------------------------------------------------------------- voices ----

  const whoosh = (
    t0: number,
    durIn: number,
    dir: "up" | "down" | undefined,
    g: number,
    rnd: () => number,
  ): void => {
    const T = Math.max(0.2, durIn);
    const t1 = t0 + T;
    const peakAt = dir === "up" ? 0.65 : dir === "down" ? 0.35 : 0.5;
    const freqAt = (x: number): number =>
      dir === "up"
        ? expInterp(260, 4200, Math.pow(x, 1.2))
        : dir === "down"
          ? expInterp(4200, 260, Math.pow(x, 0.8))
          : x < 0.5
            ? expInterp(380, 2600, x / 0.5)
            : expInterp(2600, 480, (x - 0.5) / 0.5);
    /** Raised-sine swell peaking at `peakAt`, 0 at both ends. */
    const swell = (x: number): number =>
      x < peakAt
        ? Math.pow(Math.sin((Math.PI / 2) * (x / peakAt)), 2)
        : Math.pow(Math.cos((Math.PI / 2) * ((x - peakAt) / (1 - peakAt))), 2);
    // A band-passed noise's level grows with its bandwidth (∝ centre at fixed
    // Q): compensate so the sweep's loudness follows the swell, not the filter.
    const comp = (x: number): number => Math.sqrt(1000 / freqAt(x));

    const body = noise(t0, t1, rnd, true);
    const bp = biquad("bandpass", 1000, 1.3);
    glide(bp.frequency, t0, T, freqAt);
    const bp2 = biquad("bandpass", 1000, 0.9);
    glide(bp2.frequency, t0, T, (x) => freqAt(x) * 1.6);
    const env = gain();
    glide(env.gain, t0, T, (x) => 0.9 * g * TRIM.whoosh * swell(x) * comp(x));
    body.connect(bp).connect(env);
    body.connect(bp2).connect(env);

    // Air: a faint high band riding slightly after the body's peak.
    const air = noise(t0, t1, rnd, true);
    const hp = biquad("highpass", 5500, 0.7);
    const airEnv = gain();
    glide(
      airEnv.gain,
      t0,
      T,
      (x) => 0.05 * g * TRIM.whoosh * swell(Math.max(0, x - 0.05)),
    );
    air.connect(hp).connect(airEnv);

    const side = rnd() < 0.5 ? -1 : 1;
    const pan = ctx.createStereoPanner();
    glide(pan.pan, t0, T, (x) => side * (-0.6 + 1.2 * x));
    env.connect(pan);
    airEnv.connect(pan);
    route(pan, { dry: 1, room: 0.18, hall: 0.12 });
  };

  /**
   * A real mouse click: the recorded press at `t0` and the recorded release
   * `hold` later (Kenney's UI SFX set, CC0 — `media/film/deps`), scaled so the
   * press peaks at CLICK_PEAK_DBFS × `g`.
   */
  const click = (t0: number, hold: number, g: number): void => {
    const s = mouse;
    if (!s) throw new Error("renderSfx: click cue without the mouse samples");
    const play = (buf: AudioBuffer, at: number): void => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const e = gain(g * s.scale);
      src.connect(e);
      src.start(at);
      route(e, { dry: 1 });
    };
    play(s.press, t0);
    play(s.release, t0 + hold);
  };

  const key = (t0In: number, seed: number, g: number): void => {
    const rnd = prng(seedOf(seed, 7919));
    const t0 = Math.max(0, t0In + (rnd() - 0.5) * 0.008);
    const a = g * TRIM.key * dbToGain((rnd() - 0.5) * 4);
    const soft = biquad("lowpass", 7000, 0.6);
    // Press: membrane click (band-passed noise) …
    const n1 = noise(t0, t0 + 0.06, rnd);
    const b1 = biquad("bandpass", 2600 + rnd() * 1400, 1.2);
    const e1 = gain();
    ad(e1.gain, t0, 0.0006, 0.9 * a, 0.004 + rnd() * 0.003);
    n1.connect(b1).connect(e1);
    // … over a low thump as the key bottoms out.
    const f = 150 + rnd() * 40;
    const s = osc("sine", f, t0, t0 + 0.12);
    s.frequency.setValueAtTime(f, t0);
    s.frequency.exponentialRampToValueAtTime(90, t0 + 0.03);
    const e2 = gain();
    ad(e2.gain, t0 + 0.001, 0.002, 0.22 * a, 0.016);
    s.connect(e2);
    // Release: a lighter, higher click as the key comes back up.
    const tr = t0 + 0.07 + rnd() * 0.035;
    const n3 = noise(tr, tr + 0.04, rnd);
    const b3 = biquad("bandpass", 3800 + rnd() * 1200, 1.5);
    const e3 = gain();
    ad(e3.gain, tr, 0.0005, 0.32 * a, 0.003);
    n3.connect(b3).connect(e3);
    sum([e1, e2, e3]).connect(soft);
    route(soft, { pan: (rnd() - 0.5) * 0.3, room: 0.06 });
  };

  const pop = (
    t0: number,
    pitch: number,
    g: number,
    rnd: () => number,
  ): void => {
    const a = g * TRIM.pop;
    const r = Math.pow(2, pitch / 12);
    const end = t0 + 0.3;
    const layers: AudioNode[] = [];
    const tone = (mult: number, level: number): void => {
      const o = osc("sine", 900 * r * mult, t0, end);
      o.frequency.setValueAtTime(900 * r * mult, t0);
      o.frequency.exponentialRampToValueAtTime(600 * r * mult, t0 + 0.045);
      const e = gain();
      ad(e.gain, t0, 0.0015, level * a, 0.032 / mult);
      layers.push(o.connect(e));
    };
    tone(1, 1);
    tone(2, 0.1);
    const n = noise(t0, t0 + 0.02, rnd);
    const hp = biquad("highpass", 3000, 0.7);
    const en = gain();
    ad(en.gain, t0, 0.0003, 0.12 * a, 0.0018);
    layers.push(n.connect(hp).connect(en));
    route(sum(layers), { pan: (rnd() - 0.5) * 0.24, room: 0.14 });
  };

  const riser = (
    t0: number,
    dur: number,
    g: number,
    rnd: () => number,
  ): void => {
    const a = g * TRIM.riser;
    const t1 = t0 + dur;
    const fadeOut = Math.min(0.004, dur / 4);
    /** Swell along the riser, exactly 0 at its end (a 4 ms ramp, not a step). */
    const shape = (x: number, power: number): number => {
      const tail = Math.min(1, ((1 - x) * dur) / fadeOut);
      return Math.pow(x, power) * tail;
    };
    // Noise through a resonant lowpass opening 200 Hz → 9 kHz.
    const n = noise(t0, t1, rnd, true);
    const lp = biquad("lowpass", 200, 4);
    glide(lp.frequency, t0, dur, (x) => expInterp(200, 9000, Math.pow(x, 1.4)));
    const en = gain();
    glide(en.gain, t0, dur, (x) => 0.55 * a * shape(x, 2.2), 256);
    n.connect(lp).connect(en);

    // Detuned saws gliding up an octave, through their own opening lowpass.
    const saws: AudioNode[] = [];
    const sawLp = biquad("lowpass", 500, 2);
    glide(sawLp.frequency, t0, dur, (x) =>
      expInterp(500, 7000, Math.pow(x, 1.3)),
    );
    const voices: Array<[number, number, number]> = [
      [-14, -0.5, 0.33],
      [0, 0, 0.33],
      [14, 0.5, 0.33],
      [1200, 0, 0.12],
    ];
    for (const [cents, pan, level] of voices) {
      const o = osc("sawtooth", 220, t0, t1);
      o.detune.value = cents;
      glide(o.frequency, t0, dur, (x) => expInterp(220, 440, Math.pow(x, 1.6)));
      const vg = gain(level);
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      saws.push(o.connect(vg).connect(p));
    }
    // A tremolo that quickens 4 → 18 Hz as the tension builds.
    const trem = gain(0.85);
    const lfo = osc("sine", 4, t0, t1);
    glide(lfo.frequency, t0, dur, (x) => expInterp(4, 18, x));
    lfo.connect(gain(0.15)).connect(trem.gain);
    const es = gain();
    glide(es.gain, t0, dur, (x) => 0.22 * a * shape(x, 2.6), 256);
    sum(saws).connect(sawLp).connect(trem).connect(es);

    // Dry only: a riser stops dead at its end, no tail.
    route(sum([en, es]), { dry: 1 });
  };

  const impact = (t0: number, g: number, rnd: () => number): void => {
    const a = g * TRIM.impact;
    // Sub: 45 → 30 Hz over 1.2 s.
    const sub = osc("sine", 45, t0, t0 + 1.6);
    sub.frequency.setValueAtTime(45, t0);
    sub.frequency.exponentialRampToValueAtTime(30, t0 + 1.2);
    const es = gain();
    ad(es.gain, t0, 0.004, 0.62 * a, 0.38);
    sub.connect(es);
    route(es, { dry: 1 });
    // Punch: 110 → 42 Hz in 120 ms, what a laptop speaker can actually play.
    const body = osc("sine", 110, t0, t0 + 0.5);
    body.frequency.setValueAtTime(110, t0);
    body.frequency.exponentialRampToValueAtTime(42, t0 + 0.12);
    const eb = gain();
    ad(eb.gain, t0, 0.002, 0.4 * a, 0.07);
    body.connect(eb);
    route(eb, { dry: 1, hall: 0.25 });
    // Low noise burst closing 2.5 kHz → 180 Hz, into the hall.
    const n = noise(t0, t0 + 1.2, rnd, true);
    const lp = biquad("lowpass", 2500, 0.8);
    lp.frequency.setValueAtTime(2500, t0);
    lp.frequency.exponentialRampToValueAtTime(180, t0 + 0.45);
    const en = gain();
    ad(en.gain, t0, 0.002, 0.7 * a, 0.13);
    n.connect(lp).connect(en);
    route(en, { dry: 1, hall: 1.4 });
    // Crack: a short mid transient for definition.
    const c = noise(t0, t0 + 0.15, rnd);
    const bp = biquad("bandpass", 1500, 0.8);
    const ec = gain();
    ad(ec.gain, t0, 0.0005, 0.35 * a, 0.018);
    c.connect(bp).connect(ec);
    route(ec, { dry: 1, hall: 0.9 });
  };

  /** A struck bell-ish note: additive partials, upper ones dying faster. */
  const bell = (
    t0: number,
    f: number,
    level: number,
    partials: Array<[number, number, number]>,
    pan: number,
    sends: { room: number; hall: number },
  ): void => {
    const layers: AudioNode[] = [];
    let longest = 0;
    for (const [, , tau] of partials) longest = Math.max(longest, tau);
    const end = t0 + 0.002 + longest * 9;
    for (const [ratio, amp, tau] of partials) {
      const o = osc("sine", f * ratio, t0, end);
      const e = gain();
      ad(e.gain, t0, 0.002, amp * level, tau);
      layers.push(o.connect(e));
    }
    route(sum(layers), { pan, room: sends.room, hall: sends.hall });
  };

  const chime = (t0: number, g: number, rnd: () => number): void => {
    const a = g * TRIM.chime;
    const partials: Array<[number, number, number]> = [
      [1, 1, 0.42],
      [2, 0.26, 0.2],
      [3.01, 0.07, 0.11],
      [4.18, 0.05, 0.06],
    ];
    // C6 then E6 — a rising major third.
    bell(t0, 1046.5, 0.5 * a, partials, -0.12, { room: 0.3, hall: 0.12 });
    bell(t0 + 0.085, 1318.5, 0.5 * a, partials, 0.12, {
      room: 0.3,
      hall: 0.12,
    });
    // Mallet: a breath of high noise on each strike.
    for (const t of [t0, t0 + 0.085]) {
      const n = noise(t, t + 0.03, rnd);
      const bp = biquad("bandpass", 5200, 1.2);
      const e = gain();
      ad(e.gain, t, 0.0004, 0.06 * a, 0.003);
      n.connect(bp).connect(e);
      route(e, { room: 0.1 });
    }
  };

  const ding = (t0: number, g: number): void => {
    const a = g * TRIM.ding;
    // F6 with its harmonic and a faint inharmonic shimmer, plus its fifth.
    bell(
      t0,
      1396.9,
      0.5 * a,
      [
        [1, 1, 0.55],
        [2, 0.2, 0.22],
        [2.76, 0.05, 0.12],
      ],
      0,
      { room: 0.28, hall: 0.08 },
    );
    bell(t0, 1396.9 * 1.5, 0.5 * a, [[1, 0.32, 0.28]], 0.05, {
      room: 0.28,
      hall: 0.08,
    });
  };

  const shimmer = (
    t0: number,
    dur: number,
    g: number,
    rnd: () => number,
  ): void => {
    const a = g * TRIM.shimmer;
    const T = Math.max(0.3, dur);
    // C-major pentatonic, 2–5.3 kHz: a cloud that stays consonant.
    const scale = [2093, 2349.3, 2637, 3136, 3520, 4186, 4698.6, 5274];
    /** The cloud's overall swell: in over 25%, out over 35%. */
    const cloud = (x: number): number =>
      x < 0.25
        ? Math.sin((Math.PI / 2) * (x / 0.25))
        : x > 0.65
          ? Math.cos((Math.PI / 2) * ((x - 0.65) / 0.35))
          : 1;
    const grains = Math.max(4, Math.round(T * 30));
    for (let i = 0; i < grains; i++) {
      const x = rnd();
      const t = t0 + x * T;
      const f =
        (scale[Math.floor(rnd() * scale.length)] ?? 3136) *
        (1 + (rnd() - 0.5) * 0.004);
      const attack = 0.008 + rnd() * 0.012;
      const tau = 0.03 + rnd() * 0.05;
      const o = osc("sine", f, t, t + attack + tau * 7);
      const e = gain();
      // Linear attack, then exponential decay (a soft, bell-like grain).
      ad(e.gain, t, attack, a * 0.2 * cloud(x) * (0.45 + 0.55 * rnd()), tau);
      o.connect(e);
      route(e, { pan: (rnd() - 0.5) * 1.4, dry: 1, room: 0.2, hall: 0.55 });
    }
    // Air bed: a breath of high noise under the cloud.
    const n = noise(t0, t0 + T, rnd, true);
    const bp = biquad("bandpass", 7500, 0.7);
    const e = gain();
    glide(e.gain, t0, T, (x) => 0.012 * a * cloud(x));
    n.connect(bp).connect(e);
    route(e, { room: 0.2 });
  };

  const tick = (t0: number, g: number, rnd: () => number): void => {
    const a = g * TRIM.tick;
    const end = t0 + 0.015;
    const n = noise(t0, end, () => 0.61); // one fixed grain: every tick alike

    // Band-limited around 6.5 kHz: crisp, not fizzy.
    const hp = biquad("highpass", 4000, 0.7);
    const lp = biquad("lowpass", 10000, 0.7);
    const en = gain();
    ad(en.gain, t0, 0.0002, 0.9 * a, 0.0009);
    n.connect(hp).connect(lp).connect(en);
    const s = osc("sine", 5200, t0, end);
    const es = gain();
    ad(es.gain, t0, 0.0002, 0.08 * a, 0.0012);
    s.connect(es);
    route(sum([en, es]), { pan: (rnd() - 0.5) * 0.2, room: 0.05 });
  };

  // ------------------------------------------------------------ schedule ----
  cues.forEach((cue, index) => {
    if (!(cue.at >= 0) || cue.at >= duration) {
      throw new Error(
        `renderSfx: cue #${index} (${cue.kind}) at ${cue.at}s is outside the ${duration}s film`,
      );
    }
    const g = cue.gain ?? 1;
    if (!(g >= 0))
      throw new Error(`renderSfx: cue #${index} has bad gain ${g}`);
    const rnd = prng(seedOf(index, cue.at, cue.kind.length));
    const at = cue.at + PRE_ROLL;
    switch (cue.kind) {
      case "whoosh":
        whoosh(at, cue.dur, cue.dir, g, rnd);
        break;
      case "click":
        click(at, cue.hold ?? 0.08, g);
        break;
      case "key":
        key(at, cue.seed, g);
        break;
      case "pop":
        pop(at, cue.pitch ?? 0, g, rnd);
        break;
      case "riser":
        if (!(cue.dur > 0) || cue.at + cue.dur > duration + 1e-9) {
          throw new Error(
            `renderSfx: riser #${index} (${cue.at}s + ${cue.dur}s) must end inside the ${duration}s film`,
          );
        }
        riser(at, cue.dur, g, rnd);
        break;
      case "impact":
        impact(at, g, rnd);
        break;
      case "chime":
        chime(at, g, rnd);
        break;
      case "shimmer":
        shimmer(at, cue.dur, g, rnd);
        break;
      case "ding":
        ding(at, g);
        break;
      case "tick":
        tick(at, g, rnd);
        break;
    }
  });

  if (roomIn.length > 0) sum(roomIn).connect(room.input);
  if (hallIn.length > 0) sum(hallIn).connect(hall.input);
  const buses = [...dryIn];
  if (roomIn.length > 0) buses.push(room.output);
  if (hallIn.length > 0) buses.push(hall.output);
  if (buses.length > 0) sum(buses).connect(mix);

  const rendered = await ctx.startRendering();

  // ----------------------------------------------------------- WAV encode ---
  const L = rendered.getChannelData(0).subarray(skip);
  const R = rendered.getChannelData(1).subarray(skip);
  const n = length;
  const bytes = new Uint8Array(44 + n * 4);
  const view = new DataView(bytes.buffer);
  const ascii = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) bytes[off + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + n * 4, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 2, true); // stereo
  view.setUint32(24, SR, true);
  view.setUint32(28, SR * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, n * 4, true);
  // TPDF dither (±1 LSB), seeded so the file stays byte-identical.
  const dither = prng(0xd1);
  const q = (x: number): number => {
    const d = (dither() - dither()) / 32768;
    const v = Math.max(-1, Math.min(1, x + d));
    return Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  };
  for (let i = 0; i < n; i++) {
    view.setInt16(44 + i * 4, q(L[i] ?? 0), true);
    view.setInt16(46 + i * 4, q(R[i] ?? 0), true);
  }
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
