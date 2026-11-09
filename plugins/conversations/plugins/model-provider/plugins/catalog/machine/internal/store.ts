import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  defineFileWatcher,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import type { ModelCatalog } from "@plugins/conversations/plugins/model-provider/core";
import { notifyModelCatalogChanged } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";
import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";
import { modelCatalogDir } from "../../data-dirs";
import {
  ModelCatalogUnreadableError,
  catalogFromFile,
  writeCatalogFile,
} from "./catalog-file";

function catalogFile(): AppPath {
  return modelCatalogDir.file("catalog.json");
}

/**
 * The last catalog read from disk (or the error it threw), or null before the
 * first load. Loaded off the request path — at register, then on every file
 * change — so the launch path reads it synchronously without touching the disk.
 */
let memory:
  { catalog: ModelCatalog } | { error: ModelCatalogUnreadableError } | null =
  null;

/** One read at a time, so an older read never lands after a newer one. */
const reading = createKeyedMutex();

function reload(): Promise<void> {
  return reading.run("catalog", async () => {
    try {
      memory = { catalog: await catalogFromFile(catalogFile()) };
    } catch (err) {
      if (!(err instanceof ModelCatalogUnreadableError)) throw err;
      memory = { error: err };
    }
  });
}

/**
 * Load the catalog into memory — the plugin's `onReadyBlocking`, which every
 * boot mode awaits before it serves, so no launch reads it first.
 */
export async function loadModelCatalog(): Promise<void> {
  await reload();
}

/**
 * The desktop's `ModelCatalogSource`: the host-global `catalog.json` (the
 * baseline while there is none), held in memory and re-read whenever the file
 * changes. Throws `ModelCatalogUnreadableError` while the file is unreadable —
 * a launch never runs against a guess.
 */
export function readFileCatalog(): ModelCatalog {
  if (memory === null) {
    throw new Error("the model catalog is read before it was loaded");
  }
  if ("error" in memory) throw memory.error;
  return memory.catalog;
}

/** Re-read the file, then tell every subscriber to read again. */
async function invalidate(): Promise<void> {
  await reload();
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
  // The one known file, followed on kqueue: heard in milliseconds, where an
  // FSEvents watch of its folder was 3–14 s late while fseventsd was loaded.
  // The writer's tmp sibling is not followed; its rename over the file is.
  writesWhileOpen: true,
});

let watcher: FileWatcher | null = null;

/** Follow the catalog file for as long as the backend serves. */
export async function startCatalogWatcher(): Promise<void> {
  if (watcher) return;
  // Following a file in a missing directory fails; the dir is host-global and cheap.
  await modelCatalogDir.ensure();
  watcher = await modelCatalogWatcher.start({
    files: [catalogFile()],
    onChange: () => invalidate(),
  });
  // A rewrite between the first read and the subscription would be missed.
  await invalidate();
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
  const changes = await reading.run("catalog", async () => {
    const result = change(await catalogFromFile(file));
    await writeCatalogFile(file, result.catalog);
    memory = { catalog: result.catalog };
    return result.changes;
  });
  notifyModelCatalogChanged();
  return changes;
}
