import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { DatabaseDriver } from "@plugins/database/server";
import { hostStorage } from "@plugins/framework/plugins/browser-server/plugins/host-storage/core";
import { createPgliteDriver } from "./internal/pglite-driver";

export default {
  description:
    "The PGlite database driver: provides the DatabaseDriver host service with Postgres compiled to WASM, for a host without the computer's Postgres cluster (the browser composition, the portable boot test) — in memory, or in IndexedDB when the host's declared storage is persistent (browser-server/host-storage). Never booted by the desktop, which provides its own driver.",
  contributions: [
    DatabaseDriver.provide(createPgliteDriver({ storage: hostStorage })),
  ],
} satisfies ServerPluginDefinition;
