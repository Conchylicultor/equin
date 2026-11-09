import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { DataFiles } from "./internal/service";
export type {
  DataFilesImpl,
  FileRootLedgerSpec,
  FileRootSpec,
  FileRootStore,
  FileRootWatchSpec,
} from "./internal/service";
export { defineFileRoot, listFileRoots } from "./internal/root";
export type { FileRoot, WatchedFileRoot } from "./internal/root";
export {
  assertNotRoot,
  requireWatchSpec,
  watchedPaths,
} from "./internal/provider-rules";

export default {
  description:
    "Data files: the files app-owned data dirs hold, on whatever host runs — the DataFiles host service (the computer's disk on the desktop, memory in a browser host) behind defineFileRoot, a root declared by the plugin owning the data dir: list / stat / read / write (atomic) / remove / rename (never replacing) / withLock / watch over validated relative paths, every miss a typed result and every mutation naming its writer. Each root's folder is a location in this host's file system (DataFilesImpl.location: the data dir on the computer's disk, or the same dir in the browser storage's hidden data folder), where file-systems' reads read its files. A person browses a root's files as a folder of that file system (Files), never through the root.",
  contributions: [],
} satisfies ServerPluginDefinition;
