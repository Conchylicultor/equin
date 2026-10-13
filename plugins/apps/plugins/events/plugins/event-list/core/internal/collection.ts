import { liveCollection } from "@plugins/network/plugins/live/core";
import { SourcedEventSchema } from "@plugins/apps/plugins/events/plugins/events-core/core";
import { EVENT_LIST_FILTERABLE, EVENT_LIST_SORTABLE } from "./fields";

/**
 * The events list's live collection: every event with its source's ref
 * (`sourceType` / `sourceConfig`), read by the DataView as live key-range pages
 * (the set grows without bound) and kept fresh by the routed
 * change feed, with no revision tick and no refetch of the loaded pages:
 *
 * - an event write refills exactly that event in the live pages that hold (or now
 *   admit) it;
 * - a source write reaches the list through the `source` lookup's REVERSE route
 *   (research/2026-09-29-global-scoped-change-routing.md, P4), gated on the
 *   source columns the list reads: a run flipping the source's `status` or its
 *   watermarks reaches nothing; a type / config edit refills that source's
 *   events a tuple holds; an `enabled` flip — which moves membership, the list
 *   hiding a disabled source's events by default — refills the source's events
 *   (at most 500 of them, then the window reloads, bounded);
 * - a deleted source's events arrive as event deletes (the FK cascade).
 *
 * `columnScope` is the events DataView's id (`defineDataView("events.list")`,
 * asserted equal at mount): the user's custom columns on that surface sort and
 * filter the window server-side.
 */
export const eventsList = liveCollection("events.list", {
  row: SourcedEventSchema,
  id: "id",
  filterable: EVENT_LIST_FILTERABLE,
  sortable: EVENT_LIST_SORTABLE,
  default: { orderBy: [["startsAt", "asc"]], limit: 100 },
  maxLimit: 500,
  columnScope: "events.list",
});
