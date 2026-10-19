import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

// Force every fields storage/filter-sql capability barrel to evaluate (each
// self-registers its column/filter builder into the `server-capabilities` eager
// index) BEFORE any consumer's `tables.ts` body calls `defineEntity` — which
// resolves builders synchronously at module-eval, ahead of `collectContributions`.
// This side-effect import is also the composition-closure edge that pulls the
// capability barrels into every release bundle shipping an entity-defining plugin.
import "@plugins/fields/plugins/server-capabilities-loader/server";

export { defineEntity } from "./internal/define-entity";
export {
  defaultNow,
  defaultRandom,
  sqlDefault,
  isDbDefault,
} from "./internal/types";
export type {
  Entity,
  EntityMeta,
  EntityMetaBase,
  EntityColumnMeta,
  EntityColumns,
  EntityReference,
  EntityRow,
  EntityTable,
  DefaultedKeys,
  ServerOnlyKeys,
  ColumnDefault,
  DbDefault,
  TouchedBy,
  UpdatedAtMeta,
} from "./internal/types";

export default {
  portable: true,
  description:
    "Derives a Drizzle pgTable AND a zod wire schema from one FieldsRecord, so entity.table.$inferSelect is identical by construction to z.infer<entity.schema>. Field-set drift becomes a tsc error; loaders drop their row projection.",
} satisfies ServerPluginDefinition;
