import {
  LOOK_AHEAD_SEC,
  PUMP_SEC,
  barsDue,
  type AmbientMood,
} from "../../core";
import { SONGS } from "./songs";
import {
  bell,
  crackle,
  keys,
  makeNoise,
  makeReverb,
  midi,
  step,
  whoosh,
  type Rig,
} from "./voices";

/** The small sound effects, played at once (no-ops while the engine is stopped). */
export interface AmbientSfx {
  /** A footstep. */
  step(): void;
  /** A soft key: `high` for an arrival (a door reached), low for a hover. */
  blip(high?: boolean): void;
  /** A rising arpeggio of bells: something opens. */
  enter(): void;
  /** A rush of air: a scene changes. */
  whoosh(): void;
}

export interface Ambient {
  /** Fades the music in and begins writing bars. The context must be running (a user gesture). */
  start(): void;
  /** Fades everything out and stops writing bars. */
  stop(): void;
  /** Switches song from the next bar. */
  setMood(mood: AmbientMood): void;
  /** Lowers the music under something else (an app opening). */
  duck(on: boolean): void;
  readonly sfx: AmbientSfx;
  /** Stops and disconnects from the context's destination. */
  dispose(): void;
}

const MASTER = 0.9;
const MUSIC = 0.55;
const DUCKED = 0.15;

/**
 * The generative ambient engine on a caller's AudioContext: two songs (`lofi`,
 * `ambient`) written bar by bar a little ahead of the audio clock, and sound
 * effects. The look-ahead pump is woken by the audio clock itself — a silent
 * source's `onended` — never by an interval: it follows the context (a
 * suspended context writes nothing; a slept tab skips the missed bars).
 */
export function createAmbient(
  ctx: BaseAudioContext,
  opts: { readonly mood: AmbientMood },
): Ambient {
  let mood = opts.mood;
  const master = ctx.createGain();
  master.gain.value = 0;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 5200;
  master.connect(lp).connect(ctx.destination);
  const music = ctx.createGain();
  music.gain.value = MUSIC;
  music.connect(master);
  const sfxBus = ctx.createGain();
  sfxBus.gain.value = 0.7;
  sfxBus.connect(master);
  const reverb = makeReverb(ctx);
  const rv = ctx.createGain();
  rv.gain.value = 0.32;
  reverb.connect(rv).connect(master);
  const rig: Rig = { ctx, music, sfx: sfxBus, reverb, noise: makeNoise(ctx) };

  let playing = false;
  let next = 0;
  let bar = 0;
  let waker: ConstantSourceNode | null = null;
  let hiss: AudioBufferSourceNode | null = null;

  const syncCrackle = () => {
    const want = playing && SONGS[mood].crackle;
    if (want && !hiss) hiss = crackle(rig);
    if (!want && hiss) {
      hiss.stop();
      hiss = null;
    }
  };

  const pump = () => {
    waker = null;
    if (!playing) return;
    const song = SONGS[mood];
    const r = barsDue(
      next,
      bar,
      ctx.currentTime,
      LOOK_AHEAD_SEC,
      () => song.barSec,
    );
    for (const d of r.due) song.bar(rig, d.at, d.bar);
    next = r.next;
    bar = r.bar;
    // the audio clock wakes the next refill: a silent source ending PUMP_SEC from now
    const w = ctx.createConstantSource();
    w.offset.value = 0;
    w.connect(ctx.destination);
    w.onended = () => {
      w.disconnect();
      if (waker === w) pump();
    };
    w.start();
    w.stop(ctx.currentTime + PUMP_SEC);
    waker = w;
  };

  const fade = (to: number, sec: number) => {
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(to, now + sec);
  };

  return {
    start() {
      if (playing) return;
      playing = true;
      next = ctx.currentTime + 0.1;
      bar = 0;
      fade(MASTER, 3);
      syncCrackle();
      pump();
    },
    stop() {
      if (!playing) return;
      playing = false;
      waker = null;
      fade(0, 0.8);
      syncCrackle();
    },
    setMood(m) {
      if (m === mood) return;
      mood = m;
      // the new song starts from its first bar, at the next bar line already written
      bar = 0;
      syncCrackle();
    },
    duck(on) {
      music.gain.setTargetAtTime(on ? DUCKED : MUSIC, ctx.currentTime, 0.3);
    },
    sfx: {
      step() {
        if (playing) step(rig, ctx.currentTime);
      },
      blip(high = false) {
        if (playing)
          keys(rig, midi(high ? 84 : 79), ctx.currentTime, 0.5, 0.06, sfxBus);
      },
      enter() {
        if (!playing) return;
        const t = ctx.currentTime;
        [72, 76, 79, 84].forEach((n, k) =>
          bell(rig, midi(n), t + k * 0.07, 0.07, sfxBus),
        );
      },
      whoosh() {
        if (playing) whoosh(rig, ctx.currentTime);
      },
    },
    dispose() {
      playing = false;
      waker = null;
      if (hiss) {
        hiss.stop();
        hiss = null;
      }
      lp.disconnect();
    },
  };
}
