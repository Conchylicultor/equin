import type { ReactElement } from "react";
import { useConfigResult, useSetConfig } from "@plugins/config_v2/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import {
  ControlPanel,
  ControlPanelPane,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { sidequestAutopilotConfig } from "../../shared/config";

/**
 * Whether the autopilot asks task-triage for a read of every new sidequest.
 * How a read runs — its model, prompt, concurrency and when it goes stale — is
 * task-triage's own config. Triage only proposes: the launch list's Approve is
 * the only way a sidequest may launch.
 */
export function TriageSection(): ReactElement {
  const config = useConfigResult(sidequestAutopilotConfig);
  const set = useSetConfig(sidequestAutopilotConfig);
  switch (config.status) {
    case "loading":
      return <Loading variant="rows" />;
    case "error":
      return (
        <ResourceErrorInline
          variant="block"
          subject="its triage settings"
          error={config.error}
          refetch={config.refetch}
        />
      );
    case "ready":
      break;
  }
  const { triage } = config.data;
  return (
    <ControlPanelPane label="Triage">
      <ControlPanel.Section
        label="Triage"
        description="A read-only agent reads each sidequest and proposes it in the launch list. It never approves anything. Its model, prompt, how many run at once and when a read goes stale are in Settings → Config → task-triage."
      >
        <ControlPanel.Row
          select="switch"
          checked={triage}
          onSelect={() => set("triage", !triage)}
          description={
            triage
              ? "Asks for a read of every sidequest that becomes ready, whether or not the autopilot is on."
              : "Asks for nothing new. Existing reads stay; a task's Triage card can still run one."
          }
        >
          Triage new sidequests automatically
        </ControlPanel.Row>
      </ControlPanel.Section>
    </ControlPanelPane>
  );
}
