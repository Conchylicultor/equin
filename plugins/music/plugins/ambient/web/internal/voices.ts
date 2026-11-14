// The instruments the ambient engine plays, all synthesised (no samples): a
// soft electric piano, a detuned pad, a bell, a sine bass, a kick / snare /
// hat from noise, vinyl crackle, a wash of surf and a bird's chirp. Each
// schedules its own nodes at an audio-clock time `t` and lets them stop.

/** The graph the voices play into. */
export interface Rig {
  readonly ctx: BaseAudioContext;
  /** The music's bus (ducked while an app opens). */
  readonly music: AudioNode;
  /** The sound effects' bus. */
  readonly sfx: AudioNode;
  readonly reverb: AudioNode;
  /** One second of white noise, made once. */
  readonly noise: AudioBuffer;
}

export const midi = (n: number): number => 440 * Math.pow(2, (n - 69) / 12);

/** A stereo reverb impulse: noise under a decaying envelope. */
export function makeReverb(
  ctx: BaseAudioContext,
  seconds = 3.2,
): ConvolverNode {
  const len = Math.round(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  const env = new Float32Array(len);
  for (let i = 0; i < len; i++) env[i] = Math.pow(1 - i / len, 2.6);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * env[i]!;
  }
  const r = ctx.createConvolver();
  r.buffer = buf;
  return r;
}

export function makeNoise(ctx: BaseAudioContext): AudioBuffer {
  const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

function noiseSource(r: Rig): AudioBufferSourceNode {
  const s = r.ctx.createBufferSource();
  s.buffer = r.noise;
  return s;
}

/** A soft electric piano with a gentle tape wobble. */
export function keys(
  r: Rig,
  freq: number,
  t: number,
  dur: number,
  vel = 0.12,
  dest: AudioNode = r.music,
): void {
  const { ctx } = r;
  const o1 = ctx.createOscillator();
  const o2 = ctx.createOscillator();
  const g = ctx.createGain();
  const f = ctx.createBiquadFilter();
  o1.type = "sine";
  o2.type = "triangle";
  o1.frequency.value = freq;
  o2.frequency.value = freq * 2.001;
  const g2 = ctx.createGain();
  g2.gain.value = 0.18;
  f.type = "lowpass";
  f.frequency.setValueAtTime(2400, t);
  f.frequency.exponentialRampToValueAtTime(700, t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vel, t + 0.012);
  g.gain.exponentialRampToValueAtTime(vel * 0.35, t + 0.5);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o1.connect(g);
  o2.connect(g2).connect(g);
  g.connect(f);
  f.connect(dest);
  f.connect(r.reverb);
  const lfo = ctx.createOscillator();
  const lg = ctx.createGain();
  lfo.frequency.value = 0.6;
  lg.gain.value = freq * 0.0025;
  lfo.connect(lg);
  lg.connect(o1.frequency);
  lg.connect(o2.frequency);
  for (const o of [o1, o2, lfo]) {
    o.start(t);
    o.stop(t + dur + 0.05);
  }
}

export function pad(
  r: Rig,
  freq: number,
  t: number,
  dur: number,
  vel = 0.05,
): void {
  const { ctx } = r;
  const g = ctx.createGain();
  const f = ctx.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = 900;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vel, t + dur * 0.4);
  g.gain.linearRampToValueAtTime(0, t + dur);
  for (const det of [-6, 6]) {
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = freq;
    o.detune.value = det;
    o.connect(f);
    o.start(t);
    o.stop(t + dur + 0.1);
  }
  f.connect(g);
  g.connect(r.music);
  g.connect(r.reverb);
}

export function bell(
  r: Rig,
  freq: number,
  t: number,
  vel = 0.06,
  dest: AudioNode = r.music,
): void {
  const { ctx } = r;
  for (const [ratio, a] of [
    [1, 1],
    [2.76, 0.35],
    [5.4, 0.12],
  ] as const) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = freq * ratio;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel * a, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.6 / ratio);
    o.connect(g);
    g.connect(dest);
    g.connect(r.reverb);
    o.start(t);
    o.stop(t + 3);
  }
}

