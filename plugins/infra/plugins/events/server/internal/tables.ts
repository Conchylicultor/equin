import { index } from "drizzle-orm/pg-core";
import {
  defineEntity,
  defaultNow,
  defaultRandom,
} from "@plugins/infra/plugins/entities/server";
import { eventEmissionsEntityRef } from "../../core";

// Capped ring-buffer log of every emit() call. Written from dispatch() in
// event.ts, including zero-match emits — that case is the primary debugging
// value ("my trigger didn't fire, why"). Pruned inline to ~EMISSIONS_CAP rows
// (core, beside the `eventEmissions` collection whose `maxLimit` it also is)
// so the table stays bounded without a background job.
//
// The table + the `EmissionRow` wire schema both derive from the single
// `eventEmissionFields` record (core, named by `eventEmissionsEntityRef`), so a
// column/schema drift is unrepresentable and `loadEmissions` returns
// `db.select()` rows verbatim.
const eventEmissions = defineEntity(eventEmissionsEntityRef, {
  primaryKey: "id",
  columns: {
    id: { default: defaultRandom() },
    emittedAt: { default: defaultNow() },
  },
  indexes: (t) => [index("event_emissions_emitted_at_idx").on(t.emittedAt)],
});

// drizzle-kit schema-glob discovery. Name kept so consumers don't churn.
export const _event_emissions = eventEmissions.table;
