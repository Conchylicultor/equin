import type { Registration } from "@plugins/framework/plugins/server-core/core";
import type { TrashEntry } from "../../core";

// A registered trash source. The primitive owns the ledger table and the
// list/restore/purge wiring; each source owns how its domain rows are restored
// (clear `deleted_at` flags) and how they are finally destroyed (run destroy
// hooks + hard-delete the roots so the FK cascades fire — intended, at purge).
// Collection-consumer separation: the primitive never names a source — sources
// register themselves and the primitive looks them up by id.
export interface TrashSource {
  id: string;
  /** Clear the domain's `deleted_at` flags for this entry's subtree. */
  restore: (entry: TrashEntry) => Promise<void>;
  /** Run destroy hooks + hard-delete the roots (FK cascades fire here). */
  purge: (entries: TrashEntry[]) => Promise<void>;
}

// Module-load-time registry. Populated by `defineTrashSource`'s `register()`
// during the framework's register phase (mirrors `defineHistorySource`).
const trashSourceRegistry = new Map<string, TrashSource>();

/**
 * Register a trash source. Returns a {@link Registration} — a lazy registry
 * write the framework applies when the token sits in a plugin's
 * `register: [...]` array. Mirrors the `defineHistorySource` shape: the returned
 * object carries the public API (`id`) alongside `register()` plus the
 * `_kind` / `_factory` / `_doc` docgen metadata the framework reads.
 */
export function defineTrashSource(
  source: TrashSource,
): TrashSource & Registration {
  return {
    ...source,
    _kind: "trash-source",
    _factory: "defineTrashSource",
    _doc: { label: source.id },
    register() {
      if (trashSourceRegistry.has(source.id)) {
        throw new Error(`[trash] duplicate trash source id: ${source.id}`);
      }
      trashSourceRegistry.set(source.id, source);
    },
  };
}

export function getTrashSource(id: string): TrashSource | undefined {
  return trashSourceRegistry.get(id);
}
