import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import { useConfigLink } from "../internal/use-config-link";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const settingsIcon = symbol("settings");

export interface ConfigGearButtonProps {
  descriptor: ConfigDescriptor;
  label?: string;
}

// Reusable "configure this" affordance: a compact gear that opens the given
// config descriptor's settings section. Drop in next to any surface backed by
// config_v2 (chips, popover headers, expanded panels).
export function ConfigGearButton({ descriptor, label }: ConfigGearButtonProps) {
  const configLink = useConfigLink();
  return (
    <ControlSizeProvider size="sm">
      <IconButton
        icon={settingsIcon}
        label={label ?? "Open settings"}
        // Isolated: the gear sits inside picker chrome (a select's header, a
        // chip) whose own click must not also fire.
        {...activationProps(configLink(descriptor), { isolate: true })}
      />
    </ControlSizeProvider>
  );
}
