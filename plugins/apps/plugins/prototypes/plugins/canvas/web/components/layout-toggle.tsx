import type { ReactElement } from "react";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  layoutToggleLabel,
  type CanvasLayout,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/core";
import { usePrototypeDetail } from "../context";
import { railButtonClass } from "../internal/rail-button";

const ICONS = {
  swipe: symbol("swipe"),
  side: symbol("view-column-2"),
} as const;

/**
 * The switch between the two layouts of a two-frame canvas, drawn ON the
 * canvas rather than in the header — a glass button of the add rail's family
 * (`railButtonClass`), so it reads as the canvas's own chrome:
 * side by side it sits in the gap between the two frames and swipes them; swiped
 * it sits on the divider and puts them back side by side. Placed by the caller.
 */
export function LayoutToggle({ to }: { to: CanvasLayout }): ReactElement {
  const { dispatch } = usePrototypeDetail();
  return (
    <ControlSizeProvider size="sm">
      <IconButton
        variant="floating"
        className={railButtonClass}
        icon={ICONS[to]}
        label={layoutToggleLabel(to)}
        onClick={() => dispatch({ type: "setLayout", layout: to })}
      />
    </ControlSizeProvider>
  );
}
