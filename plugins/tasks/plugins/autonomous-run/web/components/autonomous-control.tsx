import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { LaunchControlProps } from "@plugins/tasks/plugins/launch-options/web";
import { AUTONOMOUS_LABEL, INTERACTIVE_LABEL } from "./autonomous-pill";

const INTERACTIVE = "interactive";
const AUTONOMOUS = "autonomous";

/** One select: Interactive or Autonomous. */
export function AutonomousLaunchControl({
  value,
  onChange,
  disabled,
}: LaunchControlProps<true | null>) {
  return (
    <Select
      // base-ui resolves the collapsed trigger label from `items`.
      items={{
        [INTERACTIVE]: INTERACTIVE_LABEL,
        [AUTONOMOUS]: AUTONOMOUS_LABEL,
      }}
      value={value ? AUTONOMOUS : INTERACTIVE}
      onValueChange={(v: string | null) => {
        if (v) onChange(v === AUTONOMOUS ? true : null);
      }}
      disabled={disabled}
    >
      <SelectTrigger aria-label="Run mode">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={INTERACTIVE}>{INTERACTIVE_LABEL}</SelectItem>
        <SelectItem value={AUTONOMOUS}>{AUTONOMOUS_LABEL}</SelectItem>
      </SelectContent>
    </Select>
  );
}
