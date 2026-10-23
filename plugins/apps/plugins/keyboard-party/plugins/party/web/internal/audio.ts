import type { Instrument } from "../../core";

/**
 * The party's sound: every sound is synthesized with Web Audio (no samples to
 * load), through one compressor so a mashed keyboard never clips.
 *
 * The AudioContext is created on the first sound, which always follows a key
 * press or a tap — the user gesture browsers require before audio may start.
 */
export class PartyAudio {
  private ctx: AudioContext | null = null;
  private out: AudioNode | null = null;

  private context(): { ctx: AudioContext; out: AudioNode } {
    if (!this.ctx || !this.out) {
      const ctx = new AudioContext();
      const comp = ctx.createDynamicsCompressor();
      const gain = ctx.createGain();
      gain.gain.value = 0.55;
      comp.connect(gain).connect(ctx.destination);
      this.ctx = ctx;
      this.out = comp;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return { ctx: this.ctx, out: this.out };
  }

  tone(
    freq: number,
    {
      type = "sine",
      dur = 0.5,
      vol = 0.3,
      at = 0,
      slideTo,
    }: {
      type?: OscillatorType;
      dur?: number;
      vol?: number;
      at?: number;
      slideTo?: number;
    } = {},
  ): void {
    const { ctx, out } = this.context();
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  noise({
    dur = 0.3,
    vol = 0.2,
    at = 0,
    filter = 2000,
    q = 1,
    type = "bandpass",
    sweepTo,
  }: {
    dur?: number;
    vol?: number;
    at?: number;
    filter?: number;
    q?: number;
    type?: BiquadFilterType;
    sweepTo?: number;
  } = {}): void {
    const { ctx, out } = this.context();
    const t = ctx.currentTime + at;
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const biquad = ctx.createBiquadFilter();
    biquad.type = type;
    biquad.Q.value = q;
    biquad.frequency.setValueAtTime(filter, t);
    if (sweepTo)
      biquad.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(biquad).connect(gain).connect(out);
    src.start(t);
  }

  /** One note on one of the letter instruments. */
  play(instrument: Instrument, f: number): void {
    switch (instrument) {
      case "bell":
        this.tone(f, { dur: 1.4, vol: 0.28 });
        this.tone(f * 2.76, { dur: 0.6, vol: 0.08 });
        this.tone(f * 5.4, { dur: 0.25, vol: 0.04 });
        return;
      case "pluck":
        this.tone(f, { type: "triangle", dur: 0.7, vol: 0.32 });
        this.tone(f * 2, { dur: 0.3, vol: 0.1 });
        return;
      case "marimba":
        this.tone(f, { dur: 0.45, vol: 0.38 });
        this.tone(f * 4, { dur: 0.08, vol: 0.12 });
        return;
      case "chirp":
        this.tone(f, { type: "square", dur: 0.22, vol: 0.1, slideTo: f * 2 });
        this.tone(f * 2, { dur: 0.35, vol: 0.14, at: 0.08 });
        return;
    }
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
    this.out = null;
  }
}

/**
 * Speech after a sound. Each call cancels what is still being said, so mashing
 * keys speaks only the latest — never a backlog.
 */
export function say(text: string): void {
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.9;
  u.pitch = 1.35;
  speechSynthesis.speak(u);
}
