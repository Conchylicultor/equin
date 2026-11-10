import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";

export const buildConfig = defineConfig({
  fields: {
    autoBuild: boolField({
      default: true,
      label: "Auto-build on push",
      description:
        "Automatically run ./equin build when a new push to main is detected.",
    }),
  },
});
