import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import {
  liveCollection,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import {
  eventSourceFields,
  eventsEntityRef,
  type SourcedEvent,
} from "@plugins/apps/plugins/events/plugins/events-core/core";
import { EVENT_LIST_PICK, EVENT_LIST_SORTABLE } from "./fields";

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
 * Declared by FIELDS: the rows ARE events (`from`), the fields a list shows
 * `pick`ed from the entity (labels, options and filter domains its own), the
 * joined source ref and the rest of the listed event carried. The list names
 * no field beyond that.
 *
 * `columnScope` is the events DataView's id (`defineDataView("events.list")`,
 * asserted equal at mount): the user's custom columns on that surface sort and
 * filter the window server-side.
 */
export const eventsList = liveCollection("events.list", {
  from: eventsEntityRef,
  pick: EVENT_LIST_PICK,
  carry: {
    pick: [
      "id",
      "externalId",
      "date",
      "endsAt",
      "allDay",
      "imageUrl",
      "recurrenceLabel",
      "createdAt",
      "updatedAt",
    ],
    // The joined source row's columns (`source.type` / `source.config`,
    // bound by the server half's `columns`).
    fields: {
      sourceType: textField(),
      sourceConfig: eventSourceFields.config,
    },
  },
  id: "id",
  sortable: EVENT_LIST_SORTABLE,
  default: { orderBy: [["startsAt", "asc"]], limit: 100 },
  maxLimit: 500,
  columnScope: "events.list",
});

/** A row as the list delivers it: the sourced event plus every exposed field under `$columns`. */
export type EventListRow =
  typeof eventsList extends LiveRowsCollection<infer R> ? R : never;

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
/** The derived row IS the `SourcedEvent` every event surface reads. */
export type _PinEventListRow = Assert<
  Equal<Omit<EventListRow, "$columns">, SourcedEvent>
>;
