import type { ReactElement } from "react";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { usePrototypeDetail } from "../context";
import type { FrameActionRow } from "../slots";
import { symbol } from "@plugins/ui/plugins/icons/core";

const closeIcon = symbol("close");
const cropSquareIcon = symbol("crop-square");

// The canvas's own frame actions, contributed to `PrototypeFrameActions` like
// any other plugin's (Present adds its menu the same way). Keep only and Close
// show only with more than one frame: the canvas never goes empty.

/** Close every other frame — with an Undo toast. */
export function KeepOnlyFrameAction({
  row,
}: ItemActionProps<FrameActionRow>): ReactElement | null {
  const { canvas, keepOnly } = usePrototypeDetail();
  if (canvas.frames.length < 2) return null;
  return (
    <IconButton
      icon={cropSquareIcon}
      label="Keep only this frame — close the others"
      onClick={() => keepOnly(row.frame.id)}
    />
  );
}

/** Take this frame off the canvas. */
export function CloseFrameAction({
  row,
}: ItemActionProps<FrameActionRow>): ReactElement | null {
  const { canvas, dispatch } = usePrototypeDetail();
  if (canvas.frames.length < 2) return null;
  return (
    <IconButton
      icon={closeIcon}
      label="Remove from canvas"
      onClick={() => dispatch({ type: "remove", id: row.frame.id })}
    />
  );
}
