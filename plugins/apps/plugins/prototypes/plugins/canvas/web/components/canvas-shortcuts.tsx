import { useMemo, type ReactElement } from "react";
import { useSurfaceShortcuts } from "@plugins/primitives/plugins/shortcuts/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import {
  prototypeHistory,
  type PrototypeHistory,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { usePrototypeDetail } from "../context";
import {
  stepBy,
  versionForStep,
  versionSteps,
} from "../internal/version-steps";

/**
 * The canvas's keys, scoped to its surface (plain keys, so they stay silent
 * while a text field has focus):
 *
 * - `←` / `→` select the previous / next frame (wrapping around);
 * - `[` / `]` step the SELECTED frame's version;
 * - `0` toggles the zoom between 100% and Fit.
 *
 * Registered once for the canvas, not per frame: the selection says which
 * frame they act on.
 */
export function CanvasShortcuts(): ReactElement | null {
  const { name } = usePrototypeDetail();
  useSelectionKeys();
  const history = useLive(prototypeHistory, { name });
  // Until the history is known the keys are not registered — there is nowhere
  // to step yet. A failed read keeps stepping through the last history the
  // server vouched for, if any; the frame's own history surface shows the error.
  switch (history.status) {
    case "loading":
      return null;
    case "error":
      return history.stale === undefined ? null : (
        <KnownShortcuts history={history.stale} />
      );
    case "ready":
      return <KnownShortcuts history={history.data} />;
  }
}

function KnownShortcuts({
  history: known,
}: {
  history: PrototypeHistory;
}): null {
  const { canvas, dispatch } = usePrototypeDetail();

  const step = useEventCallback((delta: -1 | 1) => {
    const frame = canvas.frames.find((f) => f.id === canvas.selected);
    if (frame?.kind !== "prototype") return;
    const target = stepBy(
      versionSteps(known, frame.version?.sha ?? null),
      delta,
    );
    if (target) {
      dispatch({
        type: "setVersion",
        id: frame.id,
        version: versionForStep(target),
      });
    }
  });
  const toggleZoom = useEventCallback(() =>
    dispatch({ type: "setZoom", zoom: canvas.zoom === 1 ? "fit" : 1 }),
  );

  const shortcuts = useMemo(
    () => [
      {
        id: "prototypes.version-back",
        keys: "[",
        label: "Previous version of the selected frame",
        group: "Prototypes",
        handler: () => step(-1),
      },
      {
        id: "prototypes.version-forward",
        keys: "]",
        label: "Next version of the selected frame",
        group: "Prototypes",
        handler: () => step(1),
      },
      {
        id: "prototypes.zoom-toggle",
        keys: "0",
        label: "Toggle 100% / Fit",
        group: "Prototypes",
        handler: toggleZoom,
      },
    ],
    [step, toggleZoom],
  );
  useSurfaceShortcuts(shortcuts);
  return null;
}

/** `←` / `→`: select the previous / next frame — needs no history. */
function useSelectionKeys(): void {
  const { canvas, dispatch } = usePrototypeDetail();
  const move = useEventCallback((delta: -1 | 1) => {
    const n = canvas.frames.length;
    if (n < 2) return;
    const i = Math.max(
      0,
      canvas.frames.findIndex((f) => f.id === canvas.selected),
    );
    const next = canvas.frames[(i + delta + n) % n];
    if (next) dispatch({ type: "select", id: next.id });
  });
  const shortcuts = useMemo(
    () => [
      {
        id: "prototypes.select-previous",
        keys: "arrowleft",
        label: "Select the previous frame",
        group: "Prototypes",
        handler: () => move(-1),
      },
      {
        id: "prototypes.select-next",
        keys: "arrowright",
        label: "Select the next frame",
        group: "Prototypes",
        handler: () => move(1),
      },
    ],
    [move],
  );
  useSurfaceShortcuts(shortcuts);
}
