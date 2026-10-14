import type { PlaybackTimeline } from "@plugins/apps/plugins/sonata/plugins/score/core";

/**
 * What the playback is sounding, as one value every follower reads.
 *
 *  - `idle`: nothing sounds — stopped, counting in, or an external medium that
 *    owns the position is not advancing.
 *  - `running`: `timeline` maps the clock to the music. `generation` names the
 *    path: it moves when the path is replaced (play, seek, a loop edit, a
 *    medium's jump), and stays when only the timing changes (tempo, a drift
 *    correction, a clock swap) — so a scheduler knows whether to start over or
 *    only re-time what it has not handed out yet.
 */
export type TimelineState =
  | { kind: "idle" }
  | { kind: "running"; timeline: PlaybackTimeline; generation: number };

/**
 * The session's playback timeline, read imperatively: it changes up to every
 * frame while the speed wheel is dragged, so it is a store, not React state.
 * The session is its only writer; `subscribe` listeners are called
 * synchronously on every change, so a scheduler follows a tempo change in the
 * same commit the cursor does.
 */
export interface TimelineStore {
  get(): TimelineState;
  subscribe(listener: () => void): () => void;
}

/** The session's writable side of a {@link TimelineStore}. */
export interface TimelineWriter extends TimelineStore {
  set(state: TimelineState): void;
}

const IDLE: TimelineState = { kind: "idle" };

export function createTimelineStore(): TimelineWriter {
  let state: TimelineState = IDLE;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      if (next === state || (next.kind === "idle" && state.kind === "idle")) {
        return;
      }
      state = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
