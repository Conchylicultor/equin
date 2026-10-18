import { defineConfig } from "@plugins/config_v2/core";
import { listField } from "@plugins/fields/plugins/list/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { enumField } from "@plugins/fields/plugins/enum/plugins/config/core";

/**
 * The places the user pinned to Favorites (a drag onto the sidebar, or Add to
 * Favorites on a row). Where each shows among the favorites is the Favorites
 * view's own row order (a drop lands in the gap it was dropped in); a pin
 * never arranged there follows the built-in ones in the order pinned.
 * `path` is in display form (`~/…` under home); `kind` says whether it opens
 * as a folder or as a file previewed in its folder.
 */
export const placesConfig = defineConfig({
  fields: {
    pinned: listField({
      label: "Pinned favorites",
      description:
        "Folders and files pinned to the Places sidebar's Favorites, after the built-in ones.",
      itemFields: {
        path: textField({ label: "Path" }),
        kind: enumField({
          label: "Kind",
          options: [
            { value: "dir", label: "Folder" },
            { value: "file", label: "File" },
          ],
        }),
      },
      default: [],
    }),
  },
});
