import { eq, isNull } from "drizzle-orm";
import { serveCollection } from "@plugins/network/plugins/live/server";
import type { LookupJoin } from "@plugins/network/plugins/live/plugins/query-resource/core";
import {
  eventsTable,
  _eventSources,
} from "@plugins/apps/plugins/events/plugins/events-core/server";
import { eventsList } from "../../core";

/**
 * Each event's source, joined N:1 on `events.source_id` — REQUIRED (INNER):
 * `source_id` is NOT NULL and FK-cascaded, so the join drops no event. Its
 * route is a REVERSE route on `event_sources.id`: a source write is resolved to
 * the events referencing it, gated on the source columns the list reads (`id`,
 * `type`, `config`, `enabled`) — a run's status / watermark writes reach
 * nothing.
 */
const sourceLookup: LookupJoin<"source", typeof _eventSources> = {
  kind: "lookup",
  alias: "source",
  table: _eventSources,
  pk: _eventSources.id,
  on: { from: "base", col: eventsTable.sourceId },
  required: true,
};

// `eventsTable` is a READ handle (the `events/no-raw-events-write` rule fails
// any write on it outside the repo funnel); a served read is exactly its use.
export const eventsListServed = serveCollection(eventsList, {
  from: eventsTable,
  joins: [sourceLookup],
  columns: {
    sourceType: (j) => j.source.type,
    sourceConfig: (j) => j.source.config,
  },
  defaults: [
    // Disappearance is soft — an event absent from a successful extraction is
    // stamped, never deleted, so a flaky scrape cannot destroy rows the user
    // may have annotated — and those rows must not clutter an ordinary browse.
    // A DEFAULT, not base membership: `disappearedAt` is a real filterable
    // field, and a view that names it (with any op — `isNotEmpty` "only the
    // disappeared", `isEmpty` the default stated explicitly) is asking about
    // disappearance and gets exactly what it asked for.
    { unless: "disappearedAt", where: (j) => isNull(j.base.disappearedAt) },
    // A DISABLED source's events are hidden the same way: disabling a source
    // is the user saying "I don't care about this any more", without deleting
    // anything — re-enabling brings every event straight back. Also a default:
    // a view that names `sourceId` (the contributed `source` dimension) is
    // asking about sources, a disabled one's events included. A predicate on
    // the JOINED source row, never a denormalized copy on the event row: that
    // would turn every flip of the switch into a backfill over the source's
    // events. The flip is routed instead — the lookup's reverse route reads it
    // as membership for the tuples this default applies to.
    { unless: "sourceId", where: (j) => eq(j.source.enabled, true) },
  ],
});
