/**
 * FxToggle — the host-owned FX popover button in the lane's HUD cluster.
 *
 * Lists every PianoRollFx contribution grouped by tier ("Ambient" first —
 * the always-tasteful defaults — then the opt-in "Fancy" spectacle), each a
 * control-panel row whose switch is wired to the effect's own `{ enabled }`
 * config via useConfig/useSetConfig. Collection-consumer clean: only generic
 * slot fields are read, so every new fx plugin auto-appears here with zero edits.
 *
 * Each row is its own component so the config hooks stay stable per component
 * (the contribution list length never changes a component's hook count).
 *
 * The trigger is a ToggleChip styled to match the HUD chip aesthetic (the
 * key-chip pill: translucent background + backdrop blur). The HUD cluster is
 * pointer-events-none, so the wrapper re-enables pointer events locally.
 */
import { useState } from "react";
import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import {
  ControlPanel,
  ControlPanelPopover,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { PianoRollFx } from "../slots";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const autoAwesomeIcon = symbol("auto-awesome");

type FxItem = ReturnType<typeof PianoRollFx.useContributions>[number];

export function FxToggle() {
  const effects = PianoRollFx.useContributions();
  const [open, setOpen] = useState(false);
  if (effects.length === 0) return null;

  const ambient = effects.filter((e) => e.tier === "ambient");
  const fancy = effects.filter((e) => e.tier === "fancy");

  return (
    // The HUD sits INSIDE the lane's drag-to-scrub surface, whose pointerdown
    // handler takes pointer capture (useInertialDrag) — capture retargets the
    // gesture to the lane and suppresses the button's `click`, so the popover
    // would never open (and a press would grab the scrubber). Stop pointer
    // events here so a press on the FX button is a button press, not a drag.
    <div
      className="pointer-events-auto"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <ControlPanelPopover
        open={open}
        onOpenChange={setOpen}
        align="end"
        side="bottom"
        // A list of on/off choices — the `menu` role. The panel owns its own
        // inset and the hairline between the two tiers; this file draws neither.
        label="Visual effects"
        trigger={
          <ToggleChip
            active={open}
            icon={<Icon icon={autoAwesomeIcon} />}
            aria-label="Visual effects"
            // `ControlPanelPopover` has no tooltip prop (the trigger owns its
            // own), and a ToggleChip carries none — so the hover hint is the
            // native one.
            tooltip="Visual effects"
            className={cn(
              // Match the HUD pill look (key-chip): translucent + blurred.
              !open && "bg-background/90 shadow-sm backdrop-blur-sm",
            )}
          >
            FX
          </ToggleChip>
        }
      >
        {ambient.length > 0 ? (
          <FxTierSection label="Ambient" effects={ambient} />
        ) : null}
        {fancy.length > 0 ? (
          <FxTierSection label="Fancy" effects={fancy} />
        ) : null}
      </ControlPanelPopover>
    </div>
  );
}

function FxTierSection({
  label,
  effects,
}: {
  label: string;
  effects: FxItem[];
}) {
  return (
    <ControlPanel.Section label={label}>
      {effects.map((e) => (
        <FxToggleRow key={e.id} effect={e} />
      ))}
    </ControlPanel.Section>
  );
}

function FxToggleRow({ effect }: { effect: FxItem }) {
  const { enabled } = useConfig(effect.config);
  const setConfig = useSetConfig(effect.config);
  const icon = effect.icon;
  return (
    // `select="switch"` IS the row's on/off language — the switch owns the
    // trailing cell and the row itself is the control, so the hand-rolled track
    // and knob (two nested spans) are gone. The effect's glyph takes the `icon`
    // slot: a switch row's leading cell is free (its indicator is trailing),
    // which is why the row type lets THAT selection language carry one.
    <ControlPanel.Row
      select="switch"
      checked={enabled}
      icon={icon ? <Icon icon={icon} /> : undefined}
      onSelect={() => setConfig("enabled", !enabled)}
    >
      {effect.label}
    </ControlPanel.Row>
  );
}