export function bass(
  r: Rig,
  freq: number,
  t: number,
  dur: number,
  vel = 0.16,
): void {
  const { ctx } = r;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = "sine";
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vel, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(r.music);
  o.start(t);
  o.stop(t + dur + 0.05);
}

export function kick(r: Rig, t: number): void {
  const { ctx } = r;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.setValueAtTime(110, t);
  o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
  g.gain.setValueAtTime(0.32, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  o.connect(g).connect(r.music);
  o.start(t);
  o.stop(t + 0.32);
}

export function snare(r: Rig, t: number): void {
  const { ctx } = r;
  const n = noiseSource(r);
  const f = ctx.createBiquadFilter();
  const g = ctx.createGain();
  f.type = "bandpass";
  f.frequency.value = 1800;
  f.Q.value = 0.7;
  g.gain.setValueAtTime(0.09, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  n.connect(f).connect(g);
  g.connect(r.music);
  g.connect(r.reverb);
  n.start(t, Math.random() * 0.5);
  n.stop(t + 0.2);
}

export function hat(r: Rig, t: number, v = 0.025): void {
  const { ctx } = r;
  const n = noiseSource(r);
  const f = ctx.createBiquadFilter();
  const g = ctx.createGain();
  f.type = "highpass";
  f.frequency.value = 7000;
  g.gain.setValueAtTime(v, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  n.connect(f).connect(g).connect(r.music);
  n.start(t, Math.random() * 0.5);
  n.stop(t + 0.06);
}

/** Vinyl hiss under the lo-fi mood: a looping source, stopped by the caller. */
export function crackle(r: Rig): AudioBufferSourceNode {
  const { ctx } = r;
  const n = noiseSource(r);
  n.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = 3000;
  f.Q.value = 0.4;
  const g = ctx.createGain();
  g.gain.value = 0.006;
  n.connect(f).connect(g).connect(r.music);
  n.start();
  return n;
}

/** A slow wash of surf. */
export function waves(r: Rig, t: number, dur: number): void {
  const { ctx } = r;
  const n = noiseSource(r);
  n.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = 500;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.05, t + dur * 0.45);
  g.gain.linearRampToValueAtTime(0, t + dur);
  n.connect(f).connect(g).connect(r.music);
  n.start(t);
  n.stop(t + dur + 0.1);
}

export function chirp(r: Rig, t: number): void {
  const { ctx } = r;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  const base = 2400 + Math.random() * 1400;
  o.frequency.setValueAtTime(base, t);
  o.frequency.exponentialRampToValueAtTime(base * 1.4, t + 0.06);
  o.frequency.exponentialRampToValueAtTime(base * 0.9, t + 0.12);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.012, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
  o.connect(g);
  g.connect(r.music);
  g.connect(r.reverb);
  o.start(t);
  o.stop(t + 0.15);
}

/** A footstep: a short low thud of filtered noise. */
export function step(r: Rig, t: number): void {
  const { ctx } = r;
  const n = noiseSource(r);
  const f = ctx.createBiquadFilter();
  const g = ctx.createGain();
  f.type = "lowpass";
  f.frequency.value = 600 + Math.random() * 300;
  g.gain.setValueAtTime(0.05, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
  n.connect(f).connect(g).connect(r.sfx);
  n.start(t, Math.random() * 0.9);
  n.stop(t + 0.08);
}

/** A rising band of noise. */
export function whoosh(r: Rig, t: number): void {
  const { ctx } = r;
  const n = noiseSource(r);
  const f = ctx.createBiquadFilter();
  const g = ctx.createGain();
  f.type = "bandpass";
  f.Q.value = 1.2;
  f.frequency.setValueAtTime(300, t);
  f.frequency.exponentialRampToValueAtTime(3000, t + 0.5);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.08, t + 0.25);
  g.gain.linearRampToValueAtTime(0, t + 0.6);
  n.connect(f).connect(g).connect(r.sfx);
  n.start(t);
  n.stop(t + 0.7);
}
