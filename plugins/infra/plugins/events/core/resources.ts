import { z } from "zod";
import {
  liveCollection,
  liveValue,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { fieldsToZodObject, type FieldsRecord } from "@plugins/fields/core";
import { uuidField } from "@plugins/fields/plugins/uuid/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";

// One emission row. The `event_emissions` table and the `EmissionRow` wire
// schema both derive from this single field record (via defineEntity on the
// server), so a column/schema drift is unrepresentable and the loader returns
// `db.select()` rows verbatim (and `eventEmissions` binds them by name).
// `emittedAt` is a coerced Date on the wire. The labels are the emission log's
// columns: the `eventEmissions` collection picks them.
export const eventEmissionFields = {
  id: uuidField(),
  eventName: textField({ label: "Event", primary: true }),
  payload: jsonField<Record<string, unknown>>({
    schema: z.record(z.unknown()),
    default: {},
  }),
  matchedCount: intField({ label: "Matched" }),
  matchedTriggerIds: jsonField<string[]>({
    schema: z.array(z.string()),
    default: [],
  }),
  emittedAt: dateField({ label: "Time" }),
} satisfies FieldsRecord;

/** The `event_emissions` entity: the table is built from these fields (`server/internal/tables.ts`). */
export const eventEmissionsEntityRef = entityRef(
  "event_emissions",
  eventEmissionFields,
);

export const EmissionRowSchema = fieldsToZodObject(eventEmissionFields);
export type EmissionRow = z.infer<typeof EmissionRowSchema>;

// The `GET /api/events/emissions` endpoint's body. The live collection below
// carries the bare rows.
export const EmissionsPayloadSchema = z.object({
  rows: z.array(EmissionRowSchema),
});
export type EmissionsPayload = z.infer<typeof EmissionsPayloadSchema>;

export const TriggerRowSchema = z.object({
  eventName: z.string(),
  id: z.string(),
  jobName: z.string(),
  jobWith: z.record(z.unknown()),
  enabled: z.boolean(),
  oneShot: z.boolean(),
  createdAt: z.string(),
  filters: z.record(z.unknown()),
  // Computed (not stored): true when `jobName` is not in the live job registry,
  // i.e. the target job was removed and this trigger can never deliver. Transient
  // — the boot sweep deletes dangling rows, so this is surfaced, never persisted.
  dangling: z.boolean(),
});
export type TriggerRow = z.infer<typeof TriggerRowSchema>;

// The `GET /api/events/triggers` endpoint's body. The live value below carries
// the bare array, so the db arm's bound rule sees what it is.
export const TriggersPayloadSchema = z.object({
  rows: z.array(TriggerRowSchema),
});
export type TriggersPayload = z.infer<typeof TriggersPayloadSchema>;

// How many emissions the log keeps: every emit() prunes `event_emissions` back
// to the newest this-many rows (`server/internal/event.ts`), and a window of
// the `eventEmissions` collection grows to at most the same — so a fully grown
// window is the whole ring.
export const EMISSIONS_CAP = 1000;

/**
 * Whether an emission reached any trigger: `"unmatched"` exactly when its
 * `matchedCount` is 0. Not a stored column — the served collection computes it
 * in SQL, so it filters, groups and counts on the server like any column while
 * no write can make it disagree with `matchedCount`.
 */
export const EMISSION_MATCHES = ["matched", "unmatched"] as const;
export const EmissionMatchSchema = z.enum(EMISSION_MATCHES);
export type EmissionMatch = z.infer<typeof EmissionMatchSchema>;

// The one field the emission log computes: whether the emission reached any
// trigger. Bound by `serveCollection`'s `columns` (`server/internal/resources.ts`).
const EMISSION_OWN_FIELDS = {
  match: enumTextField(EMISSION_MATCHES, {
    label: "Match",
    options: {
      matched: { label: "Matched", variant: "success" },
      unmatched: { label: "Unmatched", variant: "destructive" },
    },
  }),
};

/**
 * The emit() log — Debug → Queue's Events tab — as a live collection: a bounded
 * window, newest first (200, grown to at most `EMISSIONS_CAP`), plus its
 * `:rows` / `:groups` siblings. It backs a live DataView (key-range pages):
 * `eventName` and `match` (derived from `matchedCount`) are facets — groupings
 * of the whole log — and `matchedCount` / `emittedAt` filter and sort. Every
 * emit prunes the log to `EMISSIONS_CAP` rows, so any query here reads at most
 * that many. Pushed: an emit's insert, and the ring's inline prune, move the
 * subscribed windows through the change feed.
 */
export const eventEmissions = liveCollection("event-emissions", {
  from: eventEmissionsEntityRef,
  pick: ["emittedAt", "eventName", "matchedCount"],
  fields: EMISSION_OWN_FIELDS,
  carry: { pick: ["id", "payload", "matchedTriggerIds"] },
  id: "id",
  sortable: ["emittedAt", "eventName", "matchedCount"],
  default: { orderBy: [["emittedAt", "desc"]], limit: 200 },
  maxLimit: EMISSIONS_CAP,
});

/** A row of the {@link eventEmissions} collection: the emission, plus its derived `match`. */
export type EmissionListRow =
  typeof eventEmissions extends LiveRowsCollection<infer R> ? R : never;

// Every trigger binding across every registered event, newest first — the
// Debug → Queue pane's Triggers tab. A value, not a collection: the rows are a
// union over one `<event>_triggers` table per event plus the computed
// `dangling` flag, which no single-table `liveCollection` can bind. Pushed
// whole on every write to any of those tables (the loader's read-set).
export const eventTriggers = liveValue("event-triggers", {
  schema: z.array(TriggerRowSchema),
});
