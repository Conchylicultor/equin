import {
  IDLE_AFTER_MS,
  MAX_ENGAGED_MS,
  appendGap,
  stripQuery,
  type CollectBody,
  type CollectResponse,
  type Gap,
  type GapKind,
} from "../../core";
import type { LandingSource } from "./landing";

/**
 * Everything the tracker reads from or does to the outside world, injected so
 * the logic below is plain and testable.
 */
export interface TrackerDeps {
  /** `location.host` of the page. */
  host: string;
  /** The landing URL's source, sent with the first pageview only. */
  landing: LandingSource;
  /** Posts one body. A rejection is left to surface; see `send` in instance.ts. */
  send: (body: CollectBody) => Promise<CollectResponse>;
  now: () => number;
  /** Whether the page is visible right now (`document.visibilityState`). */
  isVisible: () => boolean;
  /**
   * Calls `fire` once, `delayMs` from now; the returned function cancels it.
   * The idle deadline — one timer, re-armed only when it fires early.
   */
  setDeadline: (delayMs: number, fire: () => void) => () => void;
  /** Whether a `<video>` / `<audio>` on the page is playing: watching is not idle. */
  isMediaPlaying: () => boolean;
}

/** One pageview whose visible time is being counted. */
interface CurrentPage {
  path: string;
  /** Set once the pageview's response names it; null before, or if ignored. */
  pageviewId: string | null;
  /** Cumulative visible milliseconds, excluding the running stretch. */
  engagedMs: number;
  /** When the running visible stretch began, or null while hidden. */
  visibleSince: number | null;
  /** The engagedMs last sent, so a repeated hide never re-sends the same total. */
  sentMs: number;
  /** An engagement is owed but the pageview id has not arrived yet. */
  owed: boolean;
  /** `deps.now()` when the pageview was recorded: what gap offsets count from. */
  startedAt: number;
  /** Closed away stretches, offsets from `startedAt`. */
  gaps: Gap[];
  /** The running away stretch (`at` is a `deps.now()` instant), or null while present. */
  away: { kind: GapKind; at: number } | null;
  /** The gaps last sent (as JSON), so an unchanged list is not re-sent. */
  sentGaps: string;
}

export interface Tracker {
  /** The route changed (or was first read). Records a pageview when the path did. */
  pathChanged: (rawPath: string) => void;
  /** The page became hidden or is being unloaded: report visible time so far. */
  hidden: () => void;
  /** The page became visible again: resume counting. */
  visible: () => void;
  /**
   * The visitor did something (pointer, key, wheel, scroll, touch, or media
   * started / stopped): ends an idle stretch and pushes the idle deadline back.
   */
  activity: () => void;
  /**
   * A custom event on the current page. `fallbackPath` is used before any
   * pageview was recorded (no tracker mounted).
   */
  track: (
    name: string,
    props: Record<string, string> | undefined,
    fallbackPath: string,
  ) => void;
  /** The path of the page being counted, or null before the first pageview. */
  currentPath: () => string | null;
}

/**
 * The tracker's state machine: one pageview per distinct path, the landing
 * source on the first pageview only, and visible time per pageview reported as a
 * cumulative total on every hide and when the visitor leaves the path, with
 * the pageview's away stretches: `hidden` from a hide to the next show, `idle`
 * from the last input to the next one once {@link IDLE_AFTER_MS} pass without
 * any while visible and no media plays.
 *
 * One instance per page load (see instance.ts), so remounting the React
 * component — or mounting it in two tabs of the same document — can never count
 * a path twice.
 */
