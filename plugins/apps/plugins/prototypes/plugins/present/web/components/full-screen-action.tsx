import { useMemo, type ReactElement } from "react";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useSurfaceShortcuts } from "@plugins/primitives/plugins/shortcuts/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import {
  usePrototypeDetail,
  type FrameActionRow,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { usePresentation } from "./presentation";

const fullscreenIcon = symbol("fullscreen");

/**
 * "Full screen" — a frame action (`PrototypeFrameActions`) on each canvas
 * frame: presents the frame alone, handed to the browser's Fullscreen API.
 *
 * The button of the SELECTED frame also owns the `F` key, so `F` presents the
 * selected frame.
 */
export function FullScreenAction({
  row,
}: ItemActionProps<FrameActionRow>): ReactElement {
  const { frame } = row;
  const { canvas, dispatch } = usePrototypeDetail();
  const { presenting, present: open } = usePresentation();
  // Presenting selects the frame, as clicking it would — so while this frame
  // is on show, this button is the one holding `F` (and it stands down, below).
  const present = useEventCallback(() => {
    dispatch({ type: "select", id: frame.id });
    open(frame.id);
  });

  const holdsF = canvas.selected === frame.id && presenting === null;
  const fullScreenKey = useMemo(
    () =>
      holdsF
        ? [
            {
              id: "prototypes.present-full-screen",
              keys: "f",
              label: "Present the selected frame in full screen",
              group: "Prototypes",
              handler: present,
            },
          ]
        : [],
    [holdsF, present],
  );
  useSurfaceShortcuts(fullScreenKey);

  return (
    <IconButton
      icon={fullscreenIcon}
      label="Full screen"
      shortcut="f"
      onClick={present}
    />
  );
}
