import { useState } from "react";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { ControlPanelPopover } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import {
  useHasViewOptions,
  ViewOptionsPanel,
} from "@plugins/apps/plugins/sonata/plugins/view-options/web";
import { usePaneStore } from "@plugins/primitives/plugins/pane/web";
import {
  SonataPlayer,
  usePlayerView,
} from "@plugins/apps/plugins/sonata/plugins/player/web";

/**
 * The player header's own controls: the way back (the header band's own
 * identity, beside the title) and the display switcher (a
 * `sonataPlayerPane.Actions` contribution, in the toolbar pill). Each is a
 * self-contained, zero-prop component that reads the display state from
 * `usePlayerView()` and the display registry from `SonataPlayer.Display`.
 */

const arrowBackIcon = symbol("arrow-back");
const displayIcon = symbol("visibility");
const chevronIcon = symbol("keyboard-arrow-down");

/** Back to Library — clears the route back to the library index pane. */
export function BackToLibrary() {
  const store = usePaneStore();
  return (
    <IconButton
      icon={arrowBackIcon}
      label="Back to Library"
      onClick={() => store.clearRoute()}
    />
  );
}

/**
 * Display switcher: one button per `SonataPlayer.Display` contribution. The
 * lens on screen is a filled chip naming itself, with a chevron: clicking it
 * opens that lens's View options (`ViewOptionsPanel` — its config fields and
 * view sections). Every other lens is an icon (its label as tooltip and
 * accessible name); clicking one switches to it. Collection-consumer clean —
 * enumerates the dispatch slot's metadata, never naming a contributor.
 *
 * A plain row, with no bar of its own: this component IS one occupant of the
 * toolbar pill.
 */
export function DisplayPicker() {
  const { displayId, setDisplay } = usePlayerView();
  const displays = SonataPlayer.Display.useContributions();
  if (displays.length === 0) {
    return (
      <Text variant="caption" tone="muted">
        No displays
      </Text>
    );
  }
  return (
    <Line role="radiogroup" aria-label="Display" className="gap-2xs">
      {displays.map((d) =>
        d.id === displayId ? (
          <ActiveDisplay key={d.id} label={d.label} icon={d.icon} />
        ) : (
          <IconButton
            key={d.id}
            role="radio"
            aria-checked={false}
            icon={d.icon ?? displayIcon}
            label={d.label}
            onClick={() => setDisplay(d.id)}
          />
        ),
      )}
    </Line>
  );
}

/** The lens on screen: its name, and the way into its View options. */
function ActiveDisplay({ label, icon }: { label: string; icon?: IconRef }) {
  const [open, setOpen] = useState(false);
  const hasOptions = useHasViewOptions();
  const chip = (
    <Button
      role="radio"
      aria-checked
      variant="ghost"
      className="bg-foreground text-background hover:bg-foreground/90 hover:text-background aria-expanded:bg-foreground/90 aria-expanded:text-background"
      tooltip={hasOptions ? `${label} — view options` : label}
    >
      <Icon icon={icon ?? displayIcon} />
      {label}
      {hasOptions ? (
        <Icon icon={chevronIcon} className="size-3.5 opacity-60" />
      ) : null}
    </Button>
  );
  if (!hasOptions) return chip;
  return (
    <ControlPanelPopover
      open={open}
      onOpenChange={setOpen}
      align="center"
      side="bottom"
      label={`${label} view options`}
      trigger={chip}
    >
      <ViewOptionsPanel />
    </ControlPanelPopover>
  );
}
