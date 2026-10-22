import { serveValue } from "@plugins/network/plugins/live/server";
import { WALLPAPER_QUERY_MAX, wallpaperSearch } from "../../core";
import { getWallpaperProvider } from "./registry";

/**
 * The generic search dispatch: resolve the provider by id from the registry
 * and run its `search`. The picker only renders ids it read from the
 * contribution slot, so an unknown one is refused rather than failed.
 */
export const wallpaperSearchServed = serveValue(wallpaperSearch, {
  source: "external",
  changes: {
    fixed: {
      reason:
        "a third-party answer to one query (one page of the provider's results): no change signal",
    },
  },
  loader: async ({ provider: providerId, q }) => {
    if (q.length === 0 || q.length > WALLPAPER_QUERY_MAX) {
      throw wallpaperSearch.refuse(
        "invalid-query",
        `A wallpaper search needs a query of 1–${WALLPAPER_QUERY_MAX} characters.`,
      );
    }
    const provider = getWallpaperProvider(providerId);
    if (!provider) {
      throw wallpaperSearch.refuse(
        "unknown-provider",
        `Unknown wallpaper provider: ${providerId}`,
      );
    }
    return provider.search(q);
  },
});
