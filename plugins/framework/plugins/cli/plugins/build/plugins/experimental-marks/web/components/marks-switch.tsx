import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { experimentalMarksConfig } from "../../core";
import { isExperimentalBuild } from "../use-show-experimental-marks";

const scienceIcon = symbol("science");

/** The switch, as a row of the view-options popover; only on an experimental build. */
export function ExperimentalMarksSwitch() {
  const { showExperimentalMarks } = useConfig(experimentalMarksConfig);
  const set = useSetConfig(experimentalMarksConfig);
  if (!isExperimentalBuild()) return null;
  return (
    <ControlPanel.Row
      icon={<Icon icon={scienceIcon} />}
      select="switch"
      checked={showExperimentalMarks}
      onSelect={() => set("showExperimentalMarks", !showExperimentalMarks)}
    >
      Show experimental marks
    </ControlPanel.Row>
  );
}
