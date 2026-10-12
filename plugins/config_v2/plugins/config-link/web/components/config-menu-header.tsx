import { SectionLabel } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import { ConfigGearButton } from "./config-gear-button";

export interface ConfigMenuHeaderProps {
  label?: string;
  descriptor: ConfigDescriptor;
}

// The menu twin of ConfigPopoverHeader: a header row for a config-backed
// Select / DropdownMenu, with an optional section label (the menu label, as
// SectionLabel draws inside any menu surface) and a trailing gear that
// jumps to the backing config. Lives inside the menu chrome so the "configure"
// affordance can't be forgotten. The flexible spacer cell absorbs the row slack
// so the gear stays pinned right even when there is no label.
export function ConfigMenuHeader({ label, descriptor }: ConfigMenuHeaderProps) {
  return (
    <Stack direction="row" gap="sm" align="center">
      <Fill>{label ? <SectionLabel>{label}</SectionLabel> : null}</Fill>
      <Stack direction="row" gap="sm" align="center" className={rigidClass()}>
        <ConfigGearButton
          descriptor={descriptor}
          label={label ? `Configure: ${label}` : undefined}
        />
      </Stack>
    </Stack>
  );
}
