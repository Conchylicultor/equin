import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { spawnFailureShape } from "../../core";

export const spawnFailures = defineExtension(
  _conversations,
  "spawn_failure",
  spawnFailureShape,
);
// Re-export the underlying pgTable so drizzle-kit's schema glob picks it up.
export const _spawnFailuresTable = spawnFailures.table;
