import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { rawEndpointHandler } from "@plugins/infra/plugins/endpoints/server";
import { DataFiles } from "@plugins/infra/plugins/paths/plugins/data-files/server";
import { browserFileRaw } from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { memoryDataFiles } from "./internal/memory-store";
import {
  browserFileBytesServed,
  browserFileStatServed,
  browserFileTextServed,
  handleBrowserFileRaw,
} from "./internal/browser-files";

export default {
  description:
    "Data files in memory: provides the DataFiles host service for a host without the computer's disk (the browser composition), every root's tree kept in this process and written through to the host's declared storage (read back after a reload when it is persistent) — directories made as a write's parents, one monotonic clock, in-process locks, and a watch that hears every mutation as one change per microtask. And the browser's file system (file-systems' `browser` reads: files.browser.stat / .text / .bytes and GET /api/files/browser/raw): this storage laid out like a home folder, each root at its data dir under the hidden data folder the desktop keeps them in. Never booted by the desktop.",
  httpRoutes: {
    [browserFileRaw.route]: rawEndpointHandler(browserFileRaw, (req) =>
      handleBrowserFileRaw(req),
    ),
  },
  contributions: [
    DataFiles.provide(memoryDataFiles),
    ...browserFileStatServed.declare,
    ...browserFileTextServed.declare,
    ...browserFileBytesServed.declare,
  ],
} satisfies ServerPluginDefinition;
