import { useEffect, useSyncExternalStore } from "react";
import type { AmbientMood } from "../../core";
import { createAmbient, type Ambient, type AmbientSfx } from "./ambient";

/**
 * Where the music stands: `playing`, `locked` while it is asked for but the
 * browser holds the context suspended (no user gesture yet), else `off`.
 */
export type AmbientStatus = "locked" | "playing" | "off";

export interface AmbientSnapshot {
  readonly status: AmbientStatus;
  /** The AudioContext's state, for inspection (`null` while none is built). */
  readonly contextState: AudioContextState | null;
}

/**
 * One generative ambient engine for the whole page, shared by everything that
 * holds it: a view that plays its sound effects and a player that keeps the
 * music going after the view is gone are the same engine, on the same
 * AudioContext.
 *
 * The context is built on the first {@link AmbientHost.retain} — suspended, no
 * sound before a gesture — and closed on the last release. Built at retain,
 * never in a gesture: constructing a page's first AudioContext blocks the main
 * thread while the browser opens the audio output (~130 ms headless, seconds
 * on a real Mac's output device), and the reverb impulse is a few hundred
 * thousand samples to fill; built in the gesture, it froze the click that
 * asked for sound (Isle's Start, 2.2 s). Retained ahead, the gesture only
 * resumes — microseconds.
 */
export interface AmbientHost {
  /** Holds the engine (building it on the first hold); call the returned release once. */
  retain(): () => void;
  /**
   * Resumes the AudioContext — call it from a user gesture's handler (a
   * click, a key press). The browser starts no sound before one.
   */
  unlock(): void;
  /**
   * What should play: whether at all, and the mood (kept as it was when
   * omitted). `on` also resumes the context.
   */
  set(opts: { readonly on: boolean; readonly mood?: AmbientMood }): void;
  /** The listener's volume, a gain in [0, 1]. */
  setGain(gain: number): void;
  /** Lowers the music under something else. */
  duck(on: boolean): void;
  /** The sound effects (silent while the music is off). */
  readonly sfx: AmbientSfx;
  getSnapshot(): AmbientSnapshot;
  subscribe(listener: () => void): () => void;
}

export function createAmbientHost(): AmbientHost {
  let holds = 0;
  let built: { ctx: AudioContext; ambient: Ambient } | null = null;
  let wanted: { on: boolean; mood: AmbientMood } = { on: false, mood: "lofi" };
  let gain = 1;
  let ducked = false;
  let snapshot: AmbientSnapshot = { status: "off", contextState: null };
  const listeners = new Set<() => void>();

  function publish() {
    const contextState = built?.ctx.state ?? null;
    const status: AmbientStatus = !wanted.on
      ? "off"
      : contextState === "running"
        ? "playing"
        : "locked";
    if (status === snapshot.status && contextState === snapshot.contextState) {
      return;
    }
    snapshot = { status, contextState };
    for (const l of listeners) l();
  }

  function apply() {
    if (built && built.ctx.state === "running") {
      built.ambient.setMood(wanted.mood);
      if (wanted.on) built.ambient.start();
      else built.ambient.stop();
    }
    publish();
  }

  function build() {
    const ctx = new AudioContext();
    const ambient = createAmbient(ctx, { mood: wanted.mood });
    ambient.setGain(gain);
    ambient.duck(ducked);
    built = { ctx, ambient };
    ctx.onstatechange = apply;
    if (wanted.on) void ctx.resume();
    apply();
  }

  function teardown() {
    if (!built) return;
    const { ctx, ambient } = built;
    built = null;
    ctx.onstatechange = null;
    ambient.dispose();
    void ctx.close();
    publish();
  }

  const sfx: AmbientSfx = {
    step: () => built?.ambient.sfx.step(),
    blip: (high) => built?.ambient.sfx.blip(high),
    enter: () => built?.ambient.sfx.enter(),
    whoosh: () => built?.ambient.sfx.whoosh(),
    chime: (note) => built?.ambient.sfx.chime(note),
  };

  return {
    retain() {
      holds++;
      if (!built) build();
      let released = false;
      return () => {
        if (released) throw new Error("AmbientHost: released twice");
        released = true;
        holds--;
        if (holds === 0) teardown();
      };
    },
    unlock() {
      if (!built)
        throw new Error("AmbientHost: unlock() while nobody holds it");
      void built.ctx.resume();
    },
    set(opts) {
      wanted = { on: opts.on, mood: opts.mood ?? wanted.mood };
      if (built && wanted.on) void built.ctx.resume();
      apply();
    },
    setGain(next) {
      gain = next;
      built?.ambient.setGain(next);
    },
    duck(on) {
      ducked = on;
      built?.ambient.duck(on);
    },
    sfx,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Holds `host` while the calling component is mounted, and reads where it stands. */
export function useAmbientHost(host: AmbientHost): AmbientSnapshot {
  useEffect(() => host.retain(), [host]);
  return useSyncExternalStore(
    host.subscribe,
    host.getSnapshot,
    host.getSnapshot,
  );
}
