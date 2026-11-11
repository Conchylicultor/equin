import { useEffect } from "react";
import { installOverscrollHint } from "./overscroll-detector";
import { installTouchClaimGuard } from "./touch-claim-guard";

/**
 * Invisible global controller. Mounted once via `Core.Root`, it installs the
 * wasted-scroll detector and the touch-claim guard (a touch drag must declare
 * its `touch-action`, which is how the detector tells it from a wasted scroll)
 * on the window for the lifetime of the app, and renders nothing.
 */
export function OverscrollHintController(): null {
  useEffect(() => installOverscrollHint(), []);
  useEffect(() => installTouchClaimGuard(), []);
  return null;
}
