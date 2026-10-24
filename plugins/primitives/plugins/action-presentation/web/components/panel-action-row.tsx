import { Icon } from "@plugins/ui/plugins/icons/web";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Kbd } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import { formatShortcutLabel } from "@plugins/primitives/plugins/shortcuts/web";
import type { MouseEventHandler } from "react";

export interface PanelActionRowProps {
  icon: IconRef;
  /** Draw the icon in its active form (the theme's active fill). */
  active?: boolean;
  /** The action's name — the visible row text here, the aria-label inline. */
  label: string;
  disabled?: boolean;
  /** Raw shortcut string (e.g. `"mod+k"`), formatted for display. */
  shortcut?: string;
  /**
   * Typed as a plain DOM handler so the SAME handler drops into either form:
   * React's event-handler types are bivariant, so an inline button's
   * `MouseEventHandler<HTMLButtonElement>` and this row's own element type are
   * mutually assignable.
   */
  onClick?: MouseEventHandler<HTMLElement>;
  /**
   * The rest of a link's gestures (`link-gesture`): a middle-click arrives as
   * an aux click, never a click, so a relocated link that dropped these would
   * go inert for it in the panel while working inline.
   */
  onAuxClick?: MouseEventHandler<HTMLElement>;
  onMouseDown?: MouseEventHandler<HTMLElement>;
}

/**
 * The renderer of the `"row"` rung: a labelled row in the overflow panel
 * instead of a ghost icon button. The twin of `IconButton`'s full form,
 * selected between by the region's answer to `useActionForm`, never by the call
 * site.
 *
 * **It renders standalone** — no menu, no popover, no context of any kind above
 * it — and that is the whole point. The panel that hosts relocated widgets is
 * always mounted (it holds their live DOM: a Web Audio volume control, a jog
 * wheel mid-drag), so it can never be a `DropdownMenuContent`, which unmounts
 * its children on close. It is a plain dialog, and `role="menu"` would be wrong
 * there anyway: a menu's roving tabindex and typeahead eat the arrow keys a
 * relocated `role="slider"` needs. The honest cost is that the panel has no
 * typeahead and no arrow-key roving — it is Tab + Enter + Esc.
 *
 * `Row` is the right primitive here for exactly that reason: it stamps **no
 * `role`**, so it cannot turn this into a `menuitem` — it is a plain
 * `<button type="button">` named by its `<Text>` child. (It also stamps no
 * `aria-current`, which needs `selected`, which this row never passes.)
 *
 * This row once composed `Line` and hand-copied `Row`'s chrome, because
 * `Row → row-actions → IconButton → action-presentation` was a cycle
 * `./equin check plugin-boundaries` rejects. That edge is gone:
 * `row-actions` shipped an `IconButton` alias whose deletion dropped `Row`
 * below `icon-button`. See
 * `research/2026-08-17-global-row-usable-below-icon-button.md`.
 */
export function PanelActionRow({
  icon,
  active,
  label,
  disabled,
  shortcut,
  onClick,
  onAuxClick,
  onMouseDown,
}: PanelActionRowProps) {
  return (
    <Row
      icon={<Icon icon={icon} active={active} />}
      onClick={onClick}
      onAuxClick={onAuxClick}
      onMouseDown={onMouseDown}
      // `disabled` drives `Row`'s element inference as much as `onClick` does:
      // with BOTH undefined `Row` infers a non-interactive `<div>`, and both
      // are optional here. `?? false` pins the inference, so this is always a
      // real, keyboard-activatable `<button>` — there is nothing above it in
      // the panel to supply activation.
      disabled={disabled ?? false}
    >
      {/* The one flexible cell: the label absorbs the slack and ellipsizes, so a
          long action name cannot push the shortcut out of the panel. */}
      <Fill>
        <Text>{label}</Text>
      </Fill>
      {shortcut ? <Kbd>{formatShortcutLabel(shortcut)}</Kbd> : null}
    </Row>
  );
}
