import { useEffect, useState } from "react";
import { Presence } from "@plugins/primitives/plugins/css/plugins/motion/web";
import { useDesktop } from "@plugins/apps/plugins/desktop/plugins/windows/web";
import { launcherControls } from "../internal/launcher-controls";
import { LauncherPanel } from "./launcher-panel";

/**
 * The launcher's `Desktop.Overlay`: owns whether it is open and fills
 * its desktop's {@link launcherControls} so the shortcut and the shelf can open, close and
 * toggle it. The panel mounts only while open, so each opening starts from an
 * empty query and the first item selected with no reset code — each opening
 * is its own key, so one reopened while the last is still fading out is a
 * fresh panel too. Its panel arrives by itself (a `Surface`); `<Presence>`
 * fades it out.
 */
export function LauncherOverlay() {
  const [opening, setOpening] = useState<number | null>(null);
  const desk = useDesktop();
  useEffect(() => {
    let next = 0;
    return launcherControls.install(desk, {
      open: () => setOpening((o) => o ?? ++next),
      close: () => setOpening(null),
      toggle: () => setOpening((o) => (o === null ? ++next : null)),
    });
  }, [desk]);
  return (
    <Presence>
      {opening === null ? null : (
        <LauncherPanel key={opening} onClose={() => setOpening(null)} />
      )}
    </Presence>
  );
}
