import type { ReactElement, ReactNode } from "react";
import {
  Button,
  Separator,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Kbd } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { isAtScale } from "@plugins/primitives/plugins/overlay/plugins/image-viewer/core";
import type { CompareZoom } from "./zoomed-compare";
import { canZoomIn, canZoomOut, isAtFit } from "./zoom-model";

const addIcon = symbol("add");
const removeIcon = symbol("remove");
const fitWidthIcon = symbol("fit-page-width");
const fitHeightIcon = symbol("fit-page-height");

function withKey(label: string, key: string): ReactNode {
  return (
    <>
      {label} <Kbd>{key}</Kbd>
    </>
  );
}

/**
 * `− 62% + | Fit width · Fit height · 1:1` — the image viewer's zoom group,
 * for a zoomable comparison: the same steps, readout and actual size, with fit
 * split by axis (a tall page reads at its width, a wide one at its height).
 * The pressed button says which fit the view is at.
 */
export function CompareZoomControls({
  zoom,
}: {
  zoom: CompareZoom;
}): ReactElement {
  const { state, dispatch } = zoom;
  const percent = Math.round(state.view.scale * 100);
  const known = state.viewport !== null;
  return (
    <Inline gap="2xs" align="center">
      <IconButton
        icon={removeIcon}
        label="Zoom out"
        tooltip={withKey("Zoom out", "−")}
        disabled={!canZoomOut(state)}
        onClick={() => dispatch({ type: "step", dir: -1 })}
      />
      <Text variant="label" className="w-12 text-center tabular-nums">
        {known ? `${String(percent)}%` : "—"}
      </Text>
      <IconButton
        icon={addIcon}
        label="Zoom in"
        tooltip={withKey("Zoom in · or scroll", "+")}
        disabled={!known || !canZoomIn(state)}
        onClick={() => dispatch({ type: "step", dir: 1 })}
      />
      <Separator orientation="vertical" className="h-4" />
      <IconButton
        icon={fitWidthIcon}
        label="Fit width"
        tooltip={withKey("Fit width", "W")}
        aria-pressed={isAtFit(state, "width")}
        className="aria-pressed:bg-hover-fill"
        onClick={() => dispatch({ type: "fit", fit: "width" })}
      />
      <IconButton
        icon={fitHeightIcon}
        label="Fit height"
        tooltip={withKey("Fit height", "H")}
        aria-pressed={isAtFit(state, "height")}
        className="aria-pressed:bg-hover-fill"
        onClick={() => dispatch({ type: "fit", fit: "height" })}
      />
      <Button
        tooltip={withKey("Actual size", "1")}
        variant="ghost"
        aria-pressed={known && isAtScale(state.view, 1)}
        className="tabular-nums aria-pressed:bg-hover-fill"
        onClick={() => dispatch({ type: "actual-size" })}
      >
        1:1
      </Button>
    </Inline>
  );
}
