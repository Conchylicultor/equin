import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";

export const backgroundMusicConfig = defineConfig({
  fields: {
    acrossApps: boolField({
      default: true,
      label: "Keep playing across apps",
      description:
        "Music an app plays (Isle's ambience) keeps playing after you leave the app. Off, leaving the app stops it — clicking between windows on the desktop never does.",
    }),
  },
});
