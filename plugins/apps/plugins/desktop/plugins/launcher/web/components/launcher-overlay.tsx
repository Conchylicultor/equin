import { useEffect, useState } from "react";
import { launcherControlsSink } from "../internal/launcher-controls";
import { LauncherPanel } from "./launcher-panel";

/**
 * The launcher's `Desktop.Overlay`: owns whether it is open and fills
 * {@link launcherControlsSink} so the shortcut and the shelf can open, close and
 * toggle it. The panel mounts only while open, so each opening starts from an
 * empty query and the first item selected with no reset code.
 */
export function LauncherOverlay() {
  const [open, setOpen] = useState(false);
  useEffect(
    () =>
      launcherControlsSink.install({
        open: () => setOpen(true),
        close: () => setOpen(false),
        toggle: () => setOpen((o) => !o),
      }),
    [],
  );
  return open ? <LauncherPanel onClose={() => setOpen(false)} /> : null;
}
