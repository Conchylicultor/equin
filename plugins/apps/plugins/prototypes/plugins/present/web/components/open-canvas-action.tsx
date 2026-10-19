import type { ReactElement } from "react";
import { NewTabButton } from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";
import { embedUrl } from "@plugins/primitives/plugins/embed/web";
import {
  encodeCanvas,
  usePrototypeDetail,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import { presentCanvasPath } from "../internal/routes";

/**
 * "Open the canvas in a new tab" — a header action: the canvas as it is now
 * (every frame with its version and picks, the size, zoom and layout) in a
 * chromeless new browser tab, so the frames get all of the screen to compare.
 */
export function OpenCanvasAction(): ReactElement {
  const { name, canvas } = usePrototypeDetail();
  return (
    <NewTabButton
      href={embedUrl(
        presentCanvasPath(name, encodeCanvas(canvas)),
        "chromeless",
      )}
      label="Open the canvas in a new tab"
    />
  );
}
