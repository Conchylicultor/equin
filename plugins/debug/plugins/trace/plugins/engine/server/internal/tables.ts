import { index } from "drizzle-orm/pg-core";
import {
  defineEntity,
  defaultNow,
  defaultRandom,
} from "@plugins/infra/plugins/entities/server";
import { tracesEntityRef } from "../../core";

// One durable trace snapshot per row. The table + the `Trace` wire schema both
// derive from the single `traceFields` record (core, named by
// `tracesEntityRef`), so a column/schema drift is unrepresentable. `id` is
// minted synchronously by captureTrace (linkage precedes persistence), so the
// app supplies it on insert rather than relying on the default; the default
// stays as a safety net. The createdAt index serves both the list ordering
// (newest first) and the 7-day cleanup sweep's range delete. The boot-profile
// storage precedent.
const traces = defineEntity(tracesEntityRef, {
  primaryKey: "id",
  columns: {
    id: { default: defaultRandom() },
    createdAt: { default: defaultNow() },
  },
  indexes: (t) => [index("traces_created_at_idx").on(t.createdAt)],
});

// drizzle-kit schema-glob discovery.
export const _traces = traces.table;
