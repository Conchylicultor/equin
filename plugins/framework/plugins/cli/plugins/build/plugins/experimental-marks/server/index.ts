import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  ConfigV2,
  getConfig,
  onConfigDirChange,
} from "@plugins/config_v2/server";
import { DocumentHead } from "@plugins/shell/plugins/document-head/server";
import { MARKS_OFF_CLASS, experimentalMarksConfig } from "../core";

export default {
  description:
    "Registers the Show experimental marks config and, while it is off, serves a head script that hides the marks before the first frame.",
  contributions: [
    ConfigV2.Register({ descriptor: experimentalMarksConfig }),
    DocumentHead.Fragment({
      id: "experimental-marks",
      render: async () => ({
        "": getConfig(experimentalMarksConfig).showExperimentalMarks
          ? ""
          : `<script>document.documentElement.classList.add(${JSON.stringify(MARKS_OFF_CLASS)});</script>`,
      }),
      subscribe: (onChange) => onConfigDirChange(onChange),
    }),
  ],
  portable: true,
} satisfies ServerPluginDefinition;