export function createTracker(deps: TrackerDeps): Tracker {
  let current: CurrentPage | null = null;
  let landingSent = false;
  /** The last input (or show, or path change): when an idle stretch would start. */
  let lastActivity = deps.now();
  let cancelDeadline: (() => void) | null = null;

  const offset = (page: CurrentPage, at: number) => at - page.startedAt;

  /** Ends the running away stretch at `at`, keeping it if long enough. */
  const endAway = (page: CurrentPage, at: number) => {
    if (!page.away) return;
    page.gaps = appendGap(page.gaps, {
      kind: page.away.kind,
      startMs: offset(page, page.away.at),
      endMs: offset(page, at),
    });
    page.away = null;
  };

  /** The closed stretches plus the running one, cut at now: what a beacon carries. */
  const gapsSoFar = (page: CurrentPage): Gap[] =>
    page.away
      ? appendGap(page.gaps, {
          kind: page.away.kind,
          startMs: offset(page, page.away.at),
          endMs: offset(page, deps.now()),
        })
      : page.gaps;

  const stopDeadline = () => {
    cancelDeadline?.();
    cancelDeadline = null;
  };

  /** Arms the idle deadline for `lastActivity + IDLE_AFTER_MS`, unless one is armed. */
  const armDeadline = () => {
    if (cancelDeadline) return;
    cancelDeadline = deps.setDeadline(
      Math.max(0, lastActivity + IDLE_AFTER_MS - deps.now()),
      onDeadline,
    );
  };

  const onDeadline = () => {
    cancelDeadline = null;
    const page = current;
    if (!page || page.away || page.visibleSince === null) return;
    // Input since arming moved `lastActivity` without touching the timer (one
    // timer per idle window, not one per mousemove): wait out the rest.
    if (deps.now() - lastActivity < IDLE_AFTER_MS) return armDeadline();
    // Playing media is watching, not idle. Its pause / end is an `activity()`,
    // which re-arms, so nothing has to look again until then.
    if (deps.isMediaPlaying()) return;
    page.away = { kind: "idle", at: Math.max(lastActivity, page.startedAt) };
  };

  const engaged = (page: CurrentPage) =>
    Math.min(
      MAX_ENGAGED_MS,
      Math.round(
        page.engagedMs +
          (page.visibleSince === null ? 0 : deps.now() - page.visibleSince),
      ),
    );

  const sendEngagement = (page: CurrentPage) => {
    const engagedMs = engaged(page);
    const gaps = gapsSoFar(page);
    const gapsJson = JSON.stringify(gaps);
    if (engagedMs <= page.sentMs && gapsJson === page.sentGaps) return;
    if (page.pageviewId === null) {
      // The pageview's response is still in flight: send once it names the id.
      page.owed = true;
      return;
    }
    page.owed = false;
    page.sentMs = engagedMs;
    page.sentGaps = gapsJson;
    void deps.send({
      kind: "engagement",
      pageviewId: page.pageviewId,
      engagedMs,
      gaps,
    });
  };

  const pause = (page: CurrentPage) => {
    if (page.visibleSince === null) return;
    page.engagedMs += deps.now() - page.visibleSince;
    page.visibleSince = null;
  };

  return {
    pathChanged(rawPath) {
      const path = stripQuery(rawPath);
      if (current?.path === path) return;
      const now = deps.now();
      if (current) {
        endAway(current, now);
        pause(current);
        sendEngagement(current);
      }
      const visible = deps.isVisible();
      const page: CurrentPage = {
        path,
        pageviewId: null,
        engagedMs: 0,
        visibleSince: visible ? now : null,
        sentMs: 0,
        owed: false,
        startedAt: now,
        gaps: [],
        away: visible ? null : { kind: "hidden", at: now },
        sentGaps: "[]",
      };
      current = page;
      // A new page is a fresh start for the idle clock.
      lastActivity = now;
      if (visible) armDeadline();
      const source = landingSent ? {} : deps.landing;
      landingSent = true;
      void deps
        .send({ kind: "pageview", host: deps.host, path, ...source })
        .then((response) => {
          // `ignored` (a bot) has no id: nothing to attach engagement to.
          if (response.outcome !== "pageview") return;
          page.pageviewId = response.pageviewId;
          if (page.owed) sendEngagement(page);
        });
    },
    hidden() {
      if (!current) return;
      stopDeadline();
      // Repeated (visibilitychange, then pagehide): the hidden stretch runs on.
      if (current.away?.kind !== "hidden") {
        const now = deps.now();
        endAway(current, now);
        current.away = { kind: "hidden", at: now };
      }
      pause(current);
      sendEngagement(current);
    },
    visible() {
      if (!current || current.visibleSince !== null) return;
      const now = deps.now();
      endAway(current, now);
      current.visibleSince = now;
      lastActivity = now;
      armDeadline();
    },
    activity() {
      lastActivity = deps.now();
      if (!current || current.visibleSince === null) return;
      if (current.away?.kind === "idle") endAway(current, lastActivity);
      armDeadline();
    },
    track(name, props, fallbackPath) {
      void deps.send({
        kind: "event",
        host: deps.host,
        path: current?.path ?? stripQuery(fallbackPath),
        name,
        ...(props !== undefined ? { props } : {}),
      });
    },
    currentPath: () => current?.path ?? null,
  };
}
