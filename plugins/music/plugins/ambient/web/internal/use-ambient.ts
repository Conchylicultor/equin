import { useEffect, useMemo, useRef, useState } from "react";
import type { AmbientMood } from "../../core";
import { createAmbient, type Ambient, type AmbientSfx } from "./ambient";

/**
 * Where the music stands: `locked` until a user gesture unlocked audio (the
 * browser refuses to start sound before one), then `playing`, or `off` while
 * the caller holds it off (or the browser suspended the context).
 */
export type AmbientStatus = "locked" | "playing" | "off";

export interface AmbientHandle {
  readonly status: AmbientStatus;
  /**
   * Resumes the AudioContext (built at mount, suspended) — call it from a
   * user gesture's handler (a click, a key press). Nothing sounds before.
   */
  unlock(): void;
  /** Lowers the music under something else. */
  duck(on: boolean): void;
  /** The sound effects (silent until unlocked, and while off). */
  readonly sfx: AmbientSfx;
  /** The AudioContext's state, for inspection (`null` before unlock). */
  readonly contextState: AudioContextState | null;
}

/**
 * Generative ambient music owned by the calling component: its own
 * AudioContext and engine, built when the component mounts (suspended — no
 * sound before a gesture), resumed by `unlock()` (a user gesture), playing
 * `mood` while `on`, closed on unmount.
 *
 * Why the context is built at mount, not in `unlock()`: constructing a page's
 * first AudioContext blocks the main thread while the browser sets up the
 * audio output (a synchronous round trip to its audio service — ~130 ms
 * headless, seconds on a real Mac's output device), and the engine's reverb
 * impulse is a few hundred thousand samples to fill and transform. Built in
 * the gesture, all of it froze the click that asked for sound (the Isle's
 * Start, 2.2 s); built at mount it runs while the caller is still loading,
 * and the gesture only resumes — microseconds.
 */
export function useAmbient(opts: {
  readonly mood: AmbientMood;
  readonly on: boolean;
}): AmbientHandle {
  const { mood, on } = opts;
  const ref = useRef<{ ctx: AudioContext; ambient: Ambient } | null>(null);
  const [ctxState, setCtxState] = useState<AudioContextState | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const moodRef = useRef(mood);
  useEffect(() => {
    moodRef.current = mood;
  }, [mood]);

  // built with the component (suspended until a gesture), closed with it
  useEffect(() => {
    const ctx = new AudioContext();
    const cur = { ctx, ambient: createAmbient(ctx, { mood: moodRef.current }) };
    ref.current = cur;
    ctx.onstatechange = () => setCtxState(ctx.state);
    return () => {
      ref.current = null;
      ctx.onstatechange = null;
      cur.ambient.dispose();
      void ctx.close();
    };
  }, []);

  const running = unlocked && ctxState === "running";
  useEffect(() => {
    const cur = ref.current;
    if (!cur || !running) return;
    cur.ambient.setMood(mood);
    if (on) cur.ambient.start();
    else cur.ambient.stop();
  }, [on, mood, running]);

  const handle = useMemo(() => {
    const sfx: AmbientSfx = {
      step: () => ref.current?.ambient.sfx.step(),
      blip: (high) => ref.current?.ambient.sfx.blip(high),
      enter: () => ref.current?.ambient.sfx.enter(),
      whoosh: () => ref.current?.ambient.sfx.whoosh(),
      chime: (note) => ref.current?.ambient.sfx.chime(note),
    };
    return {
      unlock() {
        const cur = ref.current;
        if (!cur)
          throw new Error("useAmbient: unlock() before the context was built");
        setUnlocked(true);
        // its state so far (a browser that lets it run without a gesture
        // never reports a change); later changes arrive by onstatechange
        setCtxState(cur.ctx.state);
        void cur.ctx.resume();
      },
      duck: (d: boolean) => ref.current?.ambient.duck(d),
      sfx,
    };
  }, []);

  const status: AmbientStatus = !unlocked
    ? "locked"
    : running && on
      ? "playing"
      : "off";
  return { ...handle, status, contextState: unlocked ? ctxState : null };
}
