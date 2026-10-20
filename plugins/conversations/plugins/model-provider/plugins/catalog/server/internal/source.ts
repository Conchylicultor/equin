import { defineHostService } from "@plugins/framework/plugins/server-core/core";
import { serveValue } from "@plugins/network/plugins/live/server";
import {
  modelCatalog,
  type ModelCatalog,
} from "@plugins/conversations/plugins/model-provider/core";

/**
 * Where this host's model catalog comes from. On the desktop it is the
 * host-global `catalog.json` the discovery job writes (`catalog#machine`:
 * held in memory, re-read by a file watcher); a host without the computer has
 * no Claude CLI to discover from, so its catalog is the code baseline
 * (`catalog/baseline`).
 */
export interface ModelCatalogSourceImpl {
  /**
   * The catalog this host launches against. Synchronous: the launch path
   * needs it without an await. Throws while the catalog is unreadable — a
   * launch never runs against a guess.
   */
  read(): ModelCatalog;
}

export const ModelCatalogSource = defineHostService<ModelCatalogSourceImpl>(
  "model-provider.catalog-source",
);

/** The model catalog this backend launches against (see `ModelCatalogSource`). */
export function getModelCatalog(): ModelCatalog {
  return ModelCatalogSource.get().read();
}

/**
 * Pushed whole. External: the truth is the source's (a file every backend on
 * the machine shares, or code); a source whose catalog can change calls
 * `notifyModelCatalogChanged` on every change.
 */
export const modelCatalogServed = serveValue(modelCatalog, {
  source: "external",
  changes: "notified",
  loader: () => getModelCatalog(),
});

/** Tell every subscriber of `model-provider.catalog` to read the source again. */
export function notifyModelCatalogChanged(): void {
  modelCatalogServed.notify();
}
