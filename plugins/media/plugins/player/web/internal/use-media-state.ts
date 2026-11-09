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

/**
 * A snapshot of the element re-read on `events` only, stable while its values
 * are.
 *
 * `getSnapshot` never reads the element itself: WebKit's `currentTime` is a
 * live clock that advances between two reads in the same render (Chromium's
 * holds still until the next `timeupdate`), so reading it there hands React a
 * new value every call — a store that "changed" during render, re-rendered
 * until React gives up (#185, in the Tauri app's WKWebView). The element is
 * read once when it appears, then only by the event that says it changed.
 */
function useElementSnapshot<T extends object>(
  el: HTMLMediaElement | null,
  events: readonly string[],
  read: (el: HTMLMediaElement) => T,
  initial: T,
): T {
  const cache = useRef<{ el: HTMLMediaElement | null; value: T }>({
    el: null,
    value: initial,
  });
  const current = useCallback((): T => {
    if (el === null) return initial;
    if (cache.current.el !== el) cache.current = { el, value: read(el) };
    return cache.current.value;
  }, [el, read, initial]);
  const subscribe = useCallback(
    (notify: () => void) => {
      if (el === null) return () => undefined;
      const onEvent = () => {
        const next = read(el);
        const prev = current();
        if (sameValues(prev, next)) return;
        cache.current = { el, value: next };
        notify();
      };
      for (const e of events) el.addEventListener(e, onEvent);
      // Catch up on what changed between the render's read and now.
      onEvent();
      return () => {
        for (const e of events) el.removeEventListener(e, onEvent);
      };
    },
    [el, events, read, current],
  );
  return useSyncExternalStore(subscribe, current);
}

/** Playing, length and level. */
export function useMediaState(el: HTMLMediaElement | null): MediaState {
  return useElementSnapshot(el, STATE_EVENTS, readState, INITIAL_STATE);
}

/** The playhead and what is buffered ahead of it. */
export function useMediaTime(el: HTMLMediaElement | null): MediaTime {
  return useElementSnapshot(el, TIME_EVENTS, readTime, INITIAL_TIME);
}
