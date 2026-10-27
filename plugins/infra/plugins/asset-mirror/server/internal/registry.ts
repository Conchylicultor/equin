import type { Registration } from "@plugins/framework/plugins/server-core/core";

/**
 * Module-load-time registry: mirror id → remote base URL. Populated by
 * `defineAssetMirror().register()` during the plugin register phase; read by
 * the mirror route handler at request time. Mirrors the `defineJob` pattern
 * (`@plugins/infra/plugins/jobs` registry) — a lazy register-token write so the
 * registry is fully populated before any route is served.
 */
export const mirrorRegistry = new Map<string, string>();

export interface AssetMirrorSpec {
  /** Stable id; becomes the URL segment `/api/asset-mirror/<id>/…`. Must match
   *  the id the web consumer passes to `assetMirrorBase`. */
  id: string;
  /** Remote base URL. Files are fetched as `<remoteBaseUrl>/<file>` on a cache
   *  miss, then cached under `~/.equin/cache/asset-mirror/<id>/`. */
  remoteBaseUrl: string;
}

/**
 * Declare an asset mirror. Add the returned token to a server plugin's
 * `register: [...]` array. After registration, the primitive's route serves
 * `<remoteBaseUrl>`'s files at `/api/asset-mirror/<id>/<file>` — downloading
 * each file once on first request and serving it from local disk thereafter.
 */
export function defineAssetMirror(spec: AssetMirrorSpec): Registration {
  return {
    register() {
      const base = spec.remoteBaseUrl.replace(/\/$/, "");
      const existing = mirrorRegistry.get(spec.id);
      if (existing !== undefined && existing !== base) {
        throw new Error(
          `[asset-mirror] duplicate mirror id "${spec.id}" with conflicting base URLs: "${existing}" vs "${base}"`,
        );
      }
      mirrorRegistry.set(spec.id, base);
    },
  };
}
