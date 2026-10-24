import type { ReactElement } from "react";
import { useAudience, useSetDeveloperMode } from "@plugins/audience/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import {
  ControlPanel,
  ControlPanelPane,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";

/** Who the user is: the Developer mode switch, and what it changes. */
export function ProfileSettings(): ReactElement {
  const audience = useAudience();
  const setDeveloperMode = useSetDeveloperMode();
  switch (audience.status) {
    case "loading":
      return <Loading variant="rows" />;
    case "error":
      return (
        <ResourceErrorInline
          variant="block"
          subject="Developer mode"
          error={audience.error}
          refetch={audience.refetch}
        />
      );
    case "ready":
      break;
  }
  const developer = audience.data === "developer";
  return (
    <ControlPanelPane label="Profile">
      <ControlPanel.Section
        label="Profile"
        description="How you use equin. Features meant for people building equin itself stay out of the way unless you are a developer."
      >
        <ControlPanel.Row
          select="switch"
          checked={developer}
          onSelect={() => setDeveloperMode(!developer)}
          description={
            developer
              ? "The developer apps (Studio, Debug, Deploy, …) appear in the app gallery and launchers."
              : "The developer apps stay out of the app gallery and launchers. They still open at their URL."
          }
        >
          Developer mode
        </ControlPanel.Row>
      </ControlPanel.Section>
    </ControlPanelPane>
  );
}
