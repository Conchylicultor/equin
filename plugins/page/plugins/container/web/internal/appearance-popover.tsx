import { useState, type ReactNode } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  type PopoverWidth,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ControlPanelPopover } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import type { BlockEditorAPI } from "@plugins/page/plugins/editor/web";

/**
 * A container's per-instance APPEARANCE controls, and the two props that only
 * exist to present them. They travel together on purpose: a container with
 * nothing to configure (the context card, whose payload is `{}`) has no popover,
 * and therefore no trigger to give an accessible name to and no width to choose.
 * Making them one member of a union rather than three independent optionals is
 * what makes "a decoration with no appearance, but a trigger label"
 * unrepresentable.
 *
 * Shared by BOTH decoration seats — the gutter glyph and the corner label — so
 * "what a container may hang off its decoration" has one definition and the two
 * seats cannot drift into different contracts.
 */
export type ContainerAppearanceSections =
  | {
      /**
       * Rendered inside the decoration's popover, handed the (definitely
       * present) block API and a `close()` so a committing control can dismiss
       * the popover the shell owns.
       *
       * The SAME component should also be registered as the container's
       * `BlockFrameMeta.menu`, so appearance is reachable from the rail's block
       * actions too. That duplication is deliberate, not an oversight: the rail
       * is where a user looks for block actions, the decoration is where they
       * look for the decoration.
       */
      sections: (ctx: {
        editor: BlockEditorAPI;
        close: () => void;
      }) => ReactNode;
      /** The trigger's accessible name, e.g. `"Callout icon and color"`. */
      triggerLabel: string;
      /** Popover width role. Defaults to `"sm"`. */
      width?: PopoverWidth;
      panel?: never;
    }
  | {
      /**
       * The same sections, when they are built from the CONTROL-PANEL
       * vocabulary (`ControlPanel.Section` / `.Row` / …). Those members need a
       * `cp-panel` ancestor to inherit their inset and hang their hairlines
       * from, and the panel body owns its own padding — so this arm opens a
       * `ControlPanelPopover` instead of a raw padded `PopoverContent`. It
       * carries no width: a panel is as wide as its content declares
       * (`ControlPanel.Section needs`).
       *
       * Mutually exclusive with `width` by type: a panel has no width to pick.
       */
      sections: (ctx: {
        editor: BlockEditorAPI;
        close: () => void;
      }) => ReactNode;
      triggerLabel: string;
      panel: true;
      width?: never;
    };

/**
 * The third arm on its own: a decoration with nothing to configure, and so no
 * popover, no trigger name and no width. Split out from the union above because
 * a seat may want to attach something ELSE to the interactive arms only — the
 * corner label's `action`, which is a swap of the trigger's own text and would
 * be inert without a trigger.
 */
export type ContainerAppearanceNone = {
  sections?: never;
  triggerLabel?: never;
  width?: never;
  panel?: never;
};

export type ContainerAppearance =
  ContainerAppearanceSections | ContainerAppearanceNone;

/**
 * The interactive arm shared by both seats: the decoration as a popover trigger
 * over the container's own appearance controls.
 *
 * The trigger sits beside a live caret, so it `preventDefault`s its mousedown to
 * keep that caret put — the same shape `BlockActionsMenu` uses, for the same
 * reason. The popover's open state belongs here, so a control that commits and
 * should dismiss says so through the `close()` it is given rather than holding a
 * second copy of that state.
 *
 * The SEAT supplies what the trigger looks like (`trigger` + `triggerClass`);
 * everything else — the two popover flavours, the caret guard, the open state —
 * is the same whichever seat asked.
 */
export function ContainerAppearancePopover({
  editor,
  trigger,
  triggerClass,
  triggerLabel,
  width = "sm",
  panel,
  sections,
}: {
  editor: BlockEditorAPI;
  /** What the trigger renders — a centred glyph, or a name. */
  trigger: ReactNode;
  /** The trigger's own chrome, owned by the seat. */
  triggerClass: string;
  triggerLabel: string;
  width?: PopoverWidth;
  panel?: true;
  sections: (ctx: { editor: BlockEditorAPI; close: () => void }) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  // Panel-shaped sections open through the vocabulary's own surface: the body
  // brings its own inset and its bands draw their own hairlines, so a
  // `PopoverContent padding="sm"` around it would be a second padding role.
  if (panel) {
    return (
      <ControlPanelPopover
        open={open}
        onOpenChange={setOpen}
        label={triggerLabel}
        align="start"
        trigger={
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            className={triggerClass}
            aria-label={triggerLabel}
          >
            {trigger}
          </button>
        }
      >
        {sections({ editor, close })}
      </ControlPanelPopover>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        onMouseDown={(e) => e.preventDefault()}
        className={triggerClass}
        aria-label={triggerLabel}
      >
        {trigger}
      </PopoverTrigger>
      <PopoverContent width={width} padding="sm" align="start">
        {sections({ editor, close })}
      </PopoverContent>
    </Popover>
  );
}
