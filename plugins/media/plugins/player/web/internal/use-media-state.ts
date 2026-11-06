import { useCallback, useRef, useSyncExternalStore } from "react";
import { bufferedEnd } from "./math";

/**
 * What the player draws from its media element, read in two parts by how
 * often they change: the coarse state (playing, length, level) a handful of
 * times per session, and the playhead several times a second. Only the
 * timeline subscribes to the playhead, so a `timeupdate` re-renders the
 * seek bar and the two times — never the whole player.
 *
 * The element is the one truth (a key, a click, the browser's own picture
 * in picture all drive it), so neither part mirrors it in React state that
 * could drift: each is re-read on the element's own events.
 */
export interface MediaState {
  paused: boolean;
  /** `NaN` until the metadata loads. */
  duration: number;
  volume: number;
  muted: boolean;
}

export interface MediaTime {
  currentTime: number;
  /** The end of the buffered range the playhead is in, seconds. */
  buffered: number;
}

const STATE_EVENTS = [
  "play",
  "pause",
  "playing",
  "ended",
  "loadedmetadata",
  "durationchange",
  "volumechange",
  "emptied",
] as const;

const TIME_EVENTS = [
  "timeupdate",
  "progress",
  "seeking",
  "seeked",
  "loadedmetadata",
  "emptied",
] as const;

const INITIAL_STATE: MediaState = {
  paused: true,
  duration: Number.NaN,
  volume: 1,
  muted: false,
};
const INITIAL_TIME: MediaTime = { currentTime: 0, buffered: 0 };

function readState(el: HTMLMediaElement): MediaState {
  return {
    paused: el.paused,
    duration: el.duration,
    volume: el.volume,
    muted: el.muted,
  };
}

function readTime(el: HTMLMediaElement): MediaTime {
  return {
    currentTime: el.currentTime,
    buffered: bufferedEnd(el.buffered, el.currentTime),
  };
}

function sameValues<T extends object>(a: T, b: T): boolean {
  for (const k of Object.keys(a) as (keyof T)[])
    if (!Object.is(a[k], b[k])) return false;
  return true;
}

/** A snapshot of the element re-read on `events`, stable while its values are. */
function useElementSnapshot<T extends object>(
  el: HTMLMediaElement | null,
  events: readonly string[],
  read: (el: HTMLMediaElement) => T,
  initial: T,
): T {
  const cache = useRef(initial);
  const subscribe = useCallback(
    (notify: () => void) => {
      if (el === null) return () => undefined;
      for (const e of events) el.addEventListener(e, notify);
      return () => {
        for (const e of events) el.removeEventListener(e, notify);
      };
    },
    [el, events],
  );
  const snapshot = useCallback(() => {
    if (el === null) return initial;
    const next = read(el);
    if (!sameValues(cache.current, next)) cache.current = next;
    return cache.current;
  }, [el, read, initial]);
  return useSyncExternalStore(subscribe, snapshot);
}

/** Playing, length and level. */
export function useMediaState(el: HTMLMediaElement | null): MediaState {
  return useElementSnapshot(el, STATE_EVENTS, readState, INITIAL_STATE);
}

/** The playhead and what is buffered ahead of it. */
export function useMediaTime(el: HTMLMediaElement | null): MediaTime {
  return useElementSnapshot(el, TIME_EVENTS, readTime, INITIAL_TIME);
}
