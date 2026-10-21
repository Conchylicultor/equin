import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  createSavedTheme,
  patchSavedThemeFragment,
  patchSavedThemeColorAdjust,
  renameSavedTheme,
  deleteSavedTheme,
} from "../core";
import {
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
import { savedThemesListServed } from "./internal/resource";

export { saveTheme } from "./internal/store";

export default {
  description:
    "Stores tweakcn imports and custom themes in one table, with the create / edit / rename / delete endpoints (each answering its commit's ack token), serves the live saved-themes.list value, and serves them to the server's first-frame theme painter (ThemeEngine.Source). A delete refuses while any scope still selects the theme unless asked to reassign those scopes to Default.",
  contributions: [
    ...savedThemesListServed.declare,
    ThemeEngine.Source({
      id: "saved-themes",
      list: listStoredThemes,
      subscribe: onSavedThemesChange,
    }),
  ],
  httpRoutes: {
    [createSavedTheme.route]: handleCreate,
    [patchSavedThemeFragment.route]: handlePatchFragment,
    [patchSavedThemeColorAdjust.route]: handlePatchColorAdjust,
    [renameSavedTheme.route]: handleRename,
    [deleteSavedTheme.route]: handleDelete,
  },
} satisfies ServerPluginDefinition;
