import { useEffect } from "react";
import type { AppRef } from "@plugins/primitives/plugins/pane/core";
import { usePathname } from "@plugins/primitives/plugins/pane/web";
import { getTracker } from "../internal/instance";
import { isWithinApp } from "../internal/scope";

/**
 * Records one pageview per path change of `app`, with the visible time spent on
 * each. Mounted ONCE by the app that wants to be measured — never a `Core.Root`
 * contribution, or a local composition carrying every plugin would track itself.
 *
 * Only paths under `app.basePath` count: in a composition with several apps the
 * component stays mounted in a background tab while the address shows another
 * app, and that app's pages are not this site's visits.
 *
 * Nothing is stored in the browser unless the visitor accepts the site's
 * consent prompt (`consent.ts`: one random key); the dedup lives in module
 * scope (instance.ts), so a remount never double counts.
 */
export function AnalyticsTracker({ app }: { app: AppRef }) {
  const path = usePathname();
  useEffect(() => {
    if (isWithinApp(path, app.basePath)) getTracker().pathChanged(path);
  }, [path, app.basePath]);
  return null;
}
