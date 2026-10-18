import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { defineWallpaperProvider } from "@plugins/apps/plugins/desktop/plugins/wallpaper/server";
import { searchOpenverse } from "./internal/search";

export default {
  description:
    "Openverse wallpaper search provider: maps a query to open-license image results via the Openverse API (SSRF-guarded safeFetch), registered into the generic wallpaper provider registry.",
  register: [defineWallpaperProvider({ id: "openverse", search: searchOpenverse })],
} satisfies ServerPluginDefinition;
