import type { ReactElement } from "react";
import {
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  IconButton,
  type IconButtonProps,
} from "@plugins/primitives/plugins/icon-button/web";

/**
 * One of the small actions after the prototype's name in the detail pane's
 * header card — facts about the prototype itself (copy its id, pin it, mark it
 * done), contributed to `prototypeDetailPane.Actions` by other plugins and
 * drawn alike: a compact icon button (the `xs` rung) a step quieter than the
 * card's own controls, the accent ink (`primaryText`) while `on` (pinned, done), and gone on a
 * narrow window, where the name keeps the room.
 */
export function TitleActionButton({
  on = false,
  ...props
}: Omit<IconButtonProps, "className" | "variant"> & {
  /** The toggle this button flips is on: drawn in the accent. */
  on?: boolean;
}): ReactElement {
  return (
    <ControlSizeProvider size="xs">
      <IconButton
        {...props}
        className={cn(
          "opacity-85 max-[900px]:hidden",
          on && "text-primary-text",
        )}
      />
    </ControlSizeProvider>
  );
}
