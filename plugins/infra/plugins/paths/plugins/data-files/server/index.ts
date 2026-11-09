import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  dataFileRootsServed,
  dataFileStatServed,
  dataFolderListingServed,
} from "./internal/browse";

export { DataFiles } from "./internal/service";
export type {
  DataFilesImpl,
  FileRootBrowseSpec,
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
    "Data files: the files app-owned data dirs hold, on whatever host runs — the DataFiles host service (the computer's disk on the desktop, memory in a browser host) behind defineFileRoot, a root declared by the plugin owning the data dir: list / stat / read / write (atomic) / remove / rename (never replacing) / withLock / watch over validated relative paths, every miss a typed result and every mutation naming its writer. Each root's folder is a location in this host's file system (DataFilesImpl.location: the data dir on the computer's disk, or the same dir in the browser storage's hidden data folder), where file-systems' reads read its files. A root declared `browse` (and watched) is listed by a generic browser on every host: data-files.roots (each with its location), data-files.list (a folder's entries, paged by name) and data-files.stat, each pushed from the root's watch while read.",
  contributions: [
    ...dataFileRootsServed.declare,
    ...dataFolderListingServed.declare,
    ...dataFileStatServed.declare,
  ],
} satisfies ServerPluginDefinition;
