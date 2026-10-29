import { PickerPill } from "@plugins/primitives/plugins/text-editor/plugins/composer/plugins/picker-pill/web";
import type { LaunchControlProps } from "@plugins/tasks/plugins/launch-options/web";

export const INTERACTIVE_LABEL = "Interactive";
export const SUPERVISOR_LABEL = "Supervisor";

/** The pill's text once Supervisor is picked. Never rendered for Interactive. */
export function SupervisorPillValue(_: { value: true }) {
  return <>{SUPERVISOR_LABEL}</>;
}

/** The menu rows: Interactive, Supervisor. */
export function SupervisorPillMenu({
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
        {SUPERVISOR_LABEL}
      </PickerPill.Item>
    </>
  );
}
