/**
 * The background music service's rules, as a pure step over the page's state.
 *
 * - One source plays at a time on a page (`current`), and one page at a time in
 *   the browser: music starting anywhere else (`remote-claim`) pauses it.
 * - A source plays on while one of its views is on screen (`shown`). When the
 *   last one leaves (the app switched away in a one-app-at-a-time surface, its
 *   window closed) it pauses — unless the user keeps music across apps (never
 *   for a closed desktop window: the caller passes `acrossApps` false then).
 * - Music an app plays itself (`foreground`, a Sonata song) pauses the
 *   service's music when no view of it is on screen: real music interrupts
 *   background ambience; music beside it on the desktop mixes.
 * - Music an app played in its view outlives the view (`adopt`, a Sonata song
 *   whose page went away while it played): it becomes what the service plays
 *   — if the user keeps music across apps (and the view's leaving is not its
 *   desktop window closing); otherwise it ends with the view.
 */

export interface Current {
  readonly sourceId: string;
  readonly playing: boolean;
}

/** What another page of the browser is playing, as it last said. */
export interface Remote {
  readonly pageId: string;
  readonly sourceId: string;
  readonly title: string;
  /** The route of what it plays (a song's page), empty until that page named it. */
  readonly href: string;
  readonly playing: boolean;
}

export interface MusicState {
  readonly current: Current | null;
  /** Per source, how many of its views are on screen. */
  readonly shown: Readonly<Record<string, number>>;
  readonly remote: Remote | null;
}

export const INITIAL_MUSIC_STATE: MusicState = {
  current: null,
  shown: {},
  remote: null,
};

export type MusicEvent =
  | { readonly kind: "play"; readonly sourceId: string }
  | { readonly kind: "pause" }
  | { readonly kind: "resume" }
  | { readonly kind: "stop" }
  | {
      readonly kind: "shown";
      readonly sourceId: string;
      readonly delta: 1 | -1;
      readonly acrossApps: boolean;
    }
  | { readonly kind: "foreground" }
  | {
      readonly kind: "adopt";
      readonly sourceId: string;
      readonly acrossApps: boolean;
    }
  | { readonly kind: "remote-claim" }
  | {
      readonly kind: "remote-state";
      readonly pageId: string;
      readonly now: Omit<Remote, "pageId"> | null;
    }
  | { readonly kind: "remote-gone"; readonly pageId: string };

function shownCount(s: MusicState, sourceId: string): number {
  return s.shown[sourceId] ?? 0;
}

function paused(s: MusicState): MusicState {
  return s.current?.playing
    ? { ...s, current: { ...s.current, playing: false } }
    : s;
}

export function step(s: MusicState, e: MusicEvent): MusicState {
  switch (e.kind) {
    case "play":
      return { ...s, current: { sourceId: e.sourceId, playing: true } };
    case "pause":
      return paused(s);
    case "resume":
      return s.current && !s.current.playing
        ? { ...s, current: { ...s.current, playing: true } }
        : s;
    case "stop":
      return s.current ? { ...s, current: null } : s;
    case "shown": {
      const count = shownCount(s, e.sourceId) + e.delta;
      if (count < 0) {
        throw new Error(
          `background music: "${e.sourceId}" hidden more often than shown`,
        );
      }
      const next = { ...s, shown: { ...s.shown, [e.sourceId]: count } };
      const left =
        count === 0 && e.delta === -1 && next.current?.sourceId === e.sourceId;
      return left && !e.acrossApps ? paused(next) : next;
    }
    case "foreground":
      return s.current && shownCount(s, s.current.sourceId) === 0
        ? paused(s)
        : s;
    case "adopt":
      return e.acrossApps
        ? { ...s, current: { sourceId: e.sourceId, playing: true } }
        : s;
    case "remote-claim":
      return paused(s);
    case "remote-state":
      if (e.now === null) {
        return s.remote?.pageId === e.pageId ? { ...s, remote: null } : s;
      }
      return { ...s, remote: { pageId: e.pageId, ...e.now } };
    case "remote-gone":
      return s.remote?.pageId === e.pageId ? { ...s, remote: null } : s;
  }
}

/** Whether `next` started this page playing (a claim the other pages must hear). */
export function startedPlaying(prev: MusicState, next: MusicState): boolean {
  if (!next.current?.playing) return false;
  return (
    !prev.current?.playing || prev.current.sourceId !== next.current.sourceId
  );
}

/**
 * Whether something other than `sourceId` is playing — here or in another page.
 * An app's own auto-play gives way to it; only an explicit ask takes over.
 */
export function busyElsewhere(s: MusicState, sourceId: string): boolean {
  if (s.current?.playing && s.current.sourceId !== sourceId) return true;
  return s.remote?.playing ?? false;
}

/** What the music button shows: this page's music, else another page's. */
export type NowPlaying =
  | {
      readonly where: "here";
      readonly sourceId: string;
      readonly playing: boolean;
    }
  | ({ readonly where: "remote" } & Remote);

export function nowPlaying(s: MusicState): NowPlaying | null {
  const here = s.current ? ({ where: "here", ...s.current } as const) : null;
  const remote = s.remote ? ({ where: "remote", ...s.remote } as const) : null;
  if (here?.playing) return here;
  if (remote?.playing) return remote;
  return here ?? remote;
}
