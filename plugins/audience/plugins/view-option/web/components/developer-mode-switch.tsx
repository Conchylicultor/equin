import { useAudience, useSetDeveloperMode } from "@plugins/audience/web";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { developerSymbol } from "@plugins/audience/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

/** The Developer mode switch, as a row of the view-options popover. */
export function DeveloperModeSwitch() {
  const audience = useAudience();
  const setDeveloperMode = useSetDeveloperMode();
  // The popover's error boundary shows it: the switch cannot claim a state.
  if (audience.status === "error") throw audience.error;
  if (audience.status === "loading") return <Loading variant="rows" />;
  const developer = audience.data === "developer";
  return (
    <ControlPanel.Row
      icon={<Icon icon={developerSymbol} />}
      select="switch"
      checked={developer}
      onSelect={() => setDeveloperMode(!developer)}
    >
      Developer mode
    </ControlPanel.Row>
  );
}
