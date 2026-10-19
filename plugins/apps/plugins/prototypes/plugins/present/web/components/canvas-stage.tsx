import type { ReactElement } from "react";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Movable } from "@plugins/primitives/plugins/dom/plugins/movable/web";
import { PrototypeCanvas } from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import { usePresentChrome, usePresentRoot } from "./present-box";

/**
 * The whole canvas presented — the canvas page, and an overlay once `+` or
 * Compare turned its one frame into a comparison: the canvas's own body (every
 * frame with its options pill, version stepper and actions, the size & zoom
 * chip) with the presentation's way out pinned bottom-left, revealed on hover
 * like the rest of a presentation's chrome. Drawn inside a `PresentBox`.
 */
export function CanvasStage({ exit }: { exit: ReactElement }): ReactElement {
  const chrome = usePresentChrome();
  const root = usePresentRoot();
  return (
    <>
      <PrototypeCanvas />
      <Pin to="bottom-left" offset="md" {...chrome}>
        <Movable bounds={root}>{exit}</Movable>
      </Pin>
    </>
  );
}
