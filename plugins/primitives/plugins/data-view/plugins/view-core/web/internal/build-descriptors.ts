import type {
  ConfigDescriptor,
  ConfigMigration,
} from "@plugins/config_v2/core";
import type { FieldsRecord } from "@plugins/fields/core";
import { viewsDescriptor } from "../../shared";

/**
 * Build the per-id `views` descriptors for the web runtime, parameterized by the
 * caller's id list (the consumer owns the manifest — the engine never scrapes
 * markers).
 *
 * `useConfig`/`useSetConfig` match a config registration by descriptor
 * *reference identity* (`reg.descriptor === descriptor`). So the descriptor
 * passed to `ConfigV2.WebRegister` and the one looked up by `useViewsConfig` MUST
 * be the same object. Building both off this single map (the consumer registers
 * the `entries`, the model resolves via `map.get(id)`) guarantees that.
 * (`viewsDescriptor` also caches per id, so this is belt-and-suspenders; the map
 * is the canonical lookup.)
 *
 * `extraFields` is an opaque consumer-owned set of sibling config fields (e.g.
 * data-view's `sortPresets`) threaded into every per-id descriptor — view-core
 * never names them. Pass one stable module-constant per runtime so the per-id
 * cache identity holds. `migrations` likewise: the consumer's rewrites of its
 * saved rows, opaque here.
 */
export function buildViewDescriptors(
  ids: string[],
  extraFields?: FieldsRecord,
  migrations?: readonly ConfigMigration[],
): {
  map: Map<string, ConfigDescriptor>;
  entries: Array<{ id: string; descriptor: ConfigDescriptor }>;
} {
  const map = new Map<string, ConfigDescriptor>(
    ids.map((id) => [id, viewsDescriptor(id, extraFields, migrations)]),
  );
  const entries = ids.map((id) => ({ id, descriptor: map.get(id)! }));
  return { map, entries };
}
