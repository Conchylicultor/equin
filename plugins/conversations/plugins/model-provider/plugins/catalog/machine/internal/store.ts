import {
  defineFileWatcher,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import type { ModelCatalog } from "@plugins/conversations/plugins/model-provider/core";
import { notifyModelCatalogChanged } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";
import { modelCatalogDir } from "../../data-dirs";
import { catalogFromFile, writeCatalogFile } from "./catalog-file";

function catalogFile(): string {
  return modelCatalogDir.file("catalog.json");
}

/** The last catalog read from disk, or null when the next read must go to the file. */
let memory: ModelCatalog | null = null;

/**
 * The desktop's `ModelCatalogSource`: the host-global `catalog.json` (the
 * baseline while there is none), held in memory and re-read whenever the file
 * changes. Throws `ModelCatalogUnreadableError` while the file is unreadable —
 * a launch never runs against a guess.
 */
export function readFileCatalog(): ModelCatalog {
  memory ??= catalogFromFile(catalogFile());
  return memory;
}

/** Drop the in-memory copy and tell every subscriber to read again. */
function invalidate(): void {
  memory = null;
  notifyModelCatalogChanged();
}

/**
 * Always on, not `whileSubscribed`: the catalog is read by the launch
 * path with no tab subscribed, and must still see main's discovery the moment
 * it lands. One small directory, one watcher per backend.
 */
export const modelCatalogWatcher = defineFileWatcher({
  name: "model-provider.catalog",
  description:
    "Re-reads the model catalog the moment the host's discovery job rewrites it, so every launch and picker on this backend sees a newly discovered model at once.",
  // The writer's tmp file appears and is renamed away; only the rename matters.
  ignore: ["**/*.tmp"],
});

let watcher: FileWatcher | null = null;

/** Watch the catalog's directory for as long as the backend serves. */
export async function startCatalogWatcher(): Promise<void> {
  if (watcher) return;
  watcher = await modelCatalogWatcher.start({
    // Subscribing to a missing directory fails; the dir is host-global and cheap.
    dirs: [modelCatalogDir.ensure()],
    onChange: invalidate,
  });
  // A rewrite between the first read and the subscription would be missed.
  invalidate();
}

export async function stopCatalogWatcher(): Promise<void> {
  const w = watcher;
  watcher = null;
  await w?.stop();
}

/**
 * Read-modify-write the catalog, then serve the result at once (the watcher
 * would, a beat later). Only the discovery job calls it — the catalog's one
 * writer — so the read and the write need no lock between them.
 */
export async function updateModelCatalog<R>(
  change: (current: ModelCatalog) => { catalog: ModelCatalog; changes: R },
): Promise<R> {
  const file = catalogFile();
  const { catalog, changes } = change(catalogFromFile(file));
  await writeCatalogFile(file, catalog);
  memory = catalog;
  notifyModelCatalogChanged();
  return changes;
}
