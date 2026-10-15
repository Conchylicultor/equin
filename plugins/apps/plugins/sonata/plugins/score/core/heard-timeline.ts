import type { PlaybackTimeline } from "./timeline";

/**
 * How a new timeline takes over from the one before it:
 *
 *  - `continue`: the music carries on through the change (a tempo change, a
 *    drift correction, a loop edit re-pathing from where the music is). What is
 *    heard before the takeover instant was scheduled under the earlier
 *    timeline, so it is still read from that one.
 *  - `jump`: the music is replaced (play, a seek, a load). Nothing before the
 *    takeover belongs to it, so the earlier timelines are dropped.
 */
export type TimelineTakeover = "continue" | "jump";

/** What is heard at an instant: the timeline that scheduled it and its path coordinate. */
export interface HeardReading {
  readonly timeline: PlaybackTimeline;
  readonly c: number;
}

/**
 * Which timeline was in force at each render instant, so a follower of the
 * SOUND (the visual cursor) can read the music at the instant now being heard
 * — render time minus the output latency — rather than at render time.
 *
 * A timeline replaced less than one latency ago still sounds: its last notes
 * are on their way to the ears. Reading only the newest timeline at heard time
 * would extrapolate it backwards, past where it took over — a jump of the
 * latency's worth of music on every tempo or loop change.
 *
 * Bounded: a read prunes every timeline superseded before the heard instant,
 * so it holds at most one latency of history.
 */
export interface HeardTimeline {
  /** `timeline` takes over at render time `from`. */
  push(
    timeline: PlaybackTimeline,
    from: number,
    takeover: TimelineTakeover,
  ): void;
  /** Nothing sounds any more. */
  clear(): void;
  /**
   * The music heard at render time `heard` (`now − latency`), or `null` when
   * nothing sounds. Before the first timeline's takeover nothing it scheduled
   * is heard yet: the reading holds at its takeover position.
   */
  read(heard: number): HeardReading | null;
}

interface Entry {
  readonly timeline: PlaybackTimeline;
  readonly from: number;
}

export function createHeardTimeline(): HeardTimeline {
  let entries: Entry[] = [];
  return {
    push(timeline, from, takeover) {
      const kept =
        takeover === "jump" ? [] : entries.filter((e) => e.from < from);
      entries = [...kept, { timeline, from }];
    },
    clear() {
      entries = [];
    },
    read(heard) {
      let i = entries.length - 1;
      while (i > 0 && entries[i]!.from > heard) i -= 1;
      if (i > 0) entries = entries.slice(i);
      const entry = entries[0];
      if (!entry) return null;
      const { timeline, from } = entry;
      return { timeline, c: timeline.cAt(Math.max(heard, from)) };
    },
  };
}
