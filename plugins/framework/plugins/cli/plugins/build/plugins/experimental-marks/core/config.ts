import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";

export const experimentalMarksConfig = defineConfig({
  fields: {
    showExperimentalMarks: boolField({
      default: true,
      label: "Show experimental marks",
      description:
        "On a build from worktree code (not main's), mark it as experimental: a red frame around the page and a banner in the Wish popover. Off hides both — for a recording or a demo. Has no effect on any other build.",
    }),
  },
});
