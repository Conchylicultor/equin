import { useEffect } from "react";
import { usePaneViews } from "@plugins/primitives/plugins/pane/web";
import {
  EMBED_MAXIMIZED,
  EMBED_MAXIMIZED_SURFACE,
  EMBED_PLACE_SURFACE,
} from "@plugins/primitives/plugins/pane/core";

/** The homepage's old demo keys (`/about;view.website.demo=…;view.website.demo.full=1`). */
const LEGACY_PLACE = "website.demo";
const LEGACY_MAXIMIZED = "website.demo.full";

/**
 * Old homepage links kept the demo's place in two surface views of the
 * landing pane (`/about;view.website.demo=%2Fagents%2Fc%2Fx;view.website.demo.full=1` —
 * an even older `/website…` one reaches here through the gateway's 301).
 * The embed now keeps it itself (`/about/at/agents/c/x;full=1`): such a
 * link is rewritten onto it, in place (one replaced entry), before the band
 * renders. `true` while that rewrite is pending.
 *
 * Temporary: remove once old homepage links have aged out (2027-01).
 */
export function useLegacyDemoPlace(): boolean {
  const views = usePaneViews();
  const place = views?.values[LEGACY_PLACE];
  const maximized = views?.values[LEGACY_MAXIMIZED];
  const legacy = place !== undefined || maximized !== undefined;
  const set = views?.set;
  const current = views?.values[EMBED_PLACE_SURFACE];
  useEffect(() => {
    if (!legacy || set === undefined) return;
    set({
      [LEGACY_PLACE]: undefined,
      [LEGACY_MAXIMIZED]: undefined,
      [EMBED_PLACE_SURFACE]: place ?? current,
      [EMBED_MAXIMIZED_SURFACE]:
        maximized === EMBED_MAXIMIZED ? EMBED_MAXIMIZED : undefined,
    });
  }, [legacy, set, place, maximized, current]);
  return legacy;
}
