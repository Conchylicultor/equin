import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { DatabaseDriver } from "@plugins/database/server";
import { createPgliteDriver } from "./internal/pglite-driver";

export default {
  description:
    "The PGlite database driver: provides the DatabaseDriver host service with Postgres compiled to WASM, in memory, for a host without the computer's Postgres cluster (the browser composition, the portable boot test). Never booted by the desktop, which provides its own driver.",
  portable: true,
  contributions: [DatabaseDriver.provide(createPgliteDriver())],
} satisfies ServerPluginDefinition;
