import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { MigrationSource } from "@plugins/database/plugins/migrations/server";
import { bundledMigrations } from "./internal/bundled";

export default {
  description:
    "The migration history bundled as text: provides the MigrationSource host service from the committed data/*.sql inlined at build time, for a host without the repo on disk (a browser worker host). Never booted by the desktop, which reads the files off disk (migrations#machine).",
  portable: true,
  contributions: [MigrationSource.provide({ list: bundledMigrations })],
} satisfies ServerPluginDefinition;
