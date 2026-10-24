import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";

export const costConfig = defineConfig({
  fields: {
    singularityOnly: boolField({
      default: true,
      label: "equin sessions only",
      description:
        "When enabled, charts include only Claude sessions launched by equin (joined by claudeSessionId). When disabled, every Claude Code session on this machine is counted — including ad-hoc sessions outside equin.",
    }),
  },
});
