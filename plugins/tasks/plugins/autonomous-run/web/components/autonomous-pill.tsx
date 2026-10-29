import { PickerPill } from "@plugins/primitives/plugins/text-editor/plugins/composer/plugins/picker-pill/web";
import type { LaunchControlProps } from "@plugins/tasks/plugins/launch-options/web";

export const INTERACTIVE_LABEL = "Interactive";
export const AUTONOMOUS_LABEL = "Autonomous";

/** The pill's text once a run is picked. Never rendered for Interactive. */
export function AutonomousPillValue(_: { value: true }) {
  return <>{AUTONOMOUS_LABEL}</>;
}

/** The menu rows: Interactive, Autonomous. */
export function AutonomousPillMenu({
  value,
  onChange,
  disabled,
}: LaunchControlProps<true | null>) {
  return (
    <>
      <PickerPill.Item
        selected={value == null}
        onSelect={() => onChange(null)}
        disabled={disabled}
      >
        {INTERACTIVE_LABEL}
      </PickerPill.Item>
      <PickerPill.Item
        selected={value === true}
        onSelect={() => onChange(true)}
        disabled={disabled}
      >
        {AUTONOMOUS_LABEL}
      </PickerPill.Item>
    </>
  );
}
