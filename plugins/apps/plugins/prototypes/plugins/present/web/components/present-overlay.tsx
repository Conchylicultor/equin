import { useEffect, useMemo, useRef, useState } from "react";
import { useSurfaceShortcuts } from "@plugins/primitives/plugins/shortcuts/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import { ViewportOverlay } from "@plugins/primitives/plugins/css/plugins/viewport-overlay/web";
import { useSurfaceFocused } from "@plugins/apps-core/plugins/tabs/web";
import {
  usePrototypeDetail,
  type CanvasAddAction,
  type FrameId,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import { PresentBox } from "./present-box";
import { PresentStage } from "./present-stage";

/**
 * One canvas frame alone, full screen (the whole page, handed to the browser's
 * Fullscreen API), with none of the app around it: the same live frame
 * the canvas shows (so an agent's edit still reloads it), at the canvas's size
 * and zoom fitted to the space it now has. ← / → flip through the canvas's
 * frames in place.
 *
 * `+` / Compare add the frame to the live canvas — the pane's own — and leave,
 * so the comparison is made on the canvas in the app.
 *
 * Escape leaves: the browser exits fullscreen and the resulting
 * `fullscreenchange` closes (our own key handler closes too, should the
 * browser have refused full screen).
 */
export function PresentOverlay({
  name,
  frameId,
  onClose,
}: {
  name: string;
  /** The canvas frame presented first; ← / → flip to the others in place. */
  frameId: FrameId;
  /** Stable identity required — the fullscreen effect keys on it. */
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const surfaceFocused = useSurfaceFocused();
  const { canvas, dispatch } = usePrototypeDetail();
  const [shown, setShown] = useState<FrameId>(frameId);

  // Leaving selects the frame last on show, so the canvas comes back on it
  // (and `F` presents it again). Stable, like `onClose`.
  const exit = useEventCallback(() => {
    dispatch({ type: "select", id: shown });
    onClose();
  });

  const flip = useEventCallback((delta: -1 | 1) => {
    const n = canvas.frames.length;
    if (n < 2) return;
    const i = Math.max(
      0,
      canvas.frames.findIndex((f) => f.id === shown),
    );
    const next = canvas.frames[(i + delta + n) % n];
    if (next) setShown(next.id);
  });
  // The added frame is selected by the reducer, so leave without `exit`'s
  // re-selection of the frame on show.
  const extend = useEventCallback((action: CanvasAddAction) => {
    dispatch(action);
    onClose();
  });

  const flipKeys = useMemo(
    () => [
      {
        id: "prototypes.present-previous",
        keys: "arrowleft",
        label: "Present the previous frame",
        group: "Prototypes",
        handler: () => flip(-1),
        // Over the canvas's own ← / → (select a frame), still mounted under
        // the presentation.
        priority: 1,
      },
      {
        id: "prototypes.present-next",
        keys: "arrowright",
        label: "Present the next frame",
        group: "Prototypes",
        handler: () => flip(1),
        priority: 1,
      },
    ],
    [flip],
  );
  useSurfaceShortcuts(flipKeys);

  useEffect(() => {
    // Only the focused tab listens. Tabs are keep-alive — a background tab is
    // still mounted (and under the floating placement, still on screen) — so an
    // ungated window listener would close a presentation the user is not
    // looking at.
    if (!surfaceFocused) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") exit();
    }
    // eslint-disable-next-line shortcuts/no-window-key-listener -- installed only while this surface is focused (the useSurfaceFocused gate above) and only while presenting.
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exit, surfaceFocused]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    // Still inside the button click's (or the F key's) user activation, so the
    // request is granted.
    const onChange = () => {
      if (document.fullscreenElement === null) exit();
    };
    document.addEventListener("fullscreenchange", onChange);
    void el.requestFullscreen();
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (document.fullscreenElement === el) void document.exitFullscreen();
    };
  }, [exit]);

  return (
    <ViewportOverlay
      layer="max"
      role="dialog"
      aria-modal="true"
      aria-label="Prototype presentation"
    >
      {/* The stage box: the element handed to the Fullscreen API, and the
          positioning context the chrome pins to (so it is inside the fullscreened
          subtree and stays visible there). */}
      <PresentBox boxRef={rootRef}>
        <PresentStage
          name={name}
          frameId={shown}
          onExit={exit}
          onExtend={extend}
          onFlip={flip}
        />
      </PresentBox>
    </ViewportOverlay>
  );
}
