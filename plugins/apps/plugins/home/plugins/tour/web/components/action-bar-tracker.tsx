import { useEffect } from "react";
import { setTourData, useTourRun } from "@plugins/hints/web";
import { useActionBarPinned } from "@plugins/shell/plugins/global-action-bar/web";
import { homeTour } from "../internal/tour";

/**
 * Feeds the Home tour how the toolbar is drawn — data only the page knows:
 * floating (folded into its dot until hovered) or docked (always open in the
 * tab bar). The toolbar step's copy and gesture depend on it. Mounted at
 * `Core.Root`; kept in sync for the whole run, since the surface mode can
 * change mid-tour, and writes nothing while the tour is not running.
 */
export function ActionBarTracker() {
  const run = useTourRun(homeTour);
  const floating = !useActionBarPinned();
  const current = run?.data.barFloating;
  const running = run !== null;

  useEffect(() => {
    if (!running || current === floating) return;
    setTourData(homeTour, { barFloating: floating });
  }, [running, current, floating]);

  return null;
}
