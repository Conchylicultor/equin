import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { DataFiles } from "@plugins/infra/plugins/paths/plugins/data-files/server";
import { memoryDataFiles } from "./internal/memory-store";

export default {
  description:
    "Data files in memory: provides the DataFiles host service for a host without the computer's disk (the browser composition), every root's tree kept in this process and written through to the host's declared storage (read back after a reload when it is persistent) — directories made as a write's parents, one monotonic clock, in-process locks, and a watch that hears every mutation as one change per microtask. Never booted by the desktop.",
  contributions: [DataFiles.provide(memoryDataFiles)],
} satisfies ServerPluginDefinition;
