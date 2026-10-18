import { index } from "drizzle-orm/pg-core";
import {
  defineEntity,
  defaultNow,
  defaultRandom,
} from "@plugins/infra/plugins/entities/server";
import { bootTracesEntityRef } from "../../core";

// One persisted boot-trace snapshot per row, written only on an explicit "Copy
// permalink" click. The table + the `SavedBootTrace` wire schema both derive
// from the single `savedBootTraceFields` record (core, named by
// `bootTracesEntityRef`), so a column/schema drift
// is unrepresentable. The createdAt index serves both the list ordering (newest
// first) and the 30-day cleanup sweep's range delete.
const savedBootTraces = defineEntity(bootTracesEntityRef, {
  primaryKey: "id",
  columns: {
    id:        { default: defaultRandom() },
    createdAt: { default: defaultNow() },
  },
  indexes: (t) => [index("boot_traces_created_at_idx").on(t.createdAt)],
});

// drizzle-kit schema-glob discovery.
export const _bootTraces = savedBootTraces.table;
