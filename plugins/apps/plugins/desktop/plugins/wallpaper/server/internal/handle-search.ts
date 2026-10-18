import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { searchWallpaper } from "../../core";
import { getWallpaperProvider } from "./registry";

/**
 * Generic search dispatch: resolve the provider by id from the registry and run
 * its `search`. An unknown provider id is a 404 (the picker only renders ids it
 * read from the contribution slot, so this is a defensive guard).
 */
export const handleSearch = implement(searchWallpaper, async ({ query }) => {
  const provider = getWallpaperProvider(query.provider);
  if (!provider) {
    throw new HttpError(404, `Unknown wallpaper provider: ${query.provider}`);
  }
  return provider.search(query.q);
});
