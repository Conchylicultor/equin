import { defineConfig } from "@plugins/config_v2/core";
import { multilineTextField } from "@plugins/fields/plugins/multiline-text/plugins/config/core";

export const pushAndExitConfig = defineConfig({
  fields: {
    prompt: multilineTextField({
      label: "Push & Exit prompt",
      description:
        "Prompt sent to Claude when the Push & Exit button is pressed.",
      default: "Push and exit",
    }),
  },
});
