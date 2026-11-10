import type { Registration } from "@plugins/framework/plugins/server-core/core";
import type { AssetMirrorSource } from "../../core";

/**
 * Module-load-time registry: mirror id → its pinned source. Populated by
 * `defineAssetMirror().register()` during the plugin register phase; read by
 * the mirror route handler at request time. Mirrors the `defineJob` pattern
 * (`@plugins/infra/plugins/jobs` registry) — a lazy register-token write so the
 * registry is fully populated before any route is served.
 */
export const mirrorRegistry = new Map<string, AssetMirrorSource>();

/**
 * Declare an asset mirror over a pinned source (`defineAssetMirrorSource`,
 * core). Add the returned token to a server plugin's `register: [...]` array.
 * After registration, the primitive's route serves each file the source pins
 * at `/api/asset-mirror/<id>/<file>` — downloading it once on its first
 * request, keeping it only if it hashes to its pin, and serving it from the
 * cache thereafter. A name the source does not pin is a 404.
 */
export function defineAssetMirror(source: AssetMirrorSource): Registration {
  return {
    register() {
      const existing = mirrorRegistry.get(source.id);
      if (existing !== undefined && existing !== source) {
        throw new Error(
          `[asset-mirror] mirror id "${source.id}" is declared by two sources — declare it once and share it`,
        );
      }
      mirrorRegistry.set(source.id, source);
    },
  };
}
