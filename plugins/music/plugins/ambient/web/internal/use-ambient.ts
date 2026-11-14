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
   * Creates (or resumes) the AudioContext — call it from a user gesture's
   * handler (a click, a key press). Nothing sounds before.
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
 * AudioContext, created on `unlock()` (a user gesture), playing `mood` while
 * `on`, closed on unmount.
 */
export function useAmbient(opts: {
  readonly mood: AmbientMood;
  readonly on: boolean;
}): AmbientHandle {
  const { mood, on } = opts;
  const ref = useRef<{ ctx: AudioContext; ambient: Ambient } | null>(null);
  const [ctxState, setCtxState] = useState<AudioContextState | null>(null);
  const moodRef = useRef(mood);
  useEffect(() => {
    moodRef.current = mood;
  }, [mood]);

  // closed with the component
  useEffect(
    () => () => {
      const cur = ref.current;
      ref.current = null;
      if (!cur) return;
      cur.ambient.dispose();
      void cur.ctx.close();
    },
    [],
  );

  const running = ctxState === "running";
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
    };
    return {
      unlock() {
        let cur = ref.current;
        if (!cur) {
          const ctx = new AudioContext();
          cur = { ctx, ambient: createAmbient(ctx, { mood: moodRef.current }) };
          ref.current = cur;
          ctx.onstatechange = () => setCtxState(ctx.state);
          setCtxState(ctx.state);
        }
        void cur.ctx.resume();
      },
      duck: (d: boolean) => ref.current?.ambient.duck(d),
      sfx,
    };
  }, []);

  const status: AmbientStatus =
    ctxState === null ? "locked" : running && on ? "playing" : "off";
  return { ...handle, status, contextState: ctxState };
}
