import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { rawEndpointHandler } from "@plugins/infra/plugins/endpoints/server";
import { DataFiles } from "@plugins/infra/plugins/paths/plugins/data-files/server";
import {
  browserFileMove,
  browserFileRaw,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { FileSystemProvided } from "@plugins/infra/plugins/paths/plugins/file-systems/server";
import { memoryDataFiles } from "./internal/memory-store";
import {
  browserDirPeekServed,
  browserFileBytesServed,
  browserFileListingServed,
  browserFileStatServed,
  browserFileTextServed,
  handleBrowserFileMove,
  handleBrowserFileRaw,
} from "./internal/browser-files";

// A demo's seed (or a test) writes the browser's home through this.
export {
  writeBrowserHomeFiles,
  type BrowserHomeFixture,
} from "./internal/browser-files";

export default {
  description:
    "Data files in memory: provides the DataFiles host service for a host without the computer's disk (the browser composition), every root's tree kept in this process and written through to the host's declared storage (read back after a reload when it is persistent) — directories made as a write's parents, one monotonic clock, in-process locks, and a watch that hears every mutation as one change per microtask. And the browser's file system (FileSystemProvided(\"browser\"): files.browser.list / .peek / .stat / .text / .bytes, GET /api/files/browser/raw and POST /api/files/browser/move): this storage laid out like a home folder — the home's own tree (~/Documents, …) beside the hidden data folder holding each root at its data dir, as the desktop keeps them; writeBrowserHomeFiles writes a fixture into the home for a demo's seed. Never booted by the desktop.",
  httpRoutes: {
    [browserFileRaw.route]: rawEndpointHandler(browserFileRaw, (req) =>
      handleBrowserFileRaw(req),
    ),
    [browserFileMove.route]: handleBrowserFileMove,
  },
  contributions: [
    DataFiles.provide(memoryDataFiles),
    FileSystemProvided("browser"),
    ...browserFileListingServed.declare,
    ...browserDirPeekServed.declare,
    ...browserFileStatServed.declare,
    ...browserFileTextServed.declare,
    ...browserFileBytesServed.declare,
  ],
} satisfies ServerPluginDefinition;
