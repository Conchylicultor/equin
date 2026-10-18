import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { LogPersistence } from "@plugins/primitives/plugins/log-channels/server";
import { memoryPersistence } from "./internal/memory-persistence";

export default {
  description:
    "Log persistence for a host without a disk: provides the LogPersistence host service with the in-memory ring only (the browser composition, the portable boot test) — a durable channel's lines live as long as the process. Never booted by the desktop.",
  portable: true,
  contributions: [LogPersistence.provide(memoryPersistence)],
} satisfies ServerPluginDefinition;
