import {
  EVENT_CATEGORIES,
  EVENT_CATEGORY_META,
} from "@plugins/apps/plugins/events/plugins/events-core/core";

// The events list's field vocabulary — which of the event's fields it lists,
// sorts and searches. Each field itself (label, type, options, filter domain)
// is the `events` entity's, declared once in events-core
// (`core/internal/fields.ts`); this names only which of them, in what order.
//
// `imageUrl` / `allDay` / `date` are deliberately NOT listed: they are display
// or formatting inputs the row renderer reads straight off the record, and
// promoting them would only add dead sort/filter axes. `date` in particular is
// jsonb: the queryable dimensions are its denormalized projections
// (`startsAt`, `recurring`), which are indexed columns and listed below.
//
// `description` is listed so the search box can match it (a search column is
// a filterable text column) and kept off the body by the list's overrides.
// `sourceId` is the source dimension: its options are the live sources,
// presented by the sources plugin (`sources/source-field`), so this plugin
// names no source, ever.

/** The event fields the list shows, in list order. */
export const EVENT_LIST_PICK = [
  "title",
  "startsAt",
  "category",
  "venue",
  "city",
  // Free text ("Free", "12–18 €") — venues do not publish a normalizable
  // number, so this is a text dimension, never a `number` one.
  "price",
  "recurring",
  // The jsonb string array, filtered in the `stringArray` domain (has all /
  // any / none of). Not sortable: a jsonb array has no keyset order.
  "tags",
  "url",
  // The soft-deletion stamp. A real, filterable dimension on purpose: the
  // query hides disappeared events BY DEFAULT, and an explicit rule on this
  // field is how a view says "I know about disappearance — here is what I
  // want".
  "disappearedAt",
  "sourceId",
  "description",
] as const;

/** The closed category vocabulary, as option rows (a surface outside the list's fields). */
export const EVENT_CATEGORY_OPTIONS = EVENT_CATEGORIES.map((c) => ({
  value: c,
  label: EVENT_CATEGORY_META[c].label,
}));

/**
 * What the list sorts by. Never `tags` (a jsonb array has no order), `url`,
 * `disappearedAt` or `description` (not offered).
 */
export const EVENT_LIST_SORTABLE = [
  "title",
  "startsAt",
  "category",
  "venue",
  "city",
  "price",
  "recurring",
  "sourceId",
] as const;

/**
 * The text columns the search box matches (any of, case-insensitively): what an
 * event is (title / description) and where it is (venue / city).
 */
export const EVENT_LIST_SEARCHABLE = [
  "title",
  "description",
  "venue",
  "city",
] as const;
