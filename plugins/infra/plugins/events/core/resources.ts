import { z } from "zod";
import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import {
  liveInstant,
  liveNumber,
  liveText,
} from "@plugins/network/plugins/live/plugins/filter/core";
import { fieldsToZodObject, type FieldsRecord } from "@plugins/fields/core";
import { uuidField } from "@plugins/fields/plugins/uuid/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";

// One emission row. The `event_emissions` table and the `EmissionRow` wire
// schema both derive from this single field record (via defineEntity on the
// server), so a column/schema drift is unrepresentable and the loader returns
// `db.select()` rows verbatim (and `eventEmissions` binds them by name).
// `emittedAt` is a coerced Date on the wire.
export const eventEmissionFields = {
  id: uuidField(),
  eventName: textField(),
  payload: jsonField<Record<string, unknown>>({
    schema: z.record(z.unknown()),
    default: {},
  }),
  matchedCount: intField(),
  matchedTriggerIds: jsonField<string[]>({
    schema: z.array(z.string()),
    default: [],
  }),
  emittedAt: dateField(),
} satisfies FieldsRecord;

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
export const EmissionMatchSchema = z.enum(["matched", "unmatched"]);
export type EmissionMatch = z.infer<typeof EmissionMatchSchema>;

/** A row of the {@link eventEmissions} collection: the emission, plus its derived `match`. */
export const EmissionListRowSchema = EmissionRowSchema.extend({
  match: EmissionMatchSchema,
});
export type EmissionListRow = z.infer<typeof EmissionListRowSchema>;

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
  row: EmissionListRowSchema,
  id: "id",
  filterable: {
    eventName: liveText(),
    match: liveText(EmissionMatchSchema),
    matchedCount: liveNumber(),
    emittedAt: liveInstant(),
  },
  sortable: ["emittedAt", "eventName", "matchedCount"],
  default: { orderBy: [["emittedAt", "desc"]], limit: 200 },
  maxLimit: EMISSIONS_CAP,
});

// Every trigger binding across every registered event, newest first — the
// Debug → Queue pane's Triggers tab. A value, not a collection: the rows are a
// union over one `<event>_triggers` table per event plus the computed
// `dangling` flag, which no single-table `liveCollection` can bind. Pushed
// whole on every write to any of those tables (the loader's read-set).
export const eventTriggers = liveValue("event-triggers", {
  schema: z.array(TriggerRowSchema),
});
