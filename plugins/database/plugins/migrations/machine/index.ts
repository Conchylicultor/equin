import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { MigrationSource } from "@plugins/database/plugins/migrations/server";
import { listMigrationFiles, MIGRATIONS_DIR } from "./internal/list-files";

export { listMigrationFiles, MIGRATIONS_DIR } from "./internal/list-files";

export default {
  description:
    "The desktop's migration source: the committed data/*.sql read off disk (or a release's vendored copy, its migrations-dir override).",
  contributions: [
    MigrationSource.provide({ list: () => listMigrationFiles(MIGRATIONS_DIR) }),
  ],
} satisfies MachinePluginDefinition;
