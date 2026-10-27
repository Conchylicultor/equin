import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { rawEndpointHandler } from "@plugins/infra/plugins/endpoints/server";
import { dataFilesRaw } from "../core";
import {
  dataFileRootsServed,
  dataFileStatServed,
  dataFileTextServed,
  dataFolderListingServed,
  handleDataFileRaw,
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
// Another file reader's way into a browsable root's files (file-viewer's
// bytes): by root id and path, as a browser names them.
export {
  browsableFileRevision,
  readBrowsableFile,
  watchBrowsableFile,
} from "./internal/browse";
export type { BrowsableFileBytes } from "./internal/browse";
export {
  assertNotRoot,
  requireWatchSpec,
  watchedPaths,
} from "./internal/provider-rules";

export default {
  portable: true,
  description:
    "Data files: the files app-owned data dirs hold, on whatever host runs — the DataFiles host service (the computer's disk on the desktop, memory in a browser host) behind defineFileRoot, a root declared by the plugin owning the data dir: list / stat / read / write (atomic) / remove / rename (never replacing) / withLock / watch over validated relative paths, every miss a typed result and every mutation naming its writer. A root declared `browse` (and watched) is readable by a generic browser on every host: data-files.roots, data-files.list (a folder's entries, paged by name), data-files.stat, data-files.text (on demand), each pushed from the root's watch while read, and GET /api/data-files/:root/raw (a file, inert).",
  httpRoutes: {
    [dataFilesRaw.route]: rawEndpointHandler(dataFilesRaw, handleDataFileRaw),
  },
  contributions: [
    ...dataFileRootsServed.declare,
    ...dataFolderListingServed.declare,
    ...dataFileStatServed.declare,
    ...dataFileTextServed.declare,
  ],
} satisfies ServerPluginDefinition;
