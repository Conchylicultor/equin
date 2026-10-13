import { desc, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import { getAllRegisteredJobNames } from "@plugins/infra/plugins/jobs/server";
import { expr } from "@plugins/infra/plugins/query-resource/core";
import { parsed } from "@plugins/database/plugins/sql-projection/server";
import {
  EmissionMatchSchema,
  eventEmissions,
  eventTriggers,
  type EmissionsPayload,
  type TriggerRow,
} from "../../core/resources";
import { triggerTableRegistry } from "./registry";
import { _event_emissions } from "./tables";

const BASE_COLS = new Set([
  "id",
  "jobName",
  "jobWith",
  "enabled",
  "oneShot",
  "createdAt",
]);

// biome-ignore lint/suspicious/noExplicitAny: dynamic row shape across per-event tables.
type Row = Record<string, any>;

// The `GET /api/events/emissions` read. The Events tab reads the
// `event-emissions` collection instead (`eventEmissionsServed` below).
export async function loadEmissions(limit = 200): Promise<EmissionsPayload> {
  // `_event_emissions.$inferSelect ≡ EmissionRow` by construction (both derive
  // from `eventEmissionFields`), so rows are returned verbatim — no projection.
  const rows = await db
    .select()
    .from(_event_emissions)
    .orderBy(desc(_event_emissions.emittedAt))
    .limit(limit);
  return { rows };
}

export async function loadTriggers(): Promise<TriggerRow[]> {
  const out: TriggerRow[] = [];
  const registeredNames = getAllRegisteredJobNames();
  for (const [eventName, table] of triggerTableRegistry.entries()) {
    const rows = (await db.select().from(table)) as Row[];
    for (const r of rows) {
      const filters: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (!BASE_COLS.has(k)) filters[k] = v;
      }
      out.push({
        eventName,
        id: r.id as string,
        jobName: r.jobName as string,
        jobWith: (r.jobWith ?? {}) as Record<string, unknown>,
        enabled: r.enabled as boolean,
        oneShot: r.oneShot as boolean,
        createdAt:
          r.createdAt instanceof Date
            ? r.createdAt.toISOString()
            : String(r.createdAt),
        filters,
        dangling: !registeredNames.has(r.jobName as string),
      });
    }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

// The emit() log over `event_emissions`: its window (newest first) and
// its `:rows` / `:groups` siblings. Every stored column is on the wire — the
// row is the entity (`EmissionRow`) bound by name, plus `match`, the one
// computed field: `matched_count = 0`, the same fact `matchedCount` states, so
// it cannot drift from it. Rows are written once and never updated;
// `emittedAt` never changes, so an emit is a window insert and the ring's
// inline prune a window delete.
export const eventEmissionsServed = serveCollection(eventEmissions, {
  from: _event_emissions,
  columns: {
    match: (j) =>
      expr(
        sql`(CASE WHEN ${j.base.matchedCount} > 0 THEN 'matched' ELSE 'unmatched' END)`,
        {
          decoder: parsed(EmissionMatchSchema, "event-emissions.match"),
          sqlType: "text",
          notNull: true,
        },
      ),
  },
});

// The loader's read-set is every per-event trigger table, so a write to any of
// them (a trigger() binding, a ctx.waitFor's oneShot binding and its deletion
// on dispatch, the Triggers tab's enable / delete, the boot re-projection)
// recomputes and pushes the whole list. `dangling` reads the job registry,
// which is fixed once boot has registered every job.
export const eventTriggersServed = serveValue(eventTriggers, {
  source: "db",
  loader: loadTriggers,
  unbounded: {
    reason:
      "every binding across every event's own <event>_triggers table — the code's static Trigger() bindings plus one oneShot row per pending ctx.waitFor (a never-fired one lingers) — with the computed `dangling` flag: a union over N tables, which a single-table liveCollection cannot bind",
  },
});
