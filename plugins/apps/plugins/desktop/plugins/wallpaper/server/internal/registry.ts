import type { Registration } from "@plugins/framework/plugins/server-core/core";
import type { WallpaperResult } from "../../core";

/**
 * A registered wallpaper search provider. The handler owns the generic dispatch
 * (route → registry → results); each provider owns only how its source maps a
 * query string to candidate results. Collection-consumer separation: the handler
 * never names a provider — providers register themselves and the handler looks
 * them up by id.
 */
export interface WallpaperSearchProvider {
  id: string;
  /** Map a free-text query to candidate results (thumbnail + full url + credit). */
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
