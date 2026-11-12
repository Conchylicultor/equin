import { defineConfig } from "@plugins/config_v2/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";

/**
 * The folder every app shows and opens as Home, when an instance curates one —
 * the showcase film's, whose screen must not carry the real home folder. Empty
 * (the default) is the account's own home folder. Nothing in the real home is
 * touched: the stand-in is only where `~` points (`hostHome`, host-fs).
 */
export const homeFolderConfig = defineConfig({
  name: "home-folder",
  fields: {
    standIn: textField({
      label: "Stand-in home folder",
      description:
        "An absolute folder every app shows and opens as Home instead of your account's home folder — for a demo or a recording. Leave empty for your own home folder.",
      default: "",
    }),
  },
});
