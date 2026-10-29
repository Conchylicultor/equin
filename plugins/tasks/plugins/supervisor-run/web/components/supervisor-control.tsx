import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { LaunchControlProps } from "@plugins/tasks/plugins/launch-options/web";
import { SUPERVISOR_LABEL, INTERACTIVE_LABEL } from "./supervisor-pill";

const INTERACTIVE = "interactive";
const SUPERVISOR = "supervisor";

/** One select: Interactive or Supervisor. */
export function SupervisorLaunchControl({
  value,
  onChange,
  disabled,
}: LaunchControlProps<true | null>) {
  return (
    <Select
      // base-ui resolves the collapsed trigger label from `items`.
      items={{
        [INTERACTIVE]: INTERACTIVE_LABEL,
        [SUPERVISOR]: SUPERVISOR_LABEL,
      }}
      value={value ? SUPERVISOR : INTERACTIVE}
      onValueChange={(v: string | null) => {
        if (v) onChange(v === SUPERVISOR ? true : null);
      }}
      disabled={disabled}
    >
      <SelectTrigger aria-label="Run mode">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={INTERACTIVE}>{INTERACTIVE_LABEL}</SelectItem>
        <SelectItem value={SUPERVISOR}>{SUPERVISOR_LABEL}</SelectItem>
      </SelectContent>
    </Select>
  );
}
