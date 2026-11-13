import { useMemo, type ReactElement } from "react";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useSurfaceShortcuts } from "@plugins/primitives/plugins/shortcuts/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { usePrototypeDetail } from "../context";
import type { FrameActionRow } from "../slots";
import { symbol } from "@plugins/ui/plugins/icons/core";

const closeIcon = symbol("close");
const cropSquareIcon = symbol("crop-square");
const restartIcon = symbol("restart-alt");

// The canvas's own frame actions, contributed to `PrototypeFrameActions` like
// any other plugin's (Present adds its menu the same way). Keep only and Close
// show only with more than one frame: the canvas never goes empty.

/**
 * Start the prototype over: its storage emptied and its page reloaded, so
 * whatever the reader did in it (clicks, typed values, saved state) is gone.
 * A prototype frame only — a source frame is not a document of ours. The
 * button of the SELECTED frame also owns the `R` key.
 */
export function RestartFrameAction({
  row,
}: ItemActionProps<FrameActionRow>): ReactElement | null {
  const { frame } = row;
  const { canvas, dispatch, restart } = usePrototypeDetail();
  const onRestart = useEventCallback(() => {
    dispatch({ type: "select", id: frame.id });
    restart(frame.id);
  });
  const holdsR = frame.kind === "prototype" && canvas.selected === frame.id;
  const restartKey = useMemo(
    () =>
      holdsR
        ? [
            {
              id: "prototypes.restart-frame",
              keys: "r",
              label: "Restart the selected frame from its initial state",
              group: "Prototypes",
              handler: onRestart,
            },
          ]
        : [],
    [holdsR, onRestart],
  );
  useSurfaceShortcuts(restartKey);
  if (frame.kind !== "prototype") return null;
  return (
    <IconButton
      icon={restartIcon}
      label="Restart"
      tooltip="Restart from its initial state"
      shortcut="r"
      onClick={onRestart}
    />
  );
}

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
