/**
 * ViewOptionsToggle — the shared display-options popover button, contributed to
 * the `Sonata.Hud` cluster so it appears in EVERY display lens (piano roll,
 * notation, songsheet) rather than being mounted by one display.
 *
 * Lists every `Sonata.ViewOption` contribution: each hands a config_v2
 * descriptor (optionally a `fields` subset), and the host renders those fields
 * generically through the shared `FieldRenderer` — the same control the Settings
 * config pane uses. Collection-consumer clean: only generic slot fields are
 * read, so any plugin surfacing a new display option auto-appears here with zero
 * edits.
 *
 * EVERY CONTRIBUTED FIELD IS A MEMBER OF THE ONE PANEL, and this file draws no
 * band around any of them. A field renderer now declares its shape and the
 * shared shape view maps that onto the vocabulary — so the view already decides
 * which fields are a band, which are a bare row, and where a description goes. A
 * `Section` per contribution on top of that banded a choice field twice: the
 * view makes a choice its own band (its rows ARE its options), and a wrapper
 * band around it drew a second hairline around the first.
 *
 * Each contribution is its own component (`ViewOptionGroup`) so the per-config
 * `useConfig`/`useSetConfig` hooks stay stable per component — the contribution
 * list length never changes a component's hook count.
 *
 * The trigger is a ToggleChip styled to match the HUD chip aesthetic (the
 * key-chip pill: translucent background + backdrop blur). The HUD cluster is
 * pointer-events-none, so the wrapper re-enables pointer events locally.
 */
import { useState } from "react";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import { FieldRenderer } from "@plugins/config_v2/plugins/fields/web";
import { ControlPanelPopover } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { usePlayerView } from "@plugins/apps/plugins/sonata/plugins/player/web";
import { Sonata } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const tuneIcon = symbol("tune");

type ViewOptionItem = ReturnType<
  typeof Sonata.ViewOption.useContributions
>[number];

export function ViewOptionsToggle() {
  const hasOptions = useHasViewOptions();
  const [open, setOpen] = useState(false);
  if (!hasOptions) return null;

  return (
    // The HUD may sit INSIDE a display's drag-to-scrub surface (e.g. the piano
    // roll), whose pointerdown handler takes pointer capture (useInertialDrag) —
    // capture retargets the gesture to the lane and suppresses the button's
    // `click`, so the popover would never open (and a press would grab the
    // scrubber). The shared HUD cluster is also pointer-events-none. Re-enable
    // pointer events and stop pointerdown here so a press on the button is a
    // button press, not a drag.
    <div
      className="pointer-events-auto"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <ControlPanelPopover
        open={open}
        onOpenChange={setOpen}
        align="end"
        side="bottom"
        // A list of display choices — the `menu` role. The panel owns its inset,
        // so nothing here pads itself.
        label="Display options"
        trigger={
          <ToggleChip
            active={open}
            icon={<Icon icon={tuneIcon} />}
            aria-label="Display options"
            // `ControlPanelPopover` has no tooltip prop (the trigger owns its
            // own), and a ToggleChip carries none — so the hover hint is the
            // native one.
            tooltip="Display options"
            className={cn(
              // Match the HUD pill look (key-chip): translucent + blurred.
              !open && "bg-background/90 shadow-sm backdrop-blur-sm",
            )}
          >
            View
          </ToggleChip>
        }
      >
        <ViewOptionsPanel />
      </ControlPanelPopover>
    </div>
  );
}

/** Whether the lens on screen has any view option or view section to show. */
export function useHasViewOptions(): boolean {
  const options = Sonata.ViewOption.useContributions();
  const sections = Sonata.ViewSection.useContributions();
  const { displayId } = usePlayerView();
  return (
    options.some((o) => inLens(o.displays, displayId)) ||
    sections.some((s) => inLens(s.displays, displayId))
  );
}

/**
 * The View options panel's members for the lens on screen: every
 * `Sonata.ViewOption` field scoped to it (or global), then every
 * `Sonata.ViewSection` block scoped to it. Members only — the caller's
 * `ControlPanelPopover` is the surface. Shared by the HUD chip above and any
 * host that opens the same panel from its own trigger (the player toolbar's
 * display switcher).
 */
export function ViewOptionsPanel() {
  const options = Sonata.ViewOption.useContributions();
  const sections = Sonata.ViewSection.useContributions();
  // Scope options to the active lens: show only the current display's options
  // plus globals, so e.g. Notation never surfaces piano-roll-only key controls.
  // Read the *effective* display (the lens actually on screen), not the raw
  // explicit pick — the latter is null until the user clicks the picker, which
  // would hide every lens-scoped option on first load even though a lens is up.
  const { displayId } = usePlayerView();
  return (
    <>
      {options
        .filter((o) => inLens(o.displays, displayId))
        .map((o) => (
          <ViewOptionGroup key={o.id} option={o} />
        ))}
      {sections
        .filter((s) => inLens(s.displays, displayId))
        .map((s) =>
          renderIsolated(Sonata.ViewSection, s as unknown as Contribution, {}),
        )}
    </>
  );
}

function inLens(displays: string[] | "global", displayId: string | null) {
  return (
    displays === "global" || (displayId != null && displays.includes(displayId))
  );
}

/**
 * One contribution's fields, as members of the panel around them — a fragment,
 * never a wrapper, so the panel lays each field out and separates it exactly as
 * if this component were not here.
 */
function ViewOptionGroup({ option }: { option: ViewOptionItem }) {
  const values = useConfig(option.config) as Record<string, unknown>;
  const setConfig = useSetConfig(option.config);
  const keys = option.fields ?? Object.keys(option.config.fields);

  return (
    <>
      {keys.map((key) => {
        const field = option.config.fields[key];
        if (!field) return null;
        return (
          <FieldRenderer
            key={key}
            field={field}
            value={values[key]}
            onChange={(v) => setConfig(key, v)}
          />
        );
      })}
    </>
  );
}
