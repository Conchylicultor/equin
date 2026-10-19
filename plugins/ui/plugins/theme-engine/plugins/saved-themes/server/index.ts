import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  listSavedThemes,
  createSavedTheme,
  patchSavedThemeFragment,
  patchSavedThemeColorAdjust,
  renameSavedTheme,
  deleteSavedTheme,
} from "../core";
import {
  handleList,
  handleCreate,
  handlePatchFragment,
  handlePatchColorAdjust,
  handleRename,
  handleDelete,
} from "./internal/handlers";

import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/server";
import {
  listSavedThemes as listStoredThemes,
  onSavedThemesChange,
} from "./internal/store";

export { saveTheme } from "./internal/store";

export default {
  description:
    "Stores tweakcn imports and custom themes in one table, with the create / edit / rename / delete endpoints, and serves them to the server's first-frame theme painter (ThemeEngine.Source). A delete refuses while any scope still selects the theme unless asked to reassign those scopes to Default.",
  contributions: [
    ThemeEngine.Source({
      id: "saved-themes",
      list: listStoredThemes,
      subscribe: onSavedThemesChange,
    }),
  ],
  httpRoutes: {
    [listSavedThemes.route]: handleList,
    [createSavedTheme.route]: handleCreate,
    [patchSavedThemeFragment.route]: handlePatchFragment,
    [patchSavedThemeColorAdjust.route]: handlePatchColorAdjust,
    [renameSavedTheme.route]: handleRename,
    [deleteSavedTheme.route]: handleDelete,
  },
} satisfies ServerPluginDefinition;
