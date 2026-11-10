import { useCallback, useMemo } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import {
  useOpenPane,
  usePaneViewParam,
  type HistoryMode,
} from "@plugins/primitives/plugins/pane/web";
import {
  indexKeyedSuffix,
  surfaceViewKey,
} from "@plugins/primitives/plugins/pane/core";
import { landingPane } from "@plugins/apps/plugins/website/plugins/shell/web";

/** The demo's location inside it (the embed's app-rooted URL), in the homepage's URL. */
const LOCATION_SURFACE = "website.demo";
/** Whether it is maximized (`"1"`), in the homepage's URL. */
const FULL_SURFACE = "website.demo.full";
const FULL = "1";

/**
 * Where the visitor is in the homepage's demo, kept in the homepage's own URL
 * (its surface view keys: `/website;view.website.demo=%2Fagents%2Fc%2Fx;view.website.demo.full=1`),
 * so a reload comes back to it — the rule /demo follows with `/demo/at/…`:
 *
 * - framed, the demo is a box on the page: its moves rewrite the current
 *   history entry, so Back leaves the page rather than replaying clicks made
 *   inside a widget;
 * - maximized, the demo is the tab: each move is the entry the app's own tab
 *   would write (`history`), and Back / Forward step through them (the embed
 *   follows `location`);
 * - Maximize and Restore are the page's own steps (a pushed entry each), so
 *   Back from maximized returns to the frame.
 */
export interface DemoPlace {
  /** The embed's location, `undefined` before it moved (the demo's home app). */
  location: string | undefined;
  maximized: boolean;
  /** The embed moved: keep it, per the history rule above. */
  move(location: string, history: HistoryMode): void;
  setMaximized(on: boolean): void;
  /** Back to the demo's start (after a Reset, which may erase where it was). */
  restart(): void;
  /** This page with the demo at `location`, maximized: what a new browser tab opened from inside opens. */
  maximizedUrl(location: string): string;
}

/** The homepage demo's place, read from and written to the landing pane's URL. Throws outside it. */
export function useDemoPlace(): DemoPlace {
  const locationParam = usePaneViewParam(LOCATION_SURFACE);
  const fullParam = usePaneViewParam(FULL_SURFACE);
  if (locationParam === null || fullParam === null)
    throw new Error(
      "The homepage's demo band renders outside the landing pane: its place has no URL to live in.",
    );
  const location = locationParam.value;
  const maximized = fullParam.value === FULL;
  const openPane = useOpenPane();
  const latest = useLatestRef({
    location,
    maximized,
    locationParam,
    fullParam,
    openPane,
  });

  const move = useCallback(
    (next: string, history: HistoryMode) => {
      const now = latest.current;
      if (next === now.location) return;
      now.locationParam.set(next, now.maximized ? history : "replace");
    },
    [latest],
  );
  const setMaximized = useCallback(
    (on: boolean) =>
      latest.current.fullParam.set(on ? FULL : undefined, "push"),
    [latest],
  );
  const restart = useCallback(
    () => latest.current.locationParam.set(undefined),
    [latest],
  );
  const maximizedUrl = useCallback(
    (at: string) =>
      latest.current.openPane.to(landingPane, {}, { mode: "root" }).href() +
      indexKeyedSuffix({
        [surfaceViewKey(LOCATION_SURFACE)]: at,
        [surfaceViewKey(FULL_SURFACE)]: FULL,
      }),
    [latest],
  );
  return useMemo(
    () => ({ location, maximized, move, setMaximized, restart, maximizedUrl }),
    [location, maximized, move, setMaximized, restart, maximizedUrl],
  );
}
