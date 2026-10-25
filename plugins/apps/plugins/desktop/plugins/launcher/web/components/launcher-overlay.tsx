import { useEffect, useState } from "react";
import { Presence } from "@plugins/primitives/plugins/css/plugins/motion/web";
import { launcherControlsSink } from "../internal/launcher-controls";
import { LauncherPanel } from "./launcher-panel";

/**
 * The launcher's `Desktop.Overlay`: owns whether it is open and fills
 * {@link launcherControlsSink} so the shortcut and the shelf can open, close and
 * toggle it. The panel mounts only while open, so each opening starts from an
 * empty query and the first item selected with no reset code — each opening
 * is its own key, so one reopened while the last is still fading out is a
 * fresh panel too. Its panel arrives by itself (a `Surface`); `<Presence>`
 * fades it out.
 */
export function LauncherOverlay() {
  const [opening, setOpening] = useState<number | null>(null);
  useEffect(() => {
    let next = 0;
    return launcherControlsSink.install({
      open: () => setOpening((o) => o ?? ++next),
      close: () => setOpening(null),
      toggle: () => setOpening((o) => (o === null ? ++next : null)),
    });
  }, []);
  return (
    <Presence>
      {opening === null ? null : (
        <LauncherPanel key={opening} onClose={() => setOpening(null)} />
      )}
    </Presence>
  );
}
