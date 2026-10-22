import type { Registration } from "@plugins/framework/plugins/server-core/core";
import type { WallpaperResult } from "../../core";

/**
 * A registered wallpaper search provider. The served `wallpaper.search` value
 * owns the generic dispatch (question → registry → results); each provider owns
 * only how its source maps a query string to candidate results.
 * Collection-consumer separation: the dispatch never names a provider —
 * providers register themselves and it looks them up by id.
 */
export interface WallpaperSearchProvider {
  id: string;
  /**
   * Map a free-text query to ONE page of candidate results (thumbnail + full
   * url + credit). Any failure — a source throttling requests for now
   * included — throws an Error (the read's error, with Retry); an empty array
   * means only "nothing matched".
   */
  search: (q: string) => Promise<WallpaperResult[]>;
}

// Module-load-time registry, populated by `defineWallpaperProvider`'s
// `register()` during the framework's register phase (mirrors
// `defineHistorySource`'s `historySourceRegistry`).
const registry = new Map<string, WallpaperSearchProvider>();

/**
 * Register a wallpaper search provider. Returns a {@link Registration} — a lazy
 * registry write the framework applies when the token sits in a plugin's
 * `register: [...]` array, mirroring `defineHistorySource`.
 */
export function defineWallpaperProvider(
  provider: WallpaperSearchProvider,
): WallpaperSearchProvider & Registration {
  return {
    ...provider,
    _kind: "wallpaper-provider",
    _factory: "defineWallpaperProvider",
    _doc: { label: provider.id },
    register() {
      if (registry.has(provider.id)) {
        throw new Error(
          `[wallpaper] duplicate wallpaper provider id: ${provider.id}`,
        );
      }
      registry.set(provider.id, provider);
    },
  };
}

export function getWallpaperProvider(
  id: string,
): WallpaperSearchProvider | undefined {
  return registry.get(id);
}
