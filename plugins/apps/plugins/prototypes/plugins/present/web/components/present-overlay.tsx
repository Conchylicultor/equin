import { useEffect, useMemo, useRef, useState } from "react";
import { useSurfaceShortcuts } from "@plugins/primitives/plugins/shortcuts/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import { ViewportOverlay } from "@plugins/primitives/plugins/css/plugins/viewport-overlay/web";
import { SurfaceOverlay } from "@plugins/primitives/plugins/overlay/plugins/surface-overlay/web";
import { useSurfaceFocused } from "@plugins/apps-core/plugins/tabs/web";
import {
  usePrototypeDetail,
  type CanvasAddAction,
  type FrameId,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import { CanvasStage } from "./canvas-stage";
import { PresentBox } from "./present-box";
import { ExitButton, PresentStage } from "./present-stage";

/**
 * How much of the screen the presentation covers, smallest first:
 *
 * - `surface` — the app tab's surface. The Singularity tab bar and app rail stay
 *   visible, so the user can keep switching tabs with a prototype presented.
 * - `viewport` — the whole browser page, app chrome included.
 * - `screen` — the same, handed to the browser's Fullscreen API.
 */
export type PresentPlacement = "surface" | "viewport" | "screen";

/**
 * One canvas frame alone, with none of the app around it: the same live frame
 * the canvas shows (so an agent's edit still reloads it), at the canvas's size
 * and zoom fitted to the space it now has. ← / → flip through the canvas's
 * frames in place.
 *
 * `+` / Compare add the frame to the live canvas — the pane's own, so it is
 * still there on leaving — and the overlay then presents the whole canvas, in
 * the same box (so full screen stays full screen).
 *
 * Escape leaves from any placement: in `surface`/`viewport` our own key handler
 * closes; in `screen` the browser exits fullscreen first and the resulting
 * `fullscreenchange` closes.
 */
export function PresentOverlay({
  name,
  frameId,
  placement,
  onClose,
}: {
  name: string;
  /** The canvas frame presented first; ← / → flip to the others in place. */
  frameId: FrameId;
  placement: PresentPlacement;
  /** Stable identity required — the fullscreen effect keys on it. */
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const surfaceFocused = useSurfaceFocused();
  const { canvas, dispatch } = usePrototypeDetail();
  const [shown, setShown] = useState<FrameId>(frameId);
  const [wholeCanvas, setWholeCanvas] = useState(false);

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
  const extend = useEventCallback((action: CanvasAddAction) => {
    dispatch(action);
    setWholeCanvas(true);
  });

  // The whole canvas has no one frame on show to flip.
  const flipKeys = useMemo(
    () =>
      wholeCanvas
        ? []
        : [
            {
              id: "prototypes.present-previous",
              keys: "arrowleft",
              label: "Present the previous frame",
              group: "Prototypes",
              handler: () => flip(-1),
            },
            {
              id: "prototypes.present-next",
              keys: "arrowright",
              label: "Present the next frame",
              group: "Prototypes",
              handler: () => flip(1),
            },
          ],
    [flip, wholeCanvas],
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
    if (placement !== "screen") return;
    const el = rootRef.current;
    if (!el) return;
    // Still inside the menu click's (or the F key's) user activation, so the
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
  }, [placement, exit]);

  const stageBox = (
    /* The stage box: the element handed to the Fullscreen API, and the
       positioning context the chrome pins to (so it is inside the fullscreened
       subtree and stays visible there). */
    <PresentBox boxRef={rootRef}>
      {/* Exit goes top-LEFT, beside the tag, when we only cover the surface:
          the app's own floating chrome (the global action bar) sits at the
          top-right and is portaled above us. Covering the viewport puts it
          underneath, so the top-right corner is free again. */}
      {wholeCanvas ? (
        <CanvasStage exit={<ExitButton onExit={exit} />} />
      ) : (
        <PresentStage
          name={name}
          frameId={shown}
          exit={{
            onExit: exit,
            side: placement === "surface" ? "left" : "right",
          }}
          onExtend={extend}
        />
      )}
    </PresentBox>
  );

  // `aria-modal` only where it is true: covering the viewport really does make
  // everything else unreachable, but the surface placement deliberately leaves
  // the tab bar and rail clickable — claiming modality there would tell a screen
  // reader to hide chrome the user can still use.
  return placement === "surface" ? (
    <SurfaceOverlay role="dialog" aria-label="Prototype presentation">
      {stageBox}
    </SurfaceOverlay>
  ) : (
    <ViewportOverlay
      layer="max"
      role="dialog"
      aria-modal="true"
      aria-label="Prototype presentation"
    >
      {stageBox}
    </ViewportOverlay>
  );
}
