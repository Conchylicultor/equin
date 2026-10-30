import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { ActionBar } from "@plugins/shell/plugins/action-bar/web";
import { ExperimentalMarksHost } from "./components/marks-host";
import { ExperimentalMarksSwitch } from "./components/marks-switch";
import { experimentalMarksConfig } from "../core";

export { useShowExperimentalMarks } from "./use-show-experimental-marks";

export default {
  description:
    "The Show experimental marks setting (view-options popover and Settings → Config, on an experimental build): useShowExperimentalMarks() is true when the build stamped this document experimental and the marks are on; the frame and the Wish banner both follow it.",
  contributions: [
    ConfigV2.WebRegister({ descriptor: experimentalMarksConfig }),
    Core.Root({ component: ExperimentalMarksHost }),
    ActionBar.ViewOption({
      id: "experimental-marks",
      component: ExperimentalMarksSwitch,
    }),
  ],
} satisfies PluginDefinition;
