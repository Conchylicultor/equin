import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { useScope } from "./use-scope";

export function ScopeToggle() {
  const { singularityOnly, toggle } = useScope();
  return (
    <ToggleChip
      active={singularityOnly}
      onClick={toggle}
      tooltip={
        singularityOnly
          ? "equin sessions only — click to include all Claude Code sessions on this machine"
          : "Including all Claude Code sessions — click to filter to equin only"
      }
    >
      equin only
    </ToggleChip>
  );
}
