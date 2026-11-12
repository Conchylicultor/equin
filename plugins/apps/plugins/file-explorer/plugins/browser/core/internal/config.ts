import { defineConfig } from "@plugins/config_v2/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";

/**
 * Where the Files app opens when it is launched with no folder in its URL:
 * the folder its index pane shows. `~` (the home folder) unless the user —
 * or an instance that curates one, like the showcase film's — names another.
 */
export const filesConfig = defineConfig({
  name: "files",
  fields: {
    startFolder: textField({
      label: "Start folder",
      description:
        "The folder Files opens on when launched (`~` is the home folder).",
      default: "~",
    }),
  },
});
